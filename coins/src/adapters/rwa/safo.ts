import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import { addToDBWritesList } from "../utils/database";
import { checkOracleFresh, NAV_ORACLE_MAX_AGE_SECONDS } from "../utils/oracle";

const latestRoundDataAbi =
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)";

// Spiko Amundi Overnight Swap Fund NAV oracles (Chainlink-style, 6 decimals) on Arbitrum.
// IMPORTANT: each oracle reports the share NAV in the fund's *base currency*, not USD —
// SAFO=USD, eurSAFO=EUR, gbpSAFO=GBP, chfSAFO=CHF — so the non-USD NAVs (all ~1.0) must be
// multiplied by the relevant FX rate before being stored as USD, or the funds are served
// undervalued by the whole FX premium (eurSAFO ~13% low, gbpSAFO ~26% low, chfSAFO ~20% low).
const oracles: { [symbol: string]: string } = {
  SAFO: "0x372e37cA79747A2d1671EDBC5f1e2853B96BA351",
  eurSAFO: "0x385D443ffA5b6Fb462b988D023a5DC3b37Ef1644",
  gbpSAFO: "0x835B48E97CBF727e23E7AA3bD40248818d20A2b0",
  chfSAFO: "0xD1F12049cC311DfB177f168046Ed8e2bd341a7AF",
};

// Chainlink FX feeds (Polygon, 8 decimals) converting each non-USD fund's native NAV into
// USD — the same feeds the jarvis and cnht adapters use. An FX rate is chain-agnostic, so it
// doesn't matter that the feeds live on Polygon while the funds trade elsewhere. The USD fund
// (SAFO) is omitted here and priced at NAV directly.
const FX_FEED_CHAIN = "polygon";
const fxFeeds: { [symbol: string]: string } = {
  eurSAFO: "0x73366Fe0AA0Ded304479862808e02506FE556a98", // EUR/USD
  gbpSAFO: "0x099a2540848573e94fb1Ca0Fa420b00acbBc845a", // GBP/USD
  chfSAFO: "0xc76f762CedF0F78a439727861628E0fdfE1e70c2", // CHF/USD
};
// Forex feeds idle over weekends/holidays — tolerate a few days before treating as stale (same
// rationale as cnht.ts).
const FX_MAX_AGE_SECONDS = 4 * 24 * 60 * 60;

const config: { [symbol: string]: { [chain: string]: string } } = {
  SAFO: {
    ethereum: "0xcBaDe7D9BdEe88411CB6cbCbB29952b742036992",
    polygon: "0x6F64f47F95cf656f21B40E14798F6b49f80b3dc5",
    arbitrum: "0x0c709396739b9cfb72bcea6ac691ce0ddf66479c",
    base: "0x0bb754d8940e283d9ff6855ab5dafbc14165c059",
    stellar: "CDGSC6BA4TCAOVSFQCUEHDMOIIHYYVNYBT6YEARS4MX3ITAHUINVGQHX",
    starknet: "0x035bdc17f7a7d09c45d31ab476a576d4f7aad916676b2948fe172c3bcb33725a",
    etlk: "0x5677a4dc7484762ffccee13cba20b5c979def446",
  },
  eurSAFO: {
    ethereum: "0x0990b149e915cb08e2143a5c6f669c907eddc8b0",
    polygon: "0x272ea767712cc4839f4a27ee35eb73116158c8a2",
    arbitrum: "0x1412632f2b89e87bfa20c1318a43ced25f1d7b76",
    base: "0xd879846cbe20751bde8a9342a3cca00a3e56ca47",
    stellar: "CBOOCGZSVRSZFRE4U2NWR2B4RXYVJWRCBTGOUD2JPI2TDJPWMTJX7FZP",
    starknet: "0x0128f41ef8017ab56140ffad6439305a3196ed862841ba61ff4d78e380c346a6",
    etlk: "0x35dfec1813c43d82e6b87c682f560bbb8ea0c121",
  },
  gbpSAFO: {
    ethereum: "0xC273986a91e4BFC543610a5cb5860b7Cfefb6cC0",
    polygon: "0x4fe515c67eeeadb3282780325f09bb7c244fe774",
    arbitrum: "0xbe023308ac2ef7e1c3799f4e6a3003ee6d342635",
    base: "0x2f6c0e5e06b43512706a9cdf66cd21f723fe0ec3",
    stellar: "CAGYRRKPFSWKM6SJOE4QAAVYMOSHMDS5WOQ4T5A2E6XNCU7LZZKUNQKP",
    starknet: "0x06e8a99926ff6d56f4cb93c37b63286d736cd1f81740d53f88b4875b4cbe7f49",
    etlk: "0xfe20ebe3881491b2e158b9d10cb95bcfa652262d",
  },
  chfSAFO: {
    ethereum: "0x18b5c15e5196a38a162b1787875295b76e4313fb",
    polygon: "0x9de2b2dcdcf43540e47143f28484b6d15118f089",
    arbitrum: "0x97e7962bcd091e7ecfb583fc96289b1e1553ac6e",
    base: "0xd9aa2300e126869182dfb6ecf54984e4c687f36b",
    stellar: "CAJD2IBSP7VO2VYJQUYJSOGPJINTUYV7MQITINXVPTIH3CCLCUENNMW4",
    starknet: "0x06723dcb428eddb160c5adfc2d0a5e5adc184bf6a7298780c3cbf3fa764f709b",
    etlk: "0xef53e7d17822b641c6481837238a64a688709301",
  },
};

