/**
 * ============================================================================
 * Backfill historical onchain mcap / activemcap / totalsupply for a Stellar RWA
 * ============================================================================
 *
 * Why this exists
 * ---------------
 * defi/l2/utils.ts:getStellarSupplies throws on any historical timestamp
 * (`timestamp incompatible with Stellar adapter!`), so refillParallel.ts and any
 * historical refill silently drops the entire Stellar leg via the swallowed
 * catch in atvlRefill.ts:getTotalSupplies. That left BENJI and BRZ with a
 * Stellar value of 0 across the May 11-21 rewrite, producing the +$600M cliff
 * users saw at the May 22 cron tick when the live "now" supply came back.
 *
 * Dune's `stellar.history_effects` indexes every ledger-effect since genesis,
 * including `account_debited` / `account_credited` on the issuer's own account.
 * Because a classic-asset issuer doesn't hold a trust line on its own asset,
 * supply ≡ -issuer_balance, so per-day cumulative
 * `account_debited - account_credited` ON the issuer's account gives the full
 * supply curve. This catches `payment`, `path_payment_strict_send/receive`,
 * `claim_claimable_balance`, `account_merge` — any op type that moves the
 * issuer's balance. Multiply by historical price (coins API) → mcap. Same model
 * as backfillSolanaRwaMcap.ts — read the prose there for the why behind
 * forward-fill, isMissing semantics, the dual updateOnDuplicate buckets, and
 * the dry-run preview's accept/reject criteria.
 *
 * What this script writes
 * -----------------------
 * - `mcap.stellar`        ← supply × price   (only if missing or 0)
 * - `activemcap.stellar`  ← same as mcap     (only if missing or 0)
 * - `totalsupply.stellar` ← supply           (only if missing or 0)
 * - `aggregatemcap` / `aggregatedactivemcap` recomputed from the merged chain map.
 *
 * What it never touches
 * ---------------------
 * - Existing stellar values that are already > 0 (live cron is authoritative).
 * - Other-chain entries inside any JSON column (preserved byte-for-byte).
 * - `defiactivetvl` and `aggregatedefiactivetvl`.
 *
 * ============================================================================
 * RUNBOOK — first time setup (one time per Dune account)
 * ============================================================================
 *
 * 1.  Get a Dune Plus API key. Free tier blocks API access.
 *     Save as DUNE_API_KEY env var.
 *
 * 2.  In the Dune UI, save the SQL below as a new query with two parameters:
 *       asset_code   (Text, required)
 *       asset_issuer (Text, required)
 *
 *       WITH events AS (
 *         SELECT
 *           DATE_TRUNC('day', closed_at) AS day,
 *           SUM(CASE
 *             WHEN type_string = 'account_debited'  THEN amount     -- issuer debited = supply ↑
 *             WHEN type_string = 'account_credited' THEN -amount    -- issuer credited = supply ↓
 *             ELSE 0
 *           END) AS net_change
 *         FROM stellar.history_effects
 *         WHERE asset_code   = '{{asset_code}}'
 *           AND asset_issuer = '{{asset_issuer}}'
 *           AND address      = '{{asset_issuer}}'  -- only effects on the issuer's own account
 *           AND type_string IN ('account_debited', 'account_credited')
 *         GROUP BY 1
 *       )
 *       SELECT day,
 *              SUM(net_change) OVER (ORDER BY day) AS supply
 *       FROM events
 *       ORDER BY day;
 *
 *     Note the query ID from the URL (e.g. dune.com/queries/XXXXXXX).
 *
 *     Sanity check before you trust the curve: run the query for an actively-
 *     traded asset (e.g. BENJI-GBHNGLLIE3KWGKCHIKMHJ5HVZHYIK7WTBE4QF5PLAKL4CJGSEU7HZIW5)
 *     and compare the LAST row's `supply` to the live Horizon value (you can
 *     get this from showRwaMcapBreakdown.ts). The previous ops-only formulation
 *     was 8% off on BENJI; the effects-based query should be exact (verified
 *     to within ~0.001%). If off by exactly 1e7 the column is stroops, divide
 *     by 1e7 in the SELECT.
 *
 * ============================================================================
 * RUNBOOK — per-asset backfill
 * ============================================================================
 *
 * You'll need:
 *   - The internal RWA asset ID from `daily_rwa_data.id`.
 *   - The Stellar `{CODE}-{ISSUER}` pair (e.g. BRZ-GABMA6FPH...IEO2).
 *
 * STEP 1 — Pull supply history from Dune to CSV.
 *
 *   DUNE_API_KEY=xxx ts-node defi/src/rwa/cli/fetchStellarSupplyFromDune.ts \
 *     --query-id <YOUR_DUNE_QUERY_ID> \
 *     --asset BRZ-GABMA6FPH3OJXNTGWO7PROF7I5WPQUZOB4BLTBTP4FK6QV7HWISLIEO2 \
 *     --out ./brz-stellar.csv
 *
 *   Sanity check: the last row's `supply` should match the live Horizon value
 *   (defi/l2/utils.ts:getStellarSupplies divided by 1e7) within ~1-3%. If it's
 *   wildly off, see the "Sanity check before you trust the curve" note above.
 *
 * STEP 2 — Inspect the CSV for treasury-cap noise.
 *
 *   `head -50 ./brz-stellar.csv`. Many anchored assets start with a treasury
 *   mint that wasn't really in circulation. Use --from-date to skip those rows.
 *
 * STEP 3 — Dry-run the backfill and open the HTML preview.
 *
 *   ts-node defi/src/rwa/cli/backfillStellarRwaMcap.ts \
 *     --asset-id <ID> \
 *     --asset BRZ-GABMA6FPH3OJXNTGWO7PROF7I5WPQUZOB4BLTBTP4FK6QV7HWISLIEO2 \
 *     --csv ./brz-stellar.csv \
 *     --from-date YYYY-MM-DD \   # optional
 *     --dry-run \
 *     --out ./preview-brz-stellar.html
 *
 *   open ./preview-brz-stellar.html
 *
 *   Same accept/reject criteria as the Solana backfill: red and green MUST
 *   overlap exactly from the live-cron start date onwards. Divergence in
 *   the post-cutover region means the simulation is wrong; do NOT ship.
 *
 * STEP 4 — Commit.
 *
 *   ts-node defi/src/rwa/cli/backfillStellarRwaMcap.ts \
 *     --asset-id <ID> --asset BRZ-GABMA... --csv ./brz-stellar.csv --from-date YYYY-MM-DD
 *
 * STEP 5 — Verify.
 *
 *   Wait for the next prod chart-cache rebuild, reload
 *   defillama.com/rwa/asset/<slug>. The chart should now show a continuous
 *   mcap curve through the previously-empty Stellar range.
 *
 * ============================================================================
 * Flags reference
 * ============================================================================
 *   --asset-id      REQUIRED. Internal RWA ID from daily_rwa_data.id.
 *   --asset         REQUIRED (or --asset-code + --asset-issuer).
 *                   Stellar asset in CODE-ISSUER form, e.g. BRZ-GABMA6FPH...
 *   --asset-code    Alternative to --asset: the asset code alone (e.g. "BRZ").
 *   --asset-issuer  Alternative to --asset: the issuer G-address.
 *   --csv           REQUIRED. Dune CSV path with `day,supply` columns.
 *   --from-date     YYYY-MM-DD. Skip CSV rows before this date.
 *   --flat-nav      Use a flat NAV instead of coins API. Useful when the coins
 *                   API has no historical price for the asset.
 *   --fallback-nearest-price
 *                   When the coins API has no price for a given day but DOES
 *                   for some other day in range, fall back to the chronologically
 *                   nearest known price for the missing day. Useful for
 *                   stablecoin-like RWAs (BENJI, USDC, etc.) where the coins API
 *                   only started indexing recently — extends today's $1-ish
 *                   price backward to fill the historical gap. Safer than a
 *                   hand-picked --flat-nav because it uses real coins-API data
 *                   where it exists. Off by default.
 *   --fill-missing-chains
 *                   When a candidate day has NO existing daily_rwa_data row,
 *                   carry forward the nearest prior existing row's chain maps
 *                   as the baseline before merging in the new chain's leg. Use
 *                   this when historical RWA rows are sparse (gap days where
 *                   the cron didn't write). Without this, missing days get
 *                   only the new chain's value and the chart sawteeths between
 *                   "full row" and "new-chain-only row" by exactly the size
 *                   of the other chains. Off by default.
 *   --dry-run       No writes. Prints summary, writes HTML preview to --out.
 *   --no-preview    Skip HTML preview during dry-run.
 *   --no-forward-fill  Treat the CSV as event-only (don't carry supply forward
 *                   through days with no payment activity). Off by default.
 *   --out           HTML preview path (default ./preview-<asset-id>.html).
 */

