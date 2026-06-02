jest.mock('@defillama/sdk', () => ({
  util: {
    runInPromisePool: async ({ items, processor }: { items: any[]; processor: (item: any) => Promise<void> }) => {
      for (const item of items) await processor(item);
    },
  },
}));

jest.mock('./db', () => ({
  initPG: jest.fn(async () => {}),
  storeHistoricalPG: jest.fn(async () => {}),
  storeMetadataPG: jest.fn(async () => {}),
  fetchLatestRwaRowsForIds: jest.fn(async () => ({})),
}));

jest.mock('./alerting', () => ({
  sendThrottledRwaAlert: jest.fn(async () => ({ status: 'sent' })),
}));

import { storeHistorical } from './historical';
import { fetchLatestRwaRowsForIds, storeHistoricalPG } from './db';
import { sendThrottledRwaAlert } from './alerting';

function makeStorePayload() {
  return {
    timestamp: 1_777_000_000,
    data: {
      '89': {
        ticker: 'USDY',
        governance: false,
        defiActiveTvl: {},
        onChainMcap: { Ethereum: '994000000', 'Plume Mainnet': '0', Sei: '0' },
        activeMcap: { Ethereum: '231000000', 'Plume Mainnet': '0', Sei: '0' },
      },
      '90': {
        ticker: 'TBILL',
        governance: false,
        defiActiveTvl: {},
        onChainMcap: { Ethereum: '10000000' },
        activeMcap: { Ethereum: '10000000' },
      },
    },
  };
}

describe('rwa historical store guard integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (fetchLatestRwaRowsForIds as jest.Mock).mockResolvedValue({});
    (storeHistoricalPG as jest.Mock).mockResolvedValue(undefined);
    (sendThrottledRwaAlert as jest.Mock).mockResolvedValue({ status: 'sent' });
    delete process.env.RWA_ASSET_MOVE_GUARD_ENABLED;
    delete process.env.RWA_ASSET_MOVE_GUARD_BLOCK_WRITES;
    delete process.env.RWA_ASSET_MOVE_GUARD_MIN_DELTA;
    delete process.env.RWA_ASSET_MOVE_GUARD_MIN_RATIO;
    delete process.env.RWA_ASSET_MOVE_GUARD_MAX_CONTRIBUTORS;
    delete process.env.RWA_ASSET_MOVE_GUARD_MIN_INTERVAL_HOURS;
    delete process.env.RWA_ALERT_MIN_INTERVAL_HOURS;
  });

  it('blocks only the suspicious asset before writing to PG', async () => {
    (fetchLatestRwaRowsForIds as jest.Mock).mockResolvedValue({
      '89': {
        id: '89',
        aggregatemcap: 2_142_000_000,
        aggregatedactivemcap: 1_392_000_000,
        mcap: { ethereum: 994_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
        activemcap: { ethereum: 231_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
      },
      '90': {
        id: '90',
        aggregatemcap: 9_500_000,
        aggregatedactivemcap: 9_500_000,
        mcap: { ethereum: 9_500_000 },
        activemcap: { ethereum: 9_500_000 },
      },
    });

    await storeHistorical(makeStorePayload() as any);

    expect(storeHistoricalPG).toHaveBeenCalledTimes(1);
    const [inserts] = (storeHistoricalPG as jest.Mock).mock.calls[0];
    expect(inserts.map((insert: any) => insert.id)).toEqual(['90']);
    expect(sendThrottledRwaAlert).toHaveBeenCalledTimes(1);
    expect((sendThrottledRwaAlert as jest.Mock).mock.calls[0][0].alertKey).toBe(
      'assetMoveGuard:89:activeMcap:down,onChainMcap:down'
    );
  });

  it('skips the asset guard for manual refill paths', async () => {
    await storeHistorical(makeStorePayload() as any, { skipAssetMoveGuard: true });

    expect(fetchLatestRwaRowsForIds).not.toHaveBeenCalled();
    expect(sendThrottledRwaAlert).not.toHaveBeenCalled();
    const [inserts] = (storeHistoricalPG as jest.Mock).mock.calls[0];
    expect(inserts.map((insert: any) => insert.id).sort()).toEqual(['89', '90']);
  });

  it('skips historical writes and alerts when the asset guard fails', async () => {
    (fetchLatestRwaRowsForIds as jest.Mock).mockRejectedValueOnce(new Error('db unavailable'));

    await storeHistorical(makeStorePayload() as any);

    expect(storeHistoricalPG).not.toHaveBeenCalled();
    expect(sendThrottledRwaAlert).toHaveBeenCalledTimes(1);
    expect((sendThrottledRwaAlert as jest.Mock).mock.calls[0][0].alertKey).toBe(
      'assetMoveGuardEvaluationFailure'
    );
    expect((sendThrottledRwaAlert as jest.Mock).mock.calls[0][0].message).toContain(
      'historical DB writes skipped'
    );
  });
});
