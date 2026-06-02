jest.mock('./file-cache', () => ({
  storeRouteData: jest.fn(async () => {}),
  storeRouteDataWithWriter: jest.fn(async () => {}),
  clearOldCacheVersions: jest.fn(async () => {}),
  getCacheVersion: jest.fn(() => 'test'),
  getSyncMetadata: jest.fn(async () => null),
  setSyncMetadata: jest.fn(async () => {}),
  storeHistoricalDataForId: jest.fn(async () => {}),
  readHistoricalDataForId: jest.fn(async () => null),
  mergeHistoricalData: jest.fn(() => ({})),
  storePGCacheForId: jest.fn(async () => {}),
  readPGCacheForId: jest.fn(),
  mergePGCacheData: jest.fn(() => ({})),
  getPGSyncMetadata: jest.fn(async () => null),
  setPGSyncMetadata: jest.fn(async () => {}),
  storeFlowsForId: jest.fn(async () => {}),
}));

jest.mock('./db', () => ({
  initPG: jest.fn(async () => {}),
  fetchCurrentPG: jest.fn(async () => []),
  fetchMetadataPG: jest.fn(async () => []),
  fetchAllDailyRecordsPG: jest.fn(async () => []),
  fetchMaxUpdatedAtPG: jest.fn(async () => null),
  fetchAllDailyIdsPG: jest.fn(async () => []),
  fetchDailyRecordsForIdPG: jest.fn(async () => []),
  fetchDailyRecordsWithChainsPG: jest.fn(async () => []),
  fetchDailyRecordsWithChainsForIdPG: jest.fn(async () => []),
  fetchLatestHourlyForChartTipsPG: jest.fn(async () => []),
  computeFlowSeries: jest.fn(() => []),
}));

jest.mock('./alerting', () => ({
  sendThrottledRwaAlert: jest.fn(async () => ({ status: 'sent' })),
}));

jest.mock('../protocols/parentProtocols', () => ({ parentProtocolsById: {} }));
jest.mock('../protocols/data', () => ({ protocolsById: {} }));

import { readPGCacheForId, storeRouteData, storeRouteDataWithWriter } from './file-cache';
import { generateAggregatedHistoricalCharts } from './cron';

// Asset-breakdown files are written via the streaming `storeRouteDataWithWriter`
// (chunked JSON) rather than `storeRouteData`. Reconstruct each file by re-running
// the real production writer closure and parsing the concatenated chunks, so the
// test asserts against actual prod output instead of a reimplementation.
async function collectStoredRouteData(): Promise<Map<string, any>> {
  const stored = new Map<string, any>(
    (storeRouteData as jest.Mock).mock.calls.map(([path, data]) => [path, data])
  );
  for (const [path, writeData] of (storeRouteDataWithWriter as jest.Mock).mock.calls) {
    let buffer = '';
    await writeData(async (chunk: string) => { buffer += chunk; });
    stored.set(path, JSON.parse(buffer));
  }
  return stored;
}

describe('generateAggregatedHistoricalCharts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readPGCacheForId as jest.Mock).mockImplementation(async (id: string) => ({
      1700000000: {
        onChainMcap: id === 'alpha' ? 100 : 30,
        activeMcap: id === 'alpha' ? 80 : 20,
        defiActiveTvl: id === 'alpha' ? 5 : 2,
        chains: {
          ethereum: {
            onChainMcap: id === 'alpha' ? 100 : 30,
            activeMcap: id === 'alpha' ? 80 : 20,
            defiActiveTvl: id === 'alpha' ? 5 : 2,
          },
        },
      },
    }));
  });

  it('writes category asset-breakdown data for secondary categories without creating secondary aggregate category charts', async () => {
    await generateAggregatedHistoricalCharts([
      {
        id: 'alpha',
        data: {
          canonicalMarketId: 'alpha-market',
          category: ['Treasury Bills', 'Other RWAs'],
          stablecoin: false,
          governance: false,
        },
      },
      {
        id: 'beta',
        data: {
          canonicalMarketId: 'beta-market',
          category: ['Private Credit'],
          stablecoin: false,
          governance: false,
        },
      },
    ]);

    const storedByPath = await collectStoredRouteData();

    expect(storedByPath.has('charts/category/other-rwas.json')).toBe(false);
    expect(storedByPath.has('charts/category/treasury-bills.json')).toBe(true);
    expect(storedByPath.has('charts/category/private-credit.json')).toBe(true);
    expect(storedByPath.get('charts/category-asset-breakdown/other-rwas.json')).toEqual({
      onChainMcap: [{ timestamp: 1700000000, 'alpha-market': 100 }],
      activeMcap: [{ timestamp: 1700000000, 'alpha-market': 80 }],
      defiActiveTvl: [{ timestamp: 1700000000, 'alpha-market': 5 }],
    });
  });
});