import * as fs from "fs";
import * as path from "path";
import {
  initPG,
  fetchDailyRecordsForIdPG,
  fetchDailyRecordsWithChainsForIdPG,
  DAILY_RWA_DATA,
  BACKUP_RWA_DATA,
} from "../db";
import { smoothHistoricalData, toFiniteNumberOrZero, HistoricalRecord } from "../utils";
import { trimLeadingZeros } from "../cron";

const CHAIN = "stellar";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const ASSET_ID = arg("--asset-id");
let ASSET_CODE = arg("--asset-code");
let ASSET_ISSUER = arg("--asset-issuer");
const ASSET = arg("--asset");
if (ASSET && (!ASSET_CODE || !ASSET_ISSUER)) {
  const dashIdx = ASSET.lastIndexOf("-");
  if (dashIdx > 0) {
    ASSET_CODE = ASSET_CODE ?? ASSET.substring(0, dashIdx);
    ASSET_ISSUER = ASSET_ISSUER ?? ASSET.substring(dashIdx + 1);
  }
}
const CSV = arg("--csv");
const FROM_DATE = arg("--from-date");
const FLAT_NAV_RAW = arg("--flat-nav");
const FLAT_NAV = FLAT_NAV_RAW != null ? Number(FLAT_NAV_RAW) : null;
if (FLAT_NAV_RAW != null && (!Number.isFinite(FLAT_NAV) || (FLAT_NAV as number) <= 0)) {
  console.error(`ERROR: --flat-nav "${FLAT_NAV_RAW}" must be a positive number`);
  process.exit(1);
}
const DRY_RUN = process.argv.includes("--dry-run");
const NO_PREVIEW = process.argv.includes("--no-preview");
const FALLBACK_NEAREST_PRICE = process.argv.includes("--fallback-nearest-price");
const FILL_MISSING_CHAINS = process.argv.includes("--fill-missing-chains");
const OUT = arg("--out") ?? `./preview-${ASSET_ID ?? "rwa"}-stellar.html`;

