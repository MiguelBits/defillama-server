/**
 * ui-tool server handler for the RWA refill / backfill tab.
 *
 * Each RWA refill is a standalone CLI script under defi/src/rwa/cli. Rather
 * than re-implement their logic (and risk drifting from prod), we spawn the
 * real script as a child process with a constructed argv, stream its
 * stdout/stderr back to the browser, and serve the before/after HTML preview
 * each script writes (see rwaPreviewMiddleware).
 *
 * Safety: every operation defaults to DRY RUN. The DB-writing flags are only
 * added when the client explicitly sets `commit: true` (the UI gates that
 * behind a type-to-confirm modal), matching the rule that the ui-tool must
 * never write to prod while previewing.
 */
import fs from "fs";
import path from "path";
import { spawn, ChildProcess } from "child_process";

// defi/ui-tool/src → defi
const DEFI_ROOT = path.resolve(__dirname, "../../");
const CLI_DIR = path.join(DEFI_ROOT, "src/rwa/cli");
const SOLANA_WORK_DIR = process.env.WORK_DIR || "/tmp/solana-rwa-backfill";
const BATCH_SCRIPT = path.join(CLI_DIR, "backfillSolanaRwaBatch.sh");

// Only one refill runs at a time (they're heavy + write to shared DB/caches).
let currentChild: ChildProcess | null = null;
let currentOperation: string | null = null;

function send(ws: any, type: string, payload: any = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

function streamLines(ws: any, chunk: Buffer, type: "output" | "error") {
  const text = chunk.toString();
  send(ws, type, { content: text.replace(/\s+$/, "") });
}

/**
 * Spawn one script, stream its output, resolve with the exit code.
 * Returns -2 if another run is already in progress (and notifies the client).
 */
function spawnStep(
  ws: any,
  operation: string,
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string }
): Promise<number> {
  return new Promise((resolve) => {
    if (currentChild) {
      send(ws, "error", { content: `A refill (${currentOperation}) is already running. Stop it first.` });
      resolve(-2);
      return;
    }
    const cwd = opts.cwd || DEFI_ROOT;
    console.log(`[rwa] ${operation}: ${command} ${args.join(" ")} (cwd=${cwd})`);
    send(ws, "output", { content: `\n▶ ${operation}\n  ${command} ${args.join(" ")}\n` });

    const child = spawn(command, args, { cwd, shell: true, env: { ...process.env, ...(opts.env || {}) } });
    currentChild = child;
    currentOperation = operation;

    child.stdout?.on("data", (d: Buffer) => streamLines(ws, d, "output"));
    child.stderr?.on("data", (d: Buffer) => streamLines(ws, d, "error"));

    child.on("close", (code: number | null) => {
      currentChild = null;
      currentOperation = null;
      console.log(`[rwa] ${operation} exited with code ${code}`);
      resolve(code ?? -1);
    });
    child.on("error", (e: any) => {
      currentChild = null;
      currentOperation = null;
      console.error(`[rwa] ${operation} spawn error:`, e?.message);
      send(ws, "error", { content: `Failed to start ${operation}: ${e?.message}` });
      resolve(-1);
    });
  });
}

/** Spawn a script, stream its output, then report completion + previews. */
function runChild(
  ws: any,
  operation: string,
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string; previews?: () => Preview[] }
) {
  spawnStep(ws, operation, command, args, opts).then((code) => {
    if (code === -2) return; // a run was already in progress; message already sent
    let previews: Preview[] = [];
    try {
      previews = opts.previews ? opts.previews() : [];
    } catch (e: any) {
      console.error("[rwa] preview resolution failed:", e?.message);
    }
    const ok = code === 0;
    send(ws, ok ? "output" : "error", { content: `\n${ok ? "✅" : "❌"} ${operation} finished (exit ${code})\n` });
    send(ws, "rwa-run-complete", { data: { operation, code, ok, previews } });
  });
}

interface Preview {
  label: string;
  // path served by the preview middleware, e.g. /rwa-preview/refill-preview.html
  url: string;
}

function previewIfExists(label: string, route: string, absPath: string): Preview[] {
  return fs.existsSync(absPath) ? [{ label, url: route }] : [];
}

function listSolanaPreviews(): Preview[] {
  try {
    return fs
      .readdirSync(SOLANA_WORK_DIR)
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map((f) => ({ label: f, url: `/rwa-preview-solana/${f}` }));
  } catch {
    return [];
  }
}

