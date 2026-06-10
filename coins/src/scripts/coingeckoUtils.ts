import fetch from "node-fetch";
import * as sdk from '@defillama/sdk'
const { decimals, symbol, } = sdk.erc20
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../adapters/solana/utils";
import { chainsThatShouldNotBeLowerCased } from "../utils/shared/constants";
import { cairoErc20Abis, call, feltArrToStr } from "../adapters/utils/starknet";

// CoinGecko ids we deliberately DO NOT price — priced on-chain instead. MUST be honored in BOTH the
// scheduled sync (scripts/coingecko.ts) AND the on-demand /current refetch (updateCoin.ts); otherwise
// on-demand requests keep re-pulling the CG price and the slot never goes stale (blocking the on-chain
// price + any bridge redirect).
export const cgIdDenylist = new Set<string>([
  'apxusd',              // priced via the deep Curve apxUSD/USDC pool (+ base redirect via tokenMapping.json)
  'wrapped-staked-link', // wstLINK — priced by the wstlink adapter (getUnderlyingByWrapped × LINK)
  'universal-btc',       // uniBTC — CG mark intermittently glitches to a bogus ~$93k; priced by bedrockUniBTC (1:1 × Chainlink BTC/USD), other chains redirect to ethereum via tokenMapping.json
]);

// Chains where we have no working metadata fetch path. Tokens on these chains
// will be skipped without attempting (and failing) a fetch.
const unsupportedMetadataChains = new Set<string>([
  'immutable', 'cardano', 'neo', 'xdc', 'terra', 'archway',
  'kava', 'kujira', 'provenance', 'ontology', 'move', 'tezos', 'zilliqa',
  'map', 'heco', 'energi', 'neutron', 'gala', 'injective',
]);

// Chain name aliases for the EVM erc20 fallback — maps the CG/internal chain
// name to the key @defillama/sdk uses in its providers list.
const evmChainAlias: Record<string, string> = {
  etherlink: 'etlk',
};

// Specific token addresses (chain:address, lowercased) that consistently fail
// metadata fetch and aren't worth retrying on each run.
const tokenMetadataBlacklist = new Set<string>([
  'ethereum:0x0d88ed6e74bbfd96b831231638b66c05571e824f', // aventus
  'sonic:0x2117e8b79e8e176a670c9fcf945d4348556bffad', // euler
  'moonriver:0xffffffff7d2b0b761af01ca8e25242976ac0ad7d', // usd-coin (no symbol() on chain)
  'monad:0x6fe981dbd557f81ff66836af0932cba535cbc343', // chainlink (no symbol() on chain)
  'zircuit:0xdee94506570ca186bc1e3516fcf4fd719c312ccd', // chainlink (no symbol() on chain)
  'hedera:0x7ce6bb2cc2d3fd45a974da6a0f29236cb9513a98', // chainlink (mirror node returns no symbol/decimals)
  'hedera:0x39ceba2b467fa987546000eb5d1373acf1f3a2e1', // novatti-australian-digital-dollar (mirror node returns no symbol/decimals)
  'sophon:0x000000000000000000000000000000000000800a', // sophon system token (execution reverted)
  'tron:1002357', // gmcoin-2 — non-base58 address crashes sdk
  // Stellar contract IDs (no '-' separator → no metadata path)
  'stellar:cb44w727wslhpxj47a6dhf5d34rkwsozamedxo3cf5teeeq2zx4v3vri', // allunity-eur
  'stellar:cbijbdnznf4x35bj4ffzwcdbsckop5nb4plg4snenrmlapyg4p5fm6vn', // solv-btc
  'stellar:caup7nfabxe5tjrl3fktpmwrlc7iaxydcthqrfsclr5tmgkhooqo772j', // solv-protocol-solvbtc-bbn
  'stellar:cac743nyrbms76l2dcpaxztoef6ejpkpvec5ox2sxy7hownxisslue2c', // usdm1
  'stellar:cankbynnaykezxlb655f2upntazfk5hilzuxl7ztfr3nf6lkdsvy7kfh', // societe-generale-forge-eurcv
  // Algorand asset ids that aren't resolvable via algonode
  'algorand:2768603795', // quantoz-usdq
  'algorand:2768422954', // quantoz-eurq
  'algorand:112866019', // brz
  // Aptos tokens that aptoscan.com keeps returning HTML for
  'aptos:0x2a8227993a4e38537a57caefe5e7e9a51327bf6cd732c1f56648f26f68304ebc', // kgen
  'aptos:0xb2c7780f0a255a6137e5b39733f5a4c85fe093c549de5c359c1232deef57d1b7', // echo-protocol
  'aptos:0xe067037681385b86d8344e6b7746023604c6ac90ddc997ba3c58396c258ad17b', // frax-usd
  'aptos:0xcfea864b32833f157f042618bd845145256b1bf4c0da34a7013b76e42daa53cc', // ondo-us-dollar-yield
  'aptos:0x2a90fae71afc7460ee42b20ee49a9c9b29272905ad71fef92fbd8b3905a24b56', // bonk
  // NEAR tokens that aren't on the .factory.bridge.near path
  'near:btc.omft.near', // near-intents-bridged-btc
  'near:eth.omft.near', // near-intents-bridged-eth
  'near:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near', // near-intents-bridged-usdt
  'near:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', // near-intents-bridged-usdc
  'near:sol.omft.near', // near-intents-bridged-sol
  'near:token.publicailab.near', // publicai
  // Morph token where symbol() reverts
  'morph:0x389c08bc23a7317000a1fd76c7c5b0cb0b4640b5', // bitget-token
  // TON tokens where tonscan.org public-dyor returns "Error making request"
  'ton:eqaph9rcprgg5kkumtji8ub7nfkctpbwuruu82jgtgmzklnv', // ethena
  'ton:eqauw01klxl8qke9cbiotfjst0d6gdagg51_c73z8x2-zjmj', // hypergpt
  'ton:eqcunexmdgwakadi-j2kpkthyqqtc7u650cgm0g78uzzxn9j', // wrapped-ton-tonco
]);

