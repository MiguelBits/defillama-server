/**
 * Staging visualiser for the RWA pages — two sections:
 *
 *   1. Browse: per-key (chain / category / platform / assetGroup) stacked-by-RWA
 *      breakdown chart, mirroring /chart/<dim>/<key>/asset-breakdown.
 *   2. Drill: pick one RWA (filterable by any dim), see its mcap-or-supply
 *      reference series next to its daily net flow.
 *
 * Prerequisite: run cron locally to populate the cache —
 *   NODE_OPTIONS='--max-old-space-size=10144' npx ts-node defi/src/rwa/cron.ts
 *
 * Run:
 *   npx ts-node defi/src/rwa/cli/view-aggregates.ts
 *   open defi/src/rwa/cli/view-aggregates.html
 */

import fs from "fs";
import path from "path";
import { runInPromisePool } from "@defillama/sdk/build/generalUtil";
import { initPG, fetchDailyRecordsWithChainsForIdPG, computeFlowSeries, FlowRow } from "../db";
import { readPGCacheForId, readRouteData, ROUTES_DATA_DIR } from "../file-cache";
import { getChainLabelFromKey } from "../../utils/normalizeChain";

const DIMS = ["chain", "category", "platform", "assetgroup"] as const;
type Dim = typeof DIMS[number];
const TOP_KEYS_PER_DIM = 30;
const TOP_TICKERS_PER_BREAKDOWN = 25;
const TOP_RWAS_FOR_DRILL = 100;
const RWA_FETCH_CONCURRENCY = 6;
const METRICS = ["onChainMcap", "activeMcap", "defiActiveTvl"] as const;
type Metric = typeof METRICS[number];

interface BreakdownRow { timestamp: number; [ticker: string]: number; }
interface BreakdownData { onChainMcap: BreakdownRow[]; activeMcap: BreakdownRow[]; defiActiveTvl: BreakdownRow[]; }
interface DrillRwa {
  id: string;
  ticker: string;
  canonicalMarketId: string | null;
  name: string;
  chains: string[];
  categories: string[];
  platform: string | null;
  assetGroup: string | null;
  refSeries: { timestamp: number; onChainMcap: number; totalSupply: number | null }[];
  flowSeries: { timestamp: number; netFlowUsd: number | null; netFlowByChain: { [chain: string]: number } }[];
}

