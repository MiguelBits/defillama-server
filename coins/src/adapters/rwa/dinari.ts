import { getLogs } from "../../utils/cache/getLogs";
import { Write } from "../utils/dbInterfaces";
import { addToDBWritesList } from "../utils/database";
import { getApi } from "../utils/sdk";

// dShare price = the most recent executed order fill price from Dinari's OrderProcessor.
const _latestPriceAbi = "function latestFillPrice(address assetToken, address paymentToken) view returns (tuple(uint256 price, uint64 blocktime))"
// Dinari dropped getDShares() from the production DShareFactory implementations (it still
// exists on the staging factories), so calling it reverts on every prod chain and the old
// code silently priced nothing. Enumerate the dShares from the permanent DShareAdded event
// the factory emits on every dShare creation instead.
const _dShareAddedEvent = "event DShareAdded(address indexed dShare, address indexed wrappedDShare, string indexed symbol, string name)"

// dShares trade sporadically, so latestFillPrice can be months stale. Only price off fills no
// older than this; an asset with no recent fill on ANY chain is left unpriced rather than served
// a stale price. Raising this widens coverage at the cost of freshness.
const MAX_FILL_AGE = 14 * 24 * 60 * 60; // 14 days
const CONFIDENCE = 0.9;
// dShares are 1:1-backed and bridged across chains (LayerZero/CCIP), so the same stock is fungible
// everywhere and its per-chain price differences are purely stale-fill artifacts. We pool fills by
// underlying symbol (stripping the ".d" suffix Dinari uses on some chains), write the single freshest
// price ONCE to a canonical deployment, and redirect every other chain's copy to it — rather than
// writing the same price to N addresses.
const symbolKey = (s: string) => (s || "").replace(/\.d$/i, "").toUpperCase();
// canonical = the dShare's deployment on the first of these chains where it is live.
const CHAIN_PREFERENCE = ["ethereum", "arbitrum", "base", "plume_mainnet"];

const config: any = {
  arbitrum: {
    factory: "0xB4Ca72eA4d072C779254269FD56093D3ADf603b8",
    fromBlock: 180437944,
    processor: "0xFA922457873F750244D93679df0d810881E4131D",
    // dShares settle in different stablecoins; price off the most recent fill across these.
    quoteTokens: [
      "0xfc90518D5136585ba45e34ED5E1D108BD3950CFa", // USD+
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
    ],
  },
  ethereum: {
    factory: "0x60B5E7eEcb2AEE0382db86491b8cFfA39347c747",
    fromBlock: 19180995,
    processor: "0xA8a48C202AF4E73ad19513D37158A872A4ac79Cb",
    quoteTokens: [
      "0x98C6616F1CC0D3E938A16200830DD55663dd7DD3", // USD+
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
    ],
  },
  base: {
    factory: "0xBCE6410A175a1C9B1a25D38d7e1A900F8393BC4D",
    fromBlock: 15468029,
    processor: "0x63FF43009f9ba3584aF2Ddfc3D5FE2cb8AE539c0",
    quoteTokens: [
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC (base orders settle in USDC, not USD+)
      "0x98C6616F1CC0D3E938A16200830DD55663dd7DD3", // USD+
    ],
  },
  plume_mainnet: {
    factory: "0x7a861Ae8C708DC6171006C57c9163BD2BB57a8Aa",
    fromBlock: 741978,
    processor: "0xc1571FEbBb6F8b62eDD0E4694714A382885d6bAB",
    quoteTokens: [
      "0x78adD880A697070c1e765Ac44D65323a0DcCE913", // USDC.e (plume orders settle in USDC.e, not USD+)
      "0x1fA3671dF7300DF728858B88c7216708f22dA3Fb", // USD+
    ],
  },
  // blast: dShares exist (AAPL/NVDA/TSLA/SPY/COIN/ARKB) but the processor's only payment
  // token (USDB) has dust-only fills (~$0), so latestFillPrice yields no real USD price.
  // blast: { factory: "0x6Aa1BDa7e764BC62589E64F371A4022B80B3c72a", fromBlock: 260018, processor: "0xA8a48C202AF4E73ad19513D37158A872A4ac79Cb", quoteTokens: ["0x4300000000000000000000000000000000000003"] /* USDB */ },
};

interface DShare { chain: string; token: string; key: string; symbol: string; decimals: number; price: number; blocktime: number }

