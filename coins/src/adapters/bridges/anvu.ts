import * as sdk from "@defillama/sdk";
import { lowercaseAddress } from "../../utils/processCoin";
import { fetch } from "../utils";
import { Token } from "./index";

export default async function bridge() {
  const res = await fetch("https://starknet.api.avnu.fi/v1/starknet/tokens");
  const bridge = (res?.content ?? []) as any[];

  if (!bridge.length) {
    sdk.log("avnu bridge: no token content (upstream may be down), skipping");
    return [];
  }

  const tokens: Token[] = [];

  bridge.map((token) => {
    const { address, symbol, decimals, extensions: { coingeckoId} } = token;
    tokens.push({
      from: lowercaseAddress(`starknet:${address}`),
      to: `coingecko#${coingeckoId}`,
      symbol,
      decimals,
    });
  });

  return tokens;
}