/**
 * Refill-optimised fork of atvl.ts.
 *
 * Splits the monolithic main() into:
 *   prepareAtvlContext()    — fetch CSV + build maps (call ONCE)
 *   runAtvlForTimestamp()   — per-day work (call N times in parallel)
 *
 * This avoids hundreds of redundant Airtable fetches, CSV parses,
 * and constant-data recomputations that the original atvl() repeats
 * on every invocation.
 */

import { getAllItemsAtTimeS, getLatestProtocolItems, getPGConnection, initializeTVLCacheDB } from "../../src/api2/db";
import { dailyRawTokensTvl, hourlyRawTokensTvl } from "../utils/getLastRecord";
import { excludedTvlKeys } from "../../l2/constants";
import BigNumber from "bignumber.js";
import { coins } from "@defillama/sdk";
import { QueryTypes } from "sequelize";
import { getCsvData } from "./spreadsheet";

import * as sdk from "@defillama/sdk";
const { runInPromisePool } = sdk.util;
const { cachedFetch } = sdk.cache;
import { fetchSupplies } from "../../l2/utils";
import { getChainDisplayName, getChainIdFromDisplayName } from "../utils/normalizeChain";

import { getCurrentUnixTimestamp, getTimestampAtStartOfDay, getTimestampAtStartOfDayUTC } from "../utils/date";
import { storeHistorical, storeMetadata } from "./historical";
import { initPG, fetchLatestAggregateTotals } from "./db";
import { fetchEvm, fetchSolana, fetchProvenance, fetchStellar, type WalletEntry } from "./balances";
import {
  excludedProtocolCategories,
  protocolIdMap,
  categoryMap,
  unsupportedChains,
  ONCHAIN_MCAP_EQUALS_ACTIVE_PLATFORMS,
} from "./constants";
import { RWA_KEY_MAP } from "./metadataConstants";
import {
  createAirtableHeaderToCanonicalKeyMapper,
  fetchBurnAddresses,
  formatNumAsNumber,
  normalizeRwaMetadataForApiInPlace,
  sortTokensByChain,
  toFiniteNumberOrNull,
  toFixedNumber,
} from "./utils";
import { sendThrottledRwaAlert } from "./alerting";

// ── Internal helpers (copied from atvl.ts — identical logic) ────────

async function getAggregateRawTvls(rwaTokens: { [chain: string]: string[] }, timestamp: number) {
  await initializeTVLCacheDB();

  const rawTvls =
    timestamp == 0
      ? await getLatestProtocolItems(hourlyRawTokensTvl, {
          filterLast24Hours: true,
        })
      : await getAllItemsAtTimeS(dailyRawTokensTvl, timestamp);

  let aggregateRawTvls: { [pk: string]: { [id: string]: BigNumber } } = {};
  rawTvls.forEach((protocol: any) => {
    const category = categoryMap[protocol.id];
    if (excludedProtocolCategories.includes(category)) return;
    Object.keys(protocol.data).forEach((chain: string) => {
      if (excludedTvlKeys.includes(chain)) return;
      if (!rwaTokens[chain]) return;

      Object.keys(protocol.data[chain]).forEach((pk: string) => {
        if (!rwaTokens[chain].includes(pk)) return;
        if (!aggregateRawTvls[pk]) aggregateRawTvls[pk] = {};
        aggregateRawTvls[pk][protocol.id] = BigNumber(protocol.data[chain][pk]);
      });
    });
  });

  return aggregateRawTvls;
}

async function getAggregateRawTvlsForRwaTokens(rwaTokens: { [chain: string]: string[] }, timestamp: number) {
  if (timestamp == 0) return getAggregateRawTvls(rwaTokens, timestamp);

  const tokenPairs = Object.entries(rwaTokens)
    .filter(([chain]) => !excludedTvlKeys.includes(chain))
    .flatMap(([chain, pks]) => [...new Set(pks)].map((pk) => ({ chain, pk })));

  if (tokenPairs.length === 0) return {};

  await initializeTVLCacheDB();
  const sequelize = getPGConnection();
  if (!sequelize) throw new Error("TVL cache DB connection is not initialized");

  const replacements: { [key: string]: any } = {
    timeS: new Date(timestamp * 1000).toISOString().slice(0, 10),
  };
  const values = tokenPairs
    .map(({ chain, pk }, i) => {
      replacements[`chain${i}`] = chain;
      replacements[`pk${i}`] = pk;
      return `(:chain${i}, :pk${i})`;
    })
    .join(", ");

  const excludedProtocolIds = Object.keys(categoryMap).filter((id) =>
    excludedProtocolCategories.includes(categoryMap[id])
  );
  const excludedClause = excludedProtocolIds.length ? `AND t.id NOT IN (:excludedProtocolIds)` : "";
  if (excludedProtocolIds.length) replacements.excludedProtocolIds = excludedProtocolIds;

  const rows = (await sequelize.query(
    `
      WITH pairs(chain, pk) AS (VALUES ${values})
      SELECT
        t.id,
        p.pk,
        t."data"::jsonb #>> ARRAY[p.chain, p.pk] AS amount
      FROM "dailyRawTokensTvl" t
      JOIN pairs p
        ON (t."data"::jsonb ? p.chain)
       AND ((t."data"::jsonb -> p.chain) ? p.pk)
      WHERE t."timeS" = :timeS
        ${excludedClause}
      ORDER BY t.id
    `,
    { replacements, type: QueryTypes.SELECT }
  )) as { id: string; pk: string; amount: string | null }[];

  const aggregateRawTvls: { [pk: string]: { [id: string]: BigNumber } } = {};
  rows.forEach(({ id, pk, amount }) => {
    if (amount == null) return;
    if (!aggregateRawTvls[pk]) aggregateRawTvls[pk] = {};
    aggregateRawTvls[pk][id] = BigNumber(amount);
  });

  return aggregateRawTvls;
}