export function isMetadataBlacklisted(chain: string, tokenAddress: string): boolean {
  if (unsupportedMetadataChains.has(chain)) return true;
  if (tokenMetadataBlacklist.has(`${chain}:${tokenAddress.toLowerCase()}`)) return true;
  return false;
}

let solanaTokens: Promise<any>;
let _solanaTokens: any;
export async function cacheSolanaTokens() {
  if (_solanaTokens === undefined) {
    _solanaTokens = sdk.cache.cachedFetch(
      // "https://cdn.jsdelivr.net/gh/solana-labs/token-list@main/src/tokens/solana.tokenlist.json"
      { key: 'sol-token-list', endpoint: "https://raw.githubusercontent.com/solana-labs/token-list/refs/heads/main/src/tokens/solana.tokenlist.json" }
    ).catch((e) => {
      _solanaTokens = undefined;
      console.error("Failed to fetch Solana token list:", e);
      throw new Error(`Failed to fetch Solana token list: ${e.message}`);
    });
    solanaTokens = _solanaTokens
  }
  return solanaTokens;
}

export async function getSymbolAndDecimals(
  tokenAddress: string,
  chain: string,
  coingeckoSymbol: string,
  originalAddress?: string,
): Promise<{ symbol: string; decimals: number } | undefined> {
  if (unsupportedMetadataChains.has(chain)) return;
  if (tokenMetadataBlacklist.has(`${chain}:${tokenAddress.toLowerCase()}`)) return;

  if (chainsThatShouldNotBeLowerCased.includes(chain)) {
    let solTokens = { tokens: [] }
    if (chain == "solana") {
      solTokens = await solanaTokens;
    }
    const token = (solTokens.tokens as any[]).find(
      (t) => t.address === tokenAddress,
    );
    if (token === undefined && (chain === "solana" || chain === "eclipse")) {
      const solanaConnection = getConnection(chain);
      const decimalsQuery = await solanaConnection.getParsedAccountInfo(
        new PublicKey(tokenAddress),
      );
      const decimals = (decimalsQuery.value?.data as any)?.parsed?.info
        ?.decimals;
      if (typeof decimals !== "number") {
        // return;
        throw new Error(
          `Token ${chain}:${tokenAddress} not found in solana token list`,
        );
      }
      return {
        symbol: coingeckoSymbol.toUpperCase(),
        decimals: decimals,
      };
    }
    return {
      symbol: token.symbol,
      decimals: Number(token.decimals),
    };
  }

  let res
  switch (chain) {

    case 'sui':
      try {
        const res = await fetch(`${process.env.SUI_RPC}`, {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "suix_getCoinMetadata",
            params: [tokenAddress],
          }),
        }).then((r) => r.json());
        const { symbol, decimals } = res.result;
        return { symbol, decimals };
      } catch (e) {
        console.log(`Failed to fetch Sui token data for ${tokenAddress}`,  e?.message ?? e);
        return;
      }


    case 'starknet':
      try {
        let [symbol, decimals] = await Promise.all([
          call({
            abi: cairoErc20Abis.symbol,
            target: tokenAddress,
          }).then((r) => feltArrToStr([r])),
          call({
            abi: cairoErc20Abis.decimals,
            target: tokenAddress,
          }).then((r) => Number(r)),
        ]);
        if (!symbol?.length) symbol = '-'
        return { symbol, decimals };
      } catch (e) {
        console.log(`Failed to fetch Starknet token data for ${tokenAddress}`,  e?.message ?? e);

        return;
      }

    case 'hedera':
      try {
        const { symbol, decimals } = await fetch(
          `${process.env.HEDERA_RPC ?? "https://mainnet.mirrornode.hedera.com"
          }/api/v1/tokens/${tokenAddress}`,
        ).then((r) => r.json());
        if (symbol == null || decimals == null) {
          console.log(`Hedera token data missing symbol or decimals for ${tokenAddress}`, { symbol, decimals });
          return;
        }
        return { symbol, decimals };
      } catch (e) {
        console.log(`Failed to fetch Hedera token data for ${tokenAddress}`,  e?.message ?? e);
        return;
      }


    case 'ton':
      try {
        console.log(`Fetching TON token data for ${originalAddress}`);
        const { details: { metadata: { symbol, decimals } } } = await fetch(
          `https://jetton-index.tonscan.org/public-dyor/jettons/${originalAddress}`,
        ).then((r) => r.json());
        return { symbol, decimals };
      } catch (e) {
        console.log(`Failed to fetch TON token data for ${originalAddress}`,  e?.message ?? e);
        return;
      }


    case 'aptos':
      try {
        if (!tokenAddress.includes("::")) {
          const { data } = await fetch(`https://api.aptoscan.com/v1/fungible_assets/${tokenAddress}?cluster=mainnet`).then((r) => r.json());
          if (data?.symbol) {
            return {
              decimals: data.decimals,
              symbol: data.symbol,
            };
          }
          return;
        }
        res = await fetch(
          `${process.env.APTOS_RPC ?? 'https://fullnode.mainnet.aptoslabs.com'}/v1/accounts/${tokenAddress.substring(
            0,
            tokenAddress.indexOf("::"),
          )}/resource/0x1::coin::CoinInfo%3C${tokenAddress}%3E`,
        ).then((r) => r.json());
        if (!res.data) return;
        return {
          decimals: res.data.decimals,
          symbol: res.data.symbol,
        };
      } catch (e) {
        console.log(`Failed to fetch Aptos token data for ${tokenAddress}`,  e?.message ?? e);
        return;
      }



    case 'stacks':
      res = await fetch(
        `https://api.hiro.so/metadata/v1/ft/${tokenAddress}`,
      ).then((r) => r.json());
      if (!res.decimals) return;
      return {
        decimals: res.decimals,
        symbol: res.symbol,
      };


    case 'tron':
      try {
        const tronApi = new sdk.ChainApi({ chain: "tron" });
        return {
          symbol: await tronApi.call({ target: originalAddress!, abi: "erc20:symbol" }),
          decimals: await tronApi.call({ target: originalAddress!, abi: "erc20:decimals" }),
        };
      } catch (e) {
        console.log(`Failed to fetch Tron token data for ${originalAddress}`,  e?.message ?? e);
        return;
      }

    case 'stellar':
      if (originalAddress?.includes('-')) {
        return {
          symbol: originalAddress.split('-')[0],
          // Classic Stellar assets use 7 decimal places.
          decimals: 7,
        }
      } else { return; }

    case 'near':
      if (tokenAddress.endsWith('.factory.bridge.near')) {
        const ethApi = new sdk.ChainApi({ chain: "ethereum" });
        tokenAddress = '0x' + tokenAddress.replace('.factory.bridge.near', '');
        return {
          symbol: await ethApi.call({ target: tokenAddress, abi: "erc20:symbol" }),
          decimals: await ethApi.call({ target: tokenAddress, abi: "erc20:decimals" }),
        };
      } else { return; }
    case 'algorand':
      try {
        const { asset: { params: algoParams } } = await fetch(
          `https://mainnet-api.algonode.cloud/v2/assets/${tokenAddress}`,
        ).then((r) => r.json()) as any;
        return {
          symbol: algoParams['unit-name'] ?? algoParams.name ?? coingeckoSymbol.toUpperCase(),
          decimals: algoParams.decimals,
        };
      } catch (e) {
        console.log(`Failed to fetch Algorand token data for ${tokenAddress}`,  e?.message ?? e);
        return;
      }
  }


  if (!tokenAddress.startsWith(`0x`)) {
    return;
    // throw new Error(
    //   `Token ${chain}:${tokenAddress} is not on solana or EVM so we cant get token data yet`,
    // );
  } else {
    const evmChain = evmChainAlias[chain] ?? chain;
    try {
      return {
        symbol: (await symbol(tokenAddress, evmChain as any)).output,
        decimals: Number((await decimals(tokenAddress, evmChain as any)).output),
      };
    } catch (e) {
      console.log(`Failed to fetch EVM token data for ${chain}:${tokenAddress}`, e?.message ?? e);
      return;
      // throw new Error(
      //   `ERC20 methods aren't working for token ${chain}:${tokenAddress}`,
      // );
    }
  }
}
