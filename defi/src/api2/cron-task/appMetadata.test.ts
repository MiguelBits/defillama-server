import {
  getVisibleChainMetadataEntry,
  getVisibleChainsForAppMetadata,
  removeHiddenChainMetadata,
} from "./appMetadataVisibility";

const slug = (chain: string) => chain.toLowerCase().split(" ").join("-").split("'").join("");

describe("app metadata chain visibility", () => {
  test("derives visible chains from current protocol tvl and dimensions data", () => {
    const visibleChains = getVisibleChainsForAppMetadata(
      [
        {
          category: "Dexs",
          chains: ["Ethereum"],
          chainTvls: {
            Ethereum: { tvl: 100 },
          },
        },
      ],
      {
        hyperliquid: {
          fees: {
            df: { "24h": 1 },
          },
        },
        hyperevm: {},
      }
    );

    expect(visibleChains).toEqual(["Ethereum", "Hyperliquid L1"]);
  });

  test("matches protocol tvl chain adjustments used by protocols2 visibility", () => {
    const visibleChains = getVisibleChainsForAppMetadata(
      [
        {
          category: "Dexs",
          chains: ["Ethereum", "Arbitrum"],
          chainTvls: {
            Ethereum: { tvl: 100 },
            "Ethereum-doublecounted": { tvl: 80 },
            Arbitrum: { tvl: 30 },
          },
        },
      ],
      {}
    );

    expect(visibleChains).toEqual(["Arbitrum", "Ethereum"]);
  });

  test("removes metadata-only chains that are absent from the filtered chain list", () => {
    const finalChains = {
      ethereum: { name: "Ethereum", id: "Ethereum" },
      hyperevm: {
        name: "HyperEVM",
        id: "hyper_evm",
        chainActiveUsers: true,
        chainNewUsers: true,
        dimAgg: {},
        protocolCount: 0,
      },
    };

    removeHiddenChainMetadata(finalChains, new Set(["ethereum"]));

    expect(finalChains).toEqual({
      ethereum: { name: "Ethereum", id: "Ethereum" },
    });
  });

  test("collapses legacy alias metadata to the visible canonical chain", () => {
    const finalChains = {
      "op-mainnet": { name: "OP Mainnet", id: "OP Mainnet", protocolCount: 1 },
      optimism: {
        name: "Optimism",
        id: "Optimism",
        fees: true,
        dimAgg: { fees: { df: { "24h": 1 } } },
        protocolCount: 0,
      },
    };

    removeHiddenChainMetadata(finalChains, new Set(["op-mainnet"]));

    expect(finalChains).toEqual({
      "op-mainnet": {
        name: "OP Mainnet",
        id: "OP Mainnet",
        fees: true,
        dimAgg: { fees: { df: { "24h": 1 } } },
        protocolCount: 1,
      },
    });
  });

  test("canonicalizes legacy chain labels before writing metadata", () => {
    const visibleChainSlugs = new Set(["op-mainnet", "multiversx"]);

    expect(getVisibleChainMetadataEntry("Optimism", visibleChainSlugs, slug)).toEqual({
      name: "OP Mainnet",
      slug: "op-mainnet",
    });
    expect(getVisibleChainMetadataEntry("Elrond", visibleChainSlugs, slug)).toEqual({
      name: "MultiversX",
      slug: "multiversx",
    });
    expect(getVisibleChainMetadataEntry("HyperEVM", visibleChainSlugs, slug)).toBeNull();
  });

  test("keeps visible dimension-backed chains without protocol tvl", () => {
    const finalChains = {
      "hyperliquid-l1": {
        name: "Hyperliquid L1",
        id: "hyperliquid",
        fees: true,
        dimAgg: { fees: { df: { "24h": 1 } } },
        protocolCount: 0,
      },
    };

    removeHiddenChainMetadata(finalChains, new Set(["hyperliquid-l1"]));

    expect(finalChains["hyperliquid-l1"]).toEqual({
      name: "Hyperliquid L1",
      id: "hyperliquid",
      fees: true,
      dimAgg: { fees: { df: { "24h": 1 } } },
      protocolCount: 0,
    });
  });
});