// Missing keys mean fetch failed; 0 entries are real-zero contracts.
async function getTotalSupplies(tokensSortedByChain: { [chain: string]: string[] }, timestamp: number) {
  const totalSupplies: { [token: string]: number } = {};

  await runInPromisePool({
    items: Object.keys(tokensSortedByChain),
    concurrency: 5,
    processor: async (chain: string) => {
      const tokens: string[] = [];
      tokensSortedByChain[chain].forEach((token: string) => {
        tokens.push(token.substring(token.indexOf(":") + 1));
      });

      try {
        const res = await fetchSupplies(chain, tokens, timestamp == 0 ? undefined : timestamp);
        Object.keys(res).forEach((token: string) => {
          totalSupplies[token] = res[token];
        });
      } catch (e) {
        if (process.env.DEBUG_ENABLED) console.error(`Failed to fetch supplies for ${chain}: ${e}`);
      }
    },
  });

  return totalSupplies;
}

async function fetchHolderBalances(
  timestamp: number,
  finalData: { [protocol: string]: { [key: string]: any } },
  tokenToProjectMap: { [token: string]: string },
  field: string,
  addBurnAddresses: boolean = false,
  addressesToSkip?: { [id: string]: { [chainLabel: string]: Set<string> } }
) {
  const walletsByChain: { [chain: string]: { [wallet: string]: WalletEntry[] } } = {};
  Object.keys(finalData).forEach((id: string) => {
    const chains = finalData[id]?.[field];
    if (!chains || !Object.keys(chains).length) return;
    Object.keys(chains).forEach((chain: string) => {
      const wallets: string[] = chains[chain];
      const chainRaw = getChainIdFromDisplayName(chain);
      const assets = finalData[id]?.contracts?.[chain];

      if (!assets) return;
      if (!(chainRaw in walletsByChain)) walletsByChain[chainRaw] = {};

      const skipSet = addressesToSkip?.[id]?.[chain];
      const allWallets = addBurnAddresses ? [...wallets, ...fetchBurnAddresses(chainRaw)] : wallets;
      allWallets.forEach((address: string) => {
        if (skipSet?.has(address)) return;
        if (!(address in walletsByChain[chainRaw])) walletsByChain[chainRaw][address] = [];
        walletsByChain[chainRaw][address].push({ id, assets });
      });
    });
  });

  const walletsSortedByChain: { [chain: string]: WalletEntry[] } = {};
  Object.keys(walletsByChain).forEach((chain: string) => {
    const byWallet = walletsByChain[chain];
    walletsSortedByChain[chain] = Object.entries(byWallet).map(([wallet, entries]) => ({
      id: wallet,
      assets: [...new Set(entries.flatMap((e) => e.assets))],
    }));
  });

  const amounts: { [id: string]: { [chain: string]: BigNumber } } = {};
  await runInPromisePool({
    items: Object.keys(walletsSortedByChain),
    concurrency: 1,
    processor: async (chain: any) => {
      try {
        if (chain == "solana") await fetchSolana(timestamp, walletsSortedByChain[chain], tokenToProjectMap, amounts);
        else if (chain == "provenance")
          await fetchProvenance(timestamp, walletsSortedByChain[chain], tokenToProjectMap, amounts);
        else if (chain == "stellar")
          await fetchStellar(timestamp, walletsSortedByChain[chain], tokenToProjectMap, amounts);
        else if (unsupportedChains.includes(chain)) return;
        else await fetchEvm(timestamp, chain, walletsSortedByChain[chain], tokenToProjectMap, amounts);
      } catch (e) {
        if (process.env.DEBUG_ENABLED) console.error(`Failed to fetch balances for ${chain}`);
      }
    },
  });

  return amounts;
}

async function getExcludedBalances(
  timestamp: number,
  finalData: { [protocol: string]: { [key: string]: any } },
  tokenToProjectMap: { [token: string]: string }
) {
  const excludedAmounts = await fetchHolderBalances(timestamp, finalData, tokenToProjectMap, "holdersToRemove", true);

  return excludedAmounts;
}

// FX rates: pre-built day-aligned map for O(1) lookup. Missing days are
// forward-filled with the most recent prior rate so any timestamp inside the
// FX range resolves without a search.
type FxRateMap = {
  byDay: Map<number, Record<string, number>>;
  latest: Record<string, number>;
  firstDay: number;
  lastDay: number;
};
const SECONDS_IN_DAY = 86400;
let _fxRateMapPromise: Promise<FxRateMap> | null = null;

type StablecoinChainMcap = { [chain: string]: number };
type StablecoinMcapData = {
  symbol: string | null;
  chainMcap: StablecoinChainMcap;
};

function getFxRateMap(): Promise<FxRateMap> {
  if (!_fxRateMapPromise) {
    _fxRateMapPromise = cachedFetch({
      key: "stablecoin-fx-rates-full",
      endpoint: "https://llama-stablecoins-data.s3.eu-central-1.amazonaws.com/rates/full",
    })
      .then((data: any) => {
        if (!Array.isArray(data) || !data.length) throw new Error("FX rates response unavailable");
        const sorted = data.slice().sort((a: any, b: any) => a.date - b.date);
        const sourceByDay = new Map<number, Record<string, number>>();
        for (const entry of sorted) {
          sourceByDay.set(getTimestampAtStartOfDayUTC(entry.date), entry.rates);
        }
        const firstDay = getTimestampAtStartOfDayUTC(sorted[0].date);
        const lastDay = getTimestampAtStartOfDayUTC(sorted[sorted.length - 1].date);
        const byDay = new Map<number, Record<string, number>>();
        let prev: Record<string, number> | null = null;
        for (let day = firstDay; day <= lastDay; day += SECONDS_IN_DAY) {
          const here = sourceByDay.get(day);
          if (here) prev = here;
          if (prev) byDay.set(day, prev);
        }
        return { byDay, latest: sorted[sorted.length - 1].rates, firstDay, lastDay };
      })
      .catch((e) => {
        _fxRateMapPromise = null;
        throw e;
      });
  }
  return _fxRateMapPromise;
}

