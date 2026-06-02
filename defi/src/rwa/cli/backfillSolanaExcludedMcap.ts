/**
 * Rebuild Solana RWA mcap/activeMcap/totalsupply for xStock/Backed assets.
 *
 * This is the excluded-balance-aware companion to backfillSolanaRwaMcap.ts.
 * The older script uses raw mint/burn supply and only fills missing Solana rows.
 * This script reconstructs per-day Solana token-account balances from Dune,
 * subtracts holdersToRemove plus the Solana burn address, smooths short bad
 * runs, and overwrites only the `solana` entry inside each chain map.
 *
 * Default mode is dry-run. Writes require both --write and --yes.
 *
 * Examples:
 *   npx ts-node src/rwa/cli/backfillSolanaExcludedMcap.ts \
 *     --ticker METAx --start-date 2026-03-01 --out ./metax-preview.html
 *
 *   npx ts-node src/rwa/cli/backfillSolanaExcludedMcap.ts \
 *     --all --start-date 2026-03-01 --out ./xstocks-preview.html
 *
 *   npx ts-node src/rwa/cli/backfillSolanaExcludedMcap.ts \
 *     --all --start-date 2026-03-01 --write --yes
 */

import axios from "axios";
import { Contract, Interface, JsonRpcProvider, formatUnits } from "ethers";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as sdk from "@defillama/sdk";
import {
  initPG,
  fetchDailyRecordsForIdPG,
  fetchDailyRecordsWithChainsForIdPG,
  fetchMetadataPG,
  DAILY_RWA_DATA,
  BACKUP_RWA_DATA,
} from "../db";
import { ONCHAIN_MCAP_EQUALS_ACTIVE_PLATFORMS } from "../constants";
import { fetchBurnAddresses, smoothHistoricalData, toFiniteNumberOrZero, HistoricalRecord } from "../utils";
import { trimLeadingZeros } from "../cron";

const CHAIN = "solana";
const CHAIN_LABEL = "Solana";
const DEFAULT_PLATFORMS = ["xStock", "Backed Finance"];
const DEFAULT_ALL_SKIP_TICKERS = ["PALLx", "PPLTx"];

