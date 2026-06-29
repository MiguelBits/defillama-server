/**
 * Satsuma DEX (Citrea) token prices for the DefiLlama coins API.
 *
 * Some Satsuma Citrea tokens are already live in the coins API. This adapter
 * uses those prices as anchors, but only writes tokens that are still missing
 * and needed for Satsuma TVL / vault assets.
 *
 * Copy to: defillama-server/coins/src/adapters/other/satsumaCitrea.ts
 * Register in: coins/src/adapters/other/index.ts (see coins-pr/README.md).
 */
import * as sdk from "@defillama/sdk";
import getWrites from "../utils/getWrites";

const chain = "citrea";

// Stablecoins on Citrea — anchored to $1 (lowercased addresses).
const STABLES: Record<string, true> = {
  "0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d": true, // ctUSD
  "0xe045e6c36cf77faa2cfb54466d71a3aef7bbe839": true, // USDC.e
  "0x9f3096bac87e7f03dc09b0b416eb0df837304dc4": true, // USDT.e
  "0xac8c1aeb584765db16ac3e08d4736cfce198589b": true, // GUSD
};

// Symbols for the tokens this adapter prices (lowercased address -> symbol).
const SYMBOLS: Record<string, string> = {
  "0x8d82c4e3c936c7b5724a382a9c5a4e6eb7ab6d5d": "ctUSD",
  "0xe045e6c36cf77faa2cfb54466d71a3aef7bbe839": "USDC.e",
  "0x9f3096bac87e7f03dc09b0b416eb0df837304dc4": "USDT.e",
  "0xac8c1aeb584765db16ac3e08d4736cfce198589b": "GUSD",
  "0x3100000000000000000000000000000000000006": "WCBTC",
  "0xdf240dc08b0fdad1d93b74d5048871232f6bea3d": "WBTC.e",
  "0xc778f3a8bcdf9f8daee9d0e8508af83e90e9b1f9": "wKcBTC",
  "0x547afd93b9c47d552059feb556909e017f8a9b25": "CTR",
  "0x60bf948001e7b7ea03ddaaddae048af7402e7b74": "SUMA",
  "0xd2dd3dac986cd8256a51d9e3dbcb9151f0aeeb41": "SHITREA",
  "0xbc249b89a877018080e7d381524d34cd0ddc27b8": "ZNT",
  "0xdba0f380509a3e7562c029f308e9867021d32af0": "s33",
};

// Live coins API already prices ctUSD, USDC.e, WCBTC, WBTC.e, and CTR. Only
// write the gaps needed for Satsuma TVL / vault assets.
const OUTPUT_TOKENS: Record<string, true> = {
  "0x9f3096bac87e7f03dc09b0b416eb0df837304dc4": true, // USDT.e
  "0xac8c1aeb584765db16ac3e08d4736cfce198589b": true, // GUSD
  "0xc778f3a8bcdf9f8daee9d0e8508af83e90e9b1f9": true, // wKcBTC
  "0x60bf948001e7b7ea03ddaaddae048af7402e7b74": true, // SUMA
  "0xd2dd3dac986cd8256a51d9e3dbcb9151f0aeeb41": true, // SHITREA
  "0xbc249b89a877018080e7d381524d34cd0ddc27b8": true, // ZNT
  "0xdba0f380509a3e7562c029f308e9867021d32af0": true, // s33
};

// Algebra pools used to derive non-stable prices. Each pool pairs an
// already-priceable token with one to resolve; the resolver iterates until
// no new prices can be derived, so ordering does not matter.
const POOLS: string[] = [
  "0x5d4b518984ae9778479ee2ea782b9925bbf17080", // WCBTC / ctUSD
  "0x78de0ada441a6bfe092967bb40ce30d7c77aad2c", // CTR / ctUSD
  "0x298a4e0ec1af98066b79836ea99dcc2dd5437f67", // SUMA / ctUSD
  "0x8f87f74d009e18b745fe6fb59d5859911a2c3db7", // ctUSD / SHITREA
  "0xaea5cf09209631b6a3a69d5798034e2efdbe2cc8", // WCBTC / WBTC.e
  "0x3560aa7a517b3e1fb6cddf225baf2febde3cb76c", // WCBTC / wKcBTC
  "0x0557b48af1503d1a50f76a24938998a664fcf73f", // CTR / ZNT
  "0x9ad930b091e6b7173ee85636067245b0ceddee63", // SUMA / s33
];