export async function safo(timestamp: number = 0): Promise<Write[]> {
  const api = await getApi("arbitrum", timestamp);
  const fxApi = await getApi(FX_FEED_CHAIN, timestamp);
  const symbols = Object.keys(oracles);
  const fxSymbols = Object.keys(fxFeeds);

  const [results, fxResults] = await Promise.all([
    api.multiCall({
      abi: latestRoundDataAbi,
      calls: symbols.map((s) => oracles[s]),
    }),
    fxApi.multiCall({
      abi: latestRoundDataAbi,
      calls: fxSymbols.map((s) => fxFeeds[s]),
    }),
  ]);

  // symbol -> USD per unit of the fund's base currency. USD fund needs no conversion.
  const fxRates: { [symbol: string]: number } = { SAFO: 1 };
  fxSymbols.forEach((symbol, i) => {
    const [, answer, , updatedAt] = fxResults[i];
    if (!checkOracleFresh(updatedAt, { timestamp, label: `${symbol} FX`, throwIfStale: false, maxAgeSeconds: FX_MAX_AGE_SECONDS })) return;
    fxRates[symbol] = Number(answer) / 1e8;
  });

  const writes: Write[] = [];

  symbols.forEach((symbol, i) => {
    const [, answer, , updatedAt] = results[i];
    // Spiko NAVs only post on business days — tolerate the weekend gap (see NAV_ORACLE_MAX_AGE_SECONDS).
    if (!checkOracleFresh(updatedAt, { timestamp, label: symbol, throwIfStale: false, maxAgeSeconds: NAV_ORACLE_MAX_AGE_SECONDS })) return;

    // Skip a fund whose FX rate is missing/stale rather than store its native NAV (~$1) as USD,
    // which would silently undervalue it. SAFO is USD (fxRate 1) and is never skipped here.
    const fxRate = fxRates[symbol];
    if (fxRate === undefined) return;

    const price = (answer / 1e6) * fxRate;
    const chains = config[symbol];
    const arbitrumAddress = chains["arbitrum"];

    addToDBWritesList(
      writes,
      "arbitrum",
      arbitrumAddress,
      price,
      5,
      symbol,
      timestamp,
      "safo",
      1,
    );

    for (const chain of Object.keys(chains)) {
      if (chain === "arbitrum") continue;
      addToDBWritesList(
        writes,
        chain,
        chains[chain],
        undefined,
        5,
        symbol,
        timestamp,
        "safo",
        1,
        `asset#arbitrum:${arbitrumAddress}`,
      );
    }
  });

  return writes;
}