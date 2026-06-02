/**
 * Fetch a Stellar classic asset's daily supply history from Dune and write a CSV
 * that `backfillStellarRwaMcap.ts` (and future per-asset Stellar backfills) can
 * consume. Stellar analog of fetchSolanaSupplyFromDune.ts.
 *
 * Prereq: save the SQL below as a Dune query with two parameters
 * (asset_code, asset_issuer), note its query ID, then pass it via --query-id.
 * Dune Plus or above is required for API access.
 *
 *   WITH events AS (
 *     SELECT
 *       DATE_TRUNC('day', closed_at) AS day,
 *       SUM(CASE
 *         WHEN type_string = 'account_debited'  THEN amount     -- issuer debited = supply ↑
 *         WHEN type_string = 'account_credited' THEN -amount    -- issuer credited = supply ↓
 *         ELSE 0
 *       END) AS net_change
 *     FROM stellar.history_effects
 *     WHERE asset_code   = '{{asset_code}}'
 *       AND asset_issuer = '{{asset_issuer}}'
 *       AND address      = '{{asset_issuer}}'   -- only effects on the issuer's own account
 *       AND type_string IN ('account_debited', 'account_credited')
 *     GROUP BY 1
 *   )
 *   SELECT day,
 *          SUM(net_change) OVER (ORDER BY day) AS supply
 *   FROM events
 *   ORDER BY day;
 *
 * Notes on the SQL:
 *   - Why `history_effects` and not `history_operations`: a Stellar classic-asset
 *     issuer doesn't hold a trust line on its own asset, so supply ≡ -issuer_balance.
 *     Every `account_debited` effect on the issuer = supply up; every
 *     `account_credited` = supply down. This catches `payment`, `path_payment_*`,
 *     `claim_claimable_balance`, `account_merge` — anything that moves the
 *     issuer's balance. An ops-only query (payment + clawback) under-counts for
 *     actively-traded assets by 5-10% (verified against BENJI: 8% off).
 *   - Stellar classic-asset `amount` is human-readable (Dune normalizes Stellar's
 *     7-decimal stroop convention). No `pow(10, decimals)` divisor needed.
 *   - Sanity check: the last row's supply should match the live Stellar Horizon
 *     value (defi/l2/utils.ts:getStellarSupplies divided by 1e7) within ~0.001%.
 *     If it's off by >1%, something op-specific is leaking.
 *
 * Auth: reads DUNE_API_KEY (preferred) or first entry of DUNE_API_KEYS.
 *
 * Usage:
 *   DUNE_API_KEY=xxx ts-node defi/src/rwa/cli/fetchStellarSupplyFromDune.ts \
 *     --query-id 1234567 \
 *     --asset BRZ-GABMA6FPH3OJXNTGWO7PROF7I5WPQUZOB4BLTBTP4FK6QV7HWISLIEO2 \
 *     --out ./brz-stellar.csv
 *
 *   # Or pass --asset-code / --asset-issuer separately:
 *   ts-node defi/src/rwa/cli/fetchStellarSupplyFromDune.ts \
 *     --query-id 1234567 \
 *     --asset-code BRZ \
 *     --asset-issuer GABMA6FPH3OJXNTGWO7PROF7I5WPQUZOB4BLTBTP4FK6QV7HWISLIEO2 \
 *     --out ./brz-stellar.csv
 */

import axios from "axios";
import * as fs from "fs";
import * as path from "path";

const DUNE_BASE = "https://api.dune.com/api/v1";
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = Number(process.env.DUNE_POLL_TIMEOUT_MS ?? 30 * 60 * 1000); // 30 min default

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const QUERY_ID = arg("--query-id");
let ASSET_CODE = arg("--asset-code");
let ASSET_ISSUER = arg("--asset-issuer");
const ASSET = arg("--asset"); // CODE-ISSUER convenience form
const OUT = arg("--out");

