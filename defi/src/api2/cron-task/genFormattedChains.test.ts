jest.mock("../cache/file-cache", () => ({
  readRouteData: jest.fn(),
  storeRouteData: jest.fn(),
}));

jest.mock("node-fetch", () => ({
  __esModule: true,
  default: jest.fn(() =>
    Promise.resolve({
      json: async () => ({}),
    })
  ),
}));

jest.mock("../../utils/coinsApi", () => ({
  fetchMcaps: jest.fn(async () => ({})),
}));

import { readRouteData, storeRouteData } from "../cache/file-cache";
import { genFormattedChains } from "./genFormattedChains";

const mockedReadRouteData = readRouteData as jest.MockedFunction<typeof readRouteData>;
const mockedStoreRouteData = storeRouteData as jest.MockedFunction<typeof storeRouteData>;

describe("genFormattedChains", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadRouteData.mockImplementation(async (route: string) => {
      if (route === "/lite/protocols2") {
        return {
          chains: ["Ethereum", "Hyperliquid L1"],
          protocols: [
            {
              chains: ["Ethereum"],
              chainTvls: {
                Ethereum: {
                  tvl: 100,
                  tvlPrevDay: 90,
                  tvlPrevWeek: 80,
                  tvlPrevMonth: 70,
                },
              },
            },
          ],
        } as any;
      }

      if (route === "/lite/charts/Ethereum") {
        const now = Math.floor(Date.now() / 1e3);
        const day = 24 * 60 * 60;
        return {
          tvl: [
            [now - 30 * day, 70],
            [now - 7 * day, 80],
            [now - day, 90],
            [now, 110],
          ],
          borrowed: [
            [now - 30 * day, 10],
            [now - 7 * day, 15],
            [now - day, 25],
            [now, 30],
          ],
          staking: [
            [now - 30 * day, 2],
            [now - 7 * day, 4],
            [now - day, 5],
            [now, 7],
          ],
        };
      }

      if (route === "/lite/charts/Hyperliquid L1") {
        return null;
      }

      return null;
    });
  });

  test("inherits filtered chains from /lite/protocols2 and keeps dimensions-only chains in chains2 output", async () => {
    await genFormattedChains();

    const allCall = mockedStoreRouteData.mock.calls.find(([route]) => route === "/chains2/All");
    const evmCall = mockedStoreRouteData.mock.calls.find(([route]) => route === "/chains2/EVM");

    expect(allCall).toBeDefined();
    expect(evmCall).toBeDefined();

    const allData = allCall?.[1] as any;
    const evmData = evmCall?.[1] as any;

    expect(allData.chainsUnique).toEqual(["Ethereum", "Hyperliquid L1"]);
    expect(allData.chainsUnique).not.toContain("HyperEVM");
    expect(allData.chainTvls.map((chain: any) => chain.name)).toContain("Hyperliquid L1");

    expect(evmData.chainsUnique).toContain("Hyperliquid L1");
    expect(evmData.chainsUnique).not.toContain("HyperEVM");
  });

  test("writes table-only chains2 files with current extra tvls and without chart history", async () => {
    await genFormattedChains();

    const tableCall = mockedStoreRouteData.mock.calls.find(([route]) => route === "/chains2/All/table");
    expect(tableCall).toBeDefined();

    const tableData = tableCall?.[1] as any;
    const ethereum = tableData.chainTvls.find((chain: any) => chain.name === "Ethereum");

    expect(tableData.stackedDataset).toBeUndefined();
    expect(tableData.tvlTypes).toBeUndefined();
    expect(tableData.chainsUnique).toEqual(["Ethereum", "Hyperliquid L1"]);
    expect(tableData.chainsGroupbyParent).toBeDefined();
    expect(ethereum.extraTvl).toEqual({
      borrowed: {
        tvl: 30,
        tvlPrevDay: 25,
        tvlPrevWeek: 15,
        tvlPrevMonth: 10,
      },
      staking: {
        tvl: 7,
        tvlPrevDay: 5,
        tvlPrevWeek: 4,
        tvlPrevMonth: 2,
      },
    });
  });
});