function pegTypeToCurrency(pegType: string): string | null {
  if (typeof pegType !== "string" || !pegType.startsWith("pegged")) return null;
  return pegType.slice("pegged".length) || null;
}

// Latest rate when timestamp == 0; otherwise rate at-or-before the timestamp.
function lookupFxRate(fx: FxRateMap, currency: string, timestamp: number): number | null {
  let rates: Record<string, number> | undefined;
  if (timestamp === 0) {
    rates = fx.latest;
  } else {
    const day = getTimestampAtStartOfDayUTC(timestamp);
    if (day < fx.firstDay) return null;
    rates = fx.byDay.get(day <= fx.lastDay ? day : fx.lastDay);
  }
  const r = rates?.[currency];
  return typeof r === "number" && r > 0 ? r : null;
}

async function fetchStablecoins(
  timestamp: number,
  relevantGeckoIds?: Set<string>
): Promise<{ [gecko_id: string]: StablecoinMcapData }> {
  const validStablecoinIds: string[] = [];
  const { peggedAssets } = await cachedFetch({
    key: "stablecoin-symbols",
    endpoint: "https://stablecoins.llama.fi/stablecoins",
  });

  // /stablecoins multiplies raw circulating by the asset's USD price server-side
  // (peggedassets-server api2/cron-task/getStableCoins.ts), so chainCirculating
  // values are already USD-equivalent regardless of pegType. No FX conversion here.
  const data: { [gecko_id: string]: StablecoinMcapData } = {};
  const seenStablecoinIds = new Set<string>();
  const idToGeckoId: { [id: string]: string } = {};
  const idToSymbol: { [id: string]: string | null } = {};
  peggedAssets.forEach((coin: any) => {
    const { id, chainCirculating, gecko_id, pegType, symbol } = coin;
    if (!chainCirculating || !gecko_id || !pegType) return;
    idToGeckoId[id] = gecko_id;
    idToSymbol[id] = typeof symbol === "string" && symbol ? symbol : null;
    const chainMcap: StablecoinChainMcap = {};
    let hasData = false;
    Object.keys(chainCirculating).forEach((chain: string) => {
      const circulating = chainCirculating[chain].current;
      if (!circulating) return;
      const mcap = circulating[pegType];
      if (!mcap) return;
      hasData = true;
      chainMcap[chain] = toFixedNumber(mcap, 0);
    });
    if (!hasData) return;
    data[gecko_id] = { symbol: idToSymbol[id], chainMcap };
    if (!seenStablecoinIds.has(id)) {
      validStablecoinIds.push(id);
      seenStablecoinIds.add(id);
    }
  });

  if (timestamp != 0) {
    const idsToFetch = relevantGeckoIds
      ? validStablecoinIds.filter((id) => relevantGeckoIds.has(idToGeckoId[id]))
      : validStablecoinIds;
    return await fetchHistoricalStablecoins(timestamp, idsToFetch, idToSymbol);
  }

  return data;
}

async function fetchHistoricalStablecoins(
  timestamp: number,
  validStablecoinIds: string[],
  idToSymbol: { [id: string]: string | null }
): Promise<{ [gecko_id: string]: StablecoinMcapData }> {
  const data: { [gecko_id: string]: StablecoinMcapData } = {};
  if (!process.env.INTERNAL_API_KEY) throw new Error("INTERNAL_API_KEY is not set");

  // /stablecoin/{id} chainBalances are denominated in the asset's peg currency
  // (e.g. peggedRUB rows store RUB, not USD — unlike /stablecoins which has
  // already been multiplied by USD price). Divide by the FX rate at the
  // requested timestamp so downstream RWA mcap is dollar-denominated.
  // If the global rates payload is unavailable (e.g. S3 hiccup), fall through
  // with a null map — non-USD pegs hit the per-asset skip below, USD pegs
  // are unaffected — rather than failing the whole ATVL run.
  let fxRateMap: FxRateMap | null = null;
  try {
    fxRateMap = await getFxRateMap();
  } catch (e) {
    console.error("[atvl] FX rates unavailable, skipping non-USD peg overrides", e);
  }

  await runInPromisePool({
    items: validStablecoinIds,
    concurrency: 5,
    processor: async (id: string) => {
      const apiData = await cachedFetch({
        key: `stablecoin-historical-${id}`,
        endpoint: `https://pro-api.llama.fi/${process.env.INTERNAL_API_KEY}/stablecoins/stablecoin/${id}`,
      });
      if (!apiData) return;

      const { chainBalances, gecko_id, pegType } = apiData;
      if (!chainBalances || !gecko_id || !pegType) return;

      let fxDivisor = 1;
      if (pegType && pegType !== "peggedUSD") {
        const currency = pegTypeToCurrency(pegType);
        const rate = currency && fxRateMap ? lookupFxRate(fxRateMap, currency, timestamp) : null;
        if (!rate) {
          // No FX rate for this peg/timestamp — skip the override entirely so
          // the on-chain path (supply × USD price) computes mcap downstream.
          return;
        }
        fxDivisor = rate;
      }

      const chainMcap: StablecoinChainMcap = {};
      let hasData = false;
      Object.keys(chainBalances).forEach((chain: string) => {
        const timeseries = chainBalances[chain].tokens;
        const entry = timeseries.find((t: any) => t.date == timestamp);
        if (!entry) return;
        const circulating = entry.circulating;
        if (!circulating) return;
        const mcap = circulating[pegType];
        if (!mcap) return;
        hasData = true;
        chainMcap[chain] = toFixedNumber(mcap / fxDivisor, 0);
      });
      if (hasData) data[gecko_id] = { symbol: idToSymbol[id] ?? null, chainMcap };
    },
  });

  return data;
}

