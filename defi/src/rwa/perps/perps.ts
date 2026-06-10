import { getCurrentUnixTimestamp, getTimestampAtStartOfDay } from "../../utils/date";

import * as sdk from '@defillama/sdk'
const { runInPromisePool } = sdk.util;
import { initPG, fetchLatestAggregateTotals, fetchCumulativeFundingPG, fetchLatestFundingTimestampPG, fetchRollingVolumesPG } from "./db";
import { sendMessage } from "../../utils/discord";
import { getAllAdapters, getAdapter } from "./platforms";
import type { ParsedPerpsMarket, FundingEntry } from "./platforms";
import { normalizeOpenInterestUsd, normalizeFundingRateHourly } from "./platforms/types";
import {
  getContractId,
  getContractMetadata,
  hasContractMetadata,
  isLikelyCryptoOrForex,
  loadContractMetadataFromAirtable,
  CIRCUIT_BREAKER_THRESHOLD,
} from "./constants";
import { computeProtocolFees, toFiniteNumberOrZero } from "./utils";
import { storeHistorical, storeMetadata, storeFundingHistory } from "./historical";
import type { PerpsDataEntry } from "./historical";

export async function main(ts: number = 0): Promise<void> {
  const timestamp = ts || getCurrentUnixTimestamp();
  console.log(`RWA Perps start ${new Date(timestamp * 1000).toISOString()}`);

  const metadataCount = await loadContractMetadataFromAirtable();
  console.log(`RWA Perps loaded ${metadataCount} market metadata entries from Airtable`);

  await initPG();

  const adapters = getAllAdapters();
  console.log(`RWA Perps running ${adapters.length} platform adapters: ${adapters.map((a) => a.name).join(", ")}`);

  const allMarkets: ParsedPerpsMarket[] = [];
  await runInPromisePool({
    items: adapters,
    concurrency: 3,
    processor: async (adapter: { name: string; fetchMarkets: () => Promise<ParsedPerpsMarket[]> }) => {
      try {
        const markets = await adapter.fetchMarkets();
        console.log(`RWA Perps ${adapter.name}: ${markets.length} markets`);
        allMarkets.push(...markets);
      } catch (e) {
        console.error(`RWA Perps ${adapter.name} failed:`, e);
      }
    },
  });

  if (allMarkets.length === 0) return;

  // 3. Filter to only markets with spreadsheet metadata; alert on missing ones
  const knownMarkets: ParsedPerpsMarket[] = [];
  const missingMetadata: string[] = [];
  for (const market of allMarkets) {
    if (hasContractMetadata(market.contract)) {
      knownMarkets.push(market);
    } else {
      missingMetadata.push(`${market.contract}`);
    }
  }

  // Only notify about missing RWA markets — skip crypto/forex noise
  const missingRwa = missingMetadata.filter((c) => !isLikelyCryptoOrForex(c));
  // if (missingRwa.length > 0) {
  //   const msg = `RWA Perps  ${
  //     missingRwa.length
  //   } market(s) skipped — missing spreadsheet metadata:\n${missingRwa.slice(0, 11).join(", ")}`;
  //   console.warn(msg);
  //   if (process.env.RWA_WEBHOOK && +Date.now() > +new Date('2025-04-23')) { // Re-enable after Apr 25, 2025
  //     await sendMessage(msg, process.env.RWA_WEBHOOK, false);
  //   }
  // }

  if (knownMarkets.length === 0) return;

  // Drop markets where Pyth + Ostium fallback both missed — storing $0 prices breaks OI math.
  const pricedMarkets: ParsedPerpsMarket[] = [];
  const unpricedMarkets: string[] = [];
  for (const market of knownMarkets) {
    if (market.markPx > 0) {
      pricedMarkets.push(market);
    } else {
      unpricedMarkets.push(market.contract);
    }
  }

  if (unpricedMarkets.length > 0) {
    const msg = `RWA Perps ${unpricedMarkets.length} market(s) skipped — zero price after fallback:\n${unpricedMarkets.slice(0, 20).join(", ")}`;
    console.warn(msg);
    if (process.env.RWA_WEBHOOK) {
      await sendMessage(msg, process.env.RWA_WEBHOOK, false);
    }
  }

  const fundingEntries: FundingEntry[] = [];

  // Fetch funding history for ALL knownMarkets, not just pricedMarkets.
  // Rationale: funding rate and base-unit OI don't depend on markPx, and some
  // adapters (notably edgex) only expose the single most-recent settled rate
  // per call — skipping a cycle for a transient $0 price permanently loses
  // that settlement with no way to backfill.
  await runInPromisePool({
    items: knownMarkets,
    concurrency: 5,
    processor: async (market: ParsedPerpsMarket) => {
      const adapter = getAdapter(market.platform);
      if (!adapter) return;

      const marketId = getContractId(market.contract);
      const latestTs = await fetchLatestFundingTimestampPG(marketId);
      const startTime = latestTs
        ? (latestTs + 1) * 1000
        : (timestamp - 86400) * 1000;
      const endTime = timestamp * 1000;
      if (startTime >= endTime) return;

      try {
        const entries = await adapter.fetchFundingHistory(market, startTime, endTime);
        if (entries.length > 0) fundingEntries.push(...entries);
      } catch (e) {
        console.error(`RWA Perps funding history error for ${market.contract}:`, e);
      }
    },
  });

  // After funding is captured, drop unpriced markets so finalData / OI math
  // never sees a $0 price (which would zero out openInterest USD notional).
  if (pricedMarkets.length === 0) return;

  if (fundingEntries.length > 0) await storeFundingHistory(fundingEntries);

  // Fetch rolling 7d/30d volumes from daily history (single query for all IDs)
  const secondsInDay = 86400;
  const since30d = getTimestampAtStartOfDay(timestamp - 30 * secondsInDay);
  const since7d = getTimestampAtStartOfDay(timestamp - 7 * secondsInDay);
  const rollingVolumes = await fetchRollingVolumesPG(since30d, since7d);

  const finalData: { [id: string]: PerpsDataEntry } = {};
  await runInPromisePool({
    items: pricedMarkets,
    concurrency: 10,
    processor: async (market: ParsedPerpsMarket) => {
      const marketId = getContractId(market.contract);
      const metadata = getContractMetadata(market.contract)!;

      const cumulativeFunding = await fetchCumulativeFundingPG(marketId);

      // Prefer venue-sourced fees when an adapter exposes them; fall back to Airtable metadata.
      const makerFee =
        typeof market.makerFeeRate === "number" && Number.isFinite(market.makerFeeRate)
          ? market.makerFeeRate
          : metadata.makerFeeRate;
      const takerFee =
        typeof market.takerFeeRate === "number" && Number.isFinite(market.takerFeeRate)
          ? market.takerFeeRate
          : metadata.takerFeeRate;
      const deployerShare = metadata.deployerFeeShare;
      const fees24h = computeProtocolFees(market.volume24h, takerFee, deployerShare);

      const rolling = rollingVolumes[marketId] || { volume7d: 0, volume30d: 0, volumeAllTime: 0 };
      // Include today's 24h volume in the rolling windows
      const volume7d = rolling.volume7d + market.volume24h;
      const volume30d = rolling.volume30d + market.volume24h;
      const volumeAllTime = rolling.volumeAllTime + market.volume24h;
      const fees7d = computeProtocolFees(volume7d, takerFee, deployerShare);
      const fees30d = computeProtocolFees(volume30d, takerFee, deployerShare);
      const feesAllTime = computeProtocolFees(volumeAllTime, takerFee, deployerShare);

      // OI normalization: Hyperliquid reports OI in base units, others in USD notional.
      // Logic lives in platforms/types.ts — the preview HTML uses the same helper.
      const adapter = getAdapter(market.platform);
      const openInterest = normalizeOpenInterestUsd(market, adapter);

      // Funding normalization: venues settle on different cadences (1h for most,
      // 4h edgeX, 8h Aster, per-market Variational). Store every rate per-1h so
      // they're comparable across venues. Same helper the preview HTML uses.
      const fundingRate = normalizeFundingRateHourly(market.fundingRate, market.fundingIntervalHours);

      finalData[marketId] = {
        contract: market.contract,
        venue: metadata.parentPlatform ?? market.venue,
        openInterest,
        volume24h: market.volume24h,
        price: market.markPx,
        priceChange24h: market.priceChange24h,
        fundingRate,
        premium: market.premium,
        cumulativeFunding,
        data: {
          oraclePx: market.oraclePx,
          midPx: market.midPx,
          prevDayPx: market.prevDayPx,
          maxLeverage: market.maxLeverage,
          szDecimals: market.szDecimals,
          // Native funding cadence (hours) the per-1h `fundingRate` was derived
          // from; null when the venue has no fixed-period funding. Lets consumers
          // recover the raw per-period rate (= fundingRate × fundingIntervalHours).
          fundingIntervalHours:
            market.fundingIntervalHours === undefined ? 1 : market.fundingIntervalHours,
          makerFeeRate: makerFee,
          takerFeeRate: takerFee,
          volume7d,
          volume30d,
          volumeAllTime,
          estimatedProtocolFees24h: fees24h,
          estimatedProtocolFees7d: fees7d,
          estimatedProtocolFees30d: fees30d,
          estimatedProtocolFeesAllTime: feesAllTime,
          referenceAsset: metadata.referenceAsset,
          referenceAssetGroup: metadata.referenceAssetGroup,
          assetClass: metadata.assetClass,
          parentPlatform: metadata.parentPlatform,
          pair: metadata.pair,
          marginAsset: metadata.marginAsset,
          settlementAsset: metadata.settlementAsset,
          category: metadata.category,
          rwaClassification: metadata.rwaClassification,
        },
      };
    },
  });

  console.log(`RWA Perps - data for ${Object.keys(finalData).length} markets`);
  const circuitBreakerPassed = await checkCircuitBreaker(finalData);
  if (!circuitBreakerPassed) return;

  console.log("RWA Perps  Storing historical data...");
  await storeHistorical({ data: finalData, timestamp });
  console.log("RWA Perps  Storing metadata...");
  await storeMetadata({ data: finalData });
  console.log(`RWA Perps done - ${Object.keys(finalData).length} markets`);
}

