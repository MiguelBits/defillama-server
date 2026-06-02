/**
 * For each RED (or chosen tier) spike from rwa-flow-spikes.json, fetch the
 * actual on-chain totalSupply at t-1, t, t+1 for the dominant chain and compare
 * to what we stored in daily_rwa_data.totalsupply. Output sorted by deviation —
 * largest deviation = most likely a data error.
 *
 * Uses fetchSupplies (the same call the writer uses) and coins.getPrices for
 * decimals, so the comparison is apples-to-apples with prod.
 *
 * Run:
 *   npx ts-node defi/src/rwa/cli/verifyFlowSpikes.ts \
 *     [--in=/tmp/rwa-flow-spikes.json] [--out=/tmp/rwa-flow-verifications.json] [--tier=RED]
 */

import fs from "fs";
import { coins } from "@defillama/sdk";
import { runInPromisePool } from "@defillama/sdk/build/generalUtil";
import { initPG, fetchDailyRecordsWithChainsForIdPG } from "../db";
import { fetchSupplies } from "../../../l2/utils";
import { prepareAtvlContext } from "../atvlRefill";
import { getChainIdFromDisplayName, getChainDisplayName } from "../../utils/normalizeChain";

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=")[1] : fallback;
}

const IN_PATH = arg("in", "/tmp/rwa-flow-spikes.json");
const OUT_PATH = arg("out", "/tmp/rwa-flow-verifications.json");
const TIER = arg("tier", "RED");
const CONCURRENCY = 3;

interface Spike {
  tier: string;
  id: string;
  ticker: string;
  name: string;
  date: string;
  timestamp: number;
  flowUsd: number;
  mcapUsd: number;
  pctOfMcap: number;
  topChain: string | null;
  topChainFlow: number;
}

interface Verification {
  spike: Spike;
  chainSlug: string;
  tokens: string[]; // chain:addr format
  storedByTs: { [ts: number]: number | null };
  onchainByTs: { [ts: number]: number | null };
  deviationPct: number; // max % deviation across the 3 timestamps
  diagnosis: "MATCHES_ONCHAIN" | "STORED_OFF" | "NO_TOKEN" | "NO_PRICE_DATA" | "NO_STORED_ROW" | "RPC_FAILED";
}

function buildRwaTokenByChain(rwaTokens: { [id: string]: string[] }): { [id: string]: { [chainSlug: string]: string[] } } {
  const out: { [id: string]: { [chainSlug: string]: string[] } } = {};
  for (const id of Object.keys(rwaTokens)) {
    out[id] = {};
    for (const pk of rwaTokens[id] || []) {
      if (!pk?.includes(":")) continue;
      const rawChain = pk.substring(0, pk.indexOf(":"));
      const slug = getChainIdFromDisplayName(getChainDisplayName(rawChain, true));
      if (!out[id][slug]) out[id][slug] = [];
      if (!out[id][slug].includes(pk)) out[id][slug].push(pk);
    }
  }
  return out;
}