function normalizeSymbolForMatch(value: any): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function stablecoinSymbolMatchesRwa(symbol: string | null, rwa: any): boolean {
  const normalizedSymbol = normalizeSymbolForMatch(symbol);
  if (!normalizedSymbol) return false;

  return [rwa?.ticker, rwa?.canonicalMarketId]
    .map(normalizeSymbolForMatch)
    .some((candidate) => candidate && candidate === normalizedSymbol);
}

function getStablecoinOverrideRwaId(
  cgId: string,
  stablecoinData: StablecoinMcapData,
  coingeckoIdToRwaIds: { [cgId: string]: string[] },
  finalData: { [protocol: string]: { [key: string]: any } }
): string | null {
  const candidates = coingeckoIdToRwaIds[cgId] ?? [];
  if (candidates.length === 0) return null;

  const matchingIds = stablecoinData.symbol
    ? candidates.filter((id) => stablecoinSymbolMatchesRwa(stablecoinData.symbol, finalData[id]))
    : candidates;

  if (matchingIds.length === 1) return matchingIds[0];

  if (process.env.DEBUG_ENABLED) {
    console.error(
      `[atvl] skipping stablecoin override for gecko_id=${cgId} symbol=${
        stablecoinData.symbol ?? "unknown"
      } candidates=${candidates.join(",")}`
    );
  }
  return null;
}

function getActiveTvls(
  assetPrices: any,
  tokenToProjectMap: any,
  finalData: any,
  protocolIdMap: any,
  aggregateRawTvls: any,
  projectIdsMap: { [rwaId: string]: string }
) {
  Object.keys(aggregateRawTvls).forEach((pk: string) => {
    if (!assetPrices[pk]) {
      if (process.env.DEBUG_ENABLED) console.error(`No price for ${pk}`);
      return;
    }

    const { price, decimals } = assetPrices[pk];
    const amounts = aggregateRawTvls[pk];

    Object.keys(amounts).forEach((amountId: string) => {
      const amount = amounts[amountId];
      const aum = amount.times(price).div(10 ** decimals);

      if (aum.isLessThan(10)) return;
      const rwaId = tokenToProjectMap[pk];
      const projectId = projectIdsMap[rwaId];

      if (Array.isArray(projectId) ? projectId.includes(amountId) : amountId == projectId) return;
      if (Array.isArray(projectId) ? projectId.includes(`${amountId}-treasury`) : `${amountId}-treasury` == projectId)
        return;
      if (
        Array.isArray(projectId)
          ? projectId.map((p: string) => `${p}-treasury`).includes(amountId)
          : amountId == `${projectId}-treasury`
      )
        return;

      try {
        const projectName = protocolIdMap[amountId];
        if (!projectName) return;

        if (!finalData[rwaId][RWA_KEY_MAP.defiActive]) finalData[rwaId][RWA_KEY_MAP.defiActive] = {};
        const chain = pk.substring(0, pk.indexOf(":"));
        const chainDisplayName = getChainDisplayName(chain, true);
        if (!finalData[rwaId][RWA_KEY_MAP.defiActive][chainDisplayName])
          finalData[rwaId][RWA_KEY_MAP.defiActive][chainDisplayName] = {};
        finalData[rwaId][RWA_KEY_MAP.defiActive][chainDisplayName][projectName] = toFixedNumber(aum, 0);
      } catch (e) {
        if (process.env.DEBUG_ENABLED) console.error(`Malformed ${RWA_KEY_MAP.defiActive} for ${rwaId}: ${e}`);
      }
    });
  });
}