const NODE_BIG_MEM = "--max-old-space-size=8192";
const TS_NODE = ["npx", "ts-node", "--transpile-only", "--logError"];

function scriptCmd(scriptRel: string, args: string[]): { command: string; args: string[] } {
  return { command: TS_NODE[0], args: [...TS_NODE.slice(1), scriptRel, ...args] };
}

export async function runRwaCommand(ws: any, data: any) {
  const { operation, options = {} } = data;
  console.log("[rwa] runRwaCommand:", operation, JSON.stringify(options));

  switch (operation) {
    case "parallel-refill":
      return runParallelRefill(ws, options);
    case "total-supply":
      return runTotalSupply(ws, options);
    case "solana-batch":
      return runSolanaBatch(ws, options);
    case "solana-single":
      return runSolanaSingle(ws, options);
    case "stellar-single":
      return runStellarSingle(ws, options);
    case "xstock-excluded":
      return runXstockExcluded(ws, options);
    case "combined-preview":
      return runCombinedPreview(ws, options);
    case "fetch-solana-csv":
      return runFetchSolanaCsv(ws, options);
    case "fetch-stellar-csv":
      return runFetchStellarCsv(ws, options);
    default:
      send(ws, "error", { content: `Unknown rwa operation: ${operation}` });
  }
}

export function stopRwaCommand(ws: any) {
  if (!currentChild) {
    send(ws, "output", { content: "No refill running." });
    return;
  }
  console.log(`[rwa] stopping ${currentOperation}`);
  currentChild.kill("SIGTERM");
  send(ws, "output", { content: `Sent stop signal to ${currentOperation}.` });
}

// ── Asset → mint / asset / decimals derivation ─────────────────────────

const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const solanaDecimalsCache = new Map<string, number>();

/** Resolve a Solana mint's decimals: xStock=8, else Solana JSON-RPC getTokenSupply. */
async function resolveSolanaDecimals(mint: string, parentPlatform?: string): Promise<number> {
  if (solanaDecimalsCache.has(mint)) return solanaDecimalsCache.get(mint)!;
  if (parentPlatform === "xStock") {
    solanaDecimalsCache.set(mint, 8);
    return 8;
  }
  // JSON-RPC getTokenSupply → { result: { value: { decimals } } }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [mint] });
  const resp = await fetch(SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!resp.ok) throw new Error(`getTokenSupply HTTP ${resp.status} for mint ${mint}`);
  const json: any = await resp.json();
  const d = json?.result?.value?.decimals;
  if (typeof d !== "number") throw new Error(`getTokenSupply returned no decimals for mint ${mint}: ${JSON.stringify(json).slice(0, 200)}`);
  solanaDecimalsCache.set(mint, d);
  return d;
}

/** Resolve the Solana mint for an asset (first contract). */
function pickSolanaMint(asset: AssetChoice): string | null {
  const arr = asset.contracts?.Solana || (asset.contracts as any)?.solana || [];
  return Array.isArray(arr) && arr.length ? String(arr[0]) : null;
}

/** Resolve the Stellar asset (CODE-ISSUER) for an asset (first contract). */
function pickStellarAsset(asset: AssetChoice): string | null {
  const arr = asset.contracts?.Stellar || (asset.contracts as any)?.stellar || [];
  return Array.isArray(arr) && arr.length ? String(arr[0]) : null;
}

// ── CSV lifecycle: deterministic paths, freshness, 24h sweep ───────────

const CSV_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function csvPathFor(chain: "solana" | "stellar", assetId: string): string {
  return path.join(SOLANA_WORK_DIR, `${chain}-${assetId}.csv`);
}

function isFresh(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    return Date.now() - stat.mtimeMs < CSV_TTL_MS;
  } catch { return false; }
}

