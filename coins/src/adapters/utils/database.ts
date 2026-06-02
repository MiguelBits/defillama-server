require("dotenv").config();
import axios from "axios";
import { getCurrentUnixTimestamp } from "../../utils/date";
import { batchGet, batchWrite } from "../../utils/shared/dynamodb";
import { getRecordClosestToTimestamp } from "../../utils/shared/getRecordClosestToTimestamp";
import {
  Write,
  DbEntry,
  DbQuery,
  Read,
  CoinData,
  Metadata,
} from "./dbInterfaces";
const confidenceThreshold: number = 0.3;
const staleCgConfidenceThreshold: number = 0.8;
const staleCgPriceChangeThreshold: number = 0.1; // 10%
const staleDownwardCheckHours: number = 3;
import pLimit from "p-limit";

import { staleMargin } from "../../utils/coingeckoPlatforms";
import * as sdk from '@defillama/sdk'
const { sliceIntoChunks, } = sdk.util

import { lowercase } from "../../utils/coingeckoPlatforms";
import { sendMessage } from "../../../../defi/src/utils/discord";
import { chainsThatShouldNotBeLowerCased } from "../../utils/shared/constants";
import { dualWriteToChRedis } from "./chRedisWrite";

function normalizedPKFor(pk: string): string {
  if (pk.startsWith("coingecko#")) return pk.toLowerCase();
  if (pk.startsWith("block#")) return pk.toLowerCase();
  if (!pk.startsWith("asset#")) return pk;
  const body = pk.slice("asset#".length); // chain:address
  const colonIdx = body.indexOf(":");
  if (colonIdx === -1) return pk.toLowerCase();
  const chain = body.slice(0, colonIdx).toLowerCase();
  let address = body.slice(colonIdx + 1).toLowerCase();
  if (chain === "starknet" && address.length === 66 && address.startsWith("0x0")) {
    address = address.replace(/^0x0+/, "0x");
  }
  return `asset#${chain}:${address}`;
}

const rateLimited = pLimit(10);
process.env.tableName = "prod-coins-table";

let cache: any = {};
let lastCacheClear: number;

export async function getTokenAndRedirectData(
  tokens: string[],
  chain: string,
  timestamp: number,
  hoursRange: number = 12,
): Promise<CoinData[]> {
  if (tokens.length == 0) return [];
  tokens = [...new Set(tokens)];

  if (tokens.length > 100) {
    const chunks: any = sliceIntoChunks(tokens, 99);
    const allData = [];
    for (const chunk of chunks) {
      allData.push(
        await getTokenAndRedirectData(chunk, chain, timestamp, hoursRange),
      );
    }
    return allData.flat();
  }

  if (getCurrentUnixTimestamp() - timestamp < 30 * 60) timestamp = 0; // if timestamp is less than 30 minutes ago, use current timestamp

  const response: CoinData[] = [];
  await rateLimited(async () => {
    if (!lastCacheClear) lastCacheClear = getCurrentUnixTimestamp();
    if (getCurrentUnixTimestamp() - lastCacheClear > 60 * 15)
      cache = {}; // clear cache every 15 minutes

    const cacheKey = `${chain}-${hoursRange}`;
    if (!cache[cacheKey]) cache[cacheKey] = {};
    const alreadyInCache: any[] = [];
    tokens.forEach((token: string) => {
      if (cache[cacheKey][token]) {
        alreadyInCache.push(token);
        response.push(cache[cacheKey][token]);
      }
    });

    tokens = tokens.filter((t: string) => !alreadyInCache.includes(t));
    if (tokens.length == 0) return response;

    let apiRes;
    if (process.env.LOCAL_TEST === "true") {
      apiRes = await getTokenAndRedirectDataFromAPI(tokens, chain, timestamp);
    } else {
      apiRes = await getTokenAndRedirectDataDB(
        tokens,
        chain,
        timestamp == 0 ? getCurrentUnixTimestamp() : timestamp,
        hoursRange,
      );
    }

    apiRes.map((r: any) => {
      if (r.address == null) return;
      if (!(cacheKey in cache)) cache[cacheKey] = {};
      cache[cacheKey][r.address] = r;
      return;
    });

    response.push(...apiRes);
  });

  return response;
}

