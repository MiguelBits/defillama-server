import {
  filterRwaAssetMoveGuardInserts,
  findRwaAssetMoveTrips,
  formatRwaAssetMoveGuardMessage,
  RwaAssetMoveGuardOptions,
} from './assetMoveGuard';

const baseOptions: RwaAssetMoveGuardOptions = {
  enabled: true,
  blockWrites: true,
  minDelta: 5_000_000,
  minRatio: 0.10,
  maxContributors: 3,
  minIntervalMs: 4 * 60 * 60 * 1000,
};

describe('rwa asset move guard', () => {
  it('detects per-asset mcap moves that cross both absolute and percentage thresholds', () => {
    const trips = findRwaAssetMoveTrips(
      [{
        id: '89',
        aggregatemcap: 1_373_000_000,
        aggregatedactivemcap: 617_000_000,
        mcap: { ethereum: 994_000_000, plume_mainnet: 0, sei: 0 },
        activemcap: { ethereum: 231_000_000, plume_mainnet: 0, sei: 0 },
      }],
      {
        '89': {
          id: '89',
          aggregatemcap: 2_142_000_000,
          aggregatedactivemcap: 1_392_000_000,
          mcap: { ethereum: 994_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
          activemcap: { ethereum: 231_000_000, plume_mainnet: 505_000_000, sei: 257_000_000 },
        },
      },
      { '89': 'USDY' },
      baseOptions
    );

    expect(trips).toHaveLength(2);
    expect(trips.map((trip) => trip.metric).sort()).toEqual(['activeMcap', 'onChainMcap']);
    expect(trips[0].direction).toBe('down');
    expect(trips[0].contributors[0]).toEqual({
      chain: 'plume_mainnet',
      previous: 505_000_000,
      current: 0,
      delta: -505_000_000,
    });
  });

  it('does not trip when only one threshold is crossed or previous value is zero', () => {
    const trips = findRwaAssetMoveTrips(
      [
        {
          id: 'small-ratio',
          aggregatemcap: 106_000_000,
          aggregatedactivemcap: 100_000_000,
        },
        {
          id: 'small-delta',
          aggregatemcap: 14_000_000,
          aggregatedactivemcap: 10_000_000,
        },
        {
          id: 'new-asset',
          aggregatemcap: 20_000_000,
          aggregatedactivemcap: 20_000_000,
        },
      ],
      {
        'small-ratio': { id: 'small-ratio', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 },
        'small-delta': { id: 'small-delta', aggregatemcap: 10_000_000, aggregatedactivemcap: 10_000_000 },
        'new-asset': { id: 'new-asset', aggregatemcap: 0, aggregatedactivemcap: 0 },
      },
      {},
      baseOptions
    );

    expect(trips).toHaveLength(0);
  });

  it('blocks only the tripped asset and sends one alert per asset id', async () => {
    const sendAlert = jest.fn(async (_alertKey: string, _message: string) => {});
    const result = await filterRwaAssetMoveGuardInserts({
      inserts: [
        { id: '89', aggregatemcap: 80_000_000, aggregatedactivemcap: 80_000_000 },
        { id: '90', aggregatemcap: 11_000_000, aggregatedactivemcap: 11_000_000 },
      ],
      previousById: {
        '89': { id: '89', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 },
        '90': { id: '90', aggregatemcap: 10_000_000, aggregatedactivemcap: 10_000_000 },
      },
      labelsById: { '89': 'USDY', '90': 'TBILL' },
      options: baseOptions,
      sendAlert,
    });

    expect(result.blockedIds).toEqual(new Set(['89']));
    expect(result.allowedInserts.map((insert) => insert.id)).toEqual(['90']);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    const [[alertKey, message]] = sendAlert.mock.calls;
    expect(alertKey).toBe('assetMoveGuard:89:activeMcap:down,onChainMcap:down');
    expect(message).toContain('USDY#89');
    expect(message).toContain('WRITE BLOCKED');
  });

  it('can alert without blocking writes', async () => {
    const result = await filterRwaAssetMoveGuardInserts({
      inserts: [{ id: '89', aggregatemcap: 80_000_000, aggregatedactivemcap: 80_000_000 }],
      previousById: { '89': { id: '89', aggregatemcap: 100_000_000, aggregatedactivemcap: 100_000_000 } },
      options: { ...baseOptions, blockWrites: false },
      sendAlert: jest.fn(async (_alertKey: string, _message: string) => {}),
    });

    expect(result.blockedIds.size).toBe(0);
    expect(result.allowedInserts.map((insert) => insert.id)).toEqual(['89']);
  });

  it('formats a concise message with thresholds and contributors', () => {
    const message = formatRwaAssetMoveGuardMessage('89', [{
      id: '89',
      label: 'USDY',
      metric: 'onChainMcap',
      previous: 2_142_000_000,
      current: 1_373_000_000,
      delta: -769_000_000,
      ratio: -0.359,
      direction: 'down',
      contributors: [{ chain: 'sei', previous: 257_000_000, current: 0, delta: -257_000_000 }],
    }], baseOptions);

    expect(message).toContain('USDY#89');
    expect(message).toContain('WRITE BLOCKED');
    expect(message).toContain('sei');
    expect(message).toContain('-35.9%');
  });
});
