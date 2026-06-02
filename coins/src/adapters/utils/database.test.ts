jest.mock("../../utils/shared/dynamodb", () => ({
  batchGet: jest.fn(),
  batchWrite: jest.fn(),
}));

jest.mock("./chRedisWrite", () => ({
  dualWriteToChRedis: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../../defi/src/utils/discord", () => ({
  sendMessage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@defillama/sdk", () => ({
  util: {
    sliceIntoChunks: (items: any[], size: number) => {
      const chunks = [];
      for (let i = 0; i < items.length; i += size)
        chunks.push(items.slice(i, i + size));
      return chunks;
    },
  },
  log: jest.fn(),
}));

import { staleMargin } from "../../utils/coingeckoPlatforms";
import { batchGet, batchWrite } from "../../utils/shared/dynamodb";
import { Write } from "./dbInterfaces";
import {
  batchWriteWithAlerts,
  filterWritesWithLowConfidence,
} from "./database";

const mockedBatchGet = batchGet as jest.MockedFunction<typeof batchGet>;
const mockedBatchWrite = batchWrite as jest.MockedFunction<typeof batchWrite>;

function now() {
  return Math.floor(Date.now() / 1000);
}

function write(PK: string, overrides: Partial<Write> = {}): Write {
  return {
    PK,
    SK: 0,
    price: 1,
    adapter: "test",
    confidence: 0.9,
    ...overrides,
  };
}

function read(PK: string, overrides: Record<string, any> = {}) {
  return {
    PK,
    SK: 0,
    price: 1,
    adapter: "test",
    confidence: 0.1,
    timestamp: now(),
    ...overrides,
  };
}

