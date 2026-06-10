import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFloat, safeFetch } from "../types";

// Ondo Perps — ondoperps.xyz
// API base: https://api.ondoperps.xyz/v1
//   /v1/perps/contracts → per-market ticker: lastPrice, bid/ask, openInterestUsd,
//                         indexPrice, fundingRate, maker/taker fee, 24h % change, tags.
//   /v1/markets         → contract specs: longName, leverage brackets, base increment.
// Every Ondo Perps market is an RWA (no crypto listings): tokenized US equities,
// commodities (XAU/XAG/WTI), index perps (US100/US500) and ETF perps (DRAM/QQQ/SPY).
// Margin/settlement is USD; OI is reported directly in USD notional (openInterestUsd).

export const ONDO_PERPS_MAKER_FEE = 0.00015;
export const ONDO_PERPS_TAKER_FEE = 0.00035;

const ONDO_CONTRACTS_API = "https://api.ondoperps.xyz/v1/perps/contracts";
const ONDO_MARKETS_API = "https://api.ondoperps.xyz/v1/markets";

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface OndoContract {
  market: string; // e.g. "AAPL-USD.P"
  displayName?: string;
  baseCurrency: string; // e.g. "AAPL"
  quoteCurrency?: string; // "USD"
  disabled?: boolean;
  isClosed?: boolean;
  lastPrice?: string | number;
  baseVolume?: string | number;
  quoteVolume?: string | number; // 24h volume in quote currency (USD)
  usdVolume?: string | number; // rounded USD volume
  bid?: string | number;
  ask?: string | number;
  openInterest?: string | number; // base-asset units
  openInterestUsd?: string | number; // USD notional
  indexPrice?: string | number; // oracle / index price
  fundingRate?: string | number;
  makerFee?: string | number | null;
  takerFee?: string | number | null;
  priceChangePercent?: string | number; // already a percent, e.g. -3.17
  tags?: string[];
}

interface OndoContractsResponse {
  success?: boolean;
  result?: OndoContract[];
}

export interface OndoMarketSpec {
  market: string;
  baseIncrement?: string; // size tick, e.g. "0.01" → 2 decimals
  defaultLeverage?: string | number;
  marginInfo?: Array<{ maxLeverage?: string | number }>;
}

interface OndoMarketsResponse {
  success?: boolean;
  result?: { perps?: { tradingPairs?: OndoMarketSpec[] | null } };
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchOndoContracts(): Promise<OndoContract[]> {
  const data = await safeFetch<OndoContractsResponse>(ONDO_CONTRACTS_API, "Ondo Perps contracts");
  return data?.result ?? [];
}

async function fetchOndoMarketSpecs(): Promise<OndoMarketSpec[]> {
  const data = await safeFetch<OndoMarketsResponse>(ONDO_MARKETS_API, "Ondo Perps markets");
  return data?.result?.perps?.tradingPairs ?? [];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function decimalsFromIncrement(increment: string | undefined): number {
  if (!increment) return 0;
  const [, decimals = ""] = String(increment).split(".");
  return decimals.replace(/0+$/, "").length;
}

function maxLeverageFromSpec(spec: OndoMarketSpec | undefined): number | null {
  if (!spec) return null;
  let max = 0;
  for (const bracket of spec.marginInfo ?? []) {
    const lev = safeFloat(bracket.maxLeverage);
    if (lev > max) max = lev;
  }
  if (max <= 0) max = safeFloat(spec.defaultLeverage);
  return max > 0 ? max : null;
}

function feeOrFallback(value: string | number | null | undefined, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  return safeFloat(value);
}

export function parseOndoPerpsMarkets(
  contracts: OndoContract[],
  specs: OndoMarketSpec[] = [],
): ParsedPerpsMarket[] {
  const specByMarket = new Map<string, OndoMarketSpec>();
  for (const spec of specs) specByMarket.set(spec.market, spec);

  const markets: ParsedPerpsMarket[] = [];
  for (const c of contracts) {
    // Skip disabled/delisted contracts — they report a $0 price and $0 OI, and
    // the markPx>0 gate in perps.ts would drop them anyway.
    if (c.disabled || !c.baseCurrency) continue;

    const markPx = safeFloat(c.lastPrice);
    const indexPx = safeFloat(c.indexPrice);
    const bid = safeFloat(c.bid);
    const ask = safeFloat(c.ask);
    const midPx = bid > 0 && ask > 0 ? (bid + ask) / 2 : markPx;
    const priceChange24h = safeFloat(c.priceChangePercent); // already a percent
    const prevDayPx = markPx > 0 && priceChange24h > -100 ? markPx / (1 + priceChange24h / 100) : 0;
    const premium = markPx > 0 && indexPx > 0 ? (markPx - indexPx) / indexPx : 0;

    const spec = specByMarket.get(c.market);

    markets.push({
      contract: `ondo-perps:${c.baseCurrency}`,
      venue: "ondo-perps",
      platform: "ondo-perps",
      // Ondo reports open interest directly in USD notional (openInterestUsd).
      openInterest: safeFloat(c.openInterestUsd),
      // quoteVolume is 24h volume in the quote currency (USD); usdVolume is the
      // rounded variant — prefer the precise quoteVolume.
      volume24h: safeFloat(c.quoteVolume) || safeFloat(c.usdVolume),
      markPx,
      oraclePx: indexPx,
      midPx,
      prevDayPx,
      priceChange24h,
      fundingRate: safeFloat(c.fundingRate),
      fundingIntervalHours: 1, // Ondo funds hourly (UI: funding interval "1h")
      premium,
      maxLeverage: maxLeverageFromSpec(spec),
      szDecimals: decimalsFromIncrement(spec?.baseIncrement),
      makerFeeRate: feeOrFallback(c.makerFee, ONDO_PERPS_MAKER_FEE),
      takerFeeRate: feeOrFallback(c.takerFee, ONDO_PERPS_TAKER_FEE),
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const ondoperpsAdapter: PlatformAdapter = {
  name: "ondo-perps",
  oiIsNotional: true,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const [contracts, specs] = await Promise.all([fetchOndoContracts(), fetchOndoMarketSpecs()]);
    if (contracts.length === 0) return [];
    return parseOndoPerpsMarkets(contracts, specs);
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    // Ondo exposes current + next funding on /contracts, but no public,
    // unauthenticated historical funding endpoint.
    return [];
  },
};
