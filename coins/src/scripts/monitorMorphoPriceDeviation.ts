/**
 * Morpho oracle vs DefiLlama price-deviation monitor.
 *
 * For each market it compares two prices for the COLLATERAL token:
 *   - "our price"    = the DefiLlama coins API price (coins.llama.fi)            [what we serve]
 *   - "oracle price" = the market's on-chain oracle price (collateral priced in
 *                      the loan asset), converted to USD                         [what Morpho lends against]
 * and alerts when |deviation| >= threshold (default 5%) in either direction. For Pendle-PT collateral
 * it ALSO pulls Pendle's own market price as a second reference and treats a >threshold gap vs Pendle
 * as a breach too — that is the signal that catches an inflated underlying (see apxUSD note below),
 * which the oracle gap alone can miss when the oracle also assumes ~par.
 *
 * Modes:
 *   (default)     scan EVERY listed Morpho market across all mapped chains (paginated)
 *   --watchlist   check only the small curated WATCHLIST below
 *   --market <uniqueKey> --chain <id>   check one ad-hoc market
 *
 * Why this exists — the PT-apxUSD-18JUN2026 / USDC market
 *   (0xed05fcc2893b78b3fa468d21b6e4d2925e7f2c64eb1f16279757c43f87502a99) showed our price above the
 *   oracle. Root cause was the UNDERLYING: we price apxUSD off CoinGecko (~$0.996, near peg) while its
 *   deepest market (Curve apxUSD/USDC) trades ~$0.944, so all Pendle apxUSD SY/PT/YT/LP are ~5.5% high.
 *
 * Usage (run from the coins/ directory). Scheduling is external (Jenkins) — this is a one-shot script
 * that exits after a single pass; there is no built-in cron or throttle. The scheduled run is the
 * `monitor-morpho-prices` package.json script (default mode = scan everything); URGENT_COINS_WEBHOOK from env.
 *   # scheduled run (default = scan every listed market)
 *   pnpm run monitor-morpho-prices       # = ts-node --transpile-only src/scripts/monitorMorphoPriceDeviation.ts
 *
 *   # only the small curated watchlist
 *   ts-node --transpile-only src/scripts/monitorMorphoPriceDeviation.ts --watchlist
 *
 *   # scan, but only markets with >= $1m supplied, at a 3% threshold, console-only
 *   ts-node --transpile-only src/scripts/monitorMorphoPriceDeviation.ts --min-liquidity 1000000 --threshold 3 --dry-run
 *
 *   # one ad-hoc market
 *   ts-node --transpile-only src/scripts/monitorMorphoPriceDeviation.ts \
 *     --market 0xed05fcc2893b78b3fa468d21b6e4d2925e7f2c64eb1f16279757c43f87502a99 --chain 1
 *
 * Posts a SINGLE consolidated Discord message per run (only when there are non-allowlisted breaches) to
 * env URGENT_COINS_WEBHOOK (the same channel as the "bridge … storeTokens failed" alerts). With no
 * webhook configured it just logs. Rate-limiting is the scheduler's job (Jenkins cadence).
 */
require("dotenv").config();

import fetch from "node-fetch";
import { sendMessage } from "../../../defi/src/utils/discord";

const MORPHO_GRAPHQL = "https://blue-api.morpho.org/graphql";
const COINS_API = "https://coins.llama.fi/prices/current";
const pendlePriceUrl = (chainId: number, addrs: string[]) =>
  `https://api-v2.pendle.finance/core/v1/${chainId}/assets/prices?addresses=${addrs.join(",")}`;

// Morpho chainId -> DefiLlama coins-API chain key. Markets on chains not listed here are reported as
// "unmapped-chain" and skipped (we cannot build the coin key). Extend as Morpho adds chains.
const CHAIN_KEY: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "xdai",
  130: "unichain",
  137: "polygon",
  146: "sonic",
  252: "fraxtal",
  747474: "katana",
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  57073: "ink",
  80094: "berachain",
  534352: "scroll",
  999: "hyperliquid",
};

// Curated markets checked in the default (no-flag) mode. Add { marketId, chainId, label } to extend.
const WATCHLIST: { marketId: string; chainId: number; label: string }[] = [
  {
    marketId: "0xed05fcc2893b78b3fa468d21b6e4d2925e7f2c64eb1f16279757c43f87502a99",
    chainId: 1,
    label: "PT-apxUSD-18JUN2026 / USDC",
  },
];

