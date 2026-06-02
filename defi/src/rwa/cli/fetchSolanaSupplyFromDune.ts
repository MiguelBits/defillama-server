/**
 * Fetch a Solana SPL token's daily supply history from Dune and write a CSV that
 * `backfillOnycMcap.ts` (and future per-token backfills) can consume.
 *
 * Prereq: save the SQL below as a Dune query with two parameters (mint, decimals),
 * note its query ID, then pass it via --query-id. Dune Plus or above is required
 * for API access.
 *
 * Note: action values in `tokens_solana.transfers` are 'mint'/'burn' (NOT 'mintTo').
 *
 *   WITH events AS (
 *     SELECT date_trunc('day', block_time) AS day,
 *            SUM(CASE WHEN action = 'mint' THEN amount
 *                     WHEN action = 'burn' THEN -amount END) AS net_change
 *     FROM tokens_solana.transfers
 *     WHERE token_mint_address = '{{mint}}'
 *       AND action IN ('mint', 'burn')
 *     GROUP BY 1
 *   )
 *   SELECT day,
 *          SUM(net_change) OVER (ORDER BY day) / pow(10, {{decimals}}) AS supply
 *   FROM events
 *   ORDER BY day;
 *
 * Auth: reads DUNE_API_KEY (preferred) or first entry of DUNE_API_KEYS (matches the
 * existing GitHub Actions secret).
 *
 * Usage:
 *   DUNE_API_KEY=xxx ts-node defi/src/rwa/cli/fetchSolanaSupplyFromDune.ts \
 *     --query-id 1234567 \
 *     --mint 5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5 \
 *     --decimals 9 \
 *     --out ./onyc.csv
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
const MINT = arg("--mint");
const DECIMALS = arg("--decimals");
const OUT = arg("--out");

if (!QUERY_ID || !MINT || !DECIMALS || !OUT) {
  console.error("ERROR: --query-id, --mint, --decimals, --out are all required");
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
  const body = { query_parameters: { mint: MINT, decimals: Number(DECIMALS) } };
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
  console.log(`[dune] executing query ${QUERY_ID} mint=${MINT} decimals=${DECIMALS}`);
  const executionId = await execute();
  console.log(`[dune] execution_id=${executionId}`);
  await pollUntilDone(executionId);
  const rows = await fetchResults(executionId);
  console.log(`[dune] fetched ${rows.length} rows`);
  if (rows.length === 0) {
    console.error("[dune] WARNING: zero rows. Check the query, mint address, and parameters on Dune.");
  }
  const csv = toCsv(rows);
  const outPath = path.resolve(OUT!);
  fs.writeFileSync(outPath, csv);
  console.log(`[dune] wrote ${outPath}`);

  // Quick sanity print: last row
  const last = rows[rows.length - 1];
  if (last) console.log(`[dune] last row: day=${last.day} supply=${last.supply}`);
}

main().catch((e) => {
  console.error("[dune] fatal:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
