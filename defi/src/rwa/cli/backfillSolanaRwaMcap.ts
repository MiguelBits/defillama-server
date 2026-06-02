/**
 * ============================================================================
 * Backfill historical onchain mcap / activemcap / totalsupply for a Solana RWA
 * ============================================================================
 *
 * Why this exists
 * ---------------
 * defillama-server has no Solana archive RPC, so the live cron only writes data
 * from the day an adapter is onboarded. Anything before that renders as 0 mcap
 * on the chart. Dune's `tokens_solana.transfers` table indexes Solana from
 * genesis, so cumulative `mint - burn` per day gives us the full historical
 * supply curve. Multiply by historical price (coins API) → mcap.
 *
 * What this script writes
 * -----------------------
 * - `mcap.solana`        ← supply × price   (only if missing or 0)
 * - `activemcap.solana`  ← same as mcap     (only if missing or 0)
 * - `totalsupply.solana` ← supply           (only if missing or 0)
 * - `aggregatemcap` / `aggregatedactivemcap` recomputed from the merged chain map.
 *
 * What it never touches
 * ---------------------
 * - Existing solana values that are already > 0 (live cron is authoritative).
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
 *       mint     (Text, required)
 *       decimals (Number, required)
 *
 *       WITH events AS (
 *         SELECT date_trunc('day', block_time) AS day,
 *                SUM(CASE WHEN action = 'mint' THEN amount
 *                         WHEN action = 'burn' THEN -amount END) AS net_change
 *         FROM tokens_solana.transfers
 *         WHERE token_mint_address = '{{mint}}'
 *           AND action IN ('mint', 'burn')
 *         GROUP BY 1
 *       )
 *       SELECT day,
 *              SUM(net_change) OVER (ORDER BY day) / pow(10, {{decimals}}) AS supply
 *       FROM events
 *       ORDER BY day;
 *
 *     Note the action labels are 'mint' / 'burn', NOT 'mintTo'. If you ever see
 *     the supply curve go negative, run this diagnostic to find the actual labels:
 *       SELECT action, COUNT(*), SUM(amount) / pow(10, <decimals>)
 *       FROM tokens_solana.transfers
 *       WHERE token_mint_address = '<mint>'
 *       GROUP BY action ORDER BY 2 DESC;
 *
 *     Note the query ID from the URL (e.g. dune.com/queries/7435636).
 *
 * ============================================================================
 * RUNBOOK — per-asset backfill
 * ============================================================================
 *
 * You'll need:
 *   - The internal RWA asset ID from `daily_rwa_data.id`. To find it for an
 *     asset whose chart already shows recent data, run:
 *       SELECT id, COUNT(*), MIN(timestamp), MAX(timestamp)
 *       FROM daily_rwa_data
 *       WHERE aggregatemcap > 0 AND mcap LIKE '%solana%'
 *       GROUP BY id ORDER BY MAX(timestamp) DESC;
 *     Cross-reference with the asset's expected current mcap.
 *   - The Solana mint address.
 *   - The token's decimals (Solscan → token program section).
 *
 * STEP 1 — Pull supply history from Dune to CSV.
 *
 *   DUNE_API_KEY=xxx ts-node defi/src/rwa/cli/fetchSolanaSupplyFromDune.ts \
 *     --query-id <YOUR_DUNE_QUERY_ID> \
 *     --mint <MINT_ADDRESS> \
 *     --decimals <DECIMALS> \
 *     --out ./<asset>.csv
 *
 *   Sanity check: the last row's `supply` should match Solscan's current supply
 *   for that mint, within ~1-3%. If it's wildly off, re-check the decimals or
 *   look for unusual Token-2022 extensions (most are fine, but a custom mint
 *   program may not emit standard `mint`/`burn` instructions).
 *
 * STEP 2 — Inspect the CSV for treasury-cap noise.
 *
 *   `head -50 ./<asset>.csv`. Many RWAs have a long flat section at the start
 *   where the issuer minted a treasury cap that didn't actually circulate, then
 *   later burned it down to real circulating supply (you'll see one large drop
 *   followed by organic growth). Pre-cap-burn is not real economic supply and
 *   should be excluded via --from-date set to the post-burn day. Skip this if
 *   the CSV starts cleanly.
 *
 * STEP 3 — Dry-run the backfill and open the HTML preview.
 *
 *   ts-node defi/src/rwa/cli/backfillSolanaRwaMcap.ts \
 *     --asset-id <ID> \
 *     --mint <MINT_ADDRESS> \
 *     --csv ./<asset>.csv \
 *     --from-date YYYY-MM-DD \   # optional, see step 2
 *     --dry-run \
 *     --out ./preview-<asset>.html
 *
 *   open ./preview-<asset>.html
 *
 *   The HTML shows red (current prod /chart/{id}) vs green (projected after
 *   backfill ships). Acceptance criteria:
 *     - Red and green overlap exactly from the live-cron start date onwards.
 *     - Green fills in the pre-cutover region cleanly with no spike artifacts.
 *     - Last-point mcap (after) matches what you'd expect from RWA.xyz
 *       within a few percent.
 *   If green diverges from red in the post-cutover region, STOP — the
 *   simulation has miscomputed multi-chain aggregates and the writes will
 *   damage live data.
 *
 * STEP 4 — Commit.
 *
 *   ts-node defi/src/rwa/cli/backfillSolanaRwaMcap.ts \
 *     --asset-id <ID> --mint <MINT> --csv ./<asset>.csv --from-date YYYY-MM-DD
 *
 *   Writes 80-200 rows in <1 minute. Touches `daily_rwa_data` and
 *   `backup_rwa_data` (skips `hourly_rwa_data` — old hourly rows are deleted by
 *   the prod cron anyway).
 *
 * STEP 5 — Verify.
 *
 *   Wait for the next prod chart-cache rebuild (runs every cron tick), then
 *   reload defillama.com/rwa/asset/<slug>. The chart should now show a
 *   continuous mcap curve through the previously-empty range.
 *
 * ============================================================================
 * Flags reference
 * ============================================================================
 *   --asset-id    REQUIRED. Internal RWA ID from daily_rwa_data.id.
 *   --mint        REQUIRED. Solana mint address.
 *   --csv         REQUIRED. Dune CSV path with `day,supply` columns.
 *   --from-date   YYYY-MM-DD. Skip CSV rows before this date (treasury cap).
 *   --flat-nav    Use a flat NAV (e.g. 1.00) instead of coins API. Useful when
 *                 the coins API has no historical price for the asset.
 *   --fallback-nearest-price
 *                 When the coins API has no price for a given day but DOES for
 *                 some other day in range, fall back to the chronologically
 *                 nearest known price. Useful for stablecoin-like RWAs where
 *                 the coins API only started indexing recently. Safer than a
 *                 hand-picked --flat-nav because it uses real data where it
 *                 exists. Off by default.
 *   --fill-missing-chains
 *                 When a candidate day has NO existing daily_rwa_data row,
 *                 carry forward the nearest prior existing row's chain maps
 *                 as the baseline before merging in the new chain's leg.
 *                 Prevents sawtooth charts caused by gap days where the new
 *                 chain is the only value present. Off by default.
 *   --dry-run     No writes. Prints summary, writes HTML preview to --out.
 *   --no-preview  Skip HTML preview during dry-run.
 *   --out         HTML preview path (default ./preview-<asset-id>.html).
 *
 * ============================================================================
 * Worked example — ONyc (id 175, mint 5Y8NV...2tcxp5, 9 decimals)
 * ============================================================================
 *
 *   DUNE_API_KEY=xxx ts-node defi/src/rwa/cli/fetchSolanaSupplyFromDune.ts \
 *     --query-id 7435636 \
 *     --mint 5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5 \
 *     --decimals 9 \
 *     --out ./onyc.csv
 *
 *   ts-node defi/src/rwa/cli/backfillSolanaRwaMcap.ts \
 *     --asset-id 175 \
 *     --mint 5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5 \
 *     --csv ./onyc.csv \
 *     --from-date 2025-11-29 \
 *     --dry-run --out ./preview-onyc.html
 *   open ./preview-onyc.html
 *
 *   # If preview looks correct:
 *   ts-node defi/src/rwa/cli/backfillSolanaRwaMcap.ts \
 *     --asset-id 175 \
 *     --mint 5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5 \
 *     --csv ./onyc.csv \
 *     --from-date 2025-11-29
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

const CHAIN = "solana";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const ASSET_ID = arg("--asset-id");
const MINT = arg("--mint");
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
const OUT = arg("--out") ?? `./preview-${ASSET_ID ?? "rwa"}.html`;

if (!ASSET_ID || !MINT || !CSV) {
  console.error("ERROR: --asset-id, --mint, --csv are all required");
  process.exit(1);
}

// Reject malformed/out-of-range YYYY-MM-DD: Date.UTC silently rolls e.g. Feb 31 → Mar 3.
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

const COIN_KEY = `solana:${MINT}`;

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

// Dune's tokens_solana.transfers query returns one row per day with a mint/burn
// event. Days where supply was unchanged are silently absent. Expand to a dense
// one-row-per-day series by carrying the most recent supply forward, from the
// first event day through today (UTC). This is the correct interpretation —
// "no event today" means "supply same as yesterday", not "supply = 0".
// Disable with --no-forward-fill if you want raw event-day-only behaviour.
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

// Fetch prices in bulk via the coins.llama.fi /chart endpoint (returns up to
// MAX_SPAN daily prices per request). Massively cheaper on the rate limiter
// than one-coin-one-timestamp /prices calls, which is what refillParallel.ts
// also does. Falls back to whatever's resolvable — un-resolved timestamps
// just become "supply-only" writes downstream.
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

  // chart endpoint indexes by approximate ts, not strict UTC day starts — pre-build
  // a UTC-day lookup so we can map response prices to requested timestamps.
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
  // use the chronologically-nearest known price. Only kicks in if the user
  // explicitly opts in via --fallback-nearest-price, since for volatile assets
  // this could distort mcap badly. For stablecoin-like RWAs it cleanly extends
  // a recent price back through supply-known but price-missing days.
  if (FALLBACK_NEAREST_PRICE && out.size > 0 && out.size < timestamps.length) {
    const resolvedTs = [...out.keys()].sort((a, b) => a - b);
    let filled = 0;
    for (const t of timestamps) {
      if (out.has(t)) continue;
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

// Treat null, undefined, 0, "0", and any non-finite as "missing".
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
  // What we will write (full chain maps, with solana merged in)
  newMcap: { [chain: string]: string };
  newActiveMcap: { [chain: string]: string };
  newTotalSupply: { [chain: string]: string };
  newAggregateMcap: number;
  newAggregateActiveMcap: number;
  // What changed (for logging)
  changed: { mcap: boolean; activeMcap: boolean; totalSupply: boolean };
  // For logging
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
        row = {
          mcap: { ...(prior.mcap ?? {}) },
          activemcap: { ...(prior.activemcap ?? {}) },
          totalsupply: { ...(prior.totalsupply ?? {}) },
        };
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
    let newSolanaMcap: number | null = null;
    if (mcapMissing) {
      if (!price || csvSupply <= 0) {
        // Can't compute mcap. May still be able to fill supply only.
      } else {
        newSolanaMcap = csvSupply * price;
      }
    }

    // Final per-chain values: keep existing if non-zero, else fill with new (when computable).
    const finalSolanaMcap = !mcapMissing
      ? Number(existingMcap[CHAIN])
      : (newSolanaMcap ?? 0);
    const finalSolanaActiveMcap = !activeMcapMissing
      ? Number(existingActiveMcap[CHAIN])
      : finalSolanaMcap; // activeMcap = onchainMcap when missing
    const finalSolanaSupply = !supplyMissing
      ? Number(existingSupply[CHAIN])
      : (csvSupply > 0 ? csvSupply : 0);

    // Did anything actually change?
    const mcapChanged = mcapMissing && newSolanaMcap != null;
    const activeMcapChanged = activeMcapMissing && finalSolanaActiveMcap > 0;
    const supplyChanged = supplyMissing && csvSupply > 0;
    if (!mcapChanged && !activeMcapChanged && !supplyChanged) {
      skipped++;
      continue;
    }

    // Build new chain maps. Spread existing first to preserve other chains.
    const newMcap = { ...existingMcap };
    const newActiveMcap = { ...existingActiveMcap };
    const newTotalSupply = { ...existingSupply };
    if (mcapChanged) newMcap[CHAIN] = String(finalSolanaMcap);
    if (activeMcapChanged) newActiveMcap[CHAIN] = String(finalSolanaActiveMcap);
    if (supplyChanged) newTotalSupply[CHAIN] = String(finalSolanaSupply);

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
  // Bucket by which columns changed → different updateOnDuplicate lists.
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

  // Path A: full set → write mcap + activemcap + totalsupply + aggregates.
  // updateOnDuplicate intentionally EXCLUDES defiactivetvl/aggregatedefiactivetvl/timestamp_actual.
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

  // Path B: only totalsupply → narrow updateOnDuplicate so we don't touch mcap.
  if (onlyTotalSupply.length > 0) {
    const dailyRows = onlyTotalSupply.map((w) => ({
      timestamp: w.dayTs,
      timestamp_actual: w.dayTs,
      id: ASSET_ID!,
      mcap: JSON.stringify(w.newMcap),         // unchanged values, but bulkCreate needs all PK + included cols
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
<meta charset="utf-8"><title>RWA backfill preview — id ${assetId}</title>
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
<h1>RWA backfill preview — id <code>${assetId}</code></h1>
<div class="sub">Same transform as prod <code>/chart/${assetId}</code> (smoothHistoricalData + trimLeadingZeros). Read-only.</div>
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
    `[backfill] DRY_RUN=${DRY_RUN} ASSET_ID=${ASSET_ID} MINT=${MINT} CSV=${CSV} ` +
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

  // We only need prices for days that actually need a new mcap.
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