// Reviewed deviations we deliberately DON'T alert on — the gap is expected and not worth correcting
// (oracle uses NAV / a hardcoded peg / a discounted feed, or the oracle feed is the stale side while our
// price is correct). An entry may be keyed by `${chainId}:${collateralAddress}` (suppresses every market
// with that collateral — e.g. avKAT, used in 2 markets) OR by `${chainId}:${marketId}` (suppresses only
// that one market). Both are checked, market key first. Remove an entry to re-enable alerts.
const ALLOWLIST: Record<string, string> = {
  "747474:0x7231dbacdfc968e07656d12389ab20de82fbfceb": "avKAT — Katana KAT/USD oracle feed is stale/low; our price tracks the DEX",
  "1:0x38eeb52f0771140d10c4e9a9a72349a329fe8a6a": "apyUSD — trades below NAV; oracle prices at NAV (Apyx capped collateralization ratio)",
  "1:0x7309e1e2e74af170c69bde8fcb30397f8697d5ff": "wbravUSDC — oracle hardcodes $1.00; our price is the vault NAV (oracle conservative by design)",
  "1:0x238a700ed6165261cf8b2e544ba797bc11e466ba": "mF-ONE — Morpho oracle reads a deliberately discounted feed ('mF-ONE/USD Discounted', ~7.7% haircut, ~3d stale); our price is the live Midas NAV (matches CoinGecko)",
  "1:0x7f47c3e6b2c00fc4eb4d5ae50d0ab0ab6888eb4d": "PT-USD3-17DEC2026 — Morpho uses a conservative Pendle linear-discount oracle (accretes to par at maturity, ~12.7% below market); our price matches Pendle's own market (+0.07%)",
  "1:0x3365554a61ceff74a76528f9e86c1e87946d16a5": "PT-apyUSD-18JUN2026 — our price matches Pendle's own PT market (~$0.93, within ~1.3%); Morpho oracle marks the PT ABOVE the live market (stale/low fixed-discount rate vs ~29% live implied APY). PT trades far below spot apyUSD (~$1.28) per Pendle's maturity-value expectation; our price is the accurate one",
  "1:0xb5be35d8ff83d431899b95851cb17a2b4bcef150": "PT-apyUSD-5NOV2026 — same Apyx/apyUSD case as the 18JUN PT: our price matches Pendle's own PT market (~$0.877, within ~1.3%); Morpho oracle marks the PT above the live market. Pre-allowlisted (was -4.6%, just under threshold; same benign pattern)",
};
const allowReason = (chainId: number, collateralAddress: string, marketId: string): string | undefined =>
  ALLOWLIST[`${chainId}:${marketId.toLowerCase()}`] ?? ALLOWLIST[`${chainId}:${collateralAddress.toLowerCase()}`];

// ---- args ----------------------------------------------------------------
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const THRESHOLD = Number(arg("--threshold") ?? "5"); // percent
const MIN_LIQUIDITY = Number(arg("--min-liquidity") ?? "0"); // USD supplied; scan mode (default) only
const DRY_RUN = has("--dry-run");
const FAIL_ON_BREACH = has("--fail-on-breach");
const MAX_ALERT_LINES = 40; // cap the consolidated Discord message
// Discord webhook: the coins "urgent" channel (same as the "bridge … storeTokens failed" alerts).
const WEBHOOK = process.env.URGENT_COINS_WEBHOOK;

// ---- types ---------------------------------------------------------------
type Asset = { address: string; symbol: string; decimals: number; price?: { usd: number } | null };
type Market = {
  marketId: string;
  chain?: { id: number } | null;
  oracle: { address: string; type: string | null } | null;
  collateralAsset: Asset | null;
  loanAsset: Asset;
  state: { price: string | null; supplyAssetsUsd?: number | null } | null;
};
type Target = { chainId: number; label: string; market: Market };
type Row = {
  label: string;
  chainId: number;
  marketId: string;
  oracleType: string;
  liquidityUsd: number;
  ourUsd: number;
  oracleUsd: number;
  oracleDev: number;
  pendleUsd: number | null;
  pendleDev: number | null;
  breachRefs: string[];
  acknowledged?: string; // allowlist reason, if this breach is reviewed and suppressed
  confidence?: number;
};

// ---- helpers -------------------------------------------------------------
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const usd = (n: number | null | undefined) => (n == null ? "n/a" : `$${n.toPrecision(6)}`);
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const isPtSymbol = (s: string) => /^pt[-_]/i.test(s) || /(^|[^a-z])pt[-_]/i.test(s);

