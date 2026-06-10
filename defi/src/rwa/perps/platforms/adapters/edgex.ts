
import * as sdk from '@defillama/sdk'
const { runInPromisePool } = sdk.util;
import type { PlatformAdapter, FundingEntry, ParsedPerpsMarket } from "../types";
import { safeFloat, safeFetch } from "../types";

// edgeX — StarkEx-based perp DEX
// Docs: https://edgex-1.gitbook.io/edgeX-documentation/api
// RWA assets: ~22 (equities, ETFs, commodities)
// Margin: USDT | Oracle: multi-signer Stark price feed
export const EDGEX_MAKER_FEE = 0.00018;
export const EDGEX_TAKER_FEE = 0.00038;

const EDGEX_API = "https://pro.edgex.exchange/api/v1/public";
const EDGEX_MARKET_FETCH_CONCURRENCY = 2;
const EDGEX_REQUEST_DELAY_MS = 250;

// Commodity contracts that ARE RWAs but are flagged isStock=false on edgeX.
// Source: PDF API instructions — section 2 (edgeX) "Filtering for RWAs only".
const EDGEX_COMMODITY_NAMES = new Set<string>([
  "PAXGUSD",
  "XAUTUSD",
  "SILVERUSD",
  "COPPERUSD",
  "NATGASUSD",
  "CLUSD",
]);

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

interface EdgeXContract {
  contractId: string;
  contractName: string; // e.g. "TSLAUSD", "PAXGUSD"
  isStock?: boolean;
  enableTrade?: boolean;
  enableDisplay?: boolean;
  defaultTakerFeeRate?: string;
  defaultMakerFeeRate?: string;
  displayMaxLeverage?: string;
}

interface EdgeXMetaResponse {
  code: string; // "SUCCESS"
  data: {
    contractList: EdgeXContract[];
  };
}

interface EdgeXTicker {
  contractId: string;
  contractName: string;
  priceChange?: string;
  priceChangePercent?: string; // decimal — 0.025 = +2.5%
  size?: string;               // 24h base volume
  value?: string;              // 24h USD notional volume
  open?: string;
  close?: string;
  high?: string;
  low?: string;
  lastPrice?: string;
  indexPrice?: string;
  oraclePrice?: string;
  markPrice?: string;
  openInterest?: string;       // base-asset units
  fundingRate?: string;
}

interface EdgeXTickerResponse {
  code: string;
  data: EdgeXTicker[];
}

// Map of canonical contract id ("edgex:<NAME>") to numeric contractId, populated
// by fetchMarkets so fetchFundingHistory can look it up without re-fetching meta.
const CONTRACT_ID_BY_CONTRACT = new Map<string, string>();

interface EdgeXLatestFundingRate {
  contractId: string;
  fundingTime: string;                    // next settlement, ms
  fundingTimestamp: string;               // current snapshot time, ms
  fundingRate: string;                    // running (un-settled) rate
  isSettlement: boolean;
  previousFundingRate: string;            // last SETTLED rate
  previousFundingTimestamp: string;       // last SETTLED snapshot time, ms
  premiumIndex?: string;
  oraclePrice?: string;
  markPrice?: string;
  indexPrice?: string;
}