describe("filterWritesWithLowConfidence", () => {
  beforeEach(() => {
    mockedBatchGet.mockReset();
    mockedBatchWrite.mockReset();
    mockedBatchWrite.mockImplementation(async (items: any[]) => ({
      writeCount: items.length,
    }));
  });

  it("accepts lower-confidence writes when the stored asset price is stale", async () => {
    const assetPK = "asset#tempo:0xabc";
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, { confidence: 0.95, timestamp: now() - 3 * 60 * 60 - 1 }),
    ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { confidence: 0.4, price: 1.01 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("keeps the current higher-confidence read when the stored asset price is fresh", async () => {
    const assetPK = "asset#tempo:0xabc";
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, { confidence: 0.95, timestamp: now() }),
    ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { confidence: 0.4, price: 1.01 }),
    ]);

    expect(result).toEqual([]);
  });

  it("rewrites a high-confidence asset write onto a stale CoinGecko redirect", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.05, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(cgPK);
    expect(result[0].price).toBe(1.05);
  });

  it("drops redundant asset writes when the CoinGecko redirect is fresh", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now(),
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.01, confidence: 0.9 }),
    ]);

    expect(result).toEqual([]);
  });

  it("keeps the asset write when the CoinGecko redirect is missing", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.01, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("does not rewrite stale CoinGecko redirects when price movement is too large", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.2, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("does not rewrite stale CoinGecko redirects when the CG price is zero", async () => {
    const assetPK = "asset#tempo:0xabc";
    const cgPK = "coingecko#path-usd";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 0,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { price: 1.01, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(assetPK);
  });

  it("rewrites only the highest-confidence asset when multiple assets share one stale CoinGecko redirect", async () => {
    const tempoPK = "asset#tempo:0xaaa";
    const basePK = "asset#base:0xbbb";
    const cgPK = "coingecko#shared-token";
    mockedBatchGet
      .mockResolvedValueOnce([
        read(tempoPK, { redirect: cgPK }),
        read(basePK, { redirect: cgPK }),
      ])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "coingecko",
          timestamp: now() - staleMargin - 1,
          price: 1,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(tempoPK, { price: 1.01, confidence: 0.88 }),
      write(basePK, { price: 0.99, confidence: 0.94 }),
    ]);

    expect(result.map((w) => w.PK).sort()).toEqual([cgPK, tempoPK].sort());
    expect(result.find((w) => w.PK === cgPK)?.price).toBe(0.99);
  });

  it("drops a secondary-adapter write when a different secondary adapter holds the fresh CG slot", async () => {
    const assetPK = "asset#ethereum:0xweth";
    const cgPK = "coingecko#weth";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "weth-adapter-A",
          timestamp: now(),
          price: 2000,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { adapter: "weth-adapter-B", price: 2010, confidence: 0.9 }),
    ]);

    expect(result).toEqual([]);
  });

  it("rewrites a secondary-adapter write onto its own fresh CG slot (self-update)", async () => {
    const assetPK = "asset#ethereum:0xweth";
    const cgPK = "coingecko#weth";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "weth-adapter-A",
          timestamp: now(),
          price: 2000,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { adapter: "weth-adapter-A", price: 2010, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(cgPK);
    expect(result[0].price).toBe(2010);
  });

  it("lets any secondary adapter take a stale CG slot held by a different secondary adapter", async () => {
    const assetPK = "asset#ethereum:0xweth";
    const cgPK = "coingecko#weth";
    mockedBatchGet
      .mockResolvedValueOnce([read(assetPK, { redirect: cgPK })])
      .mockResolvedValueOnce([
        read(cgPK, {
          adapter: "weth-adapter-A",
          timestamp: now() - staleMargin - 1,
          price: 2000,
        }),
      ]);

    const result = await filterWritesWithLowConfidence([
      write(assetPK, { adapter: "weth-adapter-B", price: 2010, confidence: 0.9 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].PK).toBe(cgPK);
    expect(result[0].price).toBe(2010);
  });
});

describe("batchWriteWithAlerts", () => {
  beforeEach(() => {
    mockedBatchGet.mockReset();
    mockedBatchWrite.mockReset();
    mockedBatchWrite.mockImplementation(async (items: any[]) => ({
      writeCount: items.length,
    }));
  });

  function movementWritePair(
    PK: string,
    timestamp: number,
    price: number
  ): Write[] {
    return [
      write(PK, { SK: timestamp, price, confidence: 0.9 }),
      write(PK, {
        SK: 0,
        price,
        confidence: 0.9,
        timestamp,
        symbol: "TEST",
        decimals: 18,
      }),
    ];
  }

  it("allows large downward moves before the previous row is stale by 3h", async () => {
    const assetPK = "asset#tempo:0xabc";
    const timestamp = now();
    const items = movementWritePair(assetPK, timestamp, 0.4);
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, {
        price: 1,
        confidence: 0.9,
        timestamp: now() - 2 * 60 * 60,
      }),
    ]);

    await batchWriteWithAlerts(items, true);

    expect(mockedBatchWrite).toHaveBeenCalledWith(items, true);
  });

  it("blocks large downward moves when the previous row is stale by 3h but still inside the 6h movement window", async () => {
    const assetPK = "asset#tempo:0xabc";
    const timestamp = now();
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, {
        price: 1,
        confidence: 0.9,
        timestamp: now() - 4 * 60 * 60,
      }),
    ]);

    await batchWriteWithAlerts(
      movementWritePair(assetPK, timestamp, 0.4),
      true
    );

    expect(mockedBatchWrite).toHaveBeenCalledWith([], true);
  });

  it("allows large downward moves after a normal-confidence row has left the 6h movement window", async () => {
    const assetPK = "asset#tempo:0xabc";
    const timestamp = now();
    const items = movementWritePair(assetPK, timestamp, 0.4);
    mockedBatchGet.mockResolvedValueOnce([
      read(assetPK, {
        price: 1,
        confidence: 0.9,
        timestamp: now() - 7 * 60 * 60,
      }),
    ]);

    await batchWriteWithAlerts(items, true);

    expect(mockedBatchWrite).toHaveBeenCalledWith(items, true);
  });
});