// Enumerate a chain's live dShares and find each one's most recent non-zero fill. Different
// dShares (even on the same chain) settle in different stablecoins, so we check latestFillPrice
// against each payment token and keep the newest (max blocktime) fill. latestFillPrice reverts /
// returns 0 for pairs that never traded, so those carry blocktime 0 and are filtered out later.
async function getChainDShares(chain: string, timestamp: number): Promise<DShare[]> {
  const api = await getApi(chain, timestamp);
  const { factory, fromBlock, processor, quoteTokens } = config[chain];

  // getDShares() is gone on the prod factory impls, so enumerate from the DShareAdded event.
  const logs = await getLogs({ api, target: factory, fromBlock, eventAbi: _dShareAddedEvent, onlyArgs: true });
  const allTokens: string[] = [...new Set<string>(logs.map((l: any) => l.dShare))];

  const [supplies, symbols, decimals] = await Promise.all([
    api.multiCall({ abi: 'erc20:totalSupply', calls: allTokens, permitFailure: true }),
    api.multiCall({ abi: 'erc20:symbol', calls: allTokens, permitFailure: true }),
    api.multiCall({ abi: 'erc20:decimals', calls: allTokens, permitFailure: true }),
  ]);
  // keep only live dShares
  const idxs = allTokens.map((_, i) => i).filter((i) => supplies[i] && +supplies[i] > 0);
  const tokens = idxs.map((i) => allTokens[i]);

  const best: { [token: string]: { price: number; blocktime: number } } = {};
  for (const quoteToken of quoteTokens) {
    const fills = await api.multiCall({
      abi: _latestPriceAbi,
      target: processor,
      calls: tokens.map((token: any) => ({ params: [token, quoteToken] })),
      permitFailure: true,
    });
    tokens.forEach((token: string, j: number) => {
      const fill = fills[j];
      if (!fill) return;
      const price = +fill.price / 1e18;
      const blocktime = +fill.blocktime;
      if (price > 0 && (!best[token] || blocktime > best[token].blocktime))
        best[token] = { price, blocktime };
    });
  }

  const dShares = idxs.map((i, j): DShare => ({
    chain,
    token: allTokens[i],
    // group cross-chain by underlying symbol; fall back to a per-token key if symbol() failed
    key: symbolKey(symbols[i]) || `${chain}:${allTokens[i]}`,
    symbol: symbols[i] || "",
    decimals: +decimals[i] || 18,
    price: best[tokens[j]]?.price ?? 0,
    blocktime: best[tokens[j]]?.blocktime ?? 0,
  }));
  return dShares;
}

export async function dinari(timestamp: number = 0): Promise<Write[]> {
  const refTime = timestamp || Math.floor(Date.now() / 1e3);
  const chains = Object.keys(config);
  const perChain = await Promise.all(chains.map((chain) => getChainDShares(chain, timestamp)));

  // group every live dShare across all chains by its underlying symbol
  const groups: { [key: string]: DShare[] } = {};
  for (const dShares of perChain)
    for (const d of dShares) (groups[d.key] ??= []).push(d);

  const rank = (chain: string) => {
    const i = CHAIN_PREFERENCE.indexOf(chain);
    return i < 0 ? CHAIN_PREFERENCE.length : i;
  };

  const writes: Write[] = [];
  for (const group of Object.values(groups)) {
    // freshest non-zero fill anywhere for this symbol; skip the whole symbol if stale/never traded
    const freshest = group.filter((d) => d.price > 0).sort((a, b) => b.blocktime - a.blocktime)[0];
    if (!freshest || refTime - freshest.blocktime > MAX_FILL_AGE) continue;

    // canonical deployment = preferred chain among this symbol's live copies (ethereum where it exists)
    const canonical = group.slice().sort((a, b) => rank(a.chain) - rank(b.chain) || a.token.localeCompare(b.token))[0];
    const redirectTo = `asset#${canonical.chain}:${canonical.token.toLowerCase()}`;

    // write the single freshest price to the canonical key...
    addToDBWritesList(writes, canonical.chain, canonical.token, freshest.price, canonical.decimals, canonical.symbol, timestamp, "dinari", CONFIDENCE);
    // ...and redirect every other chain's copy to it
    for (const d of group) {
      if (d.chain === canonical.chain && d.token === canonical.token) continue;
      addToDBWritesList(writes, d.chain, d.token, undefined, d.decimals, d.symbol, timestamp, "dinari", CONFIDENCE, redirectTo);
    }
  }

  return writes;
}