if (ASSET && (!ASSET_CODE || !ASSET_ISSUER)) {
  // Split on the LAST '-' to tolerate codes that themselves contain hyphens.
  const dashIdx = ASSET.lastIndexOf("-");
  if (dashIdx > 0) {
    ASSET_CODE = ASSET_CODE ?? ASSET.substring(0, dashIdx);
    ASSET_ISSUER = ASSET_ISSUER ?? ASSET.substring(dashIdx + 1);
  }
}

if (!QUERY_ID || !ASSET_CODE || !ASSET_ISSUER || !OUT) {
  console.error("ERROR: --query-id, (--asset OR --asset-code + --asset-issuer), and --out are all required");
  process.exit(1);
}

const apiKey = process.env.DUNE_API_KEY ?? process.env.DUNE_API_KEYS?.split(",")[0];
if (!apiKey) {
  console.error("ERROR: DUNE_API_KEY or DUNE_API_KEYS must be set");
  process.exit(1);
}

const headers = { "X-Dune-API-Key": apiKey };

async function execute(): Promise<string> {
  const url = `${DUNE_BASE}/query/${QUERY_ID}/execute`;
  const body = { query_parameters: { asset_code: ASSET_CODE, asset_issuer: ASSET_ISSUER } };
  const res = await axios.post(url, body, { headers });
  const id = res.data?.execution_id;
  if (!id) throw new Error(`No execution_id from Dune: ${JSON.stringify(res.data)}`);
  return id;
}

async function pollUntilDone(executionId: string): Promise<void> {
  const start = Date.now();
  let last = "";
  while (true) {
    const res = await axios.get(`${DUNE_BASE}/execution/${executionId}/status`, { headers });
    const state = res.data?.state;
    if (state !== last) {
      console.log(`[dune] state=${state}`);
      last = state;
    }
    if (state === "QUERY_STATE_COMPLETED") return;
    if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED") {
      throw new Error(`Dune execution ${state}: ${JSON.stringify(res.data)}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Dune execution timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

interface DuneResultRow {
  day: string;
  supply: number | string;
  [k: string]: any;
}

async function fetchResults(executionId: string): Promise<DuneResultRow[]> {
  const rows: DuneResultRow[] = [];
  let nextUri: string | null = `${DUNE_BASE}/execution/${executionId}/results?limit=10000`;
  while (nextUri) {
    const res: any = await axios.get(nextUri, { headers });
    const batch: DuneResultRow[] = res.data?.result?.rows ?? [];
    rows.push(...batch);
    const nextOffset: number | null | undefined = res.data?.next_offset;
    nextUri = nextOffset != null
      ? `${DUNE_BASE}/execution/${executionId}/results?limit=10000&offset=${nextOffset}`
      : null;
  }
  return rows;
}

function toCsv(rows: DuneResultRow[]): string {
  const lines = ["day,supply"];
  for (const r of rows) {
    if (r.day == null || r.supply == null) continue;
    const day = String(r.day).split(/[ T]/)[0]; // YYYY-MM-DD
    const supply = String(r.supply);
    lines.push(`${day},${supply}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  console.log(`[dune] executing query ${QUERY_ID} asset=${ASSET_CODE}-${ASSET_ISSUER}`);
  const executionId = await execute();
  console.log(`[dune] execution_id=${executionId}`);
  await pollUntilDone(executionId);
  const rows = await fetchResults(executionId);
  console.log(`[dune] fetched ${rows.length} rows`);
  if (rows.length === 0) {
    console.error("[dune] WARNING: zero rows. Check the query, asset code/issuer, and parameter names on Dune.");
  }
  const csv = toCsv(rows);
  const outPath = path.resolve(OUT!);
  fs.writeFileSync(outPath, csv);
  console.log(`[dune] wrote ${outPath}`);

  const last = rows[rows.length - 1];
  if (last) console.log(`[dune] last row: day=${last.day} supply=${last.supply}`);
}

main().catch((e) => {
  console.error("[dune] fatal:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
