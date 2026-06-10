import type { FundingEntry, ParsedPerpsMarket, PlatformAdapter } from "../types";
import { safeFetch, safeFloat } from "../types";

// Parcl v3 — Solana
// Docs: https://docs.parcl.co
// API: https://express-prod.parcl-api.com/v1 (the internal API used by app.parcl.co;
// requires an `Origin: https://app.parcl.co` header or all routes reject with 401).
// RWA assets: synthetic real-estate price perps tied to Parcl Labs metro indices.
// Margin/settlement: USDC | Oracle: Pyth feeding Parcl Labs price feeds.

const PARCL_API = "https://express-prod.parcl-api.com/v1";
const PARCL_ORIGIN = "https://app.parcl.co";
const PARCL_FETCH_INIT: RequestInit = { headers: { Origin: PARCL_ORIGIN } };

// Parcl publishes no numerical fee schedule — maker/taker rates live in each
// market's on-chain `MarketSettings` (see ParclFinance/parcl-v3-idl). We read
// them directly via Solana JSON-RPC `getMultipleAccounts` and decode the two
// u16 fields. Rates use BPS_EXPO = -4 per the SDK
// (ParclFinance/v3-sdk-ts/src/constants/preciseMath.ts), so the decimal value
// is `raw_u16 / 10_000` (e.g. raw 60 → 0.0060 = 0.60% taker fee).
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const PARCL_FEE_BPS_SCALE = 1e4;
// MarketSettings layout, byte offsets from the start of the account
// (after the 8-byte Anchor discriminator):
//      0..  8  discriminator
//      8.. 24  min_position_margin (u128)
//     24.. 40  skew_scale (u128)
//     40.. 56  max_side_size (u128)
//     56.. 64  max_liquidation_limit_accumulation_multiplier (u64)
//     64.. 72  max_seconds_in_liquidation_epoch (u64)
//     72.. 76  initial_margin_ratio (u32)
//     76.. 78  maker_fee_rate (u16)   ← read these 4 bytes via dataSlice
//     78.. 80  taker_fee_rate (u16)
const PARCL_FEE_SLICE_OFFSET = 76;
const PARCL_FEE_SLICE_LEN = 4;
// /v1/market/search returns this placeholder address for un-deployed markets
// (no on-chain account exists yet). Skip them when batching the RPC call.
const PARCL_NULL_ADDRESS = "11111111111111111111111111111111";
// getMultipleAccounts caps at 100 keys per request. Parcl has ~36 markets
// today; chunk defensively in case more are added.
const PARCL_RPC_CHUNK = 100;

// ---------------------------------------------------------------------------
// Raw API types
// ---------------------------------------------------------------------------

export interface ParclMarket {
  marketId: number;
  name: string;
  address: string;
  parclId: number | null;
  priceFeed: string;
  isNew: boolean;
  tradable: boolean;
  symbol: string;
  marketCategory: string | null;
  currency: string | null;
  metric: string | null;
  pythTokenId: string | null;
  marketPrice: number | null;
  indexPrice: number | null;
  fundingPerUnit: number | null;
  skew: number | null;
  marketSize: number | null;
  fundingRate: number | null;
  fundingVelocity: number | null;
  totalOpenInterest: number | null;
  volume: number | null;
  marketPriceTrend: number | null;
  indexPriceTrend: number | null;
  tags?: string[];
  longPct: number | null;
  shortPct: number | null;
}

interface ParclMarketSearchResponse {
  markets?: ParclMarket[];
}

export interface ParclMarketFees {
  makerFeeRate: number;
  takerFeeRate: number;
}

interface SolanaAccountInfo {
  data: [string, string] | null;
}
interface SolanaGetMultipleAccountsResp {
  result?: { value: (SolanaAccountInfo | null)[] };
}

// ---------------------------------------------------------------------------
// On-chain fee fetcher
// ---------------------------------------------------------------------------

/**
 * Read `maker_fee_rate` and `taker_fee_rate` from each deployed market's
 * on-chain MarketSettings. Returns a map keyed by market address. Markets
 * without a deployed account (placeholder address) are silently omitted —
 * the pipeline will fall back to Airtable metadata for those.
 *
 * Exported for the preview CLI / tests.
 */
