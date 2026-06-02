import type { FundingEntry, ParsedPerpsMarket, PlatformAdapter } from "../types";
import { safeFetch, safeFloat } from "../types";

// Variational Omni - Arbitrum
// Docs: https://docs.variational.io/for-developers/api
// API: https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats
// RWA assets currently exposed on the public stats endpoint are commodities
// and tokenized precious metals. The endpoint does not expose asset classes, so
// keep a conservative allowlist and avoid ingesting all crypto listings.

export const VARIATIONAL_MAKER_FEE = 0;
export const VARIATIONAL_TAKER_FEE = 0;
export const VARIATIONAL_MAX_LEVERAGE = 50;

const VARIATIONAL_STATS_API = "https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats";
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const RWA_TICKERS = new Set(["CL", "COPPER", "PAXG", "XAG", "XAU", "XAUT"]);

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface VariationalListing {
  ticker: string;
  name?: string;
  mark_price?: string | number;
  volume_24h?: string | number;
  open_interest?: {
    long_open_interest?: string | number;
    short_open_interest?: string | number;
  };
  funding_rate?: string | number;
  funding_interval_s?: number;
  base_spread_bps?: string | number;
  quotes?: {
    updated_at?: string;
    base?: VariationalQuote;
    size_1k?: VariationalQuote;
    size_100k?: VariationalQuote;
    size_1m?: VariationalQuote;
  };
}

interface VariationalQuote {
  bid?: string | number;
  ask?: string | number;
}

interface VariationalStatsResponse {
  listings?: VariationalListing[];
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchVariationalStats(): Promise<VariationalListing[]> {
  const data = await safeFetch<VariationalStatsResponse>(VARIATIONAL_STATS_API, "Variational stats");
  return data?.listings ?? [];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function midFromQuote(quote: VariationalQuote | undefined, fallback: number): number {
  const bid = safeFloat(quote?.bid);
  const ask = safeFloat(quote?.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return fallback;
}

function annualizedFundingToPeriod(fundingRate: string | number | undefined, intervalSeconds: number | undefined): number {
  const annualized = safeFloat(fundingRate);
  if (!annualized || !intervalSeconds || intervalSeconds <= 0) return 0;
  return annualized / (SECONDS_PER_YEAR / intervalSeconds);
}

export function parseVariationalMarkets(listings: VariationalListing[]): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];

  for (const listing of listings) {
    const ticker = String(listing.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!RWA_TICKERS.has(ticker)) continue;

    const markPx = safeFloat(listing.mark_price);
    const midPx = midFromQuote(listing.quotes?.base ?? listing.quotes?.size_1k, markPx);
    // Omni's UI reports open interest as 2x the long+short values from this
    // endpoint, reflecting both trader and OLP legs.
    const openInterest =
      2 *
      (safeFloat(listing.open_interest?.long_open_interest) + safeFloat(listing.open_interest?.short_open_interest));

    markets.push({
      contract: `variational:${ticker}`,
      venue: "variational",
      platform: "variational",
      openInterest,
      volume24h: safeFloat(listing.volume_24h),
      markPx,
      // The public stats endpoint exposes mark price but not Omni's index price.
      oraclePx: 0,
      midPx,
      prevDayPx: 0,
      priceChange24h: 0,
      fundingRate: annualizedFundingToPeriod(listing.funding_rate, listing.funding_interval_s),
      premium: 0,
      maxLeverage: VARIATIONAL_MAX_LEVERAGE,
      szDecimals: 0,
      makerFeeRate: VARIATIONAL_MAKER_FEE,
      takerFeeRate: VARIATIONAL_TAKER_FEE,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const variationalAdapter: PlatformAdapter = {
  name: "variational",
  oiIsNotional: true,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const listings = await fetchVariationalStats();
    if (listings.length === 0) return [];
    return parseVariationalMarkets(listings);
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    return [];
  },
};