async function fetchOnchainSupply(chainSlug: string, tokens: string[], timestamp: number): Promise<number | null> {
  const addrs = tokens.map((t) => t.substring(t.indexOf(":") + 1));
  let raw: { [key: string]: number };
  try {
    raw = await fetchSupplies(chainSlug, addrs, timestamp);
  } catch {
    return null;
  }
  const prices = await coins.getPrices(tokens, timestamp).catch(() => ({} as any));
  let total = 0;
  let foundAny = false;
  for (const tk of tokens) {
    const supply = raw[tk] ?? raw[tk.toLowerCase()] ?? raw[tk.toUpperCase()];
    const decimals = (prices as any)[tk]?.decimals;
    if (supply == null || decimals == null) continue;
    total += Number(supply) / 10 ** Number(decimals);
    foundAny = true;
  }
  return foundAny ? total : null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));
  const spikes: Spike[] = (data.spikes || []).filter((s: any) => s.tier === TIER && s.topChain);
  console.log(`[verify] ${spikes.length} ${TIER} spikes (with a top chain) loaded from ${IN_PATH}`);
  if (spikes.length === 0) { console.error("no spikes to verify"); process.exit(1); }

  await initPG();
  const ctx = await prepareAtvlContext();
  const tokenMap = buildRwaTokenByChain(ctx.rwaTokens);
  console.log(`[verify] built rwa-token map for ${Object.keys(tokenMap).length} RWAs`);

  // Cache stored daily rows per RWA so we don't re-query for multiple spikes on the same id.
  const storedRowsCache = new Map<string, Map<number, any>>();
  async function getStoredRows(id: string): Promise<Map<number, any>> {
    if (storedRowsCache.has(id)) return storedRowsCache.get(id)!;
    const rows = await fetchDailyRecordsWithChainsForIdPG(id);
    const m = new Map<number, any>(rows.map((r: any) => [r.timestamp, r]));
    storedRowsCache.set(id, m);
    return m;
  }

  const verifications: Verification[] = [];
  let processed = 0;

  await runInPromisePool({
    items: spikes,
    concurrency: CONCURRENCY,
    processor: async (s: Spike) => {
      const chainSlug = getChainIdFromDisplayName(s.topChain!);
      const tokens = (tokenMap[s.id]?.[chainSlug]) || [];

      const storedRows = await getStoredRows(s.id);
      const day = 86400;
      const tsList = [s.timestamp - day, s.timestamp, s.timestamp + day];
      const storedByTs: { [ts: number]: number | null } = {};
      for (const ts of tsList) {
        const row = storedRows.get(ts);
        const v = row?.totalsupply?.[chainSlug];
        storedByTs[ts] = v == null ? null : Number(v);
      }

      const v: Verification = {
        spike: s, chainSlug, tokens,
        storedByTs, onchainByTs: {},
        deviationPct: 0, diagnosis: "MATCHES_ONCHAIN",
      };

      if (tokens.length === 0) {
        v.diagnosis = "NO_TOKEN";
        verifications.push(v);
        processed++; if (processed % 10 === 0) console.log(`[verify] ${processed}/${spikes.length}`);
        return;
      }

      for (const ts of tsList) {
        v.onchainByTs[ts] = await fetchOnchainSupply(chainSlug, tokens, ts);
      }
      const allOnchainNull = Object.values(v.onchainByTs).every((x) => x == null);
      if (allOnchainNull) v.diagnosis = "RPC_FAILED";

      // Largest % deviation across the 3 timestamps where both sides exist.
      let maxDev = 0;
      let anyComparison = false;
      for (const ts of tsList) {
        const stored = v.storedByTs[ts];
        const onchain = v.onchainByTs[ts];
        if (stored == null || onchain == null || onchain === 0) continue;
        anyComparison = true;
        const dev = Math.abs(stored - onchain) / onchain;
        if (dev > maxDev) maxDev = dev;
      }
      v.deviationPct = maxDev * 100;
      if (!anyComparison && v.diagnosis === "MATCHES_ONCHAIN") {
        v.diagnosis = Object.values(v.storedByTs).every((x) => x == null) ? "NO_STORED_ROW" : "NO_PRICE_DATA";
      } else if (anyComparison && maxDev > 0.05) {
        v.diagnosis = "STORED_OFF";
      }

      verifications.push(v);
      processed++;
      if (processed % 10 === 0) console.log(`[verify] ${processed}/${spikes.length}`);
    },
  });

  // Group by diagnosis, print STORED_OFF first sorted by deviation.
  const byDiag: { [k: string]: Verification[] } = {};
  for (const v of verifications) (byDiag[v.diagnosis] = byDiag[v.diagnosis] || []).push(v);
  const order = ["STORED_OFF", "MATCHES_ONCHAIN", "NO_TOKEN", "NO_PRICE_DATA", "NO_STORED_ROW", "RPC_FAILED"];
  const fmt = (n: number | null) => {
    if (n == null) return "—";
    const a = Math.abs(n), s = n < 0 ? "-" : "";
    if (a >= 1e9) return s + (a / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return s + (a / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return s + (a / 1e3).toFixed(2) + "K";
    return s + a.toFixed(2);
  };

  for (const diag of order) {
    const subset = byDiag[diag] || [];
    if (subset.length === 0) continue;
    subset.sort((a, b) => b.deviationPct - a.deviationPct);
    console.log(`\n=== ${diag} (${subset.length}) ===`);
    if (diag === "STORED_OFF" || diag === "MATCHES_ONCHAIN") {
      console.log("date        ticker         chain         dev   stored(t-1/t/t+1)              onchain(t-1/t/t+1)             name");
      for (const v of subset.slice(0, 30)) {
        const tsList = [v.spike.timestamp - 86400, v.spike.timestamp, v.spike.timestamp + 86400];
        const stored = tsList.map((t) => fmt(v.storedByTs[t])).join("/");
        const onchain = tsList.map((t) => fmt(v.onchainByTs[t])).join("/");
        const dev = v.deviationPct.toFixed(0) + "%";
        console.log(
          `${v.spike.date}  ${(v.spike.ticker || "?").slice(0, 13).padEnd(13)}  ${v.chainSlug.slice(0, 12).padEnd(12)}  ${dev.padStart(5)}  ${stored.padEnd(30)}  ${onchain.padEnd(30)}  ${v.spike.name.slice(0, 36)}`,
        );
      }
      if (subset.length > 30) console.log(`  ... and ${subset.length - 30} more in JSON output`);
    } else {
      for (const v of subset.slice(0, 10)) {
        console.log(`  ${v.spike.date}  ${v.spike.ticker}  ${v.chainSlug}  (${v.spike.name.slice(0, 50)})`);
      }
      if (subset.length > 10) console.log(`  ... and ${subset.length - 10} more`);
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), verifications }, null, 2));
  console.log(`\n[verify] wrote ${verifications.length} verifications → ${OUT_PATH}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