if (!ASSET_ID || !ASSET_CODE || !ASSET_ISSUER || !CSV) {
  console.error("ERROR: --asset-id, (--asset OR --asset-code+--asset-issuer), --csv are all required");
  process.exit(1);
}

function parseIsoDayUtc(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const ts = Math.floor(Date.UTC(y, m - 1, d) / 1000);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10) === day ? ts : null;
}
const FROM_TS = FROM_DATE ? parseIsoDayUtc(FROM_DATE) : null;
if (FROM_DATE && FROM_TS == null) {
  console.error(`ERROR: --from-date "${FROM_DATE}" is not a valid YYYY-MM-DD date`);
  process.exit(1);
}

// Coins API key format for Stellar mirrors what showRwaMcapBreakdown queries
// (and what the live fetchSupplies returns under): `stellar:{CODE}-{ISSUER}`.
const COIN_KEY = `stellar:${ASSET_CODE}-${ASSET_ISSUER}`;

interface DaySupply { dayTs: number; supply: number }

function parseCsv(filePath: string): DaySupply[] {
  const text = fs.readFileSync(path.resolve(filePath), "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase().replace(/^"|"$/g, ""));
  const dayIdx = header.indexOf("day");
  const supIdx = header.indexOf("supply");
  if (dayIdx < 0 || supIdx < 0) throw new Error(`CSV must have "day" and "supply" headers`);
  return lines.slice(1).filter((l) => l.trim().length > 0).map((line) => {
    const cols = line.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    const isoDay = cols[dayIdx].split(/[ T]/)[0];
    const [y, m, d] = isoDay.split("-").map(Number);
    const dayTs = Math.floor(Date.UTC(y, m - 1, d) / 1000);
    const supply = Number(cols[supIdx]);
    if (!Number.isFinite(dayTs) || !Number.isFinite(supply)) throw new Error(`Bad CSV row: ${line}`);
    return { dayTs, supply };
  });
}

// Dune's stellar.history_operations query returns one row per day with payment
// activity. Days where supply was unchanged are silently absent. Expand to a
// dense one-row-per-day series by carrying the most recent supply forward.
function expandForwardFill(sparse: DaySupply[]): DaySupply[] {
  if (sparse.length === 0) return [];
  const sorted = [...sparse].sort((a, b) => a.dayTs - b.dayTs);
  const eventByDay = new Map<number, number>(sorted.map((d) => [d.dayTs, d.supply]));
  const now = new Date();
  const startOfTodayUtc = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  const endTs = Math.max(sorted[sorted.length - 1].dayTs, startOfTodayUtc);
  const out: DaySupply[] = [];
  let cur = sorted[0].supply;
  for (let t = sorted[0].dayTs; t <= endTs; t += 86400) {
    if (eventByDay.has(t)) cur = eventByDay.get(t) as number;
    out.push({ dayTs: t, supply: cur });
  }
  return out;
}

async function getPriceMap(timestamps: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (FLAT_NAV != null) {
    for (const t of timestamps) out.set(t, FLAT_NAV);
    return out;
  }
  if (timestamps.length === 0) return out;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const minTs = sorted[0];
  const maxTs = sorted[sorted.length - 1];
  const totalSpanDays = Math.ceil((maxTs - minTs) / 86400) + 1;
  const MAX_SPAN = 500;

  const dayToReqTs = new Map<string, number>();
  for (const t of timestamps) {
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    if (!dayToReqTs.has(d)) dayToReqTs.set(d, t);
  }

  let cursor = minTs;
  let remaining = totalSpanDays;
  while (remaining > 0) {
    const span = Math.min(remaining, MAX_SPAN);
    const url = `https://coins.llama.fi/chart/${encodeURIComponent(COIN_KEY)}?start=${cursor}&span=${span}&period=1d&searchWidth=4h`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: any = await resp.json();
      const prices: Array<{ timestamp: number; price: number }> = data?.coins?.[COIN_KEY]?.prices ?? [];
      for (const p of prices) {
        const day = new Date(p.timestamp * 1000).toISOString().slice(0, 10);
        const reqTs = dayToReqTs.get(day);
        if (reqTs != null && Number.isFinite(p.price)) out.set(reqTs, Number(p.price));
      }
    } catch (e) {
      console.error(`[backfill] /chart failed at cursor=${cursor} span=${span}: ${(e as any)?.message || e}`);
    }
    cursor += span * 86400;
    remaining -= span;
  }

  // Optional fallback: for timestamps where the coins API returned no price,
  // use the chronologically-nearest known price (forward and backward search,
  // tie goes to the future). Only kicks in if the user explicitly opts in via
  // --fallback-nearest-price, since for volatile assets this could distort
  // mcap badly. For stablecoin-like RWAs (BENJI, etc.) it cleanly extends the
  // recent-era price back through the supply-known but price-missing days.
  if (FALLBACK_NEAREST_PRICE && out.size > 0 && out.size < timestamps.length) {
    const resolvedTs = [...out.keys()].sort((a, b) => a - b);
    let filled = 0;
    for (const t of timestamps) {
      if (out.has(t)) continue;
      // Binary search would be nicer but timestamps.length is small (<10k).
      let bestTs = resolvedTs[0];
      let bestDist = Math.abs(t - bestTs);
      for (const rt of resolvedTs) {
        const d = Math.abs(t - rt);
        if (d < bestDist) {
          bestDist = d;
          bestTs = rt;
        } else if (d === bestDist && rt > bestTs) {
          // Tie-break: prefer later timestamps (recent prices are more reliable)
          bestTs = rt;
        }
      }
      out.set(t, out.get(bestTs)!);
      filled++;
    }
    console.log(`[backfill] price fallback: filled ${filled} missing-price days using nearest known coin price`);
  }

  return out;
}