/** Spawn the right Dune fetcher to (re)build the CSV. Throws on failure. */
async function ensureCsv(
  ws: any,
  chain: "solana" | "stellar",
  asset: AssetChoice,
  assetId: string,
): Promise<string> {
  const out = csvPathFor(chain, assetId);
  if (isFresh(out)) {
    send(ws, "output", { content: `Reusing fresh CSV (<24h): ${out}` });
    return out;
  }
  if (!process.env.DUNE_API_KEY) {
    throw new Error("DUNE_API_KEY is not set on the server — can't auto-fetch supply CSV.");
  }
  fs.mkdirSync(SOLANA_WORK_DIR, { recursive: true });

  if (chain === "solana") {
    const mint = pickSolanaMint(asset);
    if (!mint) throw new Error(`Asset ${assetId} (${asset.ticker}) has no Solana contract in metadata.`);
    const decimals = await resolveSolanaDecimals(mint, asset.parentPlatform);
    const args = [
      "--query-id", String(process.env.DUNE_QUERY_ID || "7435636"),
      "--mint", mint,
      "--decimals", String(decimals),
      "--out", out,
    ];
    const { command, args: full } = scriptCmd("src/rwa/cli/fetchSolanaSupplyFromDune.ts", args);
    const code = await spawnStep(ws, "auto-fetch · solana CSV", command, full, {});
    if (code !== 0 || !fs.existsSync(out)) throw new Error(`fetchSolanaSupplyFromDune exited ${code}; CSV missing.`);
    return out;
  } else {
    const ast = pickStellarAsset(asset);
    if (!ast) throw new Error(`Asset ${assetId} (${asset.ticker}) has no Stellar contract in metadata.`);
    const queryId = process.env.STELLAR_DUNE_QUERY_ID;
    if (!queryId) throw new Error("STELLAR_DUNE_QUERY_ID is not set on the server — can't auto-fetch Stellar CSV.");
    const args = ["--query-id", queryId, "--asset", ast, "--out", out];
    const { command, args: full } = scriptCmd("src/rwa/cli/fetchStellarSupplyFromDune.ts", args);
    const code = await spawnStep(ws, "auto-fetch · stellar CSV", command, full, {});
    if (code !== 0 || !fs.existsSync(out)) throw new Error(`fetchStellarSupplyFromDune exited ${code}; CSV missing.`);
    return out;
  }
}