function readJsonIfExists(p: string): any {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function trimBreakdown(breakdown: any): BreakdownData | null {
  if (!breakdown) return null;
  const out: any = {};
  for (const metric of METRICS) {
    const series: BreakdownRow[] = breakdown[metric] || [];
    if (!series.length) { out[metric] = []; continue; }
    const last = series[series.length - 1];
    const tickers = Object.keys(last).filter((k) => k !== "timestamp");
    tickers.sort((a, b) => (Number(last[b]) || 0) - (Number(last[a]) || 0));
    const topTickers = new Set(tickers.slice(0, TOP_TICKERS_PER_BREAKDOWN));
    const restCount = tickers.length - topTickers.size;
    out[metric] = series.map((row) => {
      const newRow: BreakdownRow = { timestamp: row.timestamp };
      let other = 0;
      for (const k of Object.keys(row)) {
        if (k === "timestamp") continue;
        if (topTickers.has(k)) newRow[k] = Number(row[k]) || 0;
        else other += Number(row[k]) || 0;
      }
      if (restCount > 0 && other !== 0) newRow[`Other (${restCount})`] = other;
      return newRow;
    });
  }
  return out as BreakdownData;
}

function loadDim(dim: Dim) {
  const aggDir = path.join(ROUTES_DATA_DIR, "charts", dim);
  const breakdownDir = path.join(ROUTES_DATA_DIR, "charts", `${dim}-asset-breakdown`);
  if (!fs.existsSync(aggDir)) return [];

  const files = fs.readdirSync(aggDir).filter((f) => f.endsWith(".json"));
  const entries = files.map((f) => {
    const key = f.replace(/\.json$/, "");
    const agg = readJsonIfExists(path.join(aggDir, f)) || [];
    const breakdown = trimBreakdown(readJsonIfExists(path.join(breakdownDir, f)));
    const last = agg[agg.length - 1];
    return { key, breakdown, lastOnChainMcap: Number(last?.onChainMcap) || 0 };
  });
  entries.sort((a, b) => b.lastOnChainMcap - a.lastOnChainMcap);
  return entries
    .slice(0, TOP_KEYS_PER_DIM)
    .filter((e) => e.breakdown !== null)
    .map(({ key, breakdown }) => ({ key, breakdown }));
}

function sumOnChainMcap(meta: any): number {
  const obj = meta.onChainMcap || {};
  return Object.values(obj).reduce((s: number, v: any) => s + (Number(v) || 0), 0);
}

async function loadDrillRwas(metaList: any[]): Promise<DrillRwa[]> {
  const ranked = metaList
    .map((m: any) => ({ meta: m, agg: sumOnChainMcap(m) }))
    .sort((a, b) => b.agg - a.agg)
    .slice(0, TOP_RWAS_FOR_DRILL);

  const rwas: DrillRwa[] = [];
  await runInPromisePool({
    items: ranked,
    concurrency: RWA_FETCH_CONCURRENCY,
    processor: async ({ meta }: any) => {
      const id = meta.id != null ? String(meta.id) : null;
      if (!id) return;
      const pgCache = await readPGCacheForId(id);
      if (!pgCache) return;
      const refSeries = Object.keys(pgCache).map(Number).sort((a, b) => a - b).map((ts) => ({
        timestamp: ts,
        onChainMcap: Number((pgCache as any)[ts]?.onChainMcap) || 0,
        totalSupply: (pgCache as any)[ts]?.totalSupply == null ? null : Number((pgCache as any)[ts].totalSupply),
      }));

      const dailyRows = await fetchDailyRecordsWithChainsForIdPG(id);
      const flowRows: FlowRow[] = dailyRows.map((r: any) => ({ timestamp: r.timestamp, mcap: r.mcap, totalsupply: r.totalsupply }));
      const flowSeries = computeFlowSeries(flowRows, getChainLabelFromKey);

      rwas.push({
        id,
        ticker: meta.ticker || meta.canonicalMarketId || id,
        canonicalMarketId: meta.canonicalMarketId || null,
        name: meta.assetName || meta.name || id,
        chains: Object.keys(meta.onChainMcap || {}),
        categories: Array.isArray(meta.category) ? meta.category : (meta.category ? [meta.category] : []),
        platform: meta.parentPlatform || null,
        assetGroup: typeof meta.assetGroup === "string" ? meta.assetGroup : null,
        refSeries,
        flowSeries,
      });
    },
  });
  rwas.sort((a, b) => a.ticker.localeCompare(b.ticker));
  return rwas;
}

async function main() {
  const t0 = Date.now();
  console.log("[view-aggregates] loading per-key breakdowns...");
  const browseData = Object.fromEntries(DIMS.map((d) => [d, loadDim(d)]));
  console.log("[view-aggregates] dims:", Object.fromEntries(DIMS.map((d) => [d, (browseData as any)[d].length])));

  console.log("[view-aggregates] loading current.json + initialising DB...");
  const current = await readRouteData("current.json");
  if (!Array.isArray(current) || current.length === 0) {
    console.error("[view-aggregates] current.json not found or empty — run cron first.");
    process.exit(1);
  }
  await initPG();

  console.log(`[view-aggregates] loading top ${TOP_RWAS_FOR_DRILL} RWAs (pg-cache + daily-row flows)...`);
  const rwas = await loadDrillRwas(current);
  console.log(`[view-aggregates] loaded ${rwas.length} RWAs in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Filter dropdown options (union across all loaded RWAs).
  const chainSet = new Set<string>();
  const categorySet = new Set<string>();
  const platformSet = new Set<string>();
  const assetGroupSet = new Set<string>();
  for (const r of rwas) {
    for (const c of r.chains) chainSet.add(c);
    for (const c of r.categories) categorySet.add(c);
    if (r.platform) platformSet.add(r.platform);
    if (r.assetGroup) assetGroupSet.add(r.assetGroup);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    browseData,
    drill: {
      rwas,
      chains: Array.from(chainSet).sort(),
      categories: Array.from(categorySet).sort(),
      platforms: Array.from(platformSet).sort(),
      assetGroups: Array.from(assetGroupSet).sort(),
    },
  };

  const out = path.join(__dirname, "view-aggregates.html");
  fs.writeFileSync(out, buildHtml(payload));
  console.log(`[view-aggregates] wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

function buildHtml(payload: any): string {
  const json = JSON.stringify(payload);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>RWA staging visualiser</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 20px; background: #111; color: #eee; }
  h1 { margin: 0 0 4px; }
  h2 { margin: 24px 0 8px; font-size: 16px; color: #4fc3f7; }
  .sub { color: #888; margin-bottom: 16px; font-size: 13px; }
  .panel { background: #1b1b1b; border: 1px solid #2a2a2a; border-radius: 8px; padding: 14px; margin-bottom: 16px; }
  .panel-head { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .panel-head h3 { margin: 0; font-size: 14px; color: #ddd; }
  select { background: #262626; color: #eee; border: 1px solid #333; padding: 4px 8px; border-radius: 4px; font-size: 12px; min-width: 100px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  canvas { background: #0c0c0c; border-radius: 4px; padding: 6px; }
  .label { color: #aaa; font-size: 12px; }
  .filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
</style>
</head>
<body>
<h1>RWA staging visualiser</h1>
<div class="sub">Generated ${payload.generatedAt}.</div>

<h2>Browse — per-key stacked breakdown by RWA</h2>
<div class="sub">Top ${30} keys per dim by latest onChainMcap; top ${25} tickers per breakdown + Other. Mirrors /chart/&lt;dim&gt;/&lt;key&gt;/asset-breakdown.</div>
${["chain", "category", "platform", "assetgroup"].map((dim) => `
<div class="panel" data-dim="${dim}" data-section="browse">
  <div class="panel-head">
    <h3>${dim === "assetgroup" ? "Asset group" : dim.charAt(0).toUpperCase() + dim.slice(1)}</h3>
    <span class="label">key:</span><select class="key-select"></select>
    <span class="label">metric:</span>
    <select class="metric-select">
      <option value="onChainMcap">onChainMcap</option>
      <option value="activeMcap">activeMcap</option>
      <option value="defiActiveTvl">defiActiveTvl</option>
    </select>
    <span class="label" style="margin-left:auto">flow chart sums top-${100} RWAs only</span>
  </div>
  <div class="row">
    <canvas class="bd-chart" height="120"></canvas>
    <canvas class="flow-chart" height="120"></canvas>
  </div>
</div>
`).join("")}

<h2>Drill — single RWA reference + daily flow</h2>
<div class="sub">Top ${100} RWAs by latest onChainMcap embedded. Reference reads pg-cache; daily flow runs computeFlowSeries on raw daily rows (= /flows/:id).</div>
<div class="panel" data-section="drill">
  <div class="panel-head filters">
    <span class="label">chain:</span><select id="filter-chain"></select>
    <span class="label">category:</span><select id="filter-category"></select>
    <span class="label">platform:</span><select id="filter-platform"></select>
    <span class="label">asset group:</span><select id="filter-assetGroup"></select>
    <span class="label">RWA:</span><select id="filter-rwa" style="min-width: 240px"></select>
    <span class="label">reference:</span>
    <select id="ref-toggle">
      <option value="onChainMcap">onChainMcap</option>
      <option value="totalSupply">totalSupply</option>
    </select>
  </div>
  <div class="row">
    <canvas id="ref-chart" height="120"></canvas>
    <canvas id="flow-chart" height="120"></canvas>
  </div>
</div>

<script>
const PAYLOAD = ${json};
const PALETTE = ["#4fc3f7","#81c784","#ffb74d","#ce93d8","#ff8a65","#90caf9","#aed581","#fff176","#f06292","#7986cb","#a1887f","#9fa8da","#80cbc4","#ef9a9a","#bcaaa4","#b0bec5","#f48fb1","#ffcc80","#dce775","#b39ddb","#ffab91","#80deea","#dcedc8","#f8bbd0","#c5cae9","#fbc02d"];
function toMs(ts){return ts > 1e12 ? ts : ts * 1000;}
function isoDay(ts){return new Date(toMs(ts)).toISOString().slice(0,10);}
function fmt(n){
  if (n == null || !isFinite(n)) return "";
  const a = Math.abs(n);
  if (a >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (a >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (a >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(2);
}
function chartOptions(stacked){
  return {
    responsive: true,
    interaction: { mode: "index", intersect: false },
    scales: {
      x: { ticks: { color: "#888", maxTicksLimit: 8 }, grid: { color: "#222" }, stacked: !!stacked },
      y: { stacked: !!stacked, ticks: { color: "#888", callback: (v) => fmt(v) }, grid: { color: "#222" } },
    },
    plugins: { legend: { labels: { color: "#ddd", boxWidth: 10, font: { size: 10 } } } },
    elements: { line: { borderWidth: 1.4 } },
  };
}
const charts = new Map();
function rebuildChart(key, ctx, config) {
  if (charts.has(key)) charts.get(key).destroy();
  charts.set(key, new Chart(ctx, config));
}

// ── Browse panels ─────────────────────────────────────────────────────────
function rwaSlug(s) {
  return String(s ?? "").toLowerCase().trim()
    .replace(/[^\\w]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
function rwasMatching(dim, key) {
  return PAYLOAD.drill.rwas.filter(r => {
    if (dim === "chain") return r.chains.some(c => rwaSlug(c) === key);
    if (dim === "category") return r.categories.some(c => rwaSlug(c) === key);
    if (dim === "platform") return r.platform && rwaSlug(r.platform) === key;
    if (dim === "assetgroup") return r.assetGroup && rwaSlug(r.assetGroup) === key;
    return false;
  });
}
function flowContribution(rwa, dim, key) {
  // Returns Map<ts, value> of this RWA's per-period contribution to (dim, key).
  const map = new Map();
  if (dim === "chain") {
    const label = rwa.chains.find(c => rwaSlug(c) === key);
    if (!label) return map;
    for (const p of rwa.flowSeries) map.set(p.timestamp, Number(p.netFlowByChain?.[label]) || 0);
  } else {
    for (const p of rwa.flowSeries) map.set(p.timestamp, p.netFlowUsd === null ? 0 : p.netFlowUsd);
  }
  return map;
}
const TOP_FLOW_RWAS = 10;
function renderBrowse(panel) {
  const dim = panel.dataset.dim;
  const entries = (PAYLOAD.browseData[dim] || []);
  const keySelect = panel.querySelector(".key-select");
  const metricSelect = panel.querySelector(".metric-select");
  const bdCanvas = panel.querySelector(".bd-chart");
  const flowCanvas = panel.querySelector(".flow-chart");

  const entry = entries.find(e => e.key === keySelect.value);
  if (!entry || !entry.breakdown) return;
  const series = entry.breakdown[metricSelect.value] || [];

  // Breakdown chart (left)
  const labels = series.map(r => isoDay(r.timestamp));
  const tickerSet = new Set();
  for (const row of series) for (const k of Object.keys(row)) if (k !== "timestamp") tickerSet.add(k);
  const tickers = Array.from(tickerSet);
  const last = series[series.length - 1] || {};
  tickers.sort((a, b) => (Number(last[b]) || 0) - (Number(last[a]) || 0));
  const bdDatasets = tickers.map((t, i) => ({
    label: t,
    data: series.map(r => Number(r[t]) || 0),
    backgroundColor: PALETTE[i % PALETTE.length] + "cc",
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 0,
    pointRadius: 0,
    fill: true,
    tension: 0,
    stack: "bd",
  }));
  rebuildChart(dim + "-bd", bdCanvas, { type: "line", data: { labels, datasets: bdDatasets }, options: chartOptions(true) });

  // Flow chart (right) — sum per-RWA daily flows for RWAs matching (dim, key).
  const matches = rwasMatching(dim, keySelect.value);
  if (matches.length === 0) {
    rebuildChart(dim + "-flow", flowCanvas, { data: { labels: [], datasets: [] }, options: chartOptions(false) });
    return;
  }
  // Union of timestamps from matching RWAs' flowSeries.
  const tsSet = new Set();
  for (const r of matches) for (const p of r.flowSeries) tsSet.add(p.timestamp);
  const flowTs = Array.from(tsSet).sort((a, b) => a - b);
  const flowLabels = flowTs.map(isoDay);

  // Per-RWA contribution arrays + rank by absolute total over the last 60 days.
  const recencyCutoff = flowTs[flowTs.length - 1] - 60 * 86400;
  const contribs = matches.map(r => {
    const m = flowContribution(r, dim, keySelect.value);
    const values = flowTs.map(ts => m.get(ts) ?? 0);
    let recencyScore = 0;
    for (let i = 0; i < flowTs.length; i++) if (flowTs[i] >= recencyCutoff) recencyScore += Math.abs(values[i]);
    return { rwa: r, values, recencyScore };
  }).filter(c => c.recencyScore > 0 || c.values.some(v => v !== 0));
  contribs.sort((a, b) => b.recencyScore - a.recencyScore);

  const top = contribs.slice(0, TOP_FLOW_RWAS);
  const rest = contribs.slice(TOP_FLOW_RWAS);
  const flowDatasets = top.map((c, i) => ({
    type: "bar",
    label: c.rwa.ticker,
    data: c.values,
    backgroundColor: PALETTE[i % PALETTE.length] + "cc",
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 0,
    stack: "flow",
  }));
  if (rest.length > 0) {
    const otherValues = flowTs.map((_, i) => rest.reduce((s, c) => s + c.values[i], 0));
    flowDatasets.push({
      type: "bar",
      label: \`Other (\${rest.length})\`,
      data: otherValues,
      backgroundColor: "#55555588",
      borderColor: "#666",
      borderWidth: 0,
      stack: "flow",
    });
  }
  // Total line on top
  const total = flowTs.map((_, i) => contribs.reduce((s, c) => s + c.values[i], 0));
  flowDatasets.push({
    type: "line",
    label: "TOTAL",
    data: total,
    borderColor: "#fff",
    borderWidth: 1.5,
    pointRadius: 0,
    fill: false,
  });
  rebuildChart(dim + "-flow", flowCanvas, {
    data: { labels: flowLabels, datasets: flowDatasets },
    options: {
      ...chartOptions(false),
      scales: {
        x: { stacked: true, ticks: { color: "#888", maxTicksLimit: 8 }, grid: { color: "#222" } },
        y: { stacked: true, ticks: { color: "#888", callback: (v) => fmt(v) }, grid: { color: "#222" } },
      },
    },
  });
}
for (const panel of document.querySelectorAll('.panel[data-section="browse"]')) {
  const dim = panel.dataset.dim;
  const entries = PAYLOAD.browseData[dim] || [];
  const keySelect = panel.querySelector(".key-select");
  if (entries.length === 0) {
    keySelect.innerHTML = "<option>(no data)</option>";
    keySelect.disabled = true;
    continue;
  }
  for (const e of entries) {
    const opt = document.createElement("option");
    opt.value = e.key; opt.textContent = e.key;
    keySelect.appendChild(opt);
  }
  keySelect.addEventListener("change", () => renderBrowse(panel));
  panel.querySelector(".metric-select").addEventListener("change", () => renderBrowse(panel));
  renderBrowse(panel);
}

// ── Drill panel ───────────────────────────────────────────────────────────
function fillSelect(id, items, anyLabel) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  const any = document.createElement("option");
  any.value = ""; any.textContent = anyLabel || "(any)";
  sel.appendChild(any);
  for (const it of items) {
    const opt = document.createElement("option");
    opt.value = it; opt.textContent = it;
    sel.appendChild(opt);
  }
}
fillSelect("filter-chain", PAYLOAD.drill.chains, "(any chain)");
fillSelect("filter-category", PAYLOAD.drill.categories, "(any category)");
fillSelect("filter-platform", PAYLOAD.drill.platforms, "(any platform)");
fillSelect("filter-assetGroup", PAYLOAD.drill.assetGroups, "(any asset group)");

function refreshRwaList() {
  const c = document.getElementById("filter-chain").value;
  const cat = document.getElementById("filter-category").value;
  const p = document.getElementById("filter-platform").value;
  const ag = document.getElementById("filter-assetGroup").value;
  const matches = PAYLOAD.drill.rwas.filter(r => {
    if (c && !r.chains.includes(c)) return false;
    if (cat && !r.categories.includes(cat)) return false;
    if (p && r.platform !== p) return false;
    if (ag && r.assetGroup !== ag) return false;
    return true;
  });
  const rwaSelect = document.getElementById("filter-rwa");
  const prev = rwaSelect.value;
  rwaSelect.innerHTML = "";
  if (matches.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "(no matching RWA in top 100)";
    rwaSelect.appendChild(opt);
    rwaSelect.disabled = true;
    return;
  }
  rwaSelect.disabled = false;
  for (const r of matches) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = \`\${r.ticker} — \${r.name} (id \${r.id})\`;
    rwaSelect.appendChild(opt);
  }
  if (matches.some(r => r.id === prev)) rwaSelect.value = prev;
  renderDrill();
}

function renderDrill() {
  const id = document.getElementById("filter-rwa").value;
  const refKey = document.getElementById("ref-toggle").value; // onChainMcap | totalSupply
  const rwa = PAYLOAD.drill.rwas.find(r => r.id === id);
  if (!rwa) return;

  const refLabels = rwa.refSeries.map(p => isoDay(p.timestamp));
  const refData = rwa.refSeries.map(p => p[refKey]);
  rebuildChart("ref", document.getElementById("ref-chart"), {
    type: "line",
    data: {
      labels: refLabels,
      datasets: [{
        label: refKey,
        data: refData,
        borderColor: refKey === "totalSupply" ? "#ce93d8" : "#4fc3f7",
        backgroundColor: (refKey === "totalSupply" ? "#ce93d8" : "#4fc3f7") + "22",
        pointRadius: 0,
        tension: 0,
        spanGaps: false,
        fill: true,
      }],
    },
    options: chartOptions(false),
  });

  const flowLabels = rwa.flowSeries.map(p => isoDay(p.timestamp));
  const flowChainSet = new Set();
  rwa.flowSeries.forEach(p => Object.keys(p.netFlowByChain || {}).forEach(c => flowChainSet.add(c)));
  const flowChains = Array.from(flowChainSet);
  const flowDatasets = flowChains.map((c, i) => ({
    type: "bar",
    label: c,
    data: rwa.flowSeries.map(p => p.netFlowUsd === null ? null : (p.netFlowByChain[c] || 0)),
    backgroundColor: PALETTE[i % PALETTE.length] + "cc",
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 0,
    stack: "flow",
  }));
  flowDatasets.push({
    type: "line",
    label: "TOTAL netFlowUsd",
    data: rwa.flowSeries.map(p => p.netFlowUsd),
    borderColor: "#fff",
    borderWidth: 1.5,
    pointRadius: 0,
    spanGaps: false,
    fill: false,
  });
  rebuildChart("flow", document.getElementById("flow-chart"), {
    data: { labels: flowLabels, datasets: flowDatasets },
    options: {
      ...chartOptions(false),
      scales: {
        x: { stacked: true, ticks: { color: "#888", maxTicksLimit: 8 }, grid: { color: "#222" } },
        y: { stacked: true, ticks: { color: "#888", callback: (v) => fmt(v) }, grid: { color: "#222" } },
      },
    },
  });
}

for (const fId of ["filter-chain", "filter-category", "filter-platform", "filter-assetGroup"]) {
  document.getElementById(fId).addEventListener("change", refreshRwaList);
}
document.getElementById("filter-rwa").addEventListener("change", renderDrill);
document.getElementById("ref-toggle").addEventListener("change", renderDrill);
refreshRwaList();
</script>
</body>
</html>`;
}