// All outbound calls go through here: an AbortController timeout so a stalled endpoint can't hang the
// cron, and a status check so non-2xx/HTML responses fail loudly instead of as opaque JSON parse errors.
const HTTP_TIMEOUT_MS = 30_000;
async function fetchJson(url: string, init?: any): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res: any = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function gql(query: string, variables?: any): Promise<any> {
  const res: any = await fetchJson(MORPHO_GRAPHQL, {
    method: "post",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (res.errors) throw new Error("Morpho GraphQL error: " + JSON.stringify(res.errors));
  return res;
}

const MARKET_FIELDS = `
  marketId
  chain { id }
  oracle { address type }
  collateralAsset { address symbol decimals }
  loanAsset { address symbol decimals price { usd } }
  state { price supplyAssetsUsd }`;

async function fetchMarketsByKeys(items: { marketId: string; chainId: number }[]): Promise<Record<string, Market>> {
  const res = await gql(
    `query ($keys: [String!], $chains: [Int!]) {
      markets(where: { uniqueKey_in: $keys, chainId_in: $chains }) { items { ${MARKET_FIELDS} } }
    }`,
    { keys: items.map((i) => i.marketId), chains: [...new Set(items.map((i) => i.chainId))] }
  );
  const out: Record<string, Market> = {};
  for (const m of res.data.markets.items as Market[]) out[m.marketId.toLowerCase()] = m;
  return out;
}

async function fetchAllMarkets(minLiquidity: number): Promise<Market[]> {
  const pageSize = 300;
  const where = minLiquidity > 0 ? `listed: true, supplyAssetsUsd_gte: ${minLiquidity}` : `listed: true`;
  const all: Market[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const res = await gql(
      `query ($first: Int!, $skip: Int!) {
        markets(first: $first, skip: $skip, where: { ${where} }) {
          items { ${MARKET_FIELDS} }
          pageInfo { countTotal }
        }
      }`,
      { first: pageSize, skip }
    );
    const items = res.data.markets.items as Market[];
    all.push(...items);
    if (items.length < pageSize || all.length >= res.data.markets.pageInfo.countTotal) break;
  }
  return all;
}

async function fetchDlPrices(keys: string[]): Promise<Record<string, { price: number; confidence?: number }>> {
  const uniq = [...new Set(keys)];
  const out: Record<string, { price: number; confidence?: number }> = {};
  for (const batch of chunk(uniq, 50)) {
    const res: any = await fetchJson(`${COINS_API}/${batch.join(",")}?searchWidth=6h`);
    for (const [k, v] of Object.entries(res.coins || {})) out[k.toLowerCase()] = v as any;
  }
  return out;
}

// PT addresses grouped by chainId -> map of `${chainId}:${addr}` -> usd price (best-effort).
async function fetchPendlePrices(byChain: Record<number, string[]>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [chainIdStr, addrs] of Object.entries(byChain)) {
    const chainId = Number(chainIdStr);
    for (const batch of chunk([...new Set(addrs.map((a) => a.toLowerCase()))], 80)) {
      try {
        const res: any = await fetchJson(pendlePriceUrl(chainId, batch));
        for (const [addr, p] of Object.entries(res?.prices || {})) {
          if (typeof p === "number") out[`${chainId}:${addr.toLowerCase()}`] = p;
        }
      } catch {
        /* best-effort reference; never fail the run on Pendle */
      }
    }
  }
  return out;
}

// Morpho oracle price is scaled by 10^(36 + loanDecimals - collateralDecimals) and expresses the value
// of 1 collateral token denominated in the loan asset.
const oraclePriceInLoan = (statePrice: string, loanDec: number, collDec: number) =>
  Number(statePrice) / 10 ** (36 + loanDec - collDec);

function evaluate(
  t: Target,
  dl: Record<string, { price: number; confidence?: number }>,
  pendle: Record<string, number>
): { row?: Row; skip?: string } {
  const { market: m, chainId } = t;
  const chainKey = CHAIN_KEY[chainId];
  if (!chainKey) return { skip: "unmapped-chain" };
  const coll = m.collateralAsset;
  if (!coll) return { skip: "idle/no-collateral" };
  if (!m.state?.price) return { skip: "no-oracle-price" };

  const collKey = `${chainKey}:${coll.address.toLowerCase()}`;
  const loanKey = `${chainKey}:${m.loanAsset.address.toLowerCase()}`;
  const ourUsd = dl[collKey]?.price;
  if (ourUsd == null) return { skip: "no-DL-price" };

  // Don't default an unknown loan-asset price to $1 — for a non-stable loan asset that fabricates a wrong
  // USD conversion (and synthetic breaches / false alerts in --all mode). Skip the market instead.
  const loanUsd = dl[loanKey]?.price ?? m.loanAsset.price?.usd;
  if (loanUsd == null) return { skip: "no-loan-price" };
  const oracleUsd = oraclePriceInLoan(m.state.price, m.loanAsset.decimals, coll.decimals) * loanUsd;
  const oracleDev = (ourUsd / oracleUsd - 1) * 100;

  let pendleUsd: number | null = null;
  let pendleDev: number | null = null;
  if (isPtSymbol(coll.symbol)) {
    const p = pendle[`${chainId}:${coll.address.toLowerCase()}`];
    if (typeof p === "number" && p > 0) {
      pendleUsd = p;
      pendleDev = (ourUsd / p - 1) * 100;
    }
  }

  const breachRefs: string[] = [];
  if (Math.abs(oracleDev) >= THRESHOLD) breachRefs.push("oracle");
  if (pendleDev != null && Math.abs(pendleDev) >= THRESHOLD) breachRefs.push("pendle");

  return {
    row: {
      label: t.label,
      chainId,
      marketId: m.marketId.toLowerCase(),
      oracleType: m.oracle?.type ?? "unknown",
      liquidityUsd: Number(m.state.supplyAssetsUsd ?? 0),
      ourUsd,
      oracleUsd,
      oracleDev,
      pendleUsd,
      pendleDev,
      breachRefs,
      acknowledged: allowReason(chainId, coll.address, m.marketId),
      confidence: dl[collKey]?.confidence,
    },
  };
}

const worstDev = (r: Row) => Math.max(Math.abs(r.oracleDev), r.pendleDev != null ? Math.abs(r.pendleDev) : 0);
// Signed deviation of whichever reference deviates most — used for the leading severity figure & direction.
const worstSignedDev = (r: Row) =>
  r.pendleDev != null && Math.abs(r.pendleDev) > Math.abs(r.oracleDev) ? r.pendleDev : r.oracleDev;
const breachLine = (r: Row) => {
  const p = r.pendleUsd != null ? ` | pendle ${usd(r.pendleUsd)} ${pct(r.pendleDev!)}` : "";
  return `${pct(worstSignedDev(r)).padStart(8)}  ${r.label} (${CHAIN_KEY[r.chainId]})  our ${usd(
    r.ourUsd
  )} | oracle ${usd(r.oracleUsd)} ${pct(r.oracleDev)}${p}  [${r.breachRefs.join("+")}]`;
};

// ---- main ----------------------------------------------------------------
async function main() {
  const argMarket = arg("--market");
  const useWatchlist = has("--watchlist"); // opt into the small curated list; default scans everything

  let targets: Target[] = [];
  let mode = "scan";

  if (argMarket) {
    mode = "single";
    const chainId = Number(arg("--chain") ?? "1");
    const byKey = await fetchMarketsByKeys([{ marketId: argMarket.toLowerCase(), chainId }]);
    const m = byKey[argMarket.toLowerCase()];
    if (m) targets = [{ chainId, label: short(argMarket), market: m }];
    else console.warn(`  ! market not found: ${argMarket} (chain ${chainId})`);
  } else if (useWatchlist) {
    mode = "watchlist";
    const byKey = await fetchMarketsByKeys(WATCHLIST);
    for (const w of WATCHLIST) {
      const m = byKey[w.marketId.toLowerCase()];
      if (m) targets.push({ chainId: w.chainId, label: w.label, market: m });
      else console.warn(`  ! market not found: ${w.marketId} (chain ${w.chainId})`);
    }
  } else {
    // default: scan every listed Morpho market
    console.log(`[Morpho monitor] scanning all listed markets (min liquidity $${MIN_LIQUIDITY.toLocaleString()})…`);
    const markets = await fetchAllMarkets(MIN_LIQUIDITY);
    console.log(`  fetched ${markets.length} markets`);
    targets = markets.map((m) => ({
      chainId: m.chain?.id ?? 0,
      label: `${m.collateralAsset?.symbol ?? "?"} / ${m.loanAsset.symbol}`,
      market: m,
    }));
  }

  console.log(
    `[Morpho monitor] mode=${mode}, ${targets.length} market(s), threshold ${THRESHOLD}%` +
      `${DRY_RUN ? " (dry-run: console only)" : ""}\n`
  );

  // Batch price lookups: collect every collateral+loan coin key and every PT collateral address.
  const coinKeys: string[] = [];
  const ptByChain: Record<number, string[]> = {};
  for (const t of targets) {
    const chainKey = CHAIN_KEY[t.chainId];
    const coll = t.market.collateralAsset;
    if (!chainKey || !coll) continue;
    coinKeys.push(`${chainKey}:${coll.address.toLowerCase()}`, `${chainKey}:${t.market.loanAsset.address.toLowerCase()}`);
    if (isPtSymbol(coll.symbol)) (ptByChain[t.chainId] ??= []).push(coll.address);
  }
  const [dl, pendle] = await Promise.all([fetchDlPrices(coinKeys), fetchPendlePrices(ptByChain)]);

  // Evaluate every target.
  const rows: Row[] = [];
  const skips: Record<string, number> = {};
  for (const t of targets) {
    const { row, skip } = evaluate(t, dl, pendle);
    if (row) rows.push(row);
    else if (skip) skips[skip] = (skips[skip] ?? 0) + 1;
  }

  const allBreaches = rows.filter((r) => r.breachRefs.length > 0).sort((a, b) => worstDev(b) - worstDev(a));
  const breaches = allBreaches.filter((r) => !r.acknowledged); // alertable
  const acknowledged = allBreaches.filter((r) => r.acknowledged); // reviewed -> suppressed

  // ---- report --------------------------------------------------------------
  if (mode !== "scan") {
    for (const r of rows) {
      const flag = r.breachRefs.length ? (r.acknowledged ? "✓ acknowledged" : "⚠️ BREACH") : "ok";
      console.log(`${r.breachRefs.length && !r.acknowledged ? "⚠️ " : "   "}${r.label}  [${flag}]`);
      console.log(`     market   ${short(r.marketId)} (${CHAIN_KEY[r.chainId]})  oracle=${r.oracleType}`);
      console.log(`     our px   ${usd(r.ourUsd)}  (DefiLlama${r.confidence != null ? `, conf ${r.confidence}` : ""})`);
      console.log(`     oracle   ${usd(r.oracleUsd)}   ->  our vs oracle ${pct(r.oracleDev)}`);
      if (r.pendleUsd != null)
        console.log(`     pendle   ${usd(r.pendleUsd)}   ->  our vs pendle ${pct(r.pendleDev!)}  (true PT market)`);
      if (r.acknowledged) console.log(`     ✓ allowlisted: ${r.acknowledged}`);
      console.log("");
    }
  } else {
    if (breaches.length) {
      console.log(`⚠️ ${breaches.length} alertable breach(es) >= ${THRESHOLD}% (sorted by severity):`);
      for (const r of breaches) console.log("  " + breachLine(r));
      console.log("");
    }
    if (acknowledged.length) {
      console.log(`✓ ${acknowledged.length} acknowledged (allowlisted, not alerted):`);
      for (const r of acknowledged) console.log(`  ${breachLine(r)}  — ${r.acknowledged}`);
      console.log("");
    }
  }

  const skipStr = Object.entries(skips)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  console.log(
    `[Morpho monitor] ${rows.length} priced, ${breaches.length} alertable breach(es), ` +
      `${acknowledged.length} acknowledged (>= ${THRESHOLD}%)${skipStr ? `, skipped: ${skipStr}` : ""}`
  );

  // ---- consolidated alert --------------------------------------------------
  if (breaches.length) {
    const dir = (d: number) => (d > 0 ? "our HIGHER" : "our LOWER");
    const shown = breaches.slice(0, MAX_ALERT_LINES);
    const lines = [
      `[Morpho price monitor] ${breaches.length} Morpho market(s) with >=${THRESHOLD}% price deviation (mode=${mode}):`,
      ...shown.map((r) => {
        const refs = r.breachRefs
          .map((ref) =>
            ref === "oracle"
              ? `oracle ${usd(r.oracleUsd)} ${pct(r.oracleDev)}`
              : `pendle ${usd(r.pendleUsd)} ${pct(r.pendleDev!)}`
          )
          .join(", ");
        return `• ${r.label} (${CHAIN_KEY[r.chainId]}): our ${usd(r.ourUsd)} vs ${refs}  [${dir(
          worstSignedDev(r)
        )}]`;
      }),
    ];
    if (breaches.length > shown.length) lines.push(`…and ${breaches.length - shown.length} more`);
    const message = lines.join("\n");

    if (DRY_RUN) {
      console.log(`\n[dry-run] would alert:\n${message}`);
    } else if (!WEBHOOK) {
      console.warn(`[Morpho monitor] no webhook set (URGENT_COINS_WEBHOOK); message:\n${message}`);
    } else {
      await sendMessage(message, WEBHOOK, true);
      console.log(`[Morpho monitor] alert sent (${breaches.length} market(s))`);
    }
  }

  if (FAIL_ON_BREACH && breaches.length) process.exit(2);
}

main()
  .catch((e) => {
    console.error("[Morpho monitor] fatal:", e);
    process.exit(1);
  })
  .then(() => process.exit(0));