/** Sweep CSVs and HTML previews older than 24h from the work dir + cli dir. */
function sweepOldArtifacts() {
  const sweep = (dir: string, exts: string[]) => {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!exts.some((e) => f.endsWith(e))) continue;
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (Date.now() - st.mtimeMs > CSV_TTL_MS) {
            fs.unlinkSync(p);
            console.log(`[rwa] swept stale artifact: ${p}`);
          }
        } catch { /* ignore */ }
      }
    } catch { /* dir may not exist yet */ }
  };
  sweep(SOLANA_WORK_DIR, [".csv", ".html"]);
  // Stricter cli-dir sweep: only files whose names match our generated patterns,
  // so we never touch unrelated .html files that might live alongside the scripts.
  try {
    for (const f of fs.readdirSync(CLI_DIR)) {
      const ours = f === "refill-preview.html" || /^preview-.*\.html$/.test(f) || /^combined-.*\.html$/.test(f) || /^excluded-.*\.html$/.test(f);
      if (!ours) continue;
      const p = path.join(CLI_DIR, f);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > CSV_TTL_MS) {
          fs.unlinkSync(p);
          console.log(`[rwa] swept stale preview: ${p}`);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// Run once at module load + hourly.
sweepOldArtifacts();
setInterval(sweepOldArtifacts, 60 * 60 * 1000).unref();

// ── Operations ────────────────────────────────────────────────────────

function runParallelRefill(ws: any, o: any) {
  const args: string[] = [];
  if (o.startDate) args.push("--start", o.startDate);
  if (o.endDate) args.push("--end", o.endDate);
  if (Array.isArray(o.ids) && o.ids.length) args.push("--ids", o.ids.join(","));
  if (o.backfillConcurrency) args.push("--backfill-concurrency", String(o.backfillConcurrency));
  if (o.idConcurrency) args.push("--id-concurrency", String(o.idConcurrency));
  if (o.priceConcurrency) args.push("--price-concurrency", String(o.priceConcurrency));
  if (o.resetCache) args.push("--reset-cache");
  // commitCleanup gates the Phase 2/3 writes (spike deletes + price-dip fixes).
  // Defaults OFF (dry run) so a PM never writes by accident.
  if (o.commitCleanup) args.push("--commit-cleanup");

  const { command, args: full } = scriptCmd("src/rwa/cli/refillParallel.ts", args);
  runChild(ws, "parallel-refill", command, full, {
    env: { NODE_OPTIONS: NODE_BIG_MEM },
    previews: () => previewIfExists("Refill before/after", "/rwa-preview/refill-preview.html", path.join(CLI_DIR, "refill-preview.html")),
  });
}

function runTotalSupply(ws: any, o: any) {
  // NOTE: this script WRITES by default; --dry-run is opt-in. We invert that
  // for safety: only omit --dry-run when the user explicitly commits.
  const args: string[] = [];
  if (!o.commit) args.push("--dry-run");
  if (o.backup) args.push("--backup");
  const { command, args: full } = scriptCmd("src/rwa/cli/backfillTotalSupply.ts", args);
  runChild(ws, "total-supply", command, full, { env: { NODE_OPTIONS: NODE_BIG_MEM } });
}

function runSolanaBatch(ws: any, o: any) {
  if (!process.env.DUNE_API_KEY) {
    send(ws, "error", { content: "DUNE_API_KEY is not set in the server .env — Solana batch needs it." });
    return;
  }
  const args: string[] = [];
  if (o.only) args.push("--only", String(o.only));
  if (o.skip) args.push("--skip", String(o.skip));
  if (o.noXstocks) args.push("--no-xstocks");
  if (o.skipFetch) args.push("--skip-fetch");
  if (o.commit) args.push("--commit");
  runChild(ws, "solana-batch", "bash", [BATCH_SCRIPT, ...args], {
    cwd: CLI_DIR,
    env: { WORK_DIR: SOLANA_WORK_DIR },
    previews: listSolanaPreviews,
  });
}

async function runSolanaSingle(ws: any, o: any) {
  if (!o.assetId) { send(ws, "error", { content: "solana-single needs assetId." }); return; }
  if (currentChild) { send(ws, "error", { content: `A refill (${currentOperation}) is already running. Stop it first.` }); return; }
  const asset = await getAsset(String(o.assetId));
  if (!asset) { send(ws, "error", { content: `Asset id ${o.assetId} not found in metadata.` }); return; }
  const mint = pickSolanaMint(asset);
  if (!mint) { send(ws, "error", { content: `Asset ${o.assetId} (${asset.ticker}) has no Solana contract in metadata.` }); return; }
  let csv: string;
  try { csv = await ensureCsv(ws, "solana", asset, String(o.assetId)); }
  catch (e: any) {
    send(ws, "error", { content: e?.message || String(e) });
    send(ws, "rwa-run-complete", { data: { operation: "solana-single", code: -1, ok: false, previews: [] } });
    return;
  }
  const out = path.join(CLI_DIR, `preview-${o.assetId}.html`);
  const args = ["--asset-id", String(o.assetId), "--mint", mint, "--csv", csv, "--out", out];
  if (o.fromDate) args.push("--from-date", o.fromDate);
  if (o.flatNav) args.push("--flat-nav", String(o.flatNav));
  if (o.fallbackNearestPrice) args.push("--fallback-nearest-price");
  if (o.fillMissingChains) args.push("--fill-missing-chains");
  if (!o.commit) args.push("--dry-run");
  const { command, args: full } = scriptCmd("src/rwa/cli/backfillSolanaRwaMcap.ts", args);
  runChild(ws, "solana-single", command, full, {
    env: { NODE_OPTIONS: NODE_BIG_MEM },
    previews: () => previewIfExists(`Solana ${asset.ticker || o.assetId}`, `/rwa-preview/preview-${o.assetId}.html`, out),
  });
}

async function runStellarSingle(ws: any, o: any) {
  if (!o.assetId) { send(ws, "error", { content: "stellar-single needs assetId." }); return; }
  if (currentChild) { send(ws, "error", { content: `A refill (${currentOperation}) is already running. Stop it first.` }); return; }
  const asset = await getAsset(String(o.assetId));
  if (!asset) { send(ws, "error", { content: `Asset id ${o.assetId} not found in metadata.` }); return; }
  const stellarAsset = pickStellarAsset(asset);
  if (!stellarAsset) { send(ws, "error", { content: `Asset ${o.assetId} (${asset.ticker}) has no Stellar contract in metadata.` }); return; }
  let csv: string;
  try { csv = await ensureCsv(ws, "stellar", asset, String(o.assetId)); }
  catch (e: any) {
    send(ws, "error", { content: e?.message || String(e) });
    send(ws, "rwa-run-complete", { data: { operation: "stellar-single", code: -1, ok: false, previews: [] } });
    return;
  }
  const out = path.join(CLI_DIR, `preview-${o.assetId}.html`);
  const args = ["--asset-id", String(o.assetId), "--asset", stellarAsset, "--csv", csv, "--out", out];
  if (o.fromDate) args.push("--from-date", o.fromDate);
  if (o.flatNav) args.push("--flat-nav", String(o.flatNav));
  if (o.fallbackNearestPrice) args.push("--fallback-nearest-price");
  if (o.fillMissingChains) args.push("--fill-missing-chains");
  if (!o.commit) args.push("--dry-run");
  const { command, args: full } = scriptCmd("src/rwa/cli/backfillStellarRwaMcap.ts", args);
  runChild(ws, "stellar-single", command, full, {
    env: { NODE_OPTIONS: NODE_BIG_MEM },
    previews: () => previewIfExists(`Stellar ${asset.ticker || o.assetId}`, `/rwa-preview/preview-${o.assetId}.html`, out),
  });
}

function runXstockExcluded(ws: any, o: any) {
  if (!o.all && !o.ticker && !o.assetId) {
    send(ws, "error", { content: "xstock-excluded needs --all, a ticker, or an assetId." });
    return;
  }
  const outName = `excluded-${o.all ? "all" : o.ticker || o.assetId}.html`;
  const out = path.join(CLI_DIR, outName);
  const args: string[] = ["--out", out];
  if (o.all) args.push("--all");
  else if (o.ticker) args.push("--ticker", String(o.ticker));
  else if (o.assetId) args.push("--asset-id", String(o.assetId));
  if (o.startDate) args.push("--start-date", o.startDate);
  if (o.endDate) args.push("--end-date", o.endDate);
  // Writes require BOTH --write and --yes; default dry.
  if (o.commit) args.push("--write", "--yes");
  const { command, args: full } = scriptCmd("src/rwa/cli/backfillSolanaExcludedMcap.ts", args);
  runChild(ws, "xstock-excluded", command, full, {
    env: { NODE_OPTIONS: NODE_BIG_MEM },
    previews: () => previewIfExists(`xStock excluded`, `/rwa-preview/${outName}`, out),
  });
}

/**
 * Combined dry-run preview: run the parallel refill for one asset (emitting its
 * proposed post-refill rows), then run the chain backfill against THAT output as
 * its baseline. Surfaces both charts — current→refill and refill→final — so you
 * can see the true end-state of (refill + chain backfill) without any DB writes.
 */
async function runCombinedPreview(ws: any, o: any) {
  const { assetId, chain } = o;
  if (!assetId || !chain) {
    send(ws, "error", { content: "combined-preview needs assetId and chain (solana|stellar)." });
    return;
  }
  if (chain !== "solana" && chain !== "stellar") {
    send(ws, "error", { content: `Unsupported chain: ${chain}` });
    return;
  }
  if (currentChild) {
    send(ws, "error", { content: `A refill (${currentOperation}) is already running. Stop it first.` });
    return;
  }

  // Derive mint/asset/decimals from metadata, then auto-fetch (or reuse) the
  // supply CSV. No free-form inputs from the client → no junk CSVs on disk.
  const asset = await getAsset(String(assetId));
  if (!asset) { send(ws, "error", { content: `Asset id ${assetId} not found in metadata.` }); return; }

  let csv: string;
  try {
    csv = await ensureCsv(ws, chain, asset, String(assetId));
  } catch (e: any) {
    send(ws, "error", { content: e?.message || String(e) });
    send(ws, "rwa-run-complete", { data: { operation: "combined-preview", code: -1, ok: false, previews: [] } });
    return;
  }

  fs.mkdirSync(SOLANA_WORK_DIR, { recursive: true });
  const baselineJson = path.join(SOLANA_WORK_DIR, `combined-baseline-${assetId}.json`);
  try { fs.rmSync(baselineJson, { force: true }); } catch { /* ignore */ }

  // Step 1 — refill dry-run, emit proposed rows.
  const refillArgs = ["--ids", String(assetId), "--emit-rows", baselineJson];
  if (o.startDate) refillArgs.push("--start", o.startDate);
  if (o.endDate) refillArgs.push("--end", o.endDate);
  const s1 = scriptCmd("src/rwa/cli/refillParallel.ts", refillArgs);
  const code1 = await spawnStep(ws, "combined-preview · step 1 refill", s1.command, s1.args, { env: { NODE_OPTIONS: NODE_BIG_MEM } });
  if (code1 === -2) return;
  if (code1 !== 0 || !fs.existsSync(baselineJson)) {
    send(ws, "error", { content: `Refill step failed (exit ${code1}) or produced no baseline — aborting combined preview.` });
    send(ws, "rwa-run-complete", { data: { operation: "combined-preview", code: code1, ok: false, previews: [] } });
    return;
  }

  // Step 2 — chain backfill dry-run, using the refill output as its baseline.
  const outName = `combined-${chain}-${assetId}.html`;
  const out = path.join(CLI_DIR, outName);
  const common = ["--asset-id", String(assetId), "--csv", csv, "--baseline-json", baselineJson, "--dry-run", "--out", out];
  if (o.fromDate) common.push("--from-date", o.fromDate);
  if (o.flatNav) common.push("--flat-nav", String(o.flatNav));
  if (o.fallbackNearestPrice) common.push("--fallback-nearest-price");
  if (o.fillMissingChains) common.push("--fill-missing-chains");

  let s2: { command: string; args: string[] };
  if (chain === "solana") {
    const mint = pickSolanaMint(asset)!;
    s2 = scriptCmd("src/rwa/cli/backfillSolanaRwaMcap.ts", ["--mint", mint, ...common]);
  } else {
    const ast = pickStellarAsset(asset)!;
    s2 = scriptCmd("src/rwa/cli/backfillStellarRwaMcap.ts", ["--asset", ast, ...common]);
  }
  const code2 = await spawnStep(ws, "combined-preview · step 2 backfill", s2.command, s2.args, { env: { NODE_OPTIONS: NODE_BIG_MEM } });
  if (code2 === -2) return;

  const previews = [
    ...previewIfExists("Step 1 — current → after refill", "/rwa-preview/refill-preview.html", path.join(CLI_DIR, "refill-preview.html")),
    ...previewIfExists("Step 2 — after refill → after refill + backfill (final)", `/rwa-preview/${outName}`, out),
  ];
  const ok = code2 === 0;
  send(ws, ok ? "output" : "error", { content: `\n${ok ? "✅" : "❌"} combined-preview finished (refill exit ${code1}, backfill exit ${code2})\n` });
  send(ws, "rwa-run-complete", { data: { operation: "combined-preview", code: code2, ok, previews } });
}

function runFetchSolanaCsv(ws: any, o: any) {
  if (!process.env.DUNE_API_KEY) {
    send(ws, "error", { content: "DUNE_API_KEY is not set in the server .env." });
    return;
  }
  if (!o.mint || !o.decimals) {
    send(ws, "error", { content: "fetch-solana-csv needs mint and decimals." });
    return;
  }
  const out = o.out || path.join(SOLANA_WORK_DIR, `supply-${o.mint}.csv`);
  fs.mkdirSync(SOLANA_WORK_DIR, { recursive: true });
  const args = [
    "--query-id", String(o.queryId || process.env.DUNE_QUERY_ID || "7435636"),
    "--mint", String(o.mint),
    "--decimals", String(o.decimals),
    "--out", out,
  ];
  const { command, args: full } = scriptCmd("src/rwa/cli/fetchSolanaSupplyFromDune.ts", args);
  runChild(ws, "fetch-solana-csv", command, full, {});
  send(ws, "output", { content: `CSV will be written to: ${out}` });
}

function runFetchStellarCsv(ws: any, o: any) {
  if (!process.env.DUNE_API_KEY) {
    send(ws, "error", { content: "DUNE_API_KEY is not set in the server .env." });
    return;
  }
  if (!o.asset || !o.queryId) {
    send(ws, "error", { content: "fetch-stellar-csv needs asset and queryId." });
    return;
  }
  const out = o.out || path.join(SOLANA_WORK_DIR, `stellar-supply.csv`);
  fs.mkdirSync(SOLANA_WORK_DIR, { recursive: true });
  const args = ["--query-id", String(o.queryId), "--asset", String(o.asset), "--out", out];
  const { command, args: full } = scriptCmd("src/rwa/cli/fetchStellarSupplyFromDune.ts", args);
  runChild(ws, "fetch-stellar-csv", command, full, {});
  send(ws, "output", { content: `CSV will be written to: ${out}` });
}

// ── Form choices ────────────────────────────────────────────────────────

/** Solana batch named targets parsed from the bash script (kept in sync). */
function parseSolanaNamedTargets(): string[] {
  try {
    const src = fs.readFileSync(BATCH_SCRIPT, "utf8");
    const start = src.indexOf("NAMED_TARGETS=(");
    if (start < 0) return [];
    const end = src.indexOf(")", start);
    const block = src.slice(start, end);
    const labels: string[] = [];
    const re = /"([A-Za-z0-9_]+)\|/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) labels.push(m[1]);
    return labels;
  } catch {
    return [];
  }
}

/**
 * Asset list for the ID/symbol picker. Loaded lazily (DB hit) when the client
 * opens the tab, so a missing/slow PG connection never blocks server init.
 */
interface AssetChoice {
  id: string; ticker: string; symbol: string; name: string;
  // Per-chain addresses from the rwa metadata. Keys are display names (e.g.
  // "Solana", "Stellar", "Ethereum"); values are arrays of mints/asset pairs.
  contracts: Record<string, string[]>;
  parentPlatform: string;
}

let assetCache: AssetChoice[] | null = null;
let assetCacheById: Map<string, AssetChoice> | null = null;

async function loadAssets(): Promise<AssetChoice[]> {
  if (assetCache) return assetCache;
  const { fetchMetadataPG } = require("../../src/rwa/db");
  const rows = await fetchMetadataPG();
  assetCache = rows.map((r: any): AssetChoice => ({
    id: String(r.id),
    ticker: r.data?.ticker || "",
    symbol: r.data?.symbol || "",
    name: r.data?.name || "",
    contracts: r.data?.contracts || {},
    parentPlatform: r.data?.parentPlatform || "",
  }));
  assetCacheById = new Map(assetCache!.map((a) => [a.id, a]));
  return assetCache!;
}

async function getAsset(id: string): Promise<AssetChoice | null> {
  if (!assetCacheById) await loadAssets();
  return assetCacheById?.get(String(id)) || null;
}

export async function getRwaChoices(ws: any) {
  let assets: AssetChoice[] = [];
  try {
    assets = await loadAssets();
  } catch (e: any) {
    console.error("[rwa] getRwaChoices failed to load metadata:", e?.message);
  }
  send(ws, "rwa-form-choices", {
    data: {
      assets,
      solanaNamedTargets: parseSolanaNamedTargets(),
      hasDuneKey: !!process.env.DUNE_API_KEY,
      hasAlchemyKey: !!(process.env.ALCHEMY_API_KEY || process.env.SOLANA_RPC),
      hasStellarDuneQuery: !!process.env.STELLAR_DUNE_QUERY_ID,
    },
  });
}

/**
 * Run the refill script's own pre-flight check for a set of IDs and return which
 * assets have throw-on-historical chains (solana/stellar/…) that the parallel
 * refill would silently drop to $0. Reuses the exact prod logic from
 * refillParallel.ts so the UI can't drift from what the script actually does.
 * When no IDs are given, defaults to every asset that HAS a Solana or Stellar
 * leg in its metadata — the only assets where this check is meaningful.
 */
export async function getRwaPreflight(ws: any, data: any) {
  const ids: string[] = Array.isArray(data?.ids) ? data.ids : [];
  try {
    const mod = require("../../src/rwa/cli/refillParallel");
    let idList = ids.slice();
    if (idList.length === 0) {
      const assets = await loadAssets();
      idList = assets
        .filter((a) => a.contracts?.Solana?.length || a.contracts?.Stellar?.length)
        .map((a) => a.id);
    }
    console.log(`[rwa] preflight check over ${idList.length} ID(s)…`);
    const hits = await mod.preflightHistoricalIncompatibleChains(idList);
    send(ws, "rwa-preflight-result", { data: { hits, idCount: idList.length } });
  } catch (e: any) {
    console.error("[rwa] preflight failed:", e?.message);
    send(ws, "rwa-preflight-result", { data: { hits: [], idCount: 0, error: e?.message || String(e) } });
  }
}

// ── Preview HTTP middleware ───────────────────────────────────────────────

/** Mount on the ui-tool web server: serves the HTML previews each script writes. */
export function rwaPreviewRouter() {
  const express = require("express");
  const router = express.Router();
  router.use("/rwa-preview", express.static(CLI_DIR, { index: false, extensions: ["html"] }));
  router.use("/rwa-preview-solana", express.static(SOLANA_WORK_DIR, { index: false, extensions: ["html"] }));
  return router;
}