// Returns stablecoinsData[cgId] filtered to only the chains that exist
// in finalData[rwaId].contracts. Without this, the stablecoins-API multi-chain
// map fans out onto IDs that share a Coingecko ID but don't live on every
// chain that the canonical cgId asset does (the Ondo USDY phantom bug).
function getOnChainTvlAndActiveMcaps(
  assetPrices: any,
  tokenToProjectMap: any,
  finalData: any,
  coingeckoIdToRwaIds: { [cgId: string]: string[] },
  stablecoinsData: { [gecko_id: string]: StablecoinMcapData },
  totalSupplies: any,
  excludedAmounts: any,
  coingeckoPrices: { [cgKey: string]: { price: number } } = {}
) {
  // Multiple token deployments on the same chain share a price, so supply is summed.
  const setTotalSupply = (rwaId: string, chainDisplayName: string, supplyDelta: number) => {
    if (!finalData[rwaId]) return;
    if (!finalData[rwaId][RWA_KEY_MAP.totalSupply]) finalData[rwaId][RWA_KEY_MAP.totalSupply] = {};
    const prev = Number(finalData[rwaId][RWA_KEY_MAP.totalSupply][chainDisplayName]) || 0;
    finalData[rwaId][RWA_KEY_MAP.totalSupply][chainDisplayName] = toFixedNumber(prev + supplyDelta, 6);
  };

  // Stablecoins-API is the priority source for tracked stablecoins (captures
  // bridged / wrapped supply that raw totalSupply() can miss). Pass through all
  // chains from the stablecoins API — bridged/wrapped chains that aren't in the
  // RWA spreadsheet's contracts list still count toward onChainMcap so it
  // matches /stablecoin totals. totalSupply for those chains is derived in the
  // backfill loop below so mcap = supply × price stays consistent.
  const stablecoinOverrideRwaIds: { [cgId: string]: string } = {};
  const stablecoinOverrideChainMcaps: { [cgId: string]: StablecoinChainMcap } = {};
  Object.keys(stablecoinsData).forEach((cgId: string) => {
    const rwaId = getStablecoinOverrideRwaId(cgId, stablecoinsData[cgId], coingeckoIdToRwaIds, finalData);
    if (!rwaId || !finalData[rwaId]) return;
    const chainMcap: StablecoinChainMcap = { ...(stablecoinsData[cgId].chainMcap ?? {}) };
    stablecoinOverrideRwaIds[cgId] = rwaId;
    stablecoinOverrideChainMcaps[cgId] = chainMcap;
    finalData[rwaId][RWA_KEY_MAP.onChain] = { ...chainMcap };
    if (!finalData[rwaId][RWA_KEY_MAP.activeMcap] && finalData[rwaId][RWA_KEY_MAP.activeMcapChecked])
      finalData[rwaId][RWA_KEY_MAP.activeMcap] = { ...chainMcap };
  });

  // An RWA can have multiple token addresses on the same chain; aggregate across
  // them rather than overwriting, and only subtract excluded balances once per
  // (rwaId, chain) since excludedAmounts is already a per-(rwaId, chain) total.
  const exclusionApplied = new Set<string>();

  Object.keys(assetPrices).forEach((pk: string) => {
    const rwaId = tokenToProjectMap[pk];
    if (!finalData[rwaId]) return;
    const cgId = finalData[rwaId]?.coingeckoId;
    const chain = pk.substring(0, pk.indexOf(":"));
    const chainDisplayName = getChainDisplayName(chain, true);

    // Stablecoin RWAs: when stablecoinsData covers this chain, derive supply
    // from stableMcap / price and skip the on-chain accumulation. If it
    // doesn't cover this chain (chain is in the spreadsheet but not the
    // stablecoins API), fall through to the on-chain path so we don't drop coverage.
    const stablecoinChainMcap = cgId ? stablecoinOverrideChainMcaps[cgId] : undefined;
    const stablecoinChainEntry = Object.entries(stablecoinChainMcap ?? {}).find(
      ([stablecoinChain]) => getChainIdFromDisplayName(stablecoinChain) === chain
    );
    if (
      cgId &&
      stablecoinOverrideRwaIds[cgId] === rwaId &&
      stablecoinChainEntry
    ) {
      const [stablecoinChain, stablecoinMcap] = stablecoinChainEntry;
      finalData[rwaId][RWA_KEY_MAP.onChain] = { ...(stablecoinChainMcap ?? {}) };
      if (!finalData[rwaId][RWA_KEY_MAP.price] && assetPrices[pk]?.price) {
        finalData[rwaId][RWA_KEY_MAP.price] = toFiniteNumberOrNull(assetPrices[pk].price);
      }
      const stablePrice = assetPrices[pk]?.price;
      const stableMcap = Number(stablecoinMcap);
      if (stablePrice && Number.isFinite(stableMcap)) {
        finalData[rwaId][RWA_KEY_MAP.totalSupply] = finalData[rwaId][RWA_KEY_MAP.totalSupply] || {};
        finalData[rwaId][RWA_KEY_MAP.totalSupply][stablecoinChain] = toFixedNumber(stableMcap / stablePrice, 6);
      }
      if (finalData[rwaId][RWA_KEY_MAP.activeMcapChecked]) {
        if (!finalData[rwaId][RWA_KEY_MAP.activeMcap])
          finalData[rwaId][RWA_KEY_MAP.activeMcap] = { ...finalData[rwaId][RWA_KEY_MAP.onChain] };
        const exclusionKey = `${rwaId}:${stablecoinChain}`;
        if (!exclusionApplied.has(exclusionKey)) {
          exclusionApplied.add(exclusionKey);
          findActiveMcaps(finalData, rwaId, excludedAmounts, assetPrices[pk], stablecoinChain);
        }
      }
      return;
    }

    const { price, decimals } = assetPrices[pk];
    // Write price independently of supply: a missing supply (e.g. RPC failure for an
    // Aptos FA) shouldn't blank out a price we already have from coins.
    if (price && !finalData[rwaId][RWA_KEY_MAP.price]) {
      finalData[rwaId][RWA_KEY_MAP.price] = toFiniteNumberOrNull(price);
    }

    const supply = totalSupplies[pk];
    // null = fetch failed → skip (don't fabricate or wipe existing data).
    // 0 / any number = real reading → fall through; 0 produces an explicit 0
    // chain entry that overwrites stale stored values.
    if (supply == null || !price) {
      if (process.env.DEBUG_ENABLED) console.error(`No supply or price for ${pk}`);
      return;
    }

    try {
      if (!finalData[rwaId][RWA_KEY_MAP.onChain]) finalData[rwaId][RWA_KEY_MAP.onChain] = {};
      if (!finalData[rwaId][RWA_KEY_MAP.activeMcap]) finalData[rwaId][RWA_KEY_MAP.activeMcap] = {};
      if (!finalData[rwaId][RWA_KEY_MAP.onChain][chainDisplayName])
        finalData[rwaId][RWA_KEY_MAP.onChain][chainDisplayName] = {};

      const supplyAdjusted = supply / 10 ** decimals;
      const aum = price * supplyAdjusted;
      const prevOnChain = Number(finalData[rwaId][RWA_KEY_MAP.onChain][chainDisplayName]) || 0;
      finalData[rwaId][RWA_KEY_MAP.onChain][chainDisplayName] = toFixedNumber(prevOnChain + aum, 0);
      setTotalSupply(rwaId, chainDisplayName, supplyAdjusted);

      if (!finalData[rwaId][RWA_KEY_MAP.activeMcapChecked]) return;

      const prevActive = Number(finalData[rwaId][RWA_KEY_MAP.activeMcap][chainDisplayName]) || 0;
      finalData[rwaId][RWA_KEY_MAP.activeMcap][chainDisplayName] = toFixedNumber(prevActive + aum, 0);

      const exclusionKey = `${rwaId}:${chainDisplayName}`;
      if (!exclusionApplied.has(exclusionKey)) {
        exclusionApplied.add(exclusionKey);
        findActiveMcaps(finalData, rwaId, excludedAmounts, assetPrices[pk], chainDisplayName);
      }
    } catch (e) {
      if (process.env.DEBUG_ENABLED) console.error(`Malformed ${RWA_KEY_MAP.onChain} for ${rwaId}: ${e}`);
    }
  });

  // Backfill totalSupply for every stablecoin chain. Bridged/wrapped chains exist
  // in stablecoinsData but not in the spreadsheet, so the per-token loop never
  // derives their supply — leaving onChainMcap > 0 with no totalSupply entry.
  Object.keys(stablecoinsData).forEach((cgId: string) => {
    const rwaId = stablecoinOverrideRwaIds[cgId];
    if (!rwaId || !finalData[rwaId]) return;
    let price = Number(finalData[rwaId][RWA_KEY_MAP.price]) || 0;
    if (!price) {
      // Fallback: when no spreadsheet contract had a coins-API price, look the
      // asset up directly by its coingecko id so we can still derive supply.
      const cgPrice = Number(coingeckoPrices?.[`coingecko:${cgId}`]?.price);
      if (Number.isFinite(cgPrice) && cgPrice > 0) {
        price = cgPrice;
        finalData[rwaId][RWA_KEY_MAP.price] = formatNumAsNumber(price);
      }
    }
    if (!price) return;
    finalData[rwaId][RWA_KEY_MAP.totalSupply] = finalData[rwaId][RWA_KEY_MAP.totalSupply] || {};
    Object.entries(stablecoinOverrideChainMcaps[cgId] ?? {}).forEach(([chain, mcap]) => {
      if (finalData[rwaId][RWA_KEY_MAP.totalSupply][chain] != null) return;
      const mcapNum = Number(mcap);
      if (!Number.isFinite(mcapNum)) return;
      finalData[rwaId][RWA_KEY_MAP.totalSupply][chain] = toFixedNumber(mcapNum / price, 6);
    });
  });

  // For xStock/Backed Finance: set onChainMcap = activeMcap
  Object.keys(finalData).forEach((rwaId) => {
    const platform = finalData[rwaId]?.parentPlatform;
    if (!platform || !ONCHAIN_MCAP_EQUALS_ACTIVE_PLATFORMS.has(platform)) return;
    const activeMcap = finalData[rwaId][RWA_KEY_MAP.activeMcap];
    if (!activeMcap) return;
    finalData[rwaId][RWA_KEY_MAP.onChain] = { ...activeMcap };
    // Re-derive totalSupply from the overridden mcap so mcap = supply * price still holds.
    const price = Number(finalData[rwaId][RWA_KEY_MAP.price]) || 0;
    if (!price) return;
    const supplyByChain: { [chain: string]: number } = {};
    Object.keys(activeMcap).forEach((chain) => {
      const mcap = Number(activeMcap[chain]);
      if (Number.isFinite(mcap)) supplyByChain[chain] = toFixedNumber(mcap / price, 6);
    });
    finalData[rwaId][RWA_KEY_MAP.totalSupply] = supplyByChain;
  });
}