// Algebra exposes the active price via globalState(); the first return word is
// the uint160 sqrtPriceX96. Decoding it as a single uint160 reads that word and
// ignores the rest, so this works across Algebra Integral/v1.9 layouts.
const sqrtPriceAbi =
  "function globalState() view returns (uint160 sqrtPriceX96)";

const Q96 = 2 ** 96;

export function satsuma(timestamp: number = 0) {
  return getTokenPrices(timestamp);
}

async function getTokenPrices(timestamp: number) {
  const api = new sdk.ChainApi({ chain });

  const [token0s, token1s, sqrtPrices] = await Promise.all([
    api.multiCall({ abi: "address:token0", calls: POOLS, permitFailure: true }),
    api.multiCall({ abi: "address:token1", calls: POOLS, permitFailure: true }),
    api.multiCall({ abi: sqrtPriceAbi, calls: POOLS, permitFailure: true }),
  ]);

  const pools = POOLS.map((_, i) => ({
    token0: token0s[i] ? String(token0s[i]).toLowerCase() : null,
    token1: token1s[i] ? String(token1s[i]).toLowerCase() : null,
    sqrtPriceX96: sqrtPrices[i],
  })).filter((p) => p.token0 && p.token1 && p.sqrtPriceX96);

  // Token universe = the $1 stablecoin anchors (some, e.g. GUSD/USDC.e/USDT.e,
  // aren't in the derivation pools but must still be written) plus every token
  // that appears in a pricing pool.
  const tokens = Array.from(
    new Set([...Object.keys(STABLES), ...pools.flatMap((p) => [p.token0!, p.token1!])])
  );

  const decimalsList = await api.multiCall({
    abi: "erc20:decimals",
    calls: tokens,
  });
  const decimals: Record<string, number> = {};
  tokens.forEach((t, i) => {
    decimals[t] = Number(decimalsList[i]);
  });

  // USD price per whole token. Seed with the $1 stablecoin anchors.
  const prices: Record<string, number> = {};
  for (const t of tokens) if (STABLES[t]) prices[t] = 1;

  // token1 amount per 1 token0 (human units).
  const token1PerToken0 = (p: (typeof pools)[number]) => {
    const ratio = Number(p.sqrtPriceX96) / Q96;
    return ratio * ratio * 10 ** (decimals[p.token0!] - decimals[p.token1!]);
  };

  // Propagate prices across pools until nothing new resolves.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of pools) {
      const rate = token1PerToken0(p);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      if (prices[p.token0!] != null && prices[p.token1!] == null) {
        prices[p.token1!] = prices[p.token0!] / rate;
        changed = true;
      } else if (prices[p.token1!] != null && prices[p.token0!] == null) {
        prices[p.token0!] = prices[p.token1!] * rate;
        changed = true;
      }
    }
  }

  const stableObject: { [key: string]: any } = {};
  const derivedObject: { [key: string]: any } = {};
  for (const token of tokens) {
    if (!OUTPUT_TOKENS[token]) continue;
    const price = prices[token];
    if (price == null || !Number.isFinite(price) || price <= 0) continue;
    const entry = {
      price,
      symbol: SYMBOLS[token],
      decimals: decimals[token],
    };
    if (STABLES[token]) stableObject[token] = entry;
    else derivedObject[token] = entry;
  }

  const [stableWrites, derivedWrites] = await Promise.all([
    getWrites({
      chain,
      timestamp,
      pricesObject: stableObject,
      projectName: "satsuma",
      confidence: 0.99,
    }),
    getWrites({
      chain,
      timestamp,
      pricesObject: derivedObject,
      projectName: "satsuma",
      confidence: 0.9,
    }),
  ]);

  return [...stableWrites, ...derivedWrites];
}