function alchemyApiKey(): string | null {
  if (process.env.ALCHEMY_API_KEY) return process.env.ALCHEMY_API_KEY;
  const solanaRpc = process.env.SOLANA_RPC ?? "";
  const match = solanaRpc.match(/\/v2\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function alchemyRpc(network: string): string[] {
  const key = alchemyApiKey();
  return key ? [`https://${network}.g.alchemy.com/v2/${key}`] : [];
}

function envRpc(name: string): string[] {
  const value = process.env[name];
  return value ? [value] : [];
}

const EVM_CHAIN_CONFIG: Record<string, { label: string; chainId: number; rpcUrls: string[] }> = {
  ethereum: {
    label: "Ethereum",
    chainId: 1,
    rpcUrls: [...envRpc("ETH_RPC"), ...alchemyRpc("eth-mainnet"), "https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://1rpc.io/eth"],
  },
  bsc: {
    label: "BSC",
    chainId: 56,
    rpcUrls: [
      ...envRpc("BSC_RPC"),
      ...alchemyRpc("bnb-mainnet"),
      "https://bsc-mainnet.public.blastapi.io",
      "https://bsc.publicnode.com",
      "https://bsc-dataseed.binance.org",
    ],
  },
  arbitrum: {
    label: "Arbitrum",
    chainId: 42161,
    rpcUrls: [...envRpc("ARBITRUM_RPC"), ...alchemyRpc("arb-mainnet"), "https://arbitrum-one.public.blastapi.io", "https://arb1.arbitrum.io/rpc", "https://1rpc.io/arb"],
  },
  mantle: {
    label: "Mantle",
    chainId: 5000,
    rpcUrls: [...envRpc("MANTLE_RPC"), ...alchemyRpc("mantle-mainnet"), "https://rpc.mantle.xyz", "https://mantle.publicnode.com", "https://1rpc.io/mantle"],
  },
  ink: {
    label: "Ink",
    chainId: 57073,
    rpcUrls: [...envRpc("INK_RPC"), "https://rpc-gel.inkonchain.com", "https://rpc-qnd.inkonchain.com", "https://ink.drpc.org"],
  },
};
const EVM_LABEL_TO_SLUG = Object.fromEntries(
  Object.entries(EVM_CHAIN_CONFIG).map(([slug, cfg]) => [cfg.label, slug])
);
const DUNE_BASE = "https://api.dune.com/api/v1";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const POLL_INTERVAL_MS = Number(process.env.DUNE_POLL_INTERVAL_MS ?? 3000);
const POLL_TIMEOUT_MS = Number(process.env.DUNE_POLL_TIMEOUT_MS ?? 45 * 60 * 1000);

type ExistingSource = "cache" | "db";
type MetadataSource = "cache" | "db" | "url";

interface AssetMeta {
  id: string;
  ticker: string;
  assetName?: string;
  parentPlatform?: string;
  mint: string;
  excludedOwners: string[];
  evmContracts: EvmContractTarget[];
  raw: any;
}

interface EvmContractTarget {
  chain: string;
  label: string;
  contract: string;
  excludedOwners: string[];
}

interface DuneRow {
  id: string;
  ticker: string;
  mint: string;
  day: string;
  raw_balance: number | string;
  excluded_balance: number | string;
  active_balance: number | string;
  account_count?: number | string;
  excluded_account_count?: number | string;
}

interface SupplyPoint {
  timestamp: number;
  block?: number;
  rawBalance: number;
  excludedBalance: number;
  activeBalance: number;
  smoothedActiveBalance: number;
  accountCount: number;
  excludedAccountCount: number;
  smoothingChanged: boolean;
}

interface DailyPricePoint {
  timestamp: number;
  price: number;
  smoothedPrice: number;
  smoothingChanged: boolean;
}

interface PriceSmoothingChange {
  timestamp: number;
  oldPrice: number;
  newPrice: number;
  reason: string;
}

interface PriceMapResult {
  prices: Map<number, number>;
  changes: PriceSmoothingChange[];
  warnings: string[];
}

interface ExistingChainRow {
  timestamp: number;
  mcap: { [chain: string]: any };
  activemcap: { [chain: string]: any };
  defiactivetvl: { [chain: string]: any };
  totalsupply: { [chain: string]: any };
}

interface AggregateRow {
  timestamp: number;
  aggregatedefiactivetvl: number;
  aggregatemcap: number;
  aggregatedactivemcap: number;
}

interface PlannedWrite {
  id: string;
  ticker: string;
  timestamp: number;
  price: number;
  rawSupply: number;
  rawActiveSupply: number;
  activeSupply: number;
  excludedSupply: number;
  oldSolanaMcap: number;
  newSolanaMcap: number;
  oldAggregateMcap: number;
  newAggregateMcap: number;
  oldAggregateActiveMcap: number;
  newAggregateActiveMcap: number;
  newMcap: { [chain: string]: string };
  newActiveMcap: { [chain: string]: string };
  newTotalSupply: { [chain: string]: string };
  existingDefiActiveTvl: { [chain: string]: any };
  existingAggregateDefiActiveTvl: number;
  smoothingChanged: boolean;
  chainUpdates: {
    [chain: string]: {
      oldMcap: number;
      newMcap: number;
      rawSupply: number;
      excludedSupply: number;
      activeSupply: number;
      block?: number;
      smoothingChanged: boolean;
    };
  };
}

interface AssetPreview {
  asset: AssetMeta;
  before: HistoricalRecord[];
  after: HistoricalRecord[];
  writes: PlannedWrite[];
  supplyPoints: SupplyPoint[];
  priceMap: Map<number, number>;
  priceSmoothingChanges: PriceSmoothingChange[];
  priceSmoothingWarnings: string[];
  skippedNoPrice: number;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function usage(code = 1): never {
  console.error(`
Usage:
  npx ts-node src/rwa/cli/backfillSolanaExcludedMcap.ts --ticker METAx [flags]
  npx ts-node src/rwa/cli/backfillSolanaExcludedMcap.ts --all [flags]

Selection:
  --ticker TICKER             Run one asset by ticker, e.g. METAx.
  --asset-id ID               Run one asset by RWA id.
  --all                       Run all Solana assets on xStock/Backed Finance.
  --platforms CSV             Default: xStock,Backed Finance.
  --skip-tickers CSV           Default for --all: PALLx,PPLTx.

Sources:
  --metadata-source cache|db|url  Default: cache.
  --metadata-url URL              Used with --metadata-source url.
  --existing-source cache|db      Default: cache for dry-run, db for --write.
  --cache-version v3.09           RWA cache version; defaults to latest.

Date range:
  --start-date YYYY-MM-DD      Default: 2025-01-01.
  --end-date YYYY-MM-DD        Default: today UTC.
  --lookback-date YYYY-MM-DD   Dune carry-forward lookback. Default: 2025-01-01.

Behavior:
  --out FILE                   Dry-run HTML preview path.
  --refresh-dune               Ignore cached Dune rows.
  --refresh-prices             Ignore cached coins chart rows.
  --include-evm                Also rebuild Ethereum/BSC/Arbitrum/Mantle/Ink rows from historical RPC.
  --evm-chains CSV             Default: ethereum,bsc,arbitrum,mantle,ink.
  --refresh-evm                Ignore cached EVM RPC rows.
  --no-smoothing               Disable short-run balance smoothing.
  --smooth-max-run N           Default: 5.
  --no-price-smoothing         Disable price smoothing.
  --price-smooth-max-run N     Max bad price run to interpolate/carry. Default: 21.
  --price-smooth-max-ratio N   Daily price ratio threshold. Default: 1.45.
  --flat-nav PRICE             Use a fixed price instead of coins API.
  --write --yes                Write daily_rwa_data and backup_rwa_data.
`);
  process.exit(code);
}

const WRITE = hasFlag("--write");
const YES = hasFlag("--yes");
const ALL = hasFlag("--all");
const TICKER = arg("--ticker");
const ASSET_ID = arg("--asset-id");
const START_DATE = arg("--start-date") ?? "2025-01-01";
const END_DATE = arg("--end-date") ?? todayIsoUtc();
const LOOKBACK_DATE = arg("--lookback-date") ?? "2025-01-01";
const METADATA_SOURCE = (arg("--metadata-source") ?? "cache") as MetadataSource;
const EXISTING_SOURCE = (arg("--existing-source") ?? (WRITE ? "db" : "cache")) as ExistingSource;
const METADATA_URL = arg("--metadata-url");
const CACHE_VERSION = arg("--cache-version");
const OUT = arg("--out") ?? `./rwa-solana-excluded-${TICKER ?? ASSET_ID ?? (ALL ? "all" : "preview")}.html`;
const REFRESH_DUNE = hasFlag("--refresh-dune");
const REFRESH_PRICES = hasFlag("--refresh-prices");
const INCLUDE_EVM = hasFlag("--include-evm") || hasFlag("--all-chains");
const REFRESH_EVM = hasFlag("--refresh-evm");
const EVM_CHAINS = (arg("--evm-chains") ?? Object.keys(EVM_CHAIN_CONFIG).join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const NO_SMOOTHING = hasFlag("--no-smoothing");
const SMOOTH_MAX_RUN = Number(arg("--smooth-max-run") ?? 5);
const NO_PRICE_SMOOTHING = NO_SMOOTHING || hasFlag("--no-price-smoothing");
const PRICE_SMOOTH_MAX_RUN = Number(arg("--price-smooth-max-run") ?? 21);
const PRICE_SMOOTH_MAX_RATIO = Number(arg("--price-smooth-max-ratio") ?? 1.45);
const PRICE_SMOOTH_MIN_RATIO = 1 / PRICE_SMOOTH_MAX_RATIO;
const FLAT_NAV_RAW = arg("--flat-nav");
const FLAT_NAV = FLAT_NAV_RAW == null ? null : Number(FLAT_NAV_RAW);
const CACHE_DIR = path.resolve(process.env.RWA_SOLANA_EXCLUDED_CACHE_DIR ?? ".cache/rwa-solana-excluded");
const PLATFORMS = (arg("--platforms") ?? DEFAULT_PLATFORMS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const SKIP_TICKER_LABELS = (arg("--skip-tickers") ?? (ALL ? DEFAULT_ALL_SKIP_TICKERS.join(",") : ""))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SKIP_TICKERS = new Set(SKIP_TICKER_LABELS.map((s) => s.toLowerCase()));

if (hasFlag("--help") || hasFlag("-h")) usage(0);
if ((!ALL && !TICKER && !ASSET_ID) || (ALL && (TICKER || ASSET_ID))) usage();
if (WRITE && !YES) {
  console.error("ERROR: writes require both --write and --yes");
  process.exit(1);
}
if (WRITE && EXISTING_SOURCE !== "db") {
  console.error("ERROR: --write must use --existing-source db");
  process.exit(1);
}
if (METADATA_SOURCE === "url" && !METADATA_URL) {
  console.error("ERROR: --metadata-source url requires --metadata-url");
  process.exit(1);
}
if (!Number.isFinite(SMOOTH_MAX_RUN) || SMOOTH_MAX_RUN < 0) {
  console.error("ERROR: --smooth-max-run must be a non-negative number");
  process.exit(1);
}
if (FLAT_NAV_RAW != null && (!Number.isFinite(FLAT_NAV) || (FLAT_NAV as number) <= 0)) {
  console.error("ERROR: --flat-nav must be a positive number");
  process.exit(1);
}
if (!Number.isFinite(PRICE_SMOOTH_MAX_RUN) || PRICE_SMOOTH_MAX_RUN < 0) {
  console.error("ERROR: --price-smooth-max-run must be a non-negative number");
  process.exit(1);
}
if (!Number.isFinite(PRICE_SMOOTH_MAX_RATIO) || PRICE_SMOOTH_MAX_RATIO <= 1) {
  console.error("ERROR: --price-smooth-max-ratio must be greater than 1");
  process.exit(1);
}
for (const chain of EVM_CHAINS) {
  if (!EVM_CHAIN_CONFIG[chain]) {
    console.error(`ERROR: unsupported --evm-chains entry "${chain}". Supported: ${Object.keys(EVM_CHAIN_CONFIG).join(",")}`);
    process.exit(1);
  }
}
for (const d of [START_DATE, END_DATE, LOOKBACK_DATE]) {
  if (parseIsoDayUtc(d) == null) {
    console.error(`ERROR: invalid YYYY-MM-DD date: ${d}`);
    process.exit(1);
  }
}
if ((parseIsoDayUtc(LOOKBACK_DATE) as number) > (parseIsoDayUtc(START_DATE) as number)) {
  console.error("ERROR: --lookback-date must be on or before --start-date");
  process.exit(1);
}

function parseIsoDayUtc(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const ts = Math.floor(Date.UTC(y, m - 1, d) / 1000);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts * 1000).toISOString().slice(0, 10) === day ? ts : null;
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoToTs(day: string): number {
  const ts = parseIsoDayUtc(day);
  if (ts == null) throw new Error(`Bad date: ${day}`);
  return ts;
}

function tsToIso(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function addDaysIso(day: string, days: number): string {
  return tsToIso(isoToTs(day) + days * 86400);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function hashJson(value: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toNumber(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function sumChainValues(chainMap: { [chain: string]: any } | null | undefined): number {
  if (!chainMap) return 0;
  let total = 0;
  for (const value of Object.values(chainMap)) {
    const n = Number(value);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function latestCacheVersion(): string {
  const root = path.resolve("src/rwa/.rwa-cache");
  if (!fs.existsSync(root)) throw new Error(`RWA cache not found at ${root}`);
  const versions = fs.readdirSync(root)
    .filter((name) => /^v\d+\.\d+$/.test(name) && fs.existsSync(path.join(root, name, "build", "current.json")))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error(`No build/current.json found under ${root}`);
  return latest;
}

function cacheBuildPath(...parts: string[]): string {
  const version = CACHE_VERSION ?? latestCacheVersion();
  return path.resolve("src/rwa/.rwa-cache", version, "build", ...parts);
}

async function loadMetadata(): Promise<any[]> {
  if (METADATA_SOURCE === "db") {
    await initPG();
    const rows = await fetchMetadataPG();
    return rows.map((r: any) => ({ ...r.data, id: String(r.id ?? r.data?.id) }));
  }

  if (METADATA_SOURCE === "url") {
    const res = await fetch(METADATA_URL!);
    if (!res.ok) throw new Error(`metadata-url failed HTTP ${res.status}: ${METADATA_URL}`);
    const json: any = await res.json();
    if (!Array.isArray(json)) throw new Error(`metadata-url did not return an array`);
    return json;
  }

  const file = cacheBuildPath("current.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(json)) throw new Error(`${file} did not contain an array`);
  return json;
}

function normalizeAsset(item: any): AssetMeta | null {
  const mint = item?.contracts?.[CHAIN_LABEL]?.[0];
  if (!item?.id || !mint) return null;
  const holders = item?.holdersToRemove?.[CHAIN_LABEL] ?? [];
  const burn = fetchBurnAddresses(CHAIN);
  const evmContracts: EvmContractTarget[] = [];
  for (const [label, contracts] of Object.entries(item?.contracts ?? {}) as any[]) {
    const chain = EVM_LABEL_TO_SLUG[label];
    if (!chain || !EVM_CHAINS.includes(chain)) continue;
    const contract = Array.isArray(contracts) ? contracts[0] : null;
    if (!contract) continue;
    const excludedOwners = [
      ...(item?.holdersToRemove?.[label] ?? []),
      ...fetchBurnAddresses(chain),
    ].filter(Boolean).map(String);
    evmContracts.push({
      chain,
      label,
      contract: String(contract).toLowerCase(),
      excludedOwners: Array.from(new Set(excludedOwners.map((owner) => owner.toLowerCase()))),
    });
  }
  return {
    id: String(item.id),
    ticker: String(item.ticker ?? item.symbol ?? item.assetName ?? item.id),
    assetName: item.assetName,
    parentPlatform: item.parentPlatform,
    mint,
    excludedOwners: Array.from(new Set([...holders, ...burn].filter(Boolean).map(String))),
    evmContracts,
    raw: item,
  };
}

function selectAssets(metadata: any[]): AssetMeta[] {
  const platformSet = new Set(PLATFORMS);
  const assets = metadata.map(normalizeAsset).filter(Boolean) as AssetMeta[];
  let selected: AssetMeta[];

  if (ALL) {
    selected = assets.filter((a) => platformSet.has(String(a.parentPlatform ?? "")));
  } else if (TICKER) {
    selected = assets.filter((a) => a.ticker.toLowerCase() === TICKER.toLowerCase());
  } else {
    selected = assets.filter((a) => a.id === ASSET_ID);
  }

  const byId = new Map<string, AssetMeta>();
  for (const asset of selected) byId.set(asset.id, asset);
  return Array.from(byId.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function buildDuneSql(assets: AssetMeta[]): string {
  const assetValues = assets
    .map((a) => `(${sqlString(a.id)}, ${sqlString(a.ticker)}, ${sqlString(a.mint)})`)
    .join(",\n    ");

  const ownerValues = assets
    .flatMap((a) => a.excludedOwners.map((owner) => ({ id: a.id, mint: a.mint, owner })))
    .map((row) => `(${sqlString(row.id)}, ${sqlString(row.mint)}, ${sqlString(row.owner.toLowerCase())})`)
    .join(",\n    ");

  const endExclusive = addDaysIso(END_DATE, 1);

  return `
WITH assets(id, ticker, mint) AS (
  VALUES
    ${assetValues}
),
excluded_owners(id, mint, owner) AS (
  VALUES
    ${ownerValues}
),
dates(day) AS (
  SELECT day
  FROM UNNEST(sequence(date ${sqlString(START_DATE)}, date ${sqlString(END_DATE)}, interval '1' day)) AS t(day)
),
balance_updates AS (
  SELECT
    a.id,
    a.ticker,
    a.mint,
    CAST(b.day AS date) AS day,
    CAST(b.address AS varchar) AS address,
    max_by(CAST(b.token_balance AS double), b.day) AS token_balance,
    max_by(CAST(b.token_balance_owner AS varchar), b.day) AS owner
  FROM solana_utils.daily_balances b
  JOIN assets a ON b.token_mint_address = a.mint
  WHERE b.day >= timestamp ${sqlString(LOOKBACK_DATE)}
    AND b.day < timestamp ${sqlString(endExclusive)}
    AND b.month >= CAST(date_trunc('month', date ${sqlString(LOOKBACK_DATE)}) AS date)
    AND b.month <= CAST(date_trunc('month', date ${sqlString(END_DATE)}) AS date)
  GROUP BY 1, 2, 3, 4, 5
),
balance_intervals AS (
  SELECT
    *,
    lead(day) OVER (PARTITION BY mint, address ORDER BY day) AS next_day
  FROM balance_updates
),
expanded AS (
  SELECT
    bi.id,
    bi.ticker,
    bi.mint,
    d.day,
    bi.address,
    bi.owner,
    bi.token_balance
  FROM balance_intervals bi
  JOIN dates d
    ON d.day >= bi.day
   AND (bi.next_day IS NULL OR d.day < bi.next_day)
)
SELECT
  e.id,
  e.ticker,
  e.mint,
  CAST(e.day AS varchar) AS day,
  SUM(e.token_balance) AS raw_balance,
  SUM(CASE WHEN xo.owner IS NOT NULL THEN e.token_balance ELSE 0 END) AS excluded_balance,
  SUM(e.token_balance) - SUM(CASE WHEN xo.owner IS NOT NULL THEN e.token_balance ELSE 0 END) AS active_balance,
  COUNT_IF(e.token_balance <> 0) AS account_count,
  COUNT_IF(xo.owner IS NOT NULL AND e.token_balance <> 0) AS excluded_account_count
FROM expanded e
LEFT JOIN excluded_owners xo
  ON xo.id = e.id
 AND xo.mint = e.mint
 AND (
      lower(COALESCE(e.owner, '')) = xo.owner
   OR lower(COALESCE(e.address, '')) = xo.owner
 )
GROUP BY 1, 2, 3, 4
ORDER BY ticker, day
`.trim();
}

async function executeDuneSql(sql: string): Promise<string> {
  const apiKey = process.env.DUNE_API_KEY ?? process.env.DUNE_API_KEYS?.split(",")[0];
  if (!apiKey) throw new Error("DUNE_API_KEY or DUNE_API_KEYS must be set, unless a cached Dune result already exists");

  const res = await axios.post(
    `${DUNE_BASE}/sql/execute`,
    { sql, performance: "medium" },
    { headers: { "X-Dune-Api-Key": apiKey, "Content-Type": "application/json" } }
  );
  const executionId = res.data?.execution_id;
  if (!executionId) throw new Error(`No Dune execution_id: ${JSON.stringify(res.data)}`);
  return executionId;
}

async function pollDune(executionId: string): Promise<void> {
  const start = Date.now();
  let lastState = "";
  while (true) {
    const apiKey = process.env.DUNE_API_KEY ?? process.env.DUNE_API_KEYS?.split(",")[0];
    const res = await axios.get(`${DUNE_BASE}/execution/${executionId}/status`, {
      headers: { "X-Dune-Api-Key": apiKey },
    });
    const state = res.data?.state;
    if (state !== lastState) {
      console.log(`[dune] state=${state}`);
      lastState = state;
    }
    if (state === "QUERY_STATE_COMPLETED") return;
    if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELLED") {
      throw new Error(`Dune execution ${state}: ${JSON.stringify(res.data)}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Dune execution timed out after ${POLL_TIMEOUT_MS / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function fetchDuneResultRows(executionId: string): Promise<DuneRow[]> {
  const apiKey = process.env.DUNE_API_KEY ?? process.env.DUNE_API_KEYS?.split(",")[0];
  const rows: DuneRow[] = [];
  let nextUri: string | null = `${DUNE_BASE}/execution/${executionId}/results?limit=10000`;

  while (nextUri) {
    const res: any = await axios.get(nextUri, { headers: { "X-Dune-Api-Key": apiKey } });
    rows.push(...(res.data?.result?.rows ?? []));
    const nextOffset = res.data?.next_offset;
    if (nextOffset != null) {
      nextUri = `${DUNE_BASE}/execution/${executionId}/results?limit=10000&offset=${nextOffset}`;
    } else if (res.data?.next_uri) {
      nextUri = res.data.next_uri.startsWith("http") ? res.data.next_uri : `${DUNE_BASE}${res.data.next_uri}`;
    } else {
      nextUri = null;
    }
  }

  return rows;
}

async function getDuneRows(assets: AssetMeta[]): Promise<DuneRow[]> {
  ensureDir(CACHE_DIR);
  const spec = {
    startDate: START_DATE,
    endDate: END_DATE,
    lookbackDate: LOOKBACK_DATE,
    assets: assets.map((a) => ({
      id: a.id,
      ticker: a.ticker,
      mint: a.mint,
      excludedOwners: a.excludedOwners.map((o) => o.toLowerCase()).sort(),
    })),
  };
  const cacheFile = path.join(CACHE_DIR, `dune-${hashJson(spec)}.json`);

  if (!REFRESH_DUNE && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    console.log(`[dune] cache hit ${cacheFile} (${cached.rows?.length ?? 0} rows)`);
    return cached.rows ?? [];
  }

  const sql = buildDuneSql(assets);
  fs.writeFileSync(path.join(CACHE_DIR, `dune-${hashJson(spec)}.sql`), sql);
  console.log(`[dune] executing direct SQL for ${assets.length} asset(s)`);
  const executionId = await executeDuneSql(sql);
  console.log(`[dune] execution_id=${executionId}`);
  await pollDune(executionId);
  const rows = await fetchDuneResultRows(executionId);
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), spec, executionId, rows }, null, 2));
  console.log(`[dune] fetched ${rows.length} rows; cached ${cacheFile}`);
  return rows;
}

function rowsToSupplySeries(rows: DuneRow[], asset: AssetMeta): SupplyPoint[] {
  const raw = rows
    .filter((r) => String(r.id) === asset.id)
    .map((r) => ({
      timestamp: isoToTs(String(r.day).slice(0, 10)),
      rawBalance: toNumber(r.raw_balance),
      excludedBalance: toNumber(r.excluded_balance),
      activeBalance: Math.max(0, toNumber(r.active_balance)),
      smoothedActiveBalance: Math.max(0, toNumber(r.active_balance)),
      accountCount: toNumber(r.account_count),
      excludedAccountCount: toNumber(r.excluded_account_count),
      smoothingChanged: false,
    }))
    .filter((p) => p.rawBalance > 0 || p.activeBalance > 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  if (NO_SMOOTHING || raw.length < 3 || SMOOTH_MAX_RUN === 0) return raw;
  return smoothSupplyPoints(raw, SMOOTH_MAX_RUN);
}

function smoothSupplyPoints(points: SupplyPoint[], maxRun: number): SupplyPoint[] {
  const out = points.map((p) => ({ ...p }));
  let lastGoodIdx = 0;
  let i = 1;

  while (i < out.length) {
    const prev = out[lastGoodIdx].smoothedActiveBalance;
    const curr = out[i].smoothedActiveBalance;
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) {
      lastGoodIdx = i;
      i++;
      continue;
    }

    const ratio = curr / prev;
    if (ratio >= 0.35 && ratio <= 2.5) {
      lastGoodIdx = i;
      i++;
      continue;
    }

    let nextGoodIdx = -1;
    for (let j = i + 1; j < Math.min(i + maxRun + 1, out.length); j++) {
      const next = out[j].smoothedActiveBalance;
      if (!Number.isFinite(next)) break;
      const nextRatio = next / prev;
      if (nextRatio >= 0.5 && nextRatio <= 2) {
        nextGoodIdx = j;
        break;
      }
    }

    if (nextGoodIdx === -1) {
      lastGoodIdx = i;
      i++;
      continue;
    }

    const prevPoint = out[lastGoodIdx];
    const nextPoint = out[nextGoodIdx];
    for (let k = i; k < nextGoodIdx; k++) {
      const t = (out[k].timestamp - prevPoint.timestamp) / (nextPoint.timestamp - prevPoint.timestamp);
      const interpolated = prevPoint.smoothedActiveBalance +
        (nextPoint.smoothedActiveBalance - prevPoint.smoothedActiveBalance) * t;
      if (Math.abs(interpolated - out[k].smoothedActiveBalance) > 1e-9) {
        out[k].smoothedActiveBalance = Math.max(0, interpolated);
        out[k].smoothingChanged = true;
      }
    }

    lastGoodIdx = nextGoodIdx;
    i = nextGoodIdx + 1;
  }

  return out;
}

function median(values: number[]): number | null {
  const sorted = values.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.floor(sorted.length / 2)];
}

function priceRatioIsSane(value: number, reference: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(reference) || reference <= 0) return true;
  const ratio = value / reference;
  return ratio >= PRICE_SMOOTH_MIN_RATIO && ratio <= PRICE_SMOOTH_MAX_RATIO;
}

function smoothDailyPricePoints(asset: AssetMeta, points: DailyPricePoint[]): {
  points: DailyPricePoint[];
  changes: PriceSmoothingChange[];
  warnings: string[];
} {
  const out = points.map((p) => ({ ...p }));
  const changes: PriceSmoothingChange[] = [];
  const warnings: string[] = [];
  const maxRun = Math.floor(PRICE_SMOOTH_MAX_RUN);

  if (NO_PRICE_SMOOTHING || out.length < 3 || maxRun === 0) return { points: out, changes, warnings };

  const changePoint = (index: number, newPrice: number, reason: string) => {
    const point = out[index];
    if (!Number.isFinite(newPrice) || newPrice <= 0) return;
    if (Math.abs(point.smoothedPrice - newPrice) <= 1e-12) return;
    changes.push({
      timestamp: point.timestamp,
      oldPrice: point.smoothedPrice,
      newPrice,
      reason,
    });
    point.smoothedPrice = newPrice;
    point.smoothingChanged = true;
  };

  const leadingReference = median(out.slice(1, Math.min(out.length, 8)).map((p) => p.smoothedPrice));
  if (leadingReference != null && !priceRatioIsSane(out[0].smoothedPrice, leadingReference)) {
    changePoint(0, leadingReference, "leading price outlier");
  }

  let lastGoodIdx = 0;
  let i = 1;
  while (i < out.length) {
    const previous = out[lastGoodIdx].smoothedPrice;
    const current = out[i].smoothedPrice;

    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
      lastGoodIdx = i;
      i++;
      continue;
    }

    if (priceRatioIsSane(current, previous)) {
      lastGoodIdx = i;
      i++;
      continue;
    }

    let nextGoodIdx = -1;
    for (let j = i + 1; j < Math.min(i + maxRun + 1, out.length); j++) {
      if (priceRatioIsSane(out[j].smoothedPrice, previous)) {
        nextGoodIdx = j;
        break;
      }
    }

    if (nextGoodIdx === -1) {
      const remaining = out.length - i;
      if (remaining <= maxRun) {
        for (let k = i; k < out.length; k++) {
          changePoint(k, previous, "trailing price jump carried forward");
        }
        warnings.push(
          `${asset.ticker} carried ${remaining} trailing price point(s) from ${tsToIso(out[i].timestamp)} after an unresolved jump`
        );
        break;
      }

      warnings.push(
        `${asset.ticker} unresolved price level shift at ${tsToIso(out[i].timestamp)} ` +
        `${current.toFixed(6)} vs ${previous.toFixed(6)}; treated as a real level shift`
      );
      lastGoodIdx = i;
      i++;
      continue;
    }

    const previousPoint = out[lastGoodIdx];
    const nextPoint = out[nextGoodIdx];
    for (let k = i; k < nextGoodIdx; k++) {
      const t = (out[k].timestamp - previousPoint.timestamp) / (nextPoint.timestamp - previousPoint.timestamp);
      const interpolated = previousPoint.smoothedPrice +
        (nextPoint.smoothedPrice - previousPoint.smoothedPrice) * t;
      changePoint(k, interpolated, "interpolated price jump");
    }

    lastGoodIdx = nextGoodIdx;
    i = nextGoodIdx + 1;
  }

  return { points: out, changes, warnings };
}

async function getPriceMap(asset: AssetMeta, timestamps: number[]): Promise<PriceMapResult> {
  const out = new Map<number, number>();
  const uniqueTs = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  if (uniqueTs.length === 0) return { prices: out, changes: [], warnings: [] };
  if (FLAT_NAV != null) {
    for (const ts of uniqueTs) out.set(ts, FLAT_NAV);
    return { prices: out, changes: [], warnings: [] };
  }

  ensureDir(CACHE_DIR);
  const coin = `solana:${asset.mint}`;
  const spec = { coin, start: uniqueTs[0], end: uniqueTs[uniqueTs.length - 1] };
  const cacheFile = path.join(CACHE_DIR, `prices-${hashJson(spec)}.json`);
  let rawPrices: Array<{ timestamp: number; price: number }> = [];

  if (!REFRESH_PRICES && fs.existsSync(cacheFile)) {
    rawPrices = JSON.parse(fs.readFileSync(cacheFile, "utf8")).prices ?? [];
  } else {
    const MAX_SPAN = 500;
    const minTs = uniqueTs[0];
    const maxTs = uniqueTs[uniqueTs.length - 1];
    const totalSpanDays = Math.ceil((maxTs - minTs) / 86400) + 1;
    let cursor = minTs;
    let remaining = totalSpanDays;

    while (remaining > 0) {
      const span = Math.min(MAX_SPAN, remaining);
      const url = `https://coins.llama.fi/chart/${encodeURIComponent(coin)}?start=${cursor}&span=${span}&period=1d&searchWidth=48h`;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: any = await res.json();
        const prices: Array<{ timestamp: number; price: number }> = json?.coins?.[coin]?.prices ?? [];
        rawPrices.push(...prices.filter((p) => Number.isFinite(Number(p.price))));
      } catch (e) {
        console.error(`[prices] ${asset.ticker} chart fetch failed at ${cursor}: ${(e as any)?.message ?? e}`);
      }
      cursor += span * 86400;
      remaining -= span;
    }

    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), spec, prices: rawPrices }, null, 2));
  }

  const priceByDay = new Map<number, number>();
  for (const price of rawPrices) {
    const dayTs = isoToTs(tsToIso(Number(price.timestamp)));
    const n = Number(price.price);
    if (Number.isFinite(n) && n > 0) priceByDay.set(dayTs, n);
  }

  const dailyPricePoints: DailyPricePoint[] = Array.from(priceByDay.entries())
    .map(([timestamp, price]) => ({
      timestamp,
      price,
      smoothedPrice: price,
      smoothingChanged: false,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  const priceSmoothing = smoothDailyPricePoints(asset, dailyPricePoints);
  const smoothedPriceByDay = new Map(
    priceSmoothing.points.map((point) => [point.timestamp, point.smoothedPrice])
  );

  let last: number | null = null;
  for (const ts of uniqueTs) {
    const direct = smoothedPriceByDay.get(ts);
    if (direct != null) last = direct;
    if (last != null) out.set(ts, last);
  }

  let next: number | null = null;
  for (const ts of [...uniqueTs].reverse()) {
    if (out.has(ts)) {
      next = out.get(ts)!;
      continue;
    }
    const direct = smoothedPriceByDay.get(ts);
    if (direct != null) next = direct;
    if (next != null) out.set(ts, next);
  }

  return { prices: out, changes: priceSmoothing.changes, warnings: priceSmoothing.warnings };
}

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_IFACE = new Interface(ERC20_ABI);
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)",
];

const providerCache = new Map<string, JsonRpcProvider>();

function getEvmProvider(chain: string, rpcUrl: string): JsonRpcProvider {
  const key = `${chain}:${rpcUrl}`;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = new JsonRpcProvider(rpcUrl, EVM_CHAIN_CONFIG[chain].chainId, {
      staticNetwork: true,
      batchMaxCount: Number(process.env.RWA_EVM_RPC_BATCH_MAX ?? 50),
    });
    providerCache.set(key, provider);
  }
  return provider;
}

const decimalsCache = new Map<string, number>();

async function getEvmDecimals(target: EvmContractTarget): Promise<number> {
  const key = `${target.chain}:${target.contract.toLowerCase()}`;
  const cached = decimalsCache.get(key);
  if (cached != null) return cached;

  const cfg = EVM_CHAIN_CONFIG[target.chain];
  let lastError: any = null;
  for (const rpcUrl of cfg.rpcUrls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const provider = getEvmProvider(target.chain, rpcUrl);
        const contract = new Contract(target.contract, ERC20_ABI, provider);
        const decimals = Number(await contract.decimals());
        decimalsCache.set(key, decimals);
        return decimals;
      } catch (e: any) {
        lastError = e;
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  console.warn(
    `[evm] ${target.label} ${target.contract} decimals failed; falling back to 18: ` +
    `${lastError?.shortMessage ?? lastError?.message ?? lastError}`
  );
  decimalsCache.set(key, 18);
  return 18;
}

async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getHistoricalBlocks(timestamps: number[], chains: string[]): Promise<Map<number, { [chain: string]: number }>> {
  ensureDir(CACHE_DIR);
  const uniqueTs = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  const uniqueChains = Array.from(new Set(chains)).sort();
  const spec = { timestamps: uniqueTs, chains: uniqueChains };
  const cacheFile = path.join(CACHE_DIR, `blocks-${hashJson(spec)}.json`);

  if (!REFRESH_EVM && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const out = new Map<number, { [chain: string]: number }>();
    for (const [ts, blocks] of Object.entries(cached.blocks ?? {})) out.set(Number(ts), blocks as any);
    console.log(`[evm] block cache hit ${cacheFile} (${out.size} timestamps)`);
    return out;
  }

  const blockEntries = await mapLimit(uniqueTs, 6, async (timestamp, index) => {
    if (index % 25 === 0) console.log(`[evm] resolving blocks ${index + 1}/${uniqueTs.length}`);
    const res = await (sdk as any).util.blocks.getBlocks(timestamp, uniqueChains);
    return [timestamp, res.chainBlocks ?? {}] as [number, { [chain: string]: number }];
  });

  const blocksObject: { [timestamp: string]: { [chain: string]: number } } = {};
  const out = new Map<number, { [chain: string]: number }>();
  for (const [timestamp, blocks] of blockEntries) {
    blocksObject[String(timestamp)] = blocks;
    out.set(timestamp, blocks);
  }
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), spec, blocks: blocksObject }, null, 2));
  console.log(`[evm] cached blocks ${cacheFile}`);
  return out;
}

async function fetchEvmPoint(target: EvmContractTarget, timestamp: number, block: number): Promise<SupplyPoint> {
  const cfg = EVM_CHAIN_CONFIG[target.chain];
  let lastError: any = null;
  const decimals = await getEvmDecimals(target);

  for (const rpcUrl of cfg.rpcUrls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const provider = getEvmProvider(target.chain, rpcUrl);
        const contract = new Contract(target.contract, ERC20_ABI, provider);
        const [supplyRaw, ...excludedRaw] = await Promise.all([
          contract.totalSupply({ blockTag: block }),
          ...target.excludedOwners.map((owner) => contract.balanceOf(owner, { blockTag: block })),
        ]);

        const rawBalance = Number(formatUnits(BigInt(supplyRaw), decimals));
        const excludedBalance = excludedRaw.reduce((sum: number, value: bigint) => {
          return sum + Number(formatUnits(BigInt(value), decimals));
        }, 0);
        return {
          timestamp,
          block,
          rawBalance,
          excludedBalance,
          activeBalance: Math.max(0, rawBalance - excludedBalance),
          smoothedActiveBalance: Math.max(0, rawBalance - excludedBalance),
          accountCount: rawBalance > 0 ? 1 : 0,
          excludedAccountCount: excludedBalance > 0 ? target.excludedOwners.length : 0,
          smoothingChanged: false,
        };
      } catch (e: any) {
        lastError = e;
        try {
          const provider = getEvmProvider(target.chain, rpcUrl);
          const code = await provider.getCode(target.contract, block);
          if (!code || code === "0x") {
            return {
              timestamp,
              block,
              rawBalance: 0,
              excludedBalance: 0,
              activeBalance: 0,
              smoothedActiveBalance: 0,
              accountCount: 0,
              excludedAccountCount: 0,
              smoothingChanged: false,
            };
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  throw new Error(
    `${target.label} ${target.contract} block=${block} failed on all RPCs: ` +
    `${lastError?.shortMessage ?? lastError?.message ?? lastError}`
  );
}

async function getEvmSupplySeries(asset: AssetMeta, timestamps: number[]): Promise<Map<string, SupplyPoint[]>> {
  const targets = asset.evmContracts.filter((target) => EVM_CHAINS.includes(target.chain));
  const out = new Map<string, SupplyPoint[]>();
  if (!INCLUDE_EVM || targets.length === 0 || timestamps.length === 0) return out;

  ensureDir(CACHE_DIR);
  const uniqueTs = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  const spec = {
    assetId: asset.id,
    ticker: asset.ticker,
    timestamps: uniqueTs,
    targets: targets.map((target) => ({
      chain: target.chain,
      contract: target.contract.toLowerCase(),
      excludedOwners: target.excludedOwners.map((owner) => owner.toLowerCase()).sort(),
    })),
  };
  const cacheFile = path.join(CACHE_DIR, `evm-${hashJson(spec)}.json`);

  if (!REFRESH_EVM && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    for (const [chain, points] of Object.entries(cached.pointsByChain ?? {})) {
      out.set(chain, (points as SupplyPoint[]).map((p) => ({ ...p })));
    }
    console.log(`[evm] cache hit ${cacheFile}`);
    return out;
  }

  console.log(`[evm] fetching ${asset.ticker} ${targets.map((t) => t.chain).join(",")} (${uniqueTs.length} days)`);
  const blockMap = await getHistoricalBlocks(uniqueTs, targets.map((target) => target.chain));
  const jobs = targets.flatMap((target) => uniqueTs.map((timestamp) => ({ target, timestamp })));
  const rows = await mapLimit(jobs, Number(process.env.RWA_EVM_RPC_CONCURRENCY ?? 4), async ({ target, timestamp }, index) => {
    if (index % 100 === 0) console.log(`[evm] ${asset.ticker} rpc ${index + 1}/${jobs.length}`);
    const block = blockMap.get(timestamp)?.[target.chain];
    if (!block) throw new Error(`Missing historical block for ${target.chain} at ${tsToIso(timestamp)}`);
    const point = await fetchEvmPoint(target, timestamp, block);
    return { chain: target.chain, point };
  });

  for (const { chain, point } of rows) {
    if (!out.has(chain)) out.set(chain, []);
    out.get(chain)!.push(point);
  }

  for (const [chain, points] of out.entries()) {
    const sorted = points.sort((a, b) => a.timestamp - b.timestamp);
    out.set(chain, NO_SMOOTHING || sorted.length < 3 || SMOOTH_MAX_RUN === 0 ? sorted : smoothSupplyPoints(sorted, SMOOTH_MAX_RUN));
  }

  fs.writeFileSync(cacheFile, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    spec,
    pointsByChain: Object.fromEntries(out.entries()),
  }, null, 2));
  console.log(`[evm] cached ${cacheFile}`);
  return out;
}

type EvmBatchCache = Map<string, Map<string, SupplyPoint[]>>;

async function getEvmSupplySeriesBatch(assets: AssetMeta[], timestamps: number[]): Promise<EvmBatchCache> {
  const out: EvmBatchCache = new Map();
  if (!INCLUDE_EVM || assets.length === 0 || timestamps.length === 0) return out;

  const targets = assets.flatMap((asset) =>
    asset.evmContracts
      .filter((target) => EVM_CHAINS.includes(target.chain))
      .map((target) => ({ asset, target }))
  );
  if (!targets.length) return out;

  ensureDir(CACHE_DIR);
  const uniqueTs = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  const chains = Array.from(new Set(targets.map((item) => item.target.chain))).sort();
  const spec = {
    startDate: START_DATE,
    endDate: END_DATE,
    timestamps: uniqueTs,
    assets: assets.map((asset) => ({
      id: asset.id,
      ticker: asset.ticker,
      targets: asset.evmContracts
        .filter((target) => EVM_CHAINS.includes(target.chain))
        .map((target) => ({
          chain: target.chain,
          contract: target.contract.toLowerCase(),
          excludedOwners: target.excludedOwners.map((owner) => owner.toLowerCase()).sort(),
        })),
    })),
  };
  const cacheFile = path.join(CACHE_DIR, `evm-batch-${hashJson(spec)}.json`);

  if (!REFRESH_EVM && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    for (const [assetId, chainsObj] of Object.entries(cached.pointsByAsset ?? {}) as any[]) {
      const chainMap = new Map<string, SupplyPoint[]>();
      for (const [chain, points] of Object.entries(chainsObj ?? {}) as any[]) {
        chainMap.set(chain, (points as SupplyPoint[]).map((point) => ({ ...point })));
      }
      out.set(assetId, chainMap);
    }
    console.log(`[evm] batch cache hit ${cacheFile}`);
    return out;
  }

  console.log(`[evm] batch fetching ${assets.length} assets across ${chains.join(",")} (${uniqueTs.length} days)`);
  const blockMap = await getHistoricalBlocks(uniqueTs, chains);

  const decimalsByTarget = new Map<string, number>();
  await mapLimit(targets, Number(process.env.RWA_EVM_DECIMALS_CONCURRENCY ?? 20), async ({ target }) => {
    decimalsByTarget.set(`${target.chain}:${target.contract.toLowerCase()}`, await getEvmDecimals(target));
  });

  const targetsByChain = new Map<string, Array<{ asset: AssetMeta; target: EvmContractTarget }>>();
  for (const item of targets) {
    if (!targetsByChain.has(item.target.chain)) targetsByChain.set(item.target.chain, []);
    targetsByChain.get(item.target.chain)!.push(item);
  }

  const targetChunkSize = Number(process.env.RWA_EVM_MULTICALL_TARGET_CHUNK ?? 35);
  const jobs: Array<{
    chain: string;
    timestamp: number;
    block: number;
    items: Array<{ asset: AssetMeta; target: EvmContractTarget }>;
  }> = [];
  for (const [chain, items] of targetsByChain.entries()) {
    for (const timestamp of uniqueTs) {
      const block = blockMap.get(timestamp)?.[chain];
      if (!block) throw new Error(`Missing historical block for ${chain} at ${tsToIso(timestamp)}`);
      for (let i = 0; i < items.length; i += targetChunkSize) {
        jobs.push({ chain, timestamp, block, items: items.slice(i, i + targetChunkSize) });
      }
    }
  }

  const rows = await mapLimit(jobs, Number(process.env.RWA_EVM_MULTICALL_CONCURRENCY ?? 12), async (job, index) => {
    if (index % 100 === 0) console.log(`[evm] multicall ${index + 1}/${jobs.length}`);
    return fetchEvmMulticallChunk(job, decimalsByTarget);
  });

  for (const chunk of rows.flat()) {
    if (!out.has(chunk.asset.id)) out.set(chunk.asset.id, new Map());
    const chainMap = out.get(chunk.asset.id)!;
    if (!chainMap.has(chunk.chain)) chainMap.set(chunk.chain, []);
    chainMap.get(chunk.chain)!.push(chunk.point);
  }

  const pointsByAsset: any = {};
  for (const [assetId, chainMap] of out.entries()) {
    pointsByAsset[assetId] = {};
    for (const [chain, points] of chainMap.entries()) {
      const sorted = points.sort((a, b) => a.timestamp - b.timestamp);
      const smoothed = NO_SMOOTHING || sorted.length < 3 || SMOOTH_MAX_RUN === 0
        ? sorted
        : smoothSupplyPoints(sorted, SMOOTH_MAX_RUN);
      chainMap.set(chain, smoothed);
      pointsByAsset[assetId][chain] = smoothed;
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    spec,
    pointsByAsset,
  }, null, 2));
  console.log(`[evm] cached batch ${cacheFile}`);
  return out;
}

async function fetchEvmMulticallChunk(
  job: {
    chain: string;
    timestamp: number;
    block: number;
    items: Array<{ asset: AssetMeta; target: EvmContractTarget }>;
  },
  decimalsByTarget: Map<string, number>,
): Promise<Array<{ asset: AssetMeta; chain: string; point: SupplyPoint }>> {
  const cfg = EVM_CHAIN_CONFIG[job.chain];
  const calls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
  const callPlan: Array<{ itemIndex: number; kind: "supply" | "excluded" }> = [];

  job.items.forEach(({ target }, itemIndex) => {
    calls.push({
      target: target.contract,
      allowFailure: true,
      callData: ERC20_IFACE.encodeFunctionData("totalSupply", []),
    });
    callPlan.push({ itemIndex, kind: "supply" });
    for (const owner of target.excludedOwners) {
      calls.push({
        target: target.contract,
        allowFailure: true,
        callData: ERC20_IFACE.encodeFunctionData("balanceOf", [owner]),
      });
      callPlan.push({ itemIndex, kind: "excluded" });
    }
  });

  let lastError: any = null;
  for (const rpcUrl of cfg.rpcUrls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const provider = getEvmProvider(job.chain, rpcUrl);
        const multicall = new Contract(MULTICALL3, MULTICALL3_ABI, provider);
        const results: Array<{ success: boolean; returnData: string }> = await multicall.aggregate3(calls, { blockTag: job.block });
        const rawByItem = new Array<number>(job.items.length).fill(0);
        const excludedByItem = new Array<number>(job.items.length).fill(0);

        results.forEach((result, i) => {
          if (!result.success || !result.returnData || result.returnData === "0x") return;
          const plan = callPlan[i];
          const { target } = job.items[plan.itemIndex];
          const decimals = decimalsByTarget.get(`${target.chain}:${target.contract.toLowerCase()}`) ?? 18;
          const decoded = ERC20_IFACE.decodeFunctionResult(plan.kind === "supply" ? "totalSupply" : "balanceOf", result.returnData);
          const amount = Number(formatUnits(BigInt(decoded[0]), decimals));
          if (plan.kind === "supply") rawByItem[plan.itemIndex] = amount;
          else excludedByItem[plan.itemIndex] += amount;
        });

        return job.items.map((item, itemIndex) => {
          const rawBalance = rawByItem[itemIndex];
          const excludedBalance = excludedByItem[itemIndex];
          return {
            asset: item.asset,
            chain: job.chain,
            point: {
              timestamp: job.timestamp,
              block: job.block,
              rawBalance,
              excludedBalance,
              activeBalance: Math.max(0, rawBalance - excludedBalance),
              smoothedActiveBalance: Math.max(0, rawBalance - excludedBalance),
              accountCount: rawBalance > 0 ? 1 : 0,
              excludedAccountCount: excludedBalance > 0 ? item.target.excludedOwners.length : 0,
              smoothingChanged: false,
            },
          };
        });
      } catch (e: any) {
        lastError = e;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }

  throw new Error(
    `multicall ${job.chain} block=${job.block} items=${job.items.length} failed on all RPCs: ` +
    `${lastError?.shortMessage ?? lastError?.message ?? lastError}`
  );
}

async function loadExisting(asset: AssetMeta): Promise<{ aggregates: AggregateRow[]; chains: ExistingChainRow[] }> {
  if (EXISTING_SOURCE === "db") {
    await initPG();
    const aggregates = (await fetchDailyRecordsForIdPG(asset.id)).map((r: any) => ({
      timestamp: Number(r.timestamp),
      aggregatedefiactivetvl: toNumber(r.aggregatedefiactivetvl),
      aggregatemcap: toNumber(r.aggregatemcap),
      aggregatedactivemcap: toNumber(r.aggregatedactivemcap),
    }));
    const chains = (await fetchDailyRecordsWithChainsForIdPG(asset.id)).map((r: any) => ({
      timestamp: Number(r.timestamp),
      mcap: r.mcap ?? {},
      activemcap: r.activemcap ?? {},
      defiactivetvl: r.defiactivetvl ?? {},
      totalsupply: r.totalsupply ?? {},
    }));
    return { aggregates, chains };
  }

  const pgCacheFile = cacheBuildPath("..", "pg-cache", `${asset.id}.json`);
  if (!fs.existsSync(pgCacheFile)) {
    console.error(`[cache] missing pg-cache for ${asset.ticker} id=${asset.id}: ${pgCacheFile}`);
    return { aggregates: [], chains: [] };
  }

  const json = JSON.parse(fs.readFileSync(pgCacheFile, "utf8"));
  const aggregates: AggregateRow[] = [];
  const chains: ExistingChainRow[] = [];

  for (const [tsRaw, row] of Object.entries(json) as any[]) {
    const timestamp = Number(tsRaw);
    const chainRows = row?.chains ?? {};
    const mcap: { [chain: string]: any } = {};
    const activemcap: { [chain: string]: any } = {};
    const defiactivetvl: { [chain: string]: any } = {};

    for (const [chain, values] of Object.entries(chainRows) as any[]) {
      if (values?.onChainMcap != null) mcap[chain] = values.onChainMcap;
      if (values?.activeMcap != null) activemcap[chain] = values.activeMcap;
      if (values?.defiActiveTvl != null) defiactivetvl[chain] = values.defiActiveTvl;
    }

    aggregates.push({
      timestamp,
      aggregatemcap: toNumber(row?.onChainMcap),
      aggregatedactivemcap: toNumber(row?.activeMcap),
      aggregatedefiactivetvl: toNumber(row?.defiActiveTvl),
    });
    chains.push({ timestamp, mcap, activemcap, defiactivetvl, totalsupply: {} });
  }

  aggregates.sort((a, b) => a.timestamp - b.timestamp);
  chains.sort((a, b) => a.timestamp - b.timestamp);
  return { aggregates, chains };
}

function activeEqualsOnChain(asset: AssetMeta): boolean {
  return ONCHAIN_MCAP_EQUALS_ACTIVE_PLATFORMS.has(String(asset.parentPlatform ?? ""));
}

function planWrites(
  asset: AssetMeta,
  chainPointsByChain: Map<string, SupplyPoint[]>,
  priceMap: Map<number, number>,
  existing: { aggregates: AggregateRow[]; chains: ExistingChainRow[] },
): { writes: PlannedWrite[]; skippedNoPrice: number } {
  const chainsByTs = new Map<number, ExistingChainRow>();
  for (const row of existing.chains) chainsByTs.set(row.timestamp, row);

  const aggregatesByTs = new Map<number, AggregateRow>();
  for (const row of existing.aggregates) aggregatesByTs.set(row.timestamp, row);

  const writes: PlannedWrite[] = [];
  let skippedNoPrice = 0;
  const mirrorActive = activeEqualsOnChain(asset);
  const timestamps = Array.from(new Set(
    Array.from(chainPointsByChain.values()).flatMap((points) => points.map((point) => point.timestamp))
  )).sort((a, b) => a - b);
  const pointsByChainAndTs = new Map<string, Map<number, SupplyPoint>>();
  for (const [chain, points] of chainPointsByChain.entries()) {
    pointsByChainAndTs.set(chain, new Map(points.map((point) => [point.timestamp, point])));
  }

  for (const timestamp of timestamps) {
    const price = priceMap.get(timestamp);
    if (!price || !Number.isFinite(price) || price <= 0) {
      skippedNoPrice++;
      continue;
    }

    const existingRow = chainsByTs.get(timestamp) ?? {
      timestamp,
      mcap: {},
      activemcap: {},
      defiactivetvl: {},
      totalsupply: {},
    };
    const existingAgg = aggregatesByTs.get(timestamp) ?? {
      timestamp,
      aggregatemcap: sumChainValues(existingRow.mcap),
      aggregatedactivemcap: sumChainValues(existingRow.activemcap),
      aggregatedefiactivetvl: sumChainValues(existingRow.defiactivetvl),
    };

    // Build fresh mcap maps from the chain data we are refilling.  Do not
    // carry old DB mcap/activeMcap chain entries forward; they are the thing
    // this backfill is replacing.  defiActiveTvl is preserved separately below.
    const newMcap: { [chain: string]: string } = {};
    const newActiveMcap: { [chain: string]: string } = {};
    const newTotalSupply: { [chain: string]: string } = {};

    const chainUpdates: PlannedWrite["chainUpdates"] = {};
    for (const [chain, byTs] of pointsByChainAndTs.entries()) {
      const point = byTs.get(timestamp);
      if (!point) continue;
      const activeSupply = Math.max(0, point.smoothedActiveBalance);
      const rawSupply = Math.max(0, point.rawBalance);
      if (rawSupply <= 0 && activeSupply <= 0) {
        newMcap[chain] = "0";
        newActiveMcap[chain] = "0";
        newTotalSupply[chain] = "0";
      } else {
        newMcap[chain] = String((mirrorActive ? activeSupply : rawSupply) * price);
        newActiveMcap[chain] = String(activeSupply * price);
        newTotalSupply[chain] = String(mirrorActive ? activeSupply : rawSupply);
      }
      chainUpdates[chain] = {
        oldMcap: toNumber(existingRow.mcap?.[chain]),
        newMcap: toNumber(newMcap[chain]),
        rawSupply,
        excludedSupply: Math.max(0, point.excludedBalance),
        activeSupply,
        block: point.block,
        smoothingChanged: point.smoothingChanged,
      };
    }

    if (Object.keys(chainUpdates).length === 0) continue;
    const solanaPoint = pointsByChainAndTs.get(CHAIN)?.get(timestamp);
    const oldSolanaMcap = toNumber(existingRow.mcap?.[CHAIN]);
    const newSolanaMcap = toNumber(newMcap[CHAIN]);

    writes.push({
      id: asset.id,
      ticker: asset.ticker,
      timestamp,
      price,
      rawSupply: solanaPoint ? Math.max(0, solanaPoint.rawBalance) : 0,
      rawActiveSupply: solanaPoint ? Math.max(0, solanaPoint.activeBalance) : 0,
      activeSupply: solanaPoint ? Math.max(0, solanaPoint.smoothedActiveBalance) : 0,
      excludedSupply: solanaPoint ? Math.max(0, solanaPoint.excludedBalance) : 0,
      oldSolanaMcap,
      newSolanaMcap,
      oldAggregateMcap: toNumber(existingAgg.aggregatemcap),
      newAggregateMcap: sumChainValues(newMcap),
      oldAggregateActiveMcap: toNumber(existingAgg.aggregatedactivemcap),
      newAggregateActiveMcap: sumChainValues(newActiveMcap),
      newMcap,
      newActiveMcap,
      newTotalSupply,
      existingDefiActiveTvl: existingRow.defiactivetvl ?? {},
      existingAggregateDefiActiveTvl: toNumber(existingAgg.aggregatedefiactivetvl),
      smoothingChanged: Object.values(chainUpdates).some((update) => update.smoothingChanged),
      chainUpdates,
    });
  }

  return { writes, skippedNoPrice };
}

function applyProdTransform(rows: AggregateRow[]): HistoricalRecord[] {
  const mapped: HistoricalRecord[] = rows.map((record) => ({
    timestamp: record.timestamp,
    onChainMcap: toFiniteNumberOrZero(record.aggregatemcap),
    defiActiveTvl: toFiniteNumberOrZero(record.aggregatedefiactivetvl),
    activeMcap: toFiniteNumberOrZero(record.aggregatedactivemcap),
  }));
  return trimLeadingZeros(smoothHistoricalData(mapped));
}

function buildSimulatedAggregates(existingAgg: AggregateRow[], writes: PlannedWrite[]): AggregateRow[] {
  const byTs = new Map<number, AggregateRow>();
  for (const row of existingAgg) byTs.set(row.timestamp, { ...row });
  for (const write of writes) {
    byTs.set(write.timestamp, {
      timestamp: write.timestamp,
      aggregatemcap: write.newAggregateMcap,
      aggregatedactivemcap: write.newAggregateActiveMcap,
      aggregatedefiactivetvl: write.existingAggregateDefiActiveTvl,
    });
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function commitWrites(writes: PlannedWrite[]) {
  if (!writes.length) return;
  const now = new Date();
  const dailyRows = writes.map((w) => ({
    timestamp: w.timestamp,
    timestamp_actual: w.timestamp,
    id: w.id,
    defiactivetvl: JSON.stringify(w.existingDefiActiveTvl ?? {}),
    mcap: JSON.stringify(w.newMcap),
    activemcap: JSON.stringify(w.newActiveMcap),
    totalsupply: JSON.stringify(w.newTotalSupply),
    aggregatedefiactivetvl: w.existingAggregateDefiActiveTvl,
    aggregatemcap: w.newAggregateMcap,
    aggregatedactivemcap: w.newAggregateActiveMcap,
    created_at: now,
    updated_at: now,
  }));
  const backupRows = dailyRows.map(({ timestamp_actual, ...row }) => row);
  // Intentionally leave defiActiveTvl fields out of updateOnDuplicate so this
  // refill cannot alter existing defi TVL values.
  const updateOnDuplicate = ["mcap", "activemcap", "totalsupply", "aggregatemcap", "aggregatedactivemcap", "updated_at"];
  await DAILY_RWA_DATA.bulkCreate(dailyRows as any[], { updateOnDuplicate });
  await BACKUP_RWA_DATA.bulkCreate(backupRows as any[], { updateOnDuplicate });
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtNum(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 100) return n.toFixed(3);
  if (abs >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function escapeHtml(value: any): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SvgPoint { timestamp: number; value: number }
interface SvgSeries { label: string; color: string; points: SvgPoint[]; dash?: string }

function svgPath(points: SvgPoint[], x: (ts: number) => number, y: (v: number) => number): string {
  return points
    .filter((p) => Number.isFinite(p.timestamp) && Number.isFinite(p.value))
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.timestamp).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");
}

function renderSvg(series: SvgSeries[]): string {
  const allPoints = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.value) && p.value > 0);
  if (!allPoints.length) return `<div class="empty-chart">No chart points available</div>`;

  const width = 1120;
  const height = 520;
  const margin = { top: 22, right: 28, bottom: 48, left: 78 };
  const minTs = Math.min(...allPoints.map((p) => p.timestamp));
  const maxTs = Math.max(...allPoints.map((p) => p.timestamp));
  const minValue = 0;
  const maxValue = Math.max(...allPoints.map((p) => p.value)) * 1.08;
  const spanTs = Math.max(1, maxTs - minTs);
  const spanValue = Math.max(1, maxValue - minValue);
  const x = (ts: number) => margin.left + ((ts - minTs) / spanTs) * (width - margin.left - margin.right);
  const y = (value: number) => height - margin.bottom - ((value - minValue) / spanValue) * (height - margin.top - margin.bottom);
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => minValue + spanValue * f);
  const xTicks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => minTs + spanTs * f);

  const lines = series.map((s) => {
    const pathData = svgPath(s.points, x, y);
    if (!pathData) return "";
    return `<path d="${pathData}" fill="none" stroke="${s.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`;
  }).join("\n");

  const legend = series.map((s, i) =>
    `<g transform="translate(${margin.left + i * 190}, 16)"><rect width="12" height="3" y="5" fill="${s.color}"/><text x="18" y="10">${escapeHtml(s.label)}</text></g>`
  ).join("");

  return `
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Backfill preview chart">
  <rect width="${width}" height="${height}" fill="#111827"/>
  ${yTicks.map((tick) => `<line x1="${margin.left}" x2="${width - margin.right}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="#243244"/><text x="${margin.left - 12}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${fmtUsd(tick)}</text>`).join("\n")}
  ${xTicks.map((tick) => `<line y1="${margin.top}" y2="${height - margin.bottom}" x1="${x(tick).toFixed(1)}" x2="${x(tick).toFixed(1)}" stroke="#1d2939"/><text x="${x(tick).toFixed(1)}" y="${height - 18}" text-anchor="middle">${tsToIso(Math.round(tick)).slice(0, 7)}</text>`).join("\n")}
  <line x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" stroke="#52637a"/>
  <line x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#52637a"/>
  ${lines}
  <g class="legend">${legend}</g>
</svg>`;
}

function assetTableRows(preview: AssetPreview): string {
  const first = preview.writes[0];
  const last = preview.writes[preview.writes.length - 1];
  const maxDelta = preview.writes.reduce((acc, w) => Math.max(acc, Math.abs(w.newAggregateMcap - w.oldAggregateMcap)), 0);
  const smoothed = preview.writes.filter((w) => w.smoothingChanged).length;
  const priceSmoothed = preview.priceSmoothingChanges.length;
  const priceWarnings = preview.priceSmoothingWarnings.length;
  const excludedLast = last ? `${fmtNum(last.excludedSupply)} (${fmtUsd(last.excludedSupply * last.price)})` : "n/a";
  return `
<tr>
  <td>${escapeHtml(preview.asset.ticker)}</td>
  <td>${escapeHtml(preview.asset.id)}</td>
  <td>${escapeHtml(preview.asset.parentPlatform ?? "")}</td>
  <td>${preview.writes.length}</td>
  <td>${first ? tsToIso(first.timestamp) : "n/a"} to ${last ? tsToIso(last.timestamp) : "n/a"}</td>
  <td>${last ? fmtUsd(last.oldAggregateMcap) : "n/a"}</td>
  <td>${last ? fmtUsd(last.newAggregateMcap) : "n/a"}</td>
  <td>${excludedLast}</td>
  <td>${fmtUsd(maxDelta)}</td>
  <td>${smoothed}</td>
  <td>${priceSmoothed}${priceWarnings ? ` / ${priceWarnings} warn` : ""}</td>
</tr>`;
}

function renderHtml(previews: AssetPreview[], allWrites: PlannedWrite[]): string {
  const generatedAt = new Date().toISOString();
  const totalWrites = allWrites.length;
  const totalSmoothed = allWrites.filter((w) => w.smoothingChanged).length;
  const totalPriceSmoothed = previews.reduce((acc, preview) => acc + preview.priceSmoothingChanges.length, 0);
  const totalPriceWarnings = previews.reduce((acc, preview) => acc + preview.priceSmoothingWarnings.length, 0);
  const rows = previews.map(assetTableRows).join("\n");
  const panels = previews.map((preview) => {
    const firstWriteTs = preview.writes[0]?.timestamp ?? isoToTs(START_DATE);
    const lastWriteTs = preview.writes[preview.writes.length - 1]?.timestamp ?? isoToTs(END_DATE);
    const windowStart = firstWriteTs - 7 * 86400;
    const windowEnd = lastWriteTs + 7 * 86400;
    const inWindow = (p: SvgPoint) => p.timestamp >= windowStart && p.timestamp <= windowEnd;
    const beforeAgg = preview.before.map((r) => ({ timestamp: r.timestamp, value: r.onChainMcap })).filter(inWindow);
    const afterAgg = preview.after.map((r) => ({ timestamp: r.timestamp, value: r.onChainMcap })).filter(inWindow);
    const oldSolana = preview.writes.map((w) => ({ timestamp: w.timestamp, value: w.oldSolanaMcap }));
    const newSolana = preview.writes.map((w) => ({ timestamp: w.timestamp, value: w.newSolanaMcap }));
    const otherChains = preview.writes.map((w) => ({ timestamp: w.timestamp, value: Math.max(0, w.newAggregateMcap - w.newSolanaMcap) }));
    const rawSolana = preview.writes.map((w) => ({ timestamp: w.timestamp, value: w.rawSupply * w.price }));
    const excludedSolana = preview.writes.map((w) => ({ timestamp: w.timestamp, value: w.excludedSupply * w.price }));
    const activeBeforeSmoothing = preview.writes.map((w) => ({ timestamp: w.timestamp, value: w.rawActiveSupply * w.price }));
    const aggregateSvg = renderSvg([
      { label: "UI before", color: "#ef4444", points: beforeAgg },
      { label: "UI after", color: "#22c55e", points: afterAgg },
      { label: INCLUDE_EVM ? "Other chains after RPC" : "Other chains preserved", color: "#eab308", points: otherChains, dash: "7 5" },
      { label: "Solana old", color: "#f59e0b", points: oldSolana },
      { label: "Solana new", color: "#38bdf8", points: newSolana },
    ]);
    const componentsSvg = renderSvg([
      { label: "Raw supply", color: "#a78bfa", points: rawSolana },
      { label: "Excluded", color: "#fb7185", points: excludedSolana },
      { label: "Active before smoothing", color: "#94a3b8", points: activeBeforeSmoothing, dash: "6 5" },
      { label: "Active written", color: "#38bdf8", points: newSolana },
    ]);
    const sample = preview.writes.slice(0, 4).concat(preview.writes.slice(-4)).map((w) => `
      <tr><td>${tsToIso(w.timestamp)}</td><td>${fmtUsd(w.oldSolanaMcap)}</td><td>${fmtUsd(w.newSolanaMcap)}</td><td>${fmtNum(w.rawSupply)}</td><td>${fmtNum(w.excludedSupply)}</td><td>${fmtNum(w.rawActiveSupply)}</td><td>${fmtNum(w.activeSupply)}</td><td>${w.price.toFixed(4)}</td></tr>
    `).join("");
    const priceRows = preview.priceSmoothingChanges.slice(0, 24).map((change) => `
      <tr><td>${tsToIso(change.timestamp)}</td><td>${fmtPrice(change.oldPrice)}</td><td>${fmtPrice(change.newPrice)}</td><td>${escapeHtml(change.reason)}</td></tr>
    `).join("");
    const priceWarnings = preview.priceSmoothingWarnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
    const priceDetails = preview.priceSmoothingChanges.length || preview.priceSmoothingWarnings.length ? `
  <details>
    <summary>Price smoothing (${preview.priceSmoothingChanges.length} changed${preview.priceSmoothingWarnings.length ? `, ${preview.priceSmoothingWarnings.length} warning(s)` : ""})</summary>
    ${preview.priceSmoothingWarnings.length ? `<ul>${priceWarnings}</ul>` : ""}
    ${preview.priceSmoothingChanges.length ? `<table class="sample">
      <thead><tr><th>Date</th><th>Old price</th><th>Smoothed price</th><th>Reason</th></tr></thead>
      <tbody>${priceRows}</tbody>
    </table>` : ""}
  </details>` : "";
    return `
<section>
  <h2>${escapeHtml(preview.asset.ticker)} <span>id ${escapeHtml(preview.asset.id)}</span></h2>
  <h3>Aggregate chart result</h3>
  <div class="chart">${aggregateSvg}</div>
  <h3>Solana components fetched from Dune</h3>
  <div class="chart">${componentsSvg}</div>
  ${priceDetails}
  <details>
    <summary>Sample rows</summary>
    <table class="sample">
      <thead><tr><th>Date</th><th>Old Solana</th><th>New Solana</th><th>Raw supply</th><th>Excluded</th><th>Active raw</th><th>Active written</th><th>Price</th></tr></thead>
      <tbody>${sample}</tbody>
    </table>
  </details>
</section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>RWA excluded-balance preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b1020; color: #dbeafe; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 1240px; margin: 0 auto; padding: 24px; }
  h1 { margin: 0; font-size: 24px; font-weight: 650; }
  h2 { font-size: 18px; margin: 28px 0 12px; }
  h2 span { color: #93a4b8; font-weight: 500; font-size: 13px; }
  h3 { margin: 14px 0 8px; font-size: 13px; color: #b7c6d9; font-weight: 650; }
  .sub { color: #93a4b8; margin: 6px 0 18px; }
  .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
  .stat { border: 1px solid #243244; border-radius: 6px; padding: 12px; background: #111827; }
  .label { color: #93a4b8; font-size: 12px; }
  .value { font-size: 18px; font-weight: 650; margin-top: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border-bottom: 1px solid #243244; padding: 8px 9px; text-align: right; white-space: nowrap; }
  th:first-child, td:first-child, th:nth-child(3), td:nth-child(3), th:nth-child(5), td:nth-child(5) { text-align: left; }
  th { color: #93a4b8; font-weight: 600; }
  section { border-top: 1px solid #243244; margin-top: 22px; padding-top: 4px; }
  .chart { border: 1px solid #243244; border-radius: 6px; overflow: hidden; background: #111827; }
  svg { display: block; width: 100%; height: auto; }
  svg text { fill: #93a4b8; font-size: 12px; }
  .legend text { fill: #dbeafe; font-size: 12px; }
  details { margin-top: 10px; color: #b7c6d9; }
  summary { cursor: pointer; color: #dbeafe; }
  ul { margin: 8px 0 0; padding-left: 22px; }
  .sample { margin-top: 8px; }
  .empty-chart { min-height: 220px; display: grid; place-items: center; color: #93a4b8; }
  @media (max-width: 800px) {
    main { padding: 16px; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    table { display: block; overflow-x: auto; }
  }
</style>
</head>
<body>
<main>
  <h1>RWA excluded-balance preview</h1>
  <div class="sub">Generated ${generatedAt}. Static SVG, no external JavaScript. The "UI after" line applies the same smoothHistoricalData + trimLeadingZeros transform used by the RWA chart endpoint. Price rows use bounded interpolation/carry-forward smoothing for obvious short unit jumps, with per-asset audit rows below. ${INCLUDE_EVM ? "Solana comes from Dune; EVM chains come from historical RPC." : "Only Solana is rebuilt; other chains are preserved."}</div>
  <div class="stats">
    <div class="stat"><div class="label">Assets</div><div class="value">${previews.length}</div></div>
    <div class="stat"><div class="label">Rows to write</div><div class="value">${totalWrites}</div></div>
    <div class="stat"><div class="label">Smoothed rows</div><div class="value">${totalSmoothed}</div></div>
    <div class="stat"><div class="label">Price smoothed</div><div class="value">${totalPriceSmoothed}${totalPriceWarnings ? ` / ${totalPriceWarnings} warn` : ""}</div></div>
    <div class="stat"><div class="label">Mode</div><div class="value">${WRITE ? "write" : "dry-run"}</div></div>
  </div>
  <table>
    <thead><tr><th>Ticker</th><th>ID</th><th>Platform</th><th>Rows</th><th>Range</th><th>Last before</th><th>Last after</th><th>Last excluded</th><th>Max aggregate delta</th><th>Smoothed</th><th>Price smoothed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${panels}
</main>
</body>
</html>`;
}

async function buildAssetPreview(asset: AssetMeta, duneRows: DuneRow[], evmBatch?: EvmBatchCache): Promise<AssetPreview> {
  const supplyPoints = rowsToSupplySeries(duneRows, asset);
  const chainPointsByChain = new Map<string, SupplyPoint[]>([[CHAIN, supplyPoints]]);
  const evmPointsByChain = evmBatch?.get(asset.id) ?? await getEvmSupplySeries(asset, supplyPoints.map((p) => p.timestamp));
  for (const [chain, points] of evmPointsByChain.entries()) chainPointsByChain.set(chain, points);

  const priceTimestamps = Array.from(new Set(
    Array.from(chainPointsByChain.values()).flatMap((points) => points.map((point) => point.timestamp))
  ));
  const priceResult = await getPriceMap(asset, priceTimestamps);
  const priceMap = priceResult.prices;
  const existing = await loadExisting(asset);
  const { writes, skippedNoPrice } = planWrites(asset, chainPointsByChain, priceMap, existing);
  const before = applyProdTransform(existing.aggregates);
  const after = applyProdTransform(buildSimulatedAggregates(existing.aggregates, writes));
  return {
    asset,
    before,
    after,
    writes,
    supplyPoints,
    priceMap,
    priceSmoothingChanges: priceResult.changes,
    priceSmoothingWarnings: priceResult.warnings,
    skippedNoPrice,
  };
}

async function main() {
  console.log(`[solana-excluded] metadata=${METADATA_SOURCE} existing=${EXISTING_SOURCE} write=${WRITE}`);
  console.log(`[solana-excluded] range=${START_DATE}..${END_DATE} lookback=${LOOKBACK_DATE} platforms=${PLATFORMS.join(",")}`);

  if (EXISTING_SOURCE === "db" || METADATA_SOURCE === "db" || WRITE) await initPG();

  const metadata = await loadMetadata();
  const cacheAssets = selectAssets(metadata);
  if (!cacheAssets.length) {
    console.error("[solana-excluded] no assets matched selection");
    process.exit(1);
  }
  const assets = SKIP_TICKERS.size
    ? cacheAssets.filter((a) => !SKIP_TICKERS.has(a.ticker.toLowerCase()))
    : cacheAssets;
  if (!assets.length) {
    console.error("[solana-excluded] all selected assets were skipped");
    process.exit(1);
  }
  if (SKIP_TICKER_LABELS.length) {
    console.log(`[solana-excluded] skipped ticker(s): ${SKIP_TICKER_LABELS.join(",")}`);
  }
  console.log(`[solana-excluded] selected ${assets.length} asset(s): ${assets.map((a) => `${a.ticker}:${a.id}`).join(", ")}`);

  const withoutExcluded = assets.filter((a) => a.excludedOwners.length <= fetchBurnAddresses(CHAIN).length);
  if (withoutExcluded.length) {
    console.log(`[solana-excluded] burn-only exclusions: ${withoutExcluded.map((a) => a.ticker).join(", ")}`);
  }

  const duneRows = await getDuneRows(cacheAssets);
  const allTimestamps = Array.from(new Set(
    duneRows.map((row) => isoToTs(String(row.day).slice(0, 10)))
  )).sort((a, b) => a - b);
  const evmBatch = INCLUDE_EVM ? await getEvmSupplySeriesBatch(cacheAssets, allTimestamps) : undefined;
  const previews: AssetPreview[] = [];
  const allWrites: PlannedWrite[] = [];

  for (const asset of assets) {
    const preview = await buildAssetPreview(asset, duneRows, evmBatch);
    previews.push(preview);
    allWrites.push(...preview.writes);
    const last = preview.writes[preview.writes.length - 1];
    const smoothed = preview.writes.filter((w) => w.smoothingChanged).length;
    console.log(
      `[plan] ${asset.ticker} id=${asset.id} rows=${preview.writes.length} ` +
      `smoothed=${smoothed} priceSmoothed=${preview.priceSmoothingChanges.length}` +
      `${preview.priceSmoothingWarnings.length ? ` priceWarnings=${preview.priceSmoothingWarnings.length}` : ""} ` +
      `skippedNoPrice=${preview.skippedNoPrice} ` +
      `last=${last ? `${tsToIso(last.timestamp)} ${fmtUsd(last.oldAggregateMcap)} -> ${fmtUsd(last.newAggregateMcap)}` : "n/a"}`
    );
  }

  if (allWrites.length === 0) {
    console.log("[solana-excluded] nothing to write");
  }

  const html = renderHtml(previews, allWrites);
  const outPath = path.resolve(OUT);
  fs.writeFileSync(outPath, html);
  console.log(`[solana-excluded] preview written: ${outPath}`);

  if (WRITE) {
    await commitWrites(allWrites);
    console.log(`[solana-excluded] wrote ${allWrites.length} rows to daily_rwa_data + backup_rwa_data`);
  } else {
    console.log("[solana-excluded] DRY RUN - no DB writes performed");
  }
}

main()
  .catch((e) => {
    console.error("[solana-excluded] fatal:", e?.response?.data ?? e?.stack ?? e?.message ?? e);
    process.exit(1);
  })
  .then(() => process.exit(0));
