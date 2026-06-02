import { addToDBWritesList } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { checkOracleFresh } from "../utils/oracle";
import { getApi } from "../utils/sdk";

const latestRoundDataAbi =
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)";
const decimalsAbi = "function decimals() view returns (uint8)";

const COMMODITY_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const feeds = [
  {
    symbol: "GOLDST",
    token: "0xcdc93d30182125e05eec985b631c7c61b3f63ff0",
    feed: "0x214eD9Da11D2fbe465a6fc601a91E62EbEc1a0D6",
    label: "XAU/USD",
    maxAgeSeconds: COMMODITY_MAX_AGE_SECONDS,
  },
  {
    symbol: "SILVST",
    token: "0x2c59ef92d08efde71fe1a1cb5b45f4f6d48fcc94",
    feed: "0x379589227b15F1a12195D3f2d90bBc9F31f95235",
    label: "XAG/USD",
    maxAgeSeconds: COMMODITY_MAX_AGE_SECONDS,
  },
  {
    symbol: "USDST",
    token: "0x937efa7e3a77e20bbdbd7c0d32b6514f368c1010",
    feed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    label: "USDT/USD",
  },
];

export async function strato(timestamp: number = 0): Promise<Write[]> {
  const api = await getApi("ethereum", timestamp);
  const [prices, decimals] = await Promise.all([
    api.multiCall({
      abi: latestRoundDataAbi,
      calls: feeds.map(({ feed }) => feed),
      permitFailure: true,
    }),
    api.multiCall({
      abi: decimalsAbi,
      calls: feeds.map(({ feed }) => feed),
      permitFailure: true,
    }),
  ]);

  const writes: Write[] = [];

  feeds.forEach((feedConfig, i) => {
    const priceData = prices[i];
    const decimalsValue = decimals[i];
    if (!priceData?.answer || decimalsValue == null) {
      console.warn(`Failed to fetch ${feedConfig.label} Chainlink price`);
      return;
    }

    const isFresh = checkOracleFresh(priceData.updatedAt, {
      timestamp,
      label: feedConfig.label,
      maxAgeSeconds: feedConfig.maxAgeSeconds,
      throwIfStale: false,
    });
    if (!isFresh) return;

    const price = Number(priceData.answer) / 10 ** Number(decimalsValue);
    if (!Number.isFinite(price) || price <= 0) {
      console.warn(`Invalid ${feedConfig.label} Chainlink price: ${price}`);
      return;
    }

    addToDBWritesList(
      writes,
      "strato",
      feedConfig.token,
      price,
      18,
      feedConfig.symbol,
      timestamp,
      "strato-chainlink",
      1
    );
  });

  return writes;
}