function isMissing(v: any): boolean {
  if (v == null) return true;
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

function sumChainValues(chainMap: { [chain: string]: any } | null | undefined): number {
  if (!chainMap) return 0;
  let total = 0;
  for (const v of Object.values(chainMap)) {
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

interface PlannedWrite {
  dayTs: number;
  newMcap: { [chain: string]: string };
  newActiveMcap: { [chain: string]: string };
  newTotalSupply: { [chain: string]: string };
  newAggregateMcap: number;
  newAggregateActiveMcap: number;
  changed: { mcap: boolean; activeMcap: boolean; totalSupply: boolean };
  csvSupply: number;
  resolvedPrice: number | null;
}

async function plan(
  candidates: DaySupply[],
  priceMap: Map<number, number>,
  chainsByTs: Map<number, any>,
): Promise<{ writes: PlannedWrite[]; skipped: number }> {
  const writes: PlannedWrite[] = [];
  let skipped = 0;

  // For --fill-missing-chains: build a sorted list of existing-row timestamps
  // so we can carry-forward the nearest prior row's chain maps onto days where
  // no existing row was written.
  const existingTsSorted = FILL_MISSING_CHAINS
    ? [...chainsByTs.keys()].sort((a, b) => a - b)
    : [];
  let carriedForwardCount = 0;
  function findPriorExistingRow(targetTs: number): any | null {
    // Binary search for the largest ts <= targetTs.
    let lo = 0, hi = existingTsSorted.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (existingTsSorted[mid] <= targetTs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return null;
    return chainsByTs.get(existingTsSorted[best]) ?? null;
  }

  for (const { dayTs, supply: csvSupply } of candidates) {
    let row = chainsByTs.get(dayTs);
    if (!row && FILL_MISSING_CHAINS) {
      const prior = findPriorExistingRow(dayTs);
      if (prior) {
        // Build a synthetic baseline from the prior row's chain maps. Treat as
        // existing for the purpose of preserving other chains, but DON'T mark
        // any of these as "already-populated" — the isMissing check still
        // looks at CHAIN ("stellar"), which is what we're filling in.
        row = {
          mcap: { ...(prior.mcap ?? {}) },
          activemcap: { ...(prior.activemcap ?? {}) },
          totalsupply: { ...(prior.totalsupply ?? {}) },
        };
        // Don't carry forward a stale stellar value; this script will overwrite it.
        delete row.mcap[CHAIN];
        delete row.activemcap[CHAIN];
        delete row.totalsupply[CHAIN];
        carriedForwardCount++;
      }
    }
    const existingMcap = row?.mcap ?? {};
    const existingActiveMcap = row?.activemcap ?? {};
    const existingSupply = row?.totalsupply ?? {};

    const mcapMissing = isMissing(existingMcap[CHAIN]);
    const activeMcapMissing = isMissing(existingActiveMcap[CHAIN]);
    const supplyMissing = isMissing(existingSupply[CHAIN]);

    if (!mcapMissing && !activeMcapMissing && !supplyMissing) continue;

    const price = priceMap.get(dayTs);
    let newStellarMcap: number | null = null;
    if (mcapMissing) {
      if (!price || csvSupply <= 0) {
        // Can't compute mcap. May still fill supply only.
      } else {
        newStellarMcap = csvSupply * price;
      }
    }

    const finalStellarMcap = !mcapMissing
      ? Number(existingMcap[CHAIN])
      : (newStellarMcap ?? 0);
    const finalStellarActiveMcap = !activeMcapMissing
      ? Number(existingActiveMcap[CHAIN])
      : finalStellarMcap;
    const finalStellarSupply = !supplyMissing
      ? Number(existingSupply[CHAIN])
      : (csvSupply > 0 ? csvSupply : 0);

    const mcapChanged = mcapMissing && newStellarMcap != null;
    const activeMcapChanged = activeMcapMissing && finalStellarActiveMcap > 0;
    const supplyChanged = supplyMissing && csvSupply > 0;
    if (!mcapChanged && !activeMcapChanged && !supplyChanged) {
      skipped++;
      continue;
    }

    const newMcap = { ...existingMcap };
    const newActiveMcap = { ...existingActiveMcap };
    const newTotalSupply = { ...existingSupply };
    if (mcapChanged) newMcap[CHAIN] = String(finalStellarMcap);
    if (activeMcapChanged) newActiveMcap[CHAIN] = String(finalStellarActiveMcap);
    if (supplyChanged) newTotalSupply[CHAIN] = String(finalStellarSupply);

    writes.push({
      dayTs,
      newMcap,
      newActiveMcap,
      newTotalSupply,
      newAggregateMcap: sumChainValues(newMcap),
      newAggregateActiveMcap: sumChainValues(newActiveMcap),
      changed: { mcap: mcapChanged, activeMcap: activeMcapChanged, totalSupply: supplyChanged },
      csvSupply,
      resolvedPrice: price ?? null,
    });
  }

  if (FILL_MISSING_CHAINS && carriedForwardCount > 0) {
    console.log(`[backfill] fill-missing-chains: carried prior-row chain values onto ${carriedForwardCount} previously-empty days`);
  }
  return { writes, skipped };
}

async function commitWrites(writes: PlannedWrite[]) {
  const onlyTotalSupply: PlannedWrite[] = [];
  const fullSet: PlannedWrite[] = [];
  for (const w of writes) {
    if (!w.changed.mcap && !w.changed.activeMcap && w.changed.totalSupply) {
      onlyTotalSupply.push(w);
    } else {
      fullSet.push(w);
    }
  }

  const now = new Date();

  if (fullSet.length > 0) {
    const dailyRows = fullSet.map((w) => ({
      timestamp: w.dayTs,
      timestamp_actual: w.dayTs,
      id: ASSET_ID!,
      mcap: JSON.stringify(w.newMcap),
      activemcap: JSON.stringify(w.newActiveMcap),
      totalsupply: JSON.stringify(w.newTotalSupply),
      aggregatemcap: w.newAggregateMcap,
      aggregatedactivemcap: w.newAggregateActiveMcap,
      created_at: now,
      updated_at: now,
    }));
    const backupRows = dailyRows.map(({ timestamp_actual, ...row }) => row);
    const upd = ["mcap", "activemcap", "totalsupply", "aggregatemcap", "aggregatedactivemcap", "updated_at"];
    await DAILY_RWA_DATA.bulkCreate(dailyRows as any[], { updateOnDuplicate: upd });
    await BACKUP_RWA_DATA.bulkCreate(backupRows as any[], { updateOnDuplicate: upd });
  }

  if (onlyTotalSupply.length > 0) {
    const dailyRows = onlyTotalSupply.map((w) => ({
      timestamp: w.dayTs,
      timestamp_actual: w.dayTs,
      id: ASSET_ID!,
      mcap: JSON.stringify(w.newMcap),
      activemcap: JSON.stringify(w.newActiveMcap),
      totalsupply: JSON.stringify(w.newTotalSupply),
      aggregatemcap: w.newAggregateMcap,
      aggregatedactivemcap: w.newAggregateActiveMcap,
      created_at: now,
      updated_at: now,
    }));
    const backupRows = dailyRows.map(({ timestamp_actual, ...row }) => row);
    const upd = ["totalsupply", "updated_at"];
    await DAILY_RWA_DATA.bulkCreate(dailyRows as any[], { updateOnDuplicate: upd });
    await BACKUP_RWA_DATA.bulkCreate(backupRows as any[], { updateOnDuplicate: upd });
  }
}

// Mirror prod cron's transform exactly (cron.ts:213-221).
function applyProdTransform(records: any[]): HistoricalRecord[] {
  const mapped: HistoricalRecord[] = records.map((record) => ({
    timestamp: record.timestamp,
    onChainMcap: toFiniteNumberOrZero(record.aggregatemcap),
    defiActiveTvl: toFiniteNumberOrZero(record.aggregatedefiactivetvl),
    activeMcap: toFiniteNumberOrZero(record.aggregatedactivemcap),
  }));
  return trimLeadingZeros(smoothHistoricalData(mapped));
}

function buildSimulatedAggRows(existingAgg: any[], writes: PlannedWrite[]): any[] {
  const byTs = new Map<number, any>();
  for (const r of existingAgg) byTs.set(r.timestamp, { ...r });
  for (const w of writes) {
    const existing = byTs.get(w.dayTs) ?? {
      timestamp: w.dayTs,
      aggregatemcap: 0,
      aggregatedactivemcap: 0,
      aggregatedefiactivetvl: 0,
    };
    byTs.set(w.dayTs, {
      timestamp: w.dayTs,
      aggregatemcap: w.newAggregateMcap,
      aggregatedactivemcap: w.newAggregateActiveMcap,
      aggregatedefiactivetvl: toFiniteNumberOrZero(existing.aggregatedefiactivetvl),
    });
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function renderHtml(
  before: HistoricalRecord[],
  after: HistoricalRecord[],
  fromTs: number | null,
  cutoverTs: number | null,
  writes: PlannedWrite[],
  skipped: number,
  assetId: string,
): string {
  const beforePts = before.map((r) => ({ x: r.timestamp * 1000, y: r.onChainMcap }));
  const afterPts = after.map((r) => ({ x: r.timestamp * 1000, y: r.onChainMcap }));
  const fmtUSD = (n: number) => "$" + (n / 1e6).toFixed(2) + "M";
  const fmtDate = (ts: number | null) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "n/a");
  const lastBefore = before[before.length - 1];
  const lastAfter = after[after.length - 1];
  const fullCount = writes.filter((w) => w.changed.mcap || w.changed.activeMcap).length;
  const supplyOnlyCount = writes.length - fullCount;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>RWA Stellar backfill preview — id ${assetId}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 24px; background: #0e1116; color: #e6e6e6; }
  h1 { margin: 0 0 4px 0; font-weight: 600; }
  .sub { color: #8b949e; font-size: 14px; margin-bottom: 20px; }
  .stats { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; flex-wrap: wrap; }
  .stat { background: #161b22; padding: 12px 16px; border-radius: 6px; border: 1px solid #30363d; }
  .stat-label { color: #8b949e; }
  .stat-value { font-weight: 600; font-size: 16px; }
  .chart-wrap { background: #161b22; padding: 16px; border-radius: 6px; border: 1px solid #30363d; }
  canvas { max-height: 520px; }
  .legend-note { font-size: 12px; color: #8b949e; margin-top: 12px; }
  code { background: #21262d; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
</style></head><body>
<h1>RWA Stellar backfill preview — id <code>${assetId}</code></h1>
<div class="sub">Asset <code>${ASSET_CODE}-${ASSET_ISSUER}</code>. Same transform as prod <code>/chart/${assetId}</code> (smoothHistoricalData + trimLeadingZeros). Read-only.</div>
<div class="stats">
  <div class="stat"><div class="stat-label">Would write</div><div class="stat-value">${fullCount} full + ${supplyOnlyCount} supply-only</div></div>
  <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value">${skipped}</div></div>
  <div class="stat"><div class="stat-label">Last point — before</div><div class="stat-value">${lastBefore ? fmtUSD(lastBefore.onChainMcap) : "n/a"}</div></div>
  <div class="stat"><div class="stat-label">Last point — after</div><div class="stat-value">${lastAfter ? fmtUSD(lastAfter.onChainMcap) : "n/a"}</div></div>
  <div class="stat"><div class="stat-label">Series — before / after</div><div class="stat-value">${before.length} / ${after.length}</div></div>
  <div class="stat"><div class="stat-label">From / cutover</div><div class="stat-value">${fmtDate(fromTs)} / ${fmtDate(cutoverTs)}</div></div>
</div>
<div class="chart-wrap"><canvas id="chart"></canvas></div>
<div class="legend-note">
  Red = current prod chart. Green = projected after backfill ships. Lines should overlap from
  the live-cron start date onwards — only the pre-cutover region should change. Divergence in
  the post-cutover region means the simulation is wrong; do NOT ship.
</div>
<script>
  const before = ${JSON.stringify(beforePts)};
  const after = ${JSON.stringify(afterPts)};
  new Chart(document.getElementById('chart'), {
    type: 'line',
    data: { datasets: [
      { label: 'Before backfill (current prod)', data: before, borderColor: '#f85149',
        borderWidth: 2, pointRadius: 0, tension: 0.1 },
      { label: 'After backfill (projected)', data: after, borderColor: '#3fb950',
        borderWidth: 2, pointRadius: 0, tension: 0.1 },
    ]},
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'time', time: { unit: 'month' }, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
        y: {
          ticks: { color: '#8b949e', callback: (v) => '$' + (v / 1e6).toFixed(0) + 'M' },
          grid: { color: '#30363d' },
        },
      },
      plugins: {
        legend: { labels: { color: '#e6e6e6' } },
        tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': $' + (ctx.parsed.y / 1e6).toFixed(2) + 'M' } },
      },
    },
  });
</script></body></html>`;
}

async function main() {
  console.log(
    `[backfill] DRY_RUN=${DRY_RUN} ASSET_ID=${ASSET_ID} ASSET=${ASSET_CODE}-${ASSET_ISSUER} CSV=${CSV} ` +
    `FROM_DATE=${FROM_DATE ?? "(none)"} FLAT_NAV=${FLAT_NAV ?? "(coins API)"}`
  );
  await initPG();

  const existingAgg = await fetchDailyRecordsForIdPG(ASSET_ID!);
  const existingChains = await fetchDailyRecordsWithChainsForIdPG(ASSET_ID!);
  const chainsByTs = new Map<number, any>();
  for (const r of existingChains) chainsByTs.set(r.timestamp, r);
  console.log(`[backfill] fetched ${existingAgg.length} existing daily rows for id=${ASSET_ID}`);

  const rawSeries = parseCsv(CSV!);
  const NO_FORWARD_FILL = process.argv.includes("--no-forward-fill");
  const series = NO_FORWARD_FILL ? rawSeries : expandForwardFill(rawSeries);
  if (!NO_FORWARD_FILL) {
    console.log(`[backfill] forward-fill: ${rawSeries.length} event rows → ${series.length} dense daily rows`);
  }
  const candidates = series.filter((d) => FROM_TS == null || d.dayTs >= FROM_TS);
  console.log(`[backfill] csv rows: ${series.length}; candidates after --from-date: ${candidates.length}`);

  const needsPriceFetch = candidates.filter((d) => {
    const row = chainsByTs.get(d.dayTs);
    return isMissing(row?.mcap?.[CHAIN]);
  });
  const priceMap = await getPriceMap(needsPriceFetch.map((d) => d.dayTs));
  const pricesResolved = needsPriceFetch.filter((d) => priceMap.has(d.dayTs)).length;
  console.log(`[backfill] prices resolved: ${pricesResolved} / ${needsPriceFetch.length}`);

  const { writes, skipped } = await plan(candidates, priceMap, chainsByTs);
  const fullCount = writes.filter((w) => w.changed.mcap || w.changed.activeMcap).length;
  const supplyOnlyCount = writes.length - fullCount;
  console.log(
    `[backfill] would write: ${fullCount} full (mcap/activemcap/+supply) + ${supplyOnlyCount} supply-only; ` +
    `skipped (already populated): ${skipped}`
  );

  if (DRY_RUN) {
    for (const w of writes.slice(0, 5)) {
      const date = new Date(w.dayTs * 1000).toISOString().slice(0, 10);
      const tag = w.changed.mcap || w.changed.activeMcap ? "full" : "supply-only";
      console.log(
        `[dry-run ${tag}] ${date} supply=${w.csvSupply.toFixed(2)} ` +
        `price=${w.resolvedPrice?.toFixed(4) ?? "(kept)"} aggMcap=$${(w.newAggregateMcap / 1e6).toFixed(2)}M`
      );
    }
    if (writes.length > 10) console.log(`[dry-run] ... ${writes.length - 10} rows omitted ...`);
    for (const w of writes.slice(-5)) {
      const date = new Date(w.dayTs * 1000).toISOString().slice(0, 10);
      const tag = w.changed.mcap || w.changed.activeMcap ? "full" : "supply-only";
      console.log(
        `[dry-run ${tag}] ${date} supply=${w.csvSupply.toFixed(2)} ` +
        `price=${w.resolvedPrice?.toFixed(4) ?? "(kept)"} aggMcap=$${(w.newAggregateMcap / 1e6).toFixed(2)}M`
      );
    }

    if (!NO_PREVIEW) {
      const before = applyProdTransform(existingAgg);
      const simulatedAgg = buildSimulatedAggRows(existingAgg, writes);
      const after = applyProdTransform(simulatedAgg);
      const fullWrites = writes.filter((w) => w.changed.mcap || w.changed.activeMcap);
      const cutoverTs = fullWrites.length > 0 ? fullWrites[fullWrites.length - 1].dayTs : null;
      const html = renderHtml(before, after, FROM_TS, cutoverTs, writes, skipped, ASSET_ID!);
      const outPath = path.resolve(OUT);
      fs.writeFileSync(outPath, html);
      console.log(`[backfill] preview written: ${outPath}`);
      console.log(`[backfill] open it:  open "${outPath}"`);
    }
    console.log(`[backfill] DRY RUN — no writes performed`);
    return;
  }

  if (writes.length === 0) {
    console.log(`[backfill] nothing to write`);
    return;
  }
  await commitWrites(writes);
  console.log(`[backfill] wrote ${writes.length} rows (${fullCount} full + ${supplyOnlyCount} supply-only)`);
}

main()
  .catch((e) => { console.error("[backfill] fatal:", e); process.exit(1); })
  .then(() => process.exit(0));
