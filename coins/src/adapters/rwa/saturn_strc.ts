import { fetch } from "../utils";
import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";

// STRC is Strategy Inc.'s "Stretch" variable-rate preferred stock (NASDAQ: STRC), used by
// Saturn as the digital-credit backing for USDat / sUSDat. It has no token contract we can
// price on-chain, so we publish its tradfi market price under a DefiLlama-internal id.
// The `llama-` prefix marks this as our own id (not a CoinGecko id); adapters consume it via
// `api.addCGToken("llama-stock-strc", amount)`, which reads `coingecko#llama-stock-strc`.
const CG_ID = "llama-stock-strc";
const SYMBOL = "STRC";
const DECIMALS = 0; // 1 unit = 1 share
const CONFIDENCE = 0.9;
const ADAPTER = "saturn_strc";

// Yahoo Finance daily closes (no API key). range=max returns STRC's full history (IPO 2025-07-29)
// so backfills stay complete even after the series grows past 2y.
const SOURCE =
  "https://query1.finance.yahoo.com/v8/finance/chart/STRC?range=max&interval=1d";

type Chart = {
  chart: {
    error: any;
    result?: {
      timestamp: number[];
      indicators?: { quote?: { close: (number | null)[] }[] };
    }[];
  };
};

export async function saturn_strc(timestamp: number = 0): Promise<Write[]> {
  const res: Chart = await fetch(SOURCE, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const result = res?.chart?.result?.[0];
  if (!result?.timestamp?.length || res?.chart?.error)
    throw new Error(`saturn_strc: no STRC data from source (${res?.chart?.error})`);

  const ts = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  if (!closes?.length)
    throw new Error("saturn_strc: STRC payload missing close prices");

  // refillAdapter sets HISTORICAL=true and passes a non-zero timestamp; in that mode we
  // backfill the full daily series. The regular cron (timestamp 0) only refreshes the latest.
  const writeHistory = process.env.HISTORICAL === "true" && timestamp !== 0;

  const writes: Write[] = [];

  if (writeHistory) {
    for (let i = 0; i < ts.length; i++) {
      const price = closes[i];
      if (price == null || !isFinite(price)) continue;
      addToDBWritesList(writes, "coingecko", CG_ID, price, DECIMALS, SYMBOL, ts[i], ADAPTER, CONFIDENCE);
    }
  }

  // Latest valid close -> current price + metadata record (SK 0).
  let latest: number | undefined;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (closes[i] != null && isFinite(closes[i] as number)) {
      latest = closes[i] as number;
      break;
    }
  }
  if (latest == null) throw new Error("saturn_strc: no valid STRC close price");
  addToDBWritesList(writes, "coingecko", CG_ID, latest, DECIMALS, SYMBOL, 0, ADAPTER, CONFIDENCE);

  return writes;
}