export async function getTokenAndRedirectDataMap(
  tokens: string[],
  chain: string,
  timestamp: number,
  hoursRange: number = 12,
) {
  const res = await getTokenAndRedirectData(
    tokens,
    chain,
    timestamp,
    hoursRange,
  );
  const map: {
    [address: string]: CoinData;
  } = {};
  res.forEach((r: CoinData) => {
    map[r.address] = r;
  });
  return map;
}

export function addToDBWritesList(
  writes: Write[],
  chain: string,
  token: string,
  price: number | undefined,
  decimals: number,
  symbol: string,
  timestamp: number,
  adapter: string,
  confidence: number,
  redirect: string | undefined = undefined,
) {
  const PK: string =
    chain == "coingecko"
      ? `coingecko#${token.toLowerCase()}`
      : `asset#${chain}:${lowercase(token, chain)}`;
  const priceNum = price == null ? undefined : Number(price);
  if (redirect && timestamp == 0) {
    writes.push({
      SK: 0,
      PK,
      price: priceNum,
      symbol,
      decimals: Number(decimals),
      redirect,
      timestamp: getCurrentUnixTimestamp(),
      adapter,
      confidence: Number(confidence),
    });
  } else if (timestamp == 0) {
    writes.push(
      ...[
        {
          SK: getCurrentUnixTimestamp(),
          PK,
          price: priceNum,
          adapter,
          confidence: Number(confidence),
        },
        {
          SK: 0,
          PK,
          price: priceNum,
          symbol,
          decimals: Number(decimals),
          redirect,
          timestamp: getCurrentUnixTimestamp(),
          adapter,
          confidence: Number(confidence),
        },
      ],
    );
  } else {
    if (timestamp > 10000000000 || timestamp < 1400000000) {
      new Error("timestamp should be in unix seconds");
    }
    writes.push({
      SK: timestamp,
      PK,
      redirect,
      price: priceNum,
      adapter,
      confidence: Number(confidence),
    });
  }
}
async function getTokenAndRedirectDataFromAPI(
  tokens: string[],
  chain: string,
  timestamp: number,
) {
  const burl = "https://coins.llama.fi/prices/";
  const historical = timestamp == 0 ? "current/" : `historical/${timestamp}/`;
  const coins = tokens
    .reduce((p: string, c: string) => p + `${chain}:${c},`, "")
    .slice(0, -1);
  const tokenPrices = (await axios.get(`${burl}${historical}${coins}`)).data
    .coins;
  return Object.entries(tokenPrices).map((e: any) => {
    const pk = e[0];
    let data = e[1];
    data.chain = pk.substring(0, pk.indexOf(":"));
    const address = pk.substring(pk.indexOf(":") + 1);
    data.address = chainsThatShouldNotBeLowerCased.includes(data.chain)
      ? address
      : address.toLowerCase();
    return data;
  });
}
async function getTokenAndRedirectDataDB(
  tokens: string[],
  chain: string,
  timestamp: number,
  hoursRange: number,
) {
  let allReads: Read[] = [];
  const batchSize = 500;

  for (let lower = 0; lower < tokens.length; lower += batchSize) {
    const upper =
      lower + batchSize > tokens.length ? tokens.length : lower + batchSize;
    // in order of tokens
    // timestamped origin entries
    let timedDbEntries: any[] = await Promise.all(
      tokens.slice(lower, upper).map((t: string) => {
        return getRecordClosestToTimestamp(
          chain == "coingecko"
            ? `coingecko#${t.toLowerCase()}`
            : `asset#${chain}:${lowercase(t, chain)}`,
          timestamp,
          hoursRange * 60 * 60,
        );
      }),
    );

    // calls probably get jumbled in here
    // current origin entries, for current redirects
    const latestDbEntries: DbEntry[] = await batchGet(
      tokens.slice(lower, upper).map((t: string) => ({
        PK:
          chain == "coingecko"
            ? `coingecko#${t.toLowerCase()}`
            : `asset#${chain}:${lowercase(t, chain)}`,
        SK: 0,
      })),
    );

    // current redirect links
    const redirects: DbQuery[] = latestDbEntries.map((d: DbEntry) => {
      const selectedEntries: any[] = timedDbEntries.filter(
        (t: any) => d.PK == t.PK,
      );
      if (selectedEntries.length == 0) {
        return { PK: d.redirect, SK: d.SK };
      } else {
        return { PK: selectedEntries[0].redirect, SK: selectedEntries[0].SK };
      }
    });

    // timed redirect data
    let timedRedirects: any[] = await Promise.all(
      redirects.map((r: DbQuery) => {
        if (r.PK == undefined) return;
        return getRecordClosestToTimestamp(
          r.PK,
          timestamp,
          hoursRange * 60 * 60,
        );
      }),
    );

    // aggregate
    let validResults: Read[] = latestDbEntries
      .map((ld: DbEntry) => {
        let dbEntry = timedDbEntries.find((e: any) => {
          if (e.SK != null) return e.PK == ld.PK;
        });
        if (dbEntry != null) {
          const latestDbEntry: DbEntry | undefined = latestDbEntries.find(
            (e: any) => {
              if (e.SK != null) return e.PK == ld.PK;
            },
          );

          dbEntry.decimals = latestDbEntry?.decimals;
          dbEntry.symbol = latestDbEntry?.symbol;
        }
        let redirect = timedRedirects.find((e: any) => {
          if (e != null) return e.PK == ld.redirect && e.PK != null;
        });

        if (dbEntry == null && redirect == null)
          return { dbEntry: ld, redirect: ["FALSE"] };
        if (dbEntry && ld.redirect) dbEntry.redirect = ld.redirect;
        if (redirect == null) return { dbEntry, redirect: [] };
        return { dbEntry: ld, redirect: [redirect] };
      })
      .filter((v: any) => v.redirect[0] != "FALSE");

    allReads.push(...validResults);
  }
  return aggregateTokenAndRedirectData(allReads);
}
export async function filterWritesWithLowConfidence(
  allWrites: Write[],
  latencyHours: number = 3,
) {
  const staleTime = getCurrentUnixTimestamp() - latencyHours * 60 * 60;

  allWrites = allWrites.filter((w: Write) => w != undefined);
  const allReads = await batchGet(allWrites.map((w: Write) => ({ PK: w.PK, SK: 0 })));

  const filteredWrites: Write[] = [];
  const checkedWrites: Write[] = [];

  if (allWrites.length == 0) return [];

  allWrites.map((w: Write) => {
    let checkedWritesOfThisKind = checkedWrites.filter(
      (x: Write) =>
        x.PK == w.PK &&
        (((x.SK < w.SK + 1000 || x.SK > w.SK + 1000) &&
          w.SK != 0 &&
          x.SK != 0) ||
          (x.SK == 0 && w.SK == 0)),
    );

    if (checkedWritesOfThisKind.length > 0) return;
    checkedWrites.push(w);

    let allWritesOfThisKind = allWrites.filter(
      (x: Write) =>
        x.PK == w.PK &&
        (((x.SK < w.SK + 1000 || x.SK > w.SK + 1000) &&
          w.SK != 0 &&
          x.SK != 0) ||
          (x.SK == 0 && w.SK == 0)),
    );

    let allReadsOfThisKind = allReads.filter((x: any) => x.PK == w.PK);
    const currentRead = allReadsOfThisKind[0];
    const isStale =
      currentRead != null && (currentRead.timestamp ?? 0) < staleTime;

    if (allWritesOfThisKind.length == 1) {
      // When stored data is stale (>3h), accept lower confidence writes
      if (
        !isStale &&
        allReadsOfThisKind.length == 1 &&
        allWritesOfThisKind[0].confidence < allReadsOfThisKind[0].confidence
      )
        return;
      if (
        "confidence" in allWritesOfThisKind[0] &&
        allWritesOfThisKind[0].confidence > confidenceThreshold
      ) {
        filteredWrites.push(allWritesOfThisKind[0]);
        return;
      }
    } else {
      const maxConfidence = Math.max.apply(
        null,
        [...allWritesOfThisKind, ...(isStale ? [] : allReadsOfThisKind)].map(
          (x: Write) => x.confidence,
        ),
      );
      filteredWrites.push(
        allWritesOfThisKind.filter(
          (x: Write) =>
            x.confidence == maxConfidence &&
            x.confidence > confidenceThreshold,
        )[0],
      );
    }
  });

  // For asset writes with a coingecko redirect, rewrite PK to coingecko#<id>
  // when the override gate is open. Per-write gate: open iff the CG entry has
  // gone stale, OR the same adapter currently holds the slot (self-update).
  // Stops a chain of secondary adapters from rolling the slot around: once
  // adapter X owns the slot, only X can update it until it goes stale.
  const redirectMap: Record<string, string> = {}; // asset PK -> coingecko PK
  const missingCgPKs = new Set<string>();
  const cgEntriesByPK: Record<string, any> = {}; // cgPK -> existing SK=0 entry
  const nowTs = getCurrentUnixTimestamp();

  const assetWrites = filteredWrites.filter(
    (w) => w?.PK?.startsWith("asset#") && w.confidence >= staleCgConfidenceThreshold,
  );
  if (assetWrites.length > 0) {
    // Reuse allReads instead of re-fetching
    for (const entry of allReads.filter((r: any) => assetWrites.some((w) => w.PK === r.PK))) {
      if (entry?.redirect?.startsWith("coingecko#")) {
        redirectMap[entry.PK] = entry.redirect;
      }
    }

    const uniqueCgPKs = [...new Set(Object.values(redirectMap))];
    if (uniqueCgPKs.length > 0) {
      const cgEntries = await batchGet(
        uniqueCgPKs.map((pk) => ({ PK: pk, SK: 0 })),
      );
      const returnedPKs = new Set(cgEntries.map((e: any) => e?.PK).filter(Boolean));
      for (const pk of uniqueCgPKs) {
        if (!returnedPKs.has(pk)) {
          missingCgPKs.add(pk);
          sdk.log(`filterWrites: CG entry ${pk} missing, skipping override`);
        }
      }
      for (const entry of cgEntries) {
        if (!entry) continue;
        cgEntriesByPK[entry.PK] = entry;
      }

      // Pick one winning asset PK per cgPK so multiple chain deployments don't
      // collide on the same {PK, SK} after rewrite. Highest conf wins; ties
      // break by PK alphabetical.
      const winnerByCgPK: Record<string, { PK: string; confidence: number }> = {};
      for (const w of filteredWrites) {
        if (!w?.PK?.startsWith("asset#")) continue;
        const cgPK = redirectMap[w.PK];
        if (!cgPK) continue;
        if (missingCgPKs.has(cgPK)) continue;
        const cgEntry = cgEntriesByPK[cgPK];
        if (!canOverrideCgSlot(cgEntry, w, nowTs)) continue;
        if (w.confidence < staleCgConfidenceThreshold) continue;

        if (w.price == null || !Number.isFinite(w.price) || w.price <= 0) {
          sdk.log(
            `filterWrites: skipping CG override for ${w.PK} -> ${cgPK}: invalid write price ${w.price}`,
          );
          continue;
        }
        if (cgEntry.price != null) {
          if (!Number.isFinite(cgEntry.price) || cgEntry.price <= 0) {
            sdk.log(
              `filterWrites: skipping CG override for ${w.PK} -> ${cgPK}: invalid CG price ${cgEntry.price}`,
            );
            continue;
          }
          const priceChange = Math.abs(w.price - cgEntry.price) / cgEntry.price;
          if (priceChange > staleCgPriceChangeThreshold) {
            sdk.log(`filterWrites: skipping CG override for ${w.PK} -> ${cgPK}: price change ${(priceChange * 100).toFixed(1)}% exceeds ${staleCgPriceChangeThreshold * 100}%`);
            continue;
          }
        }
        const c = winnerByCgPK[cgPK];
        if (!c || w.confidence > c.confidence || (w.confidence === c.confidence && w.PK < c.PK)) {
          winnerByCgPK[cgPK] = { PK: w.PK, confidence: w.confidence };
        }
      }

      for (const w of filteredWrites) {
        if (!w?.PK?.startsWith("asset#")) continue;
        const cgPK = redirectMap[w.PK];
        if (!cgPK || winnerByCgPK[cgPK]?.PK !== w.PK) continue;
        sdk.log(`filterWrites: ${w.PK} -> ${cgPK} (override, confidence ${w.confidence}, $${w.price?.toFixed(4)})`);
        w.PK = cgPK;
      }
    }
  }

  const dedupedWrites = new Map<string, { write: Write; index: number }>();
  filteredWrites.forEach((w, index) => {
    if (!w) return;
    const key = `${w.PK}::${w.SK}`;
    const previous = dedupedWrites.get(key);
    if (!previous || w.confidence > previous.write.confidence) {
      dedupedWrites.set(key, { write: w, index });
    }
  });
  const writesAfterRewriteDedupe = [...dedupedWrites.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ write }) => write);

  // Drop asset writes whose CG slot is held fresh by a different adapter — the
  // current holder owns the slot until it goes stale, preventing secondary
  // adapters from cascading-clobbering each other.
  return writesAfterRewriteDedupe.filter((f: Write) => {
    if (!f) return false;
    if (!f.PK?.startsWith("asset#")) return true;
    const cgPK = redirectMap[f.PK];
    if (!cgPK) return true; // no CG redirect, keep it
    if (missingCgPKs.has(cgPK)) return true; // no CG entry, keep the asset write
    return canOverrideCgSlot(cgEntriesByPK[cgPK], f, nowTs);
  });
}

