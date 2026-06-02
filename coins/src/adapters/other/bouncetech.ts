import * as sdk from "@defillama/sdk";
import { Write } from "../utils/dbInterfaces";
import getWrites from "../utils/getWrites";

const factory = '0x65a379FE76C7AdC8037b3522De62B27c0D4e9259';
const baseAsset = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';

// Prices from LeveragedToken.exchangeRate(), which returns totalAssets * 1e18 / totalSupply
export async function bouncetech(timestamp: number = 0) {
  const api = new sdk.ChainApi({ chain: "hyperliquid", timestamp });

  const lts: string[] = await api.call({
    abi: "address[]:lts",
    target: factory,
  });

  if (!lts?.length) return [];

  const [rates, decimalsArr, symbols] = await Promise.all([
    api.multiCall({ abi: "uint256:exchangeRate", calls: lts }),
    api.multiCall({ abi: "erc20:decimals", calls: lts }),
    api.multiCall({ abi: "erc20:symbol", calls: lts }),
  ]);

  const pricesObject: any = {};
  for (let i = 0; i < lts.length; i++) {
    const rateRaw = BigInt(rates[i] ?? "0");
    if (rateRaw === BigInt(0)) continue;

    const rate = Number(rateRaw) / 1e18;
    if (!isFinite(rate) || rate <= 0) continue;

    pricesObject[lts[i]] = {
      underlying: baseAsset,
      decimals: Number(decimalsArr[i]),
      symbol: symbols[i],
      price: rate,
    };
  }

  const writes: Write[] = [];
  return await getWrites({
    chain: "hyperliquid",
    timestamp,
    pricesObject,
    projectName: "bouncetech",
    writes,
  });
}
