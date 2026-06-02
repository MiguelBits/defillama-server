import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFloat, safeFetch, pctChange } from "../types";

// Aster — Binance USD-M-style perp DEX on BNB Chain.
// Docs: https://docs.asterdex.com/
// RWA assets are tagged in `underlyingSubType`: STOCK | HK_STOCK | RWA | ETF.
// Margin: USDT/USD1 ($1-pegged) | Funding: 8h cadence.

export const ASTER_MAKER_FEE = 0.0002;
export const ASTER_TAKER_FEE = 0.0005;

const ASTER_API = "https://fapi.asterdex.com/fapi/v1";
const RWA_TAGS = new Set(["STOCK", "HK_STOCK", "RWA", "ETF"]);

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

interface AsterSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  contractType: string;
  underlyingType: string;
  underlyingSubType?: string[];
  pricePrecision: number;
  quantityPrecision: number;
}

interface AsterExchangeInfo {
  symbols: AsterSymbol[];
}

interface AsterTicker {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  priceChange: string;
  priceChangePercent: string;
  quoteVolume: string;
  volume: string;
}

interface AsterPremiumIndex {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

interface AsterOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

interface AsterFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

const isRwaSymbol = (s: AsterSymbol): boolean => {
  if (s.status !== "TRADING") return false;
  const sub = s.underlyingSubType ?? [];
  return sub.some((t) => RWA_TAGS.has(t));
};

async function fetchAsterRwaSymbols(): Promise<AsterSymbol[]> {
  const data = await safeFetch<AsterExchangeInfo>(`${ASTER_API}/exchangeInfo`, "Aster exchangeInfo");
  return (data?.symbols ?? []).filter(isRwaSymbol);
}

async function fetchAsterTickers(): Promise<Map<string, AsterTicker>> {
  const data = await safeFetch<AsterTicker[]>(`${ASTER_API}/ticker/24hr`, "Aster ticker/24hr");
  const map = new Map<string, AsterTicker>();
  for (const t of data ?? []) map.set(t.symbol, t);
  return map;
}

async function fetchAsterPremiumIndex(): Promise<Map<string, AsterPremiumIndex>> {
  const data = await safeFetch<AsterPremiumIndex[]>(`${ASTER_API}/premiumIndex`, "Aster premiumIndex");
  const map = new Map<string, AsterPremiumIndex>();
  for (const p of data ?? []) map.set(p.symbol, p);
  return map;
}

// /openInterest is per-symbol only — no bulk endpoint.
async function fetchAsterOpenInterest(symbol: string): Promise<number> {
  const data = await safeFetch<AsterOpenInterest>(
    `${ASTER_API}/openInterest?symbol=${encodeURIComponent(symbol)}`,
    `Aster openInterest ${symbol}`,
  );
  return safeFloat(data?.openInterest);
}

// Bulk-parallel OI fetch with bounded concurrency (Aster shares Binance's 2400/min weight).
async function fetchAsterOpenInterests(symbols: string[], concurrency = 5): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const queue = symbols.slice();
  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const sym = queue.shift();
          if (!sym) break;
          map.set(sym, await fetchAsterOpenInterest(sym));
        }
      })(),
    );
  }
  await Promise.all(workers);
  return map;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseAsterMarkets(
  symbols: AsterSymbol[],
  tickers: Map<string, AsterTicker>,
  premiums: Map<string, AsterPremiumIndex>,
  openInterests: Map<string, number>,
): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];
  for (const s of symbols) {
    const ticker = tickers.get(s.symbol);
    const premium = premiums.get(s.symbol);
    const oi = openInterests.get(s.symbol) ?? 0;

    const markPx = safeFloat(premium?.markPrice) || safeFloat(ticker?.lastPrice);
    const indexPx = safeFloat(premium?.indexPrice);
    const lastPx = safeFloat(ticker?.lastPrice);
    const openPx = safeFloat(ticker?.openPrice);
    // Premium = (mark − index) / index, expressed as a decimal to match the
    // ParsedPerpsMarket convention (Dashboard.tsx multiplies by 100 at render).
    const premiumDecimal = markPx > 0 && indexPx > 0 ? (markPx - indexPx) / indexPx : 0;

    markets.push({
      contract: `aster:${s.baseAsset}`,
      venue: "aster",
      platform: "aster",
      // Base-asset units; pipeline multiplies by markPx for USD notional.
      openInterest: oi,
      volume24h: safeFloat(ticker?.quoteVolume),
      markPx,
      oraclePx: indexPx,
      midPx: lastPx,
      prevDayPx: openPx,
      priceChange24h: pctChange(lastPx, openPx),
      fundingRate: safeFloat(premium?.lastFundingRate),
      premium: premiumDecimal,
      // Aster's /leverageBracket is auth-gated, and `requiredMarginPercent` on
      // /exchangeInfo is 5% across all symbols (BTC = AAPL = XAU = …) so it's
      // a tier-1 floor, not a per-market max-lev signal. No public derivation
      // available — emit null so the dashboard can distinguish "unknown" from
      // a real 0 rather than show a misleading number.
      maxLeverage: null,
      szDecimals: safeFloat(s.quantityPrecision),
    });
  }
  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const asterAdapter: PlatformAdapter = {
  name: "aster",
  oiIsNotional: false, // OI is in base-asset units
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const symbols = await fetchAsterRwaSymbols();
    if (symbols.length === 0) return [];

    const [tickers, premiums, openInterests] = await Promise.all([
      fetchAsterTickers(),
      fetchAsterPremiumIndex(),
      fetchAsterOpenInterests(symbols.map((s) => s.symbol)),
    ]);

    return parseAsterMarkets(symbols, tickers, premiums, openInterests);
  },
  async fetchFundingHistory(market, startTime, endTime): Promise<FundingEntry[]> {
    // perps.ts passes startTime/endTime in milliseconds; Aster speaks ms too.
    const start = startTime;
    const end = endTime ?? Date.now();
    if (start >= end) return [];

    // Aster funds every 8h. Cap at 1000 (Aster's max for /fundingRate limit).
    const periods = Math.ceil((end - start) / (8 * 3600 * 1000));
    const limit = Math.min(Math.max(periods + 2, 2), 1000);

    // baseAsset stored in contract id; Aster's symbol is `<base>USDT` for RWA markets.
    const baseAsset = market.contract.replace(/^aster:/, "");
    const symbol = `${baseAsset}USDT`;

    const url =
      `${ASTER_API}/fundingRate` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&startTime=${start}` +
      `&endTime=${end}` +
      `&limit=${limit}`;
    const raw = await safeFetch<AsterFundingRate[]>(url, `Aster fundingRate ${symbol}`);
    if (!raw) return [];

    const entries: FundingEntry[] = [];
    for (const r of raw) {
      const ts = Math.floor(r.fundingTime / 1000);
      const startSec = Math.floor(start / 1000);
      const endSec = Math.floor(end / 1000);
      if (ts < startSec || ts >= endSec) continue;
      const fundingRate = safeFloat(r.fundingRate);
      entries.push({
        timestamp: ts,
        contract: market.contract,
        venue: market.venue,
        fundingRate,
        premium: 0,
        openInterest: market.openInterest,
        fundingPayment: fundingRate * market.openInterest,
      });
    }
    return entries;
  },
};