function findActiveMcaps(
  finalData: any,
  rwaId: string,
  excludedAmounts: { [id: string]: { [chainSlug: string]: BigNumber } },
  assetPrices: { price: number; decimals: number },
  chain: string
) {
  if (!finalData[rwaId][RWA_KEY_MAP.price]) {
    finalData[rwaId][RWA_KEY_MAP.price] = toFiniteNumberOrNull(assetPrices.price);
  }
  if (!finalData[rwaId][RWA_KEY_MAP.activeMcap][chain]) return;
  if (!(rwaId in excludedAmounts)) return;
  const thisChainExcluded = excludedAmounts[rwaId][chain];
  if (!thisChainExcluded) return;
  const excludedUsdValue = thisChainExcluded.div(BigNumber(10).pow(assetPrices.decimals)).times(assetPrices.price);
  finalData[rwaId][RWA_KEY_MAP.activeMcap][chain] = toFixedNumber(
    finalData[rwaId][RWA_KEY_MAP.activeMcap][chain] - excludedUsdValue.toNumber(),
    0
  );
}

// ── Exported: context + per-timestamp runner ────────────────────────

export interface AtvlContext {
  finalData: { [id: string]: { [key: string]: any } };
  rwaTokens: { [id: string]: string[] };
  tokensSortedByChain: { [chain: string]: string[] };
  tokenToProjectMap: { [token: string]: string };
  projectIdsMap: { [rwaId: string]: any };
  coingeckoIdToRwaIds: { [cgId: string]: string[] };
  ids: string[];
}

/** Fetch CSV once, parse, and build all timestamp-independent data structures. */
export async function prepareAtvlContext(ids: string[] = []): Promise<AtvlContext> {
  const parsedCsvData = await getCsvData();
  const rwaTokens: { [protocol: string]: string[] } = {};
  const finalData: { [protocol: string]: { [key: string]: any } } = {};
  const projectIdsMap: { [rwaId: string]: any } = {};
  const coingeckoIdToRwaIds: { [cgId: string]: string[] } = {};

  const headerToKey = createAirtableHeaderToCanonicalKeyMapper(RWA_KEY_MAP);

  parsedCsvData.forEach((row: any) => {
    const mapped: any = {};
    for (const [header, value] of Object.entries(row || {})) {
      const key = headerToKey(String(header));
      if (!key) continue;
      mapped[key] = value;
    }

    const id = mapped.id;
    if (!id) return;
    if (ids.length > 0 && !ids.includes(id)) return;
    if (!mapped.ticker) return;

    rwaTokens[id] = Array.isArray(mapped.contracts) ? mapped.contracts : mapped.contracts ? [mapped.contracts] : [];

    const projectId = mapped.projectId;
    if (
      Array.isArray(projectId)
        ? projectId.length > 0
        : typeof projectId === "string"
        ? projectId.length > 0
        : !!projectId
    ) {
      projectIdsMap[id] = projectId;
    }

    if (typeof mapped.coingeckoId === "string" && mapped.coingeckoId) {
      if (!coingeckoIdToRwaIds[mapped.coingeckoId]) coingeckoIdToRwaIds[mapped.coingeckoId] = [];
      coingeckoIdToRwaIds[mapped.coingeckoId].push(id);
    }

    normalizeRwaMetadataForApiInPlace(mapped);
    finalData[id] = mapped;
  });

  const { tokensSortedByChain, tokenToProjectMap } = sortTokensByChain(rwaTokens);

  return { finalData, rwaTokens, tokensSortedByChain, tokenToProjectMap, projectIdsMap, coingeckoIdToRwaIds, ids };
}

