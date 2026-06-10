import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import getWrites from "../utils/getWrites";
import { checkOracleFresh } from "../utils/oracle";

// Bedrock uniBTC is a 1:1 BTC wrapper (1 uniBTC minted per 1 BTC-equivalent deposited). It has no on-chain
// accruing exchange rate — both the token and Morpho's own oracle treat it as exactly 1 BTC (the Morpho
// uniBTC oracle reads a flat 1.0 rate feed × BTC/USD). We previously inherited CoinGecko's `universal-btc`
// mark, which intermittently glitches to a byte-identical bogus ~$93,146.85 (then snaps back to ~BTC),
// serving uniBTC ~52% too high on every chain. So price it on-chain off the Chainlink BTC/USD feed instead,
// at confidence 1 so it wins over the CoinGecko redirect (0.99). Paired with: cgIdDenylist 'universal-btc'
// (stops CG re-pricing/re-redirecting it) and tokenMapping.json entries that redirect every other chain's
// uniBTC to this ethereum record.
//
// LIMITATION: this tracks the 1:1 peg; a genuine BACKING shortfall is not observable on-chain here (uniBTC
// reserves are spread across chains), so it won't auto-detect a real depeg. If Bedrock ever publishes a
// uniBTC/BTC rate feed, read it and multiply `btcUsd` by it below.
const chain = "ethereum";
const uniBTC = "0x004e9c3ef86bc1ca1f0bb5c7662861ee93350568"; // uniBTC (ethereum) — the canonical write
const BTC_USD_FEED = "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c"; // Chainlink BTC/USD (ethereum), 8 decimals
const AGGREGATOR_ABI =
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)";

export async function bedrockUniBTC(timestamp: number = 0): Promise<Write[]> {
  const api = await getApi(chain, timestamp);
  const rd = await api.call({ target: BTC_USD_FEED, abi: AGGREGATOR_ABI });
  // Don't write a stale BTC mark — skip the run if the feed is stale or non-positive.
  if (!checkOracleFresh(rd.updatedAt, { timestamp, throwIfStale: false, label: "bedrock-uniBTC BTC/USD" })) return [];
  if (!rd.answer || Number(rd.answer) <= 0) return [];

  const btcUsd = Number(rd.answer) / 1e8;
  const pricesObject: any = { [uniBTC]: { price: btcUsd } }; // uniBTC = 1.0 (peg) × BTC/USD
  return getWrites({ chain, timestamp, pricesObject, projectName: "bedrock-uniBTC", confidence: 1 });
}
