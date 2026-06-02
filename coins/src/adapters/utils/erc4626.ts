import { Write } from "./dbInterfaces";
import { getApi } from "./sdk";
import getWrites from "./getWrites";

export type Result4626 = {
  token: string;
  price: number;
  decimals: number;
  symbol: string;
};

// Vaults that must NOT be priced via the generic totalAssets/totalSupply path,
// keyed by `chain:address` (lowercase). totalAssets() on these reports assets
// backing every chain deployment (not just this one), so the standard 4626 rate
// is inflated. They are priced explicitly elsewhere (e.g. via convertToAssets in
// adapters/yield/derivs.ts) — skipping them here lets that source win.
const ERC4626_BLACKLIST = new Set<string>([
  "arbitrum:0x0b2b2b2076d95dda7817e785989fe353fe955ef9", // sUSDai (Staked USDai)
]);

export async function calculate4626Prices(
  chain: any,
  timestamp: number,
  tokensRaw: string[],
  projectName: string,
): Promise<Write[]> {
  const tokens = tokensRaw.filter(
    (t) => !ERC4626_BLACKLIST.has(`${chain}:${t.toLowerCase()}`),
  );
  const api = await getApi(chain, timestamp)
  const uTokens = await api.multiCall({ abi: 'address:asset', calls: tokens, permitFailure: true } as any)
  const supply = await api.multiCall({ abi: 'uint256:totalSupply', calls: tokens, permitFailure: true } as any)
  const tokenBals = await api.multiCall({ abi: 'uint256:totalAssets', calls: tokens, permitFailure: true } as any)
  const tokenDecimals = await api.multiCall({ abi: 'uint8:decimals', calls: tokens, permitFailure: true } as any)
  const uTokenDecimals = (await api.multiCall({ abi: 'uint8:decimals', calls: uTokens.map(i => i ?? '0x0000000000000000000000000000000000000000'), permitFailure: true } as any)).map(i => i ?? 18)
  const pricesObject: any = {}
  tokens.forEach((token, i) => {
    if (!uTokens[i] || !supply[i] || !tokenBals[i] || !tokenDecimals[i]) return; // Skip if any of the values are null/call failed
    const decimalDiff = +tokenDecimals[i] - uTokenDecimals[i]
    const price = (tokenBals[i] / supply[i]) * (10 ** decimalDiff)
    if (isNaN(price) || !isFinite(price)) return; // Skip if price is not a number
    pricesObject[token] = { underlying: uTokens[i], price }
  })
  return await getWrites({ chain, timestamp, pricesObject, projectName, confidence: 1 })
}