/** Run the per-timestamp atvl pipeline using a pre-built context. */
export async function runAtvlForTimestamp(
  ts: number,
  context: AtvlContext,
  options: { skipCircuitBreaker?: boolean; skipAssetMoveGuard?: boolean; storeResults?: boolean } = {}
): Promise<{ [id: string]: any }> {
  const timestamp = ts != 0 ? getTimestampAtStartOfDay(ts) : 0;
  const { tokensSortedByChain, tokenToProjectMap, projectIdsMap, coingeckoIdToRwaIds, ids } = context;

  // Each timestamp gets its own mutable copy (getActiveTvls / getOnChainTvlAndActiveMcaps mutate finalData)
  const finalData = structuredClone(context.finalData);

  const tFetch = performance.now();
  const timedFetch = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const s = performance.now();
    const result = await fn();
    console.log(`[timer]   ${label}: ${((performance.now() - s) / 1000).toFixed(1)}s`);
    return result;
  };
  // Coingecko-keyed prices used as fallback for stablecoin RWAs whose
  // spreadsheet contracts have no entry in the coins API (prices are looked
  // up by `coingecko:<id>` instead of by contract address).
  const cgKeys = Object.keys(coingeckoIdToRwaIds).map((id) => `coingecko:${id}`);
  const [assetPrices, aggregateRawTvls, totalSupplies, stablecoinsData, excludedAmounts, coingeckoPrices] = await Promise.all([
    timedFetch("getPrices", () => coins.getPrices(Object.keys(tokenToProjectMap), timestamp == 0 ? "now" : timestamp)),
    timedFetch("getAggregateRawTvlsForRwaTokens", () => getAggregateRawTvlsForRwaTokens(tokensSortedByChain, timestamp)),
    timedFetch("getTotalSupplies", () => getTotalSupplies(tokensSortedByChain, timestamp)),
    timedFetch("fetchStablecoins", () => fetchStablecoins(timestamp, new Set(Object.keys(coingeckoIdToRwaIds)))),
    timedFetch("getExcludedBalances", () => getExcludedBalances(ts, finalData, tokenToProjectMap)),
    timedFetch("getCoingeckoPrices", () => cgKeys.length > 0 ? coins.getPrices(cgKeys, timestamp == 0 ? "now" : timestamp) : Promise.resolve({})),
  ]);
  console.log(`[timer] Promise.all (6 fetches): ${((performance.now() - tFetch) / 1000).toFixed(1)}s`);

  Object.keys(tokenToProjectMap).forEach((address: string) => {
    if (!assetPrices[address]) {
      if (process.env.DEBUG_ENABLED) console.error(`No price for ${tokenToProjectMap[address]} at ${address}`);
      return;
    }
  });

  const tCompute = performance.now();
  getActiveTvls(assetPrices, tokenToProjectMap, finalData, protocolIdMap, aggregateRawTvls, projectIdsMap);
  getOnChainTvlAndActiveMcaps(
    assetPrices,
    tokenToProjectMap,
    finalData,
    coingeckoIdToRwaIds,
    stablecoinsData,
    totalSupplies,
    excludedAmounts,
    coingeckoPrices
  );
  console.log(
    `[timer] compute (getActiveTvls + getOnChainTvlAndActiveMcaps): ${((performance.now() - tCompute) / 1000).toFixed(
      1
    )}s`
  );

  const timestampToPublish = timestamp == 0 ? getCurrentUnixTimestamp() : timestamp;
  const res = { data: finalData, timestamp: timestampToPublish };

  const skipCB = options.skipCircuitBreaker || ids.length > 0;
  if (!skipCB) {
    const tCB = performance.now();
    const circuitBreaker = await checkCircuitBreakers(finalData);
    console.log(`[timer] circuitBreaker: ${((performance.now() - tCB) / 1000).toFixed(1)}s`);
    if (circuitBreaker.triggered) {
      const contributorsBlock = buildTripContributorsBlock(finalData, circuitBreaker.trippedMetrics);
      const message =
        `ATVL Circuit Breaker Triggered - results NOT saved!\n${circuitBreaker.details.join("\n")}\n\n${contributorsBlock}`;
      console.error(message);
      logCircuitBreakerDiagnostics(finalData, circuitBreaker.trippedMetrics);
      try {
        await sendThrottledRwaAlert({
          alertKey: 'atvlCircuitBreaker',
          message: truncateForDiscord(message),
          formatted: false,
        });
      } catch (alertError) {
        console.error('[circuit-breaker] failed to send alert:', (alertError as any)?.message);
      }
      return finalData;
    }
  }

  if (options.storeResults) {
    const tStore = performance.now();
    await Promise.all([
      timestamp == 0 ? storeMetadata(res) : Promise.resolve(),
      storeHistorical(res as any, {
        skipAssetMoveGuard: options.skipAssetMoveGuard || ids.length > 0 || ts != 0,
      }),
    ]);
    console.log(`[timer] storeResults: ${((performance.now() - tStore) / 1000).toFixed(1)}s`);
  }

  if (process.env.DEBUG_ENABLED) console.log(`Exitting atvlRefill.ts for ts=${timestamp}`);

  return finalData;
}

// ── Circuit breaker (copied from atvl.ts) ───────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 0.5;