export async function fetchParclMarketFees(
  addresses: string[],
): Promise<Map<string, ParclMarketFees>> {
  const out = new Map<string, ParclMarketFees>();
  const deployed = Array.from(
    new Set(addresses.filter((a) => a && a !== PARCL_NULL_ADDRESS)),
  );
  if (deployed.length === 0) return out;

  for (let i = 0; i < deployed.length; i += PARCL_RPC_CHUNK) {
    const chunk = deployed.slice(i, i + PARCL_RPC_CHUNK);
    const resp = await safeFetch<SolanaGetMultipleAccountsResp>(
      SOLANA_RPC_URL,
      "Parcl fetch on-chain fees",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [
            chunk,
            {
              encoding: "base64",
              commitment: "confirmed",
              dataSlice: {
                offset: PARCL_FEE_SLICE_OFFSET,
                length: PARCL_FEE_SLICE_LEN,
              },
            },
          ],
        }),
      },
    );
    const values = resp?.result?.value ?? [];
    chunk.forEach((addr, j) => {
      const acc = values[j];
      const b64 = acc?.data?.[0];
      if (!b64) return;
      const buf = Buffer.from(b64, "base64");
      if (buf.length < PARCL_FEE_SLICE_LEN) return;
      const maker = buf.readUInt16LE(0) / PARCL_FEE_BPS_SCALE;
      const taker = buf.readUInt16LE(2) / PARCL_FEE_BPS_SCALE;
      out.set(addr, { makerFeeRate: maker, takerFeeRate: taker });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseParclMarkets(
  rawMarkets: ParclMarket[],
  feesByAddress?: Map<string, ParclMarketFees>,
): ParsedPerpsMarket[] {
  const markets: ParsedPerpsMarket[] = [];

  for (const m of rawMarkets) {
    // Only ingest live real-estate markets. The /market/search payload also
    // contains placeholder rows for unlisted markets (no marketId, all metrics
    // null) and crypto reference tokens (ETH-USD, PRCL-USD) we don't want.
    if (m.marketCategory !== "real-estate") continue;
    if (m.marketPrice == null || m.totalOpenInterest == null) continue;

    const markPx = safeFloat(m.marketPrice);
    const oraclePx = safeFloat(m.indexPrice);
    // OI is in base-asset units (square feet for sales markets); the pipeline
    // multiplies by markPx to get USD notional (oiIsNotional=false).
    const openInterest = safeFloat(m.totalOpenInterest);

    const premium = oraclePx > 0 ? (markPx - oraclePx) / oraclePx : 0;

    const fees = feesByAddress?.get(m.address);

    markets.push({
      contract: `parcl:${m.symbol}`,
      venue: "parcl",
      platform: "parcl",
      openInterest,
      // /market/search and /market/{symbol} both currently return null for
      // volume on Parcl's API. Leave 0 until the venue populates it; this
      // forces estimatedProtocolFees24h to 0 even when fee rates are present.
      volume24h: 0,
      markPx,
      oraclePx,
      midPx: 0,
      prevDayPx: 0,
      priceChange24h: 0,
      fundingRate: safeFloat(m.fundingRate),
      // Parcl uses a continuous funding-velocity model (Synthetix/Perp-v2 style),
      // not fixed-period settlement — its rate isn't a per-interval fraction, so
      // mark it null to pass through unnormalized rather than assume 1h.
      fundingIntervalHours: null,
      premium,
      maxLeverage: null,
      szDecimals: 0,
      // Venue-sourced fee rates from on-chain MarketSettings. `undefined` for
      // un-deployed markets lets perps.ts fall back to Airtable metadata.
      makerFeeRate: fees?.makerFeeRate,
      takerFeeRate: fees?.takerFeeRate,
    });
  }

  return markets;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchParclMarkets(): Promise<ParclMarket[]> {
  const data = await safeFetch<ParclMarketSearchResponse>(
    `${PARCL_API}/market/search?window=1d`,
    "Parcl market search",
    PARCL_FETCH_INIT,
  );
  return data?.markets ?? [];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const parclAdapter: PlatformAdapter = {
  name: "parcl",
  oiIsNotional: false,
  async fetchMarkets(): Promise<ParsedPerpsMarket[]> {
    const raw = await fetchParclMarkets();
    if (raw.length === 0) return [];
    // Pre-filter to addresses we'll actually emit so we don't waste an RPC
    // slot on rows the parser would discard.
    const candidateAddrs = raw
      .filter(
        (m) =>
          m.marketCategory === "real-estate" &&
          m.marketPrice != null &&
          m.totalOpenInterest != null,
      )
      .map((m) => m.address);
    const fees = await fetchParclMarketFees(candidateAddrs);
    return parseParclMarkets(raw, fees);
  },
  async fetchFundingHistory(): Promise<FundingEntry[]> {
    // Parcl's market-time-series endpoint is currently unpopulated and there's
    // no documented funding-history route. Skip.
    return [];
  },
};