// Adapters that refresh the slot via their own direct write path (batchWrite,
// not this filter). They don't claim same-adapter exclusivity: a fresh slot
// held by one of these is treated the same as a slot held by coingecko itself,
// or one with no adapter field at all — no secondary adapter can override it
// unless the slot has gone stale.
const cgLikeAdapters = new Set(["coingecko", "updateCoin"]);

function canOverrideCgSlot(cgEntry: any, w: Write, nowTs: number): boolean {
  if (!cgEntry) return true; // slot is empty, anyone can take it
  const isStale = (nowTs - (cgEntry.timestamp ?? 0)) >= staleMargin;
  if (isStale) return true;
  if (cgEntry.adapter == null || cgLikeAdapters.has(cgEntry.adapter)) return false;
  // A specific secondary adapter holds the slot — only that adapter can self-update.
  return cgEntry.adapter === w.adapter;
}
function aggregateTokenAndRedirectData(reads: Read[]) {
  const coinData: CoinData[] = reads
    .map((r: Read) => {
      const addressIndex: number = r.dbEntry.PK.indexOf(":");
      const chainIndex = r.dbEntry.PK.indexOf("#");

      let price =
        r.redirect.length != 0 ? r.redirect[0].price : r.dbEntry.price;
      if (price == undefined) price = -1;

      const confidence =
        "confidence" in r.dbEntry
          ? r.dbEntry.confidence
          : r.redirect.length != 0 && "confidence" in r.redirect[0]
            ? r.redirect[0].confidence
            : undefined;

      return {
        chain:
          addressIndex == -1
            ? undefined
            : r.dbEntry.PK.substring(chainIndex + 1, addressIndex),
        address:
          addressIndex == -1
            ? r.dbEntry.PK
            : r.dbEntry.PK.substring(addressIndex + 1),
        decimals: r.dbEntry.decimals,
        symbol: r.dbEntry.symbol,
        price,
        timestamp: r.dbEntry.SK == 0 ? getCurrentUnixTimestamp() : r.dbEntry.SK,
        redirect:
          r.dbEntry.redirect ??
          (r.redirect.length ? r.redirect[0].PK : undefined),
        confidence,
      };
    })
    .filter((d: CoinData) => d.price != -1);

  return coinData;
}
export async function batchWriteWithAlerts(
  items: any[],
  failOnError: boolean,
): Promise<{ writeCount: number } | undefined> {
  try {
    const {
      previousItems,
      movementCheckHours,
      veryStaleItems,
      veryStaleHours,
      redirectChanges,
    } = await readPreviousValues(items);
    const filteredItems: any[] =
      (
        await checkMovement(
          items,
          previousItems,
          veryStaleItems,
          veryStaleHours,
          movementCheckHours,
        )
      ).filter((i: any) => isFinite(i.price) || i.redirect);
    const writeItems = [...filteredItems, ...redirectChanges]
    const ddbWriteResult = await batchWrite(writeItems, failOnError);

    // Dual-write: normalized PKs to DDB only (no alerts)
    const normalizedMap = new Map<string, any>();
    writeItems.forEach((item: any) => {
      const nPK = normalizedPKFor(item.PK);
      if (nPK === item.PK) return;
      const copy = { ...item, PK: nPK };
      if (copy.redirect) copy.redirect = normalizedPKFor(copy.redirect);
      normalizedMap.set(`${copy.PK}::${copy.SK}`, copy);
    });
    const normalizedItems = [...normalizedMap.values()];
    if (normalizedItems.length > 0) {
      await batchWrite(normalizedItems, false);
    }

    // Dual-write: ClickHouse + Redis (independent — Redis writes even if CH fails)
    const allItems = [...writeItems, ...normalizedItems];
    await dualWriteToChRedis(allItems).catch(e => {
      console.error(`[CH/Redis dual-write] non-fatal error: ${(e as Error).message}`);
      if (process.env.URGENT_COINS_WEBHOOK)
        sendMessage(`[CH/Redis dual-write] ${(e as Error).message}`, process.env.URGENT_COINS_WEBHOOK!, false).catch(() => {});
    });

    return ddbWriteResult;
  } catch (e) {
    const adapter = items.find((i) => i.adapter != null)?.adapter;
    console.log(`batchWriteWithAlerts failed with: ${e}`);
    if (process.env.URGENT_COINS_WEBHOOK)
      await sendMessage(
        `batchWriteWithAlerts ${adapter} failed with: ${e}`,
        process.env.URGENT_COINS_WEBHOOK!,
        true,
      );
    else
      await sendMessage(
        "batchWriteWithAlerts error but missing urgent webhook",
        process.env.STALE_COINS_ADAPTERS_WEBHOOK!,
        true,
      );
  }
}
async function readPreviousValues(
  items: any[],
  latencyHours: number = 6,
): Promise<{
  previousItems: DbEntry[];
  movementCheckHours: number;
  veryStaleItems: Map<string, number>;
  veryStaleHours: number;
  redirectChanges: any[];
}> {
  let queries: { PK: string; SK: number }[] = [];
  items.map(
    (t: any, i: number) => {
      if (i % 2) return;
      queries.push({
        PK: t.PK,
        SK: 0,
      });
    },
  );
  const results = await batchGet(queries);
  const now = getCurrentUnixTimestamp();
  const recentTime = now - latencyHours * 60 * 60;
  const veryStaleHours = 4 * latencyHours;
  const veryStaleTime = now - veryStaleHours * 60 * 60;
  const previousItems = results.filter(
    (r: any) => r.timestamp > recentTime || r.confidence > 1,
  );

  const veryStaleItems = new Map<string, number>();
  for (const r of results) {
    if (r && (r.timestamp ?? 0) < veryStaleTime) {
      veryStaleItems.set(r.PK, r.price ?? 0);
    }
  }

  const redirectChanges = findRedirectChanges(items, results);
  return {
    previousItems,
    movementCheckHours: latencyHours,
    veryStaleItems,
    veryStaleHours,
    redirectChanges,
  };
}
function findRedirectChanges(items: any[], results: any[]): any[] {
  const newRedirects: { [key: string]: any } = {};
  const oldRedirects: { [key: string]: any } = {};
  items.map((i: any) => {
    if (!i.redirect) return;
    newRedirects[i.PK] = i;
  });
  results.map((i: any) => {
    if (!i.redirect) return;
    oldRedirects[i.PK] = i;
  });

  const redirectChanges: any[] = [];
  Object.keys(newRedirects).map((n: string) => {
    const old = oldRedirects[n];
    if (!old) return;
    const { redirect, timestamp, PK, confidence } = newRedirects[n];
    if (old.redirect == redirect) return;
    redirectChanges.push({
      SK: timestamp,
      PK,
      adapter: old.adapter,
      confidence,
      redirect: old.redirect,
    });
  });

  return redirectChanges;
}
async function checkMovement(
  items: any[],
  previousItems: DbEntry[],
  veryStaleItems: Map<string, number>,
  veryStaleHours: number,
  movementCheckHours: number,
  margin: number = 0.5,
): Promise<any[]> {
  const filteredItems: any[] = [];
  const obj: { [PK: string]: any } = {};
  let errors: string = "";
  let staleAlerts: string = "";
  const now = getCurrentUnixTimestamp();
  const staleDownwardCheckTime = now - staleDownwardCheckHours * 60 * 60;
  const movementCheckTime = now - movementCheckHours * 60 * 60;
  previousItems.map((i: any) => (obj[i.PK] = i));

  items.map((d: any, i: number) => {
    if (i % 2 != 0) return;

    // Data beyond the configured very-stale threshold skips the % change check.
    if (veryStaleItems.has(d.PK)) {
      staleAlerts += `${d.PK} \t $${veryStaleItems.get(d.PK)} -> $${d.price}\n`;
      filteredItems.push(...[items[i], items[i + 1]]);
      return;
    }

    const previousItem = obj[d.PK];
    if (previousItem) {
      const percentageChange: number =
        (d.price - previousItem.price) / previousItem.price;
      const isStaleWithinMovementWindow =
        previousItem.timestamp != null &&
        previousItem.timestamp < staleDownwardCheckTime &&
        previousItem.timestamp > movementCheckTime;
      const isDownwardMoveBeyondMargin = percentageChange < -margin;

      if (percentageChange > margin) {
        errors += `${d.adapter} \t ${d.PK.substring(
          d.PK.indexOf("#") + 1,
        )} \t ${(percentageChange * 100).toFixed(3)}% change from $${previousItem.price
          } to $${d.price}\n`;
        return;
      }
      if (isStaleWithinMovementWindow && isDownwardMoveBeyondMargin) {
        errors += `${d.adapter} \t ${d.PK.substring(
          d.PK.indexOf("#") + 1,
        )} \t ${(percentageChange * 100).toFixed(3)}% change from $${previousItem.price
          } to $${d.price}\n`;
        return;
      }
    }
    filteredItems.push(...[items[i], items[i + 1]]);
  });

  // Fire-and-forget: a Discord outage must not block the writes we just validated
  if (staleAlerts != "" && process.env.STALE_COINS_ADAPTERS_WEBHOOK)
    sendMessage(
      `Stale coins (>${veryStaleHours}h) accepting updates:\n${staleAlerts}`,
      process.env.STALE_COINS_ADAPTERS_WEBHOOK,
      true,
    ).catch((e) => sdk.log(`checkMovement: stale-coins alert failed: ${e}`));

  return filteredItems.filter((v: any) => v != null);
}
export async function getDbMetadata(
  assets: string[],
  chain: string,
): Promise<Metadata> {
  const res: DbEntry[] = await batchGet(
    assets.map((a: string) => ({
      PK:
        chain == "coingecko"
          ? `coingecko#${a.toLowerCase()}`
          : `asset#${chain}:${lowercase(a, chain)}`,
      SK: 0,
    })),
  );
  const metadata: Metadata = {};
  res.map((r: DbEntry) => {
    metadata[r.PK.substring(r.PK.indexOf(":") + 1)] = {
      decimals: r.decimals,
      symbol: r.symbol,
    };
  });
  return metadata;
}