export type TripMetricName = "defiActiveTvl" | "onChainMcap" | "activeMcap";
export interface TrippedMetric { name: TripMetricName; prev: number; curr: number; ratio: number; }

async function checkCircuitBreakers(
  data: { [id: string]: any }
): Promise<{ triggered: boolean; details: string[]; trippedMetrics: TrippedMetric[] }> {
  const details: string[] = [];
  const trippedMetrics: TrippedMetric[] = [];

  let newDefiActiveTvl = 0;
  let newOnChainMcap = 0;
  let newActiveMcap = 0;

  Object.keys(data).forEach((id) => {
    const defiActive = data[id][RWA_KEY_MAP.defiActive];
    const onChain = data[id][RWA_KEY_MAP.onChain];
    const activeMcap = data[id][RWA_KEY_MAP.activeMcap];

    Object.values(defiActive ?? {}).forEach((chain: any) => {
      if (typeof chain === "object") {
        Object.values(chain).forEach((val: any) => {
          newDefiActiveTvl += Number(val) || 0;
        });
      }
    });

    Object.values(onChain ?? {}).forEach((val: any) => {
      newOnChainMcap += Number(val) || 0;
    });

    Object.values(activeMcap ?? {}).forEach((val: any) => {
      newActiveMcap += Number(val) || 0;
    });
  });

  await initPG();
  const previous = await fetchLatestAggregateTotals();
  if (!previous) return { triggered: false, details: [], trippedMetrics: [] };

  const checks: { name: TripMetricName; prev: number; curr: number }[] = [
    { name: "defiActiveTvl", prev: previous.defiActiveTvl, curr: newDefiActiveTvl },
    { name: "onChainMcap", prev: previous.onChainMcap, curr: newOnChainMcap },
    { name: "activeMcap", prev: previous.activeMcap, curr: newActiveMcap },
  ];

  for (const { name, prev, curr } of checks) {
    if (prev < 1) continue;
    const ratio = curr / prev;
    if (ratio > 1 + CIRCUIT_BREAKER_THRESHOLD || ratio < 1 - CIRCUIT_BREAKER_THRESHOLD) {
      const changePercent = ((ratio - 1) * 100).toFixed(2);
      details.push(`${name}: $${prev.toFixed(0)} -> $${curr.toFixed(0)} (${changePercent}% change)`);
      trippedMetrics.push({ name, prev, curr, ratio });
    }
  }

  return { triggered: details.length > 0, details, trippedMetrics };
}

// ── Trip diagnostics ────────────────────────────────────────────────
// On a circuit-breaker trip, attach the top contributors with per-chain
// breakdown to the Discord webhook (so the offender is visible in the
// alert itself), mirror them to stderr, and dump the full payload to
// disk so we can post-mortem intermittent upstream data spikes.
const TRIP_TOP_N = 10;
const TRIP_TOP_CHAINS_PER_ROW = 3;
const DISCORD_MESSAGE_SAFE_LIMIT = 1900;

function truncateForDiscord(message: string, maxLength = DISCORD_MESSAGE_SAFE_LIMIT): string {
  if (message.length <= maxLength) return message;
  const suffix = "\n\n[truncated for Discord; full diagnostics are in stderr]";
  const headLimit = Math.max(0, maxLength - suffix.length);
  const lastNewline = message.lastIndexOf("\n", headLimit);
  const cutAt = lastNewline > maxLength * 0.6 ? lastNewline : headLimit;
  return `${message.slice(0, cutAt)}${suffix}`;
}

function fmtTripUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e15) return `$${(v / 1e15).toFixed(2)}Q`;
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}

function getTripChainTotals(item: any, metric: TripMetricName): { total: number; byChain: { [chain: string]: number } } {
  const byChain: { [chain: string]: number } = {};
  if (metric === "defiActiveTvl") {
    Object.entries(item?.[RWA_KEY_MAP.defiActive] ?? {}).forEach(([chain, protocols]: [string, any]) => {
      if (!protocols || typeof protocols !== "object") return;
      byChain[chain] = (Object.values(protocols) as any[]).reduce((s: number, v: any) => s + (Number(v) || 0), 0);
    });
  } else {
    const source = metric === "onChainMcap" ? item?.[RWA_KEY_MAP.onChain] : item?.[RWA_KEY_MAP.activeMcap];
    Object.entries(source ?? {}).forEach(([chain, val]) => {
      byChain[chain] = Number(val) || 0;
    });
  }
  return { byChain, total: Object.values(byChain).reduce((s, v) => s + v, 0) };
}

export function buildTripContributorsBlock(data: { [id: string]: any }, trippedMetrics: TrippedMetric[]): string {
  const sections: string[] = [];
  for (const { name } of trippedMetrics) {
    const rows = Object.entries(data)
      .map(([id, item]) => {
        const { total, byChain } = getTripChainTotals(item, name);
        const label = item?.ticker || item?.canonicalMarketId || item?.name || id;
        return { id, label, total, byChain };
      })
      .filter((r) => r.total !== 0)
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
      .slice(0, TRIP_TOP_N);

    const lines = [`── ${name} top ${rows.length} ──`];
    rows.forEach((r, i) => {
      const chains = Object.entries(r.byChain)
        .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
        .slice(0, TRIP_TOP_CHAINS_PER_ROW)
        .map(([chain, v]) => `${chain}=${fmtTripUsd(v)}`)
        .join(", ");
      lines.push(`  ${String(i + 1).padStart(2)}. ${r.label}#${r.id}  ${fmtTripUsd(r.total)}  [${chains}]`);
    });
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

export function logCircuitBreakerDiagnostics(
  data: { [id: string]: any },
  trippedMetrics: TrippedMetric[],
): void {
  try {
    const block = buildTripContributorsBlock(data, trippedMetrics);
    block.split("\n").forEach((line) => console.error(`[circuit-breaker] ${line}`));
  } catch (e) {
    console.error("[circuit-breaker] failed to log top contributors:", e);
  }
}