async function checkCircuitBreaker(newData: { [id: string]: PerpsDataEntry }): Promise<boolean> {
  const previousTotals = await fetchLatestAggregateTotals();
  if (!previousTotals) return true;

  let newTotalOI = 0;
  let newTotalVol = 0;
  for (const entry of Object.values(newData)) {
    newTotalOI += toFiniteNumberOrZero(entry.openInterest);
    newTotalVol += toFiniteNumberOrZero(entry.volume24h);
  }

  const oiChange =
    previousTotals.openInterest > 0
      ? Math.abs(newTotalOI - previousTotals.openInterest) / previousTotals.openInterest
      : 0;

  if (oiChange > CIRCUIT_BREAKER_THRESHOLD) {
    const msg = `RWA Perps OI changed by ${(oiChange * 100).toFixed(
      1
    )}% (prev: ${previousTotals.openInterest.toFixed(0)}, new: ${newTotalOI.toFixed(0)})`;
    console.error(msg);
    if (process.env.RWA_WEBHOOK) {
      await sendMessage(msg, process.env.RWA_WEBHOOK, false);
    }
    return false;
  }

  return true;
}

// main()
//   .then(() => {
//     console.log("RWA Perps done");
//     process.exit(0);
//   })
//   .catch((e) => {
//     console.error("RWA Perps error:", e);
//     process.exit(1);
//   }); // ts-node defi/src/rwa/perps/perps.ts
