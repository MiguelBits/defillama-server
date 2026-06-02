import { createApiClient, ApiResponse } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { StablecoinAsset } from './types';
import { expectSuccessfulResponse } from '../../utils/testHelpers';

const apiClient = createApiClient(endpoints.STABLECOINS.BASE_URL);

const ONE_DAY = 86400;
const FRESH_BUDGET_SEC = ONE_DAY;
const GAP_TOLERANCE_SEC = ONE_DAY + 3600; // allow 1h jitter on a daily snapshot
const MAX_DAILY_DIFF_PCT = 10;
const RECENT_WINDOW = 7; // check last 7 daily points

type DailyTotal = { date: number; total: number };

function aggregateDailyTotals(asset: StablecoinAsset): DailyTotal[] {
  const sums = new Map<number, number>();
  const chainBalances = (asset.chainBalances ?? {}) as Record<string, any>;

  Object.values(chainBalances).forEach((chain: any) => {
    const tokens = chain?.tokens;
    if (!Array.isArray(tokens)) return;
    tokens.forEach((point: any) => {
      const date = Number(point?.date);
      const circ = point?.circulating?.peggedUSD;
      if (!Number.isFinite(date) || !Number.isFinite(circ)) return;
      sums.set(date, (sums.get(date) ?? 0) + Number(circ));
    });
  });

  return [...sums.entries()]
    .map(([date, total]) => ({ date, total }))
    .sort((a, b) => b.date - a.date);
}

const majorAssets: Array<{ id: string; symbol: string; name: string }> = [
  { id: '1', symbol: 'USDT', name: 'Tether' },
  { id: '2', symbol: 'USDC', name: 'USD Coin' },
];

describe('Stablecoins API - Major Assets Sanity (USDT, USDC)', () => {
  const responses: Record<string, ApiResponse<StablecoinAsset>> = {};
  const dailies: Record<string, DailyTotal[]> = {};

  beforeAll(async () => {
    await Promise.all(
      majorAssets.map(async ({ id }) => {
        const endpoint = endpoints.STABLECOINS.ASSET(id);
        if (!endpoint) return;
        responses[id] = await apiClient.get<StablecoinAsset>(endpoint);
        dailies[id] = aggregateDailyTotals(responses[id].data);
      })
    );
  }, 60000);

  majorAssets.forEach(({ id, symbol, name }) => {
    describe(`${symbol} (${name}, id:${id})`, () => {
      it('should return a successful response', () => {
        expectSuccessfulResponse(responses[id]);
        expect(responses[id].data.id).toBe(id);
        expect(responses[id].data.symbol).toBe(symbol);
      });

      it('should have aggregated daily totals', () => {
        const series = dailies[id];
        expect(series.length).toBeGreaterThan(RECENT_WINDOW);
        series.slice(0, RECENT_WINDOW).forEach((p) => {
          expect(p.total).toBeGreaterThan(0);
        });
      });

      it(`should have a recent datapoint within ${FRESH_BUDGET_SEC / 3600}h`, () => {
        const latest = dailies[id][0];
        const ageSec = Math.floor(Date.now() / 1000) - latest.date;
        if (ageSec > FRESH_BUDGET_SEC) {
          console.error(
            `[${symbol}] latest datapoint ${new Date(latest.date * 1000).toISOString()} is ${Math.round(ageSec / 3600)}h old`
          );
        }
        expect(ageSec).toBeLessThanOrEqual(FRESH_BUDGET_SEC);
      });

      it('should not have missing daily datapoints in the recent window', () => {
        const recent = dailies[id].slice(0, RECENT_WINDOW);
        const gaps: Array<{ from: number; to: number; gapSec: number }> = [];
        for (let i = 0; i < recent.length - 1; i++) {
          const newer = recent[i].date;
          const older = recent[i + 1].date;
          const gapSec = newer - older;
          if (gapSec > GAP_TOLERANCE_SEC) {
            gaps.push({ from: older, to: newer, gapSec });
          }
        }
        if (gaps.length > 0) {
          console.error(
            `[${symbol}] missing daily datapoints:`,
            gaps.map((g) => ({
              between: `${new Date(g.from * 1000).toISOString()} → ${new Date(g.to * 1000).toISOString()}`,
              gapHours: Math.round(g.gapSec / 3600),
            }))
          );
        }
        expect(gaps).toEqual([]);
      });

      it(`should not change total circulating by more than ${MAX_DAILY_DIFF_PCT}% day-over-day`, () => {
        const recent = dailies[id].slice(0, RECENT_WINDOW);
        const swings: Array<{ from: number; to: number; pct: number }> = [];
        for (let i = 0; i < recent.length - 1; i++) {
          const newer = recent[i];
          const older = recent[i + 1];
          if (older.total === 0) continue;
          const pct = ((newer.total - older.total) / older.total) * 100;
          if (Math.abs(pct) > MAX_DAILY_DIFF_PCT) {
            swings.push({ from: older.date, to: newer.date, pct });
          }
        }
        if (swings.length > 0) {
          console.error(
            `[${symbol}] day-over-day swings >${MAX_DAILY_DIFF_PCT}%:`,
            swings.map((s) => ({
              between: `${new Date(s.from * 1000).toISOString()} → ${new Date(s.to * 1000).toISOString()}`,
              pctChange: s.pct.toFixed(2) + '%',
            }))
          );
        }
        expect(swings).toEqual([]);
      });
    });
  });
});