interface EdgeXLatestFundingResponse {
  code: string;
  data: EdgeXLatestFundingRate[];
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchEdgeXContracts(): Promise<EdgeXContract[]> {
  const data = await safeFetch<EdgeXMetaResponse>(
    `${EDGEX_API}/meta/getMetaData`,
    "edgeX meta",
  );
  return data?.data?.contractList ?? [];
}

async function fetchEdgeXTicker(contractId: string): Promise<EdgeXTicker | null> {
  const data = await safeFetch<EdgeXTickerResponse>(
    `${EDGEX_API}/quote/getTicker?contractId=${contractId}`,
    `edgeX ticker ${contractId}`,
  );
  return data?.data?.[0] ?? null;
}

async function fetchEdgeXLatestFundingRate(
  contractId: string,
): Promise<EdgeXLatestFundingRate | null> {
  const data = await safeFetch<EdgeXLatestFundingResponse>(
    `${EDGEX_API}/funding/getLatestFundingRate?contractId=${contractId}`,
    `edgeX latestFundingRate ${contractId}`,
  );
  return data?.data?.[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRwaContract(c: EdgeXContract): boolean {
  if (!c.enableDisplay || !c.enableTrade) return false;
  // Internal placeholder contracts are named like "TEMP*" — ignore them.
  if (c.contractName.startsWith("TEMP")) return false;
  if (c.isStock === true) return true;
  if (EDGEX_COMMODITY_NAMES.has(c.contractName)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseEdgeXMarket(
  c: EdgeXContract,
  t: EdgeXTicker,
  funding: EdgeXLatestFundingRate | null,
): ParsedPerpsMarket {
  const markPx = safeFloat(t.markPrice);
  const lastPx = safeFloat(t.lastPrice);
  const indexPx = safeFloat(t.indexPrice);
  const oraclePx = safeFloat(t.oraclePrice);
  const price = markPx || lastPx;

  // priceChangePercent comes back as a decimal (e.g. -0.002298 = -0.23%).
  const pct = safeFloat(t.priceChangePercent) * 100;

  // getTicker.fundingRate is actually the FORECAST for next settlement.
  // The UI shows the running (un-settled) rate which only getLatestFundingRate
  // exposes — fall back to ticker's value if the funding fetch failed.
  const runningFunding = funding
    ? safeFloat(funding.fundingRate)
    : safeFloat(t.fundingRate);

  return {
    contract: `edgex:${c.contractName}`,
    venue: "edgex",
    platform: "edgex",
    // openInterest from getTicker is in base-asset units; pipeline multiplies
    // by markPx for USD notional.
    openInterest: safeFloat(t.openInterest),
    volume24h: safeFloat(t.value),
    markPx: price,
    oraclePx: oraclePx || indexPx || price,
    midPx: price,
    prevDayPx: safeFloat(t.open),
    priceChange24h: pct,
    fundingRate: runningFunding,
    fundingIntervalHours: 4, // edgeX settles funding every 4h (fundingRateIntervalMin: 240)
    premium: funding ? safeFloat(funding.premiumIndex) : 0,
    maxLeverage: safeFloat(c.displayMaxLeverage),
    szDecimals: 0,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const edgexAdapter: PlatformAdapter = {
  name: "edgex",
  oiIsNotional: false, // OI is in base-asset units
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const contracts = await fetchEdgeXContracts();
    const rwaContracts = contracts.filter(isRwaContract);
    if (rwaContracts.length === 0) return [];

    const markets: ParsedPerpsMarket[] = [];
    CONTRACT_ID_BY_CONTRACT.clear();
    await runInPromisePool({
      items: rwaContracts,
      concurrency: EDGEX_MARKET_FETCH_CONCURRENCY,
      processor: async (c: EdgeXContract) => {
        const ticker = await fetchEdgeXTicker(c.contractId);
        await sleep(EDGEX_REQUEST_DELAY_MS);
        if (!ticker) return;

        const funding = await fetchEdgeXLatestFundingRate(c.contractId);
        await sleep(EDGEX_REQUEST_DELAY_MS);

        const market = parseEdgeXMarket(c, ticker, funding);
        CONTRACT_ID_BY_CONTRACT.set(market.contract, c.contractId);
        markets.push(market);
      },
    });

    return markets;
  },
  async fetchFundingHistory(
    market: ParsedPerpsMarket,
    startTime: number,
    endTime?: number,
  ): Promise<FundingEntry[]> {
    // edgeX has no public historical funding-rate endpoint — every variant of
    // /api/v1/public/funding/get*History returns 404, and getKline rejects
    // any FUNDING klineType. The supported public path is getLatestFundingRate,
    // which exposes only the last settled rate via previousFundingRate /
    // previousFundingTimestamp. Capture that one entry per cron cycle; the
    // pipeline's per-market timestamp dedup accumulates settlements over time.
    const contractId = CONTRACT_ID_BY_CONTRACT.get(market.contract);
    if (!contractId) return [];

    const latest = await fetchEdgeXLatestFundingRate(contractId);
    if (!latest) return [];

    const prevTsMs = safeFloat(latest.previousFundingTimestamp);
    if (prevTsMs <= 0) return [];

    const endMs = endTime ?? Date.now();
    if (prevTsMs < startTime || prevTsMs >= endMs) return [];

    const fundingRate = safeFloat(latest.previousFundingRate);
    return [
      {
        timestamp: Math.floor(prevTsMs / 1000),
        contract: market.contract,
        venue: market.venue,
        fundingRate,
        premium: safeFloat(latest.premiumIndex),
        openInterest: market.openInterest,
        fundingPayment: fundingRate * market.openInterest,
      },
    ];
  },
};
