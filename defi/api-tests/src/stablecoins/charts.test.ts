import { createApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { StablecoinCharts, StablecoinChartPoint, isStablecoinCharts } from './types';

const apiClient = createApiClient(endpoints.STABLECOINS.BASE_URL);
import { stablecoinChartsArraySchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectArrayResponse,
  expectNonEmptyArray,
  expectValidNumber,
  expectNonNegativeNumber,
  expectValidTimestamp,
  expectFreshData,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { ApiResponse } from '../../utils/config/apiClient';
import { expectCorsHeaders } from '../../utils/corsHelpers';

function sumPegged(obj: Record<string, number> | undefined | null): number {
  if (!obj) return 0;
  return Object.values(obj).reduce((s, v) => s + (Number.isFinite(v) ? Number(v) : 0), 0);
}

describe('Stablecoins API - Charts (All Chains)', () => {
  let chartsAllResponse: ApiResponse<StablecoinCharts>;

  beforeAll(async () => {
    const endpoint = endpoints.STABLECOINS.CHARTS_ALL;
    // Skip if endpoint is not available (free-only API not configured)
    if (endpoint && endpoint !== '') {
      chartsAllResponse = await apiClient.get<StablecoinCharts>(endpoint);
    }
  });

  describe('Basic Response Validation', () => {
    it('should expose CORS headers', () => {
      expectCorsHeaders(chartsAllResponse);
    });

    it('should return successful response with valid structure', () => {
      expectSuccessfulResponse(chartsAllResponse);
      expectArrayResponse(chartsAllResponse);
      expectNonEmptyArray(chartsAllResponse.data);
      expect(isStablecoinCharts(chartsAllResponse.data)).toBe(true);
    });

    it('should validate against Zod schema', () => {
      const result = validate(chartsAllResponse.data, stablecoinChartsArraySchema, 'StablecoinCharts-All');
      expect(result.success).toBe(true);
      if (!result.success) {
        console.error('Validation errors (first 5):', result.errors.slice(0, 5));
      }
    });

    it('should have valid data points structure', () => {
      // Sample-based testing - validate first 10 data points
      chartsAllResponse.data.slice(0, 10).forEach((point) => {
        // Date is a string timestamp from API, should be convertible to number
        const dateNum = typeof point.date === 'string' ? Number(point.date) : point.date;
        expect(typeof dateNum).toBe('number');
        expect(isNaN(dateNum)).toBe(false);
        expectValidTimestamp(dateNum);
        
        // totalCirculating is an object with pegType keys
        expect(typeof point.totalCirculating).toBe('object');
        expect(point.totalCirculating).not.toBeNull();
        Object.values(point.totalCirculating).forEach((value) => {
          expectValidNumber(value);
          expectNonNegativeNumber(value);
        });
      });
    });

    it('should have data points in chronological order', () => {
      if (chartsAllResponse.data.length > 1) {
        const dates = chartsAllResponse.data.map((p) => p.date);
        const sortedDates = [...dates].sort((a, b) => a - b);
        expect(dates).toEqual(sortedDates);
      }
    });

    it('should have valid circulating breakdown when present', () => {
      const withBreakdown = chartsAllResponse.data.filter(
        (p) => p.circulating && Object.keys(p.circulating).length > 0
      );
      
      if (withBreakdown.length > 0) {
        // Sample-based testing - validate first 5 data points with breakdown
        withBreakdown.slice(0, 5).forEach((point) => {
          Object.entries(point.circulating!).forEach(([chain, amount]) => {
            expect(typeof chain).toBe('string');
            expect(chain.length).toBeGreaterThan(0);
            expectValidNumber(amount);
            expectNonNegativeNumber(amount);
          });
        });
      }
    });

    it('should have fresh data (most recent timestamp within 1 day)', () => {
      if (chartsAllResponse.data.length === 0) return; // Skip if empty

      const timestamps = chartsAllResponse.data.map((point) => point.date);
      expectFreshData(timestamps);
    });
  });

  // Per peggedassets-server api2/routes: /stablecoincharts/:chain accepts
  // `stablecoin` (filter) and `starts`/`startts` (start timestamp, only when stablecoin set).
  // `:chain` can be "all", so /stablecoincharts/all goes through the same handler.
  describe('Query Param Behavior', () => {
    it('should return a smaller total when filtered by stablecoin id (USDT)', async () => {
      const usdt = await apiClient.get<StablecoinCharts>(
        `${endpoints.STABLECOINS.CHARTS_ALL}?stablecoin=1`
      );
      expectSuccessfulResponse(usdt);
      const allTotal = sumPegged(chartsAllResponse.data[chartsAllResponse.data.length - 1]?.totalCirculating);
      const usdtTotal = sumPegged(usdt.data[usdt.data.length - 1]?.totalCirculating);
      expect(usdtTotal).toBeGreaterThan(0);
      expect(usdtTotal).toBeLessThan(allTotal);
      expect(usdtTotal / allTotal).toBeGreaterThan(0.1);
      expect(usdtTotal / allTotal).toBeLessThan(0.95);
    });

    it('should only populate peggedUSD when filtered to a USD asset (USDC)', async () => {
      const usdc = await apiClient.get<StablecoinCharts>(
        `${endpoints.STABLECOINS.CHARTS_ALL}?stablecoin=2`
      );
      expectSuccessfulResponse(usdc);
      const latest = usdc.data[usdc.data.length - 1]?.totalCirculating ?? {};
      expect(Object.keys(latest)).toContain('peggedUSD');
      Object.entries(latest)
        .filter(([k]) => k !== 'peggedUSD')
        .forEach(([, v]) => expect(Number(v) || 0).toBe(0));
    });

    it('should yield different totals for USDT vs USDC', async () => {
      const [usdt, usdc] = await Promise.all([
        apiClient.get<StablecoinCharts>(`${endpoints.STABLECOINS.CHARTS_ALL}?stablecoin=1`),
        apiClient.get<StablecoinCharts>(`${endpoints.STABLECOINS.CHARTS_ALL}?stablecoin=2`),
      ]);
      const usdtTotal = sumPegged(usdt.data[usdt.data.length - 1]?.totalCirculating);
      const usdcTotal = sumPegged(usdc.data[usdc.data.length - 1]?.totalCirculating);
      expect(usdtTotal).toBeGreaterThan(0);
      expect(usdcTotal).toBeGreaterThan(0);
      expect(usdtTotal).not.toBe(usdcTotal);
    });

    it('should NOT silently fall through to unfiltered data on an unknown stablecoin id', async () => {
      const invalid = await apiClient.get<StablecoinCharts>(
        `${endpoints.STABLECOINS.CHARTS_ALL}?stablecoin=99999999`
      );
      const unfilteredTotal = sumPegged(chartsAllResponse.data[chartsAllResponse.data.length - 1]?.totalCirculating);
      const invalidTotal = sumPegged((invalid.data ?? [])[((invalid.data ?? []).length) - 1]?.totalCirculating);
      expect(invalidTotal).not.toBe(unfilteredTotal);
    });
  });
});

describe('Stablecoins API - Charts (Specific Chain)', () => {
  // Configure test chains - keep just one for speed, add more for thoroughness
  const testChains = ['ethereum'];
  // const testChains = ['ethereum', 'bsc', 'polygon'];
  const chainChartsResponses: Record<string, ApiResponse<StablecoinCharts>> = {};

  beforeAll(async () => {
    // Fetch all test chains in parallel once
    await Promise.all(
      testChains.map(async (chain) => {
        const endpoint = endpoints.STABLECOINS.CHARTS_BY_CHAIN(chain);
        // Skip if endpoint is not available (free-only API not configured)
        if (endpoint && endpoint !== '') {
          chainChartsResponses[chain] = await apiClient.get<StablecoinCharts>(endpoint);
        }
      })
    );
  }, 60000);

  it('should expose CORS headers', () => {
    expectCorsHeaders(chainChartsResponses[testChains[0]]);
  });

  describe('Basic Response Validation', () => {
    testChains.forEach((chain) => {
      describe(`Chain: ${chain}`, () => {
        it('should return successful response with valid structure', () => {
          const response = chainChartsResponses[chain];
          expectSuccessfulResponse(response);
          expectArrayResponse(response);
          expect(isStablecoinCharts(response.data)).toBe(true);
        });

        it('should validate against Zod schema', () => {
          const response = chainChartsResponses[chain];
          const result = validate(response.data, stablecoinChartsArraySchema, `StablecoinCharts-${chain}`);
          expect(result.success).toBe(true);
          if (!result.success) {
            console.error('Validation errors (first 5):', result.errors.slice(0, 5));
          }
        });

        it('should have valid data points structure', () => {
          const response = chainChartsResponses[chain];
          if (response.data.length > 0) {
            // Sample-based testing - validate first 10 data points
            response.data.slice(0, 10).forEach((point) => {
              // Date is a string timestamp from API, should be convertible to number
              const dateNum = typeof point.date === 'string' ? Number(point.date) : point.date;
              expect(typeof dateNum).toBe('number');
              expect(isNaN(dateNum)).toBe(false);
              expectValidTimestamp(dateNum);
              
              // totalCirculating is an object with pegType keys
              expect(typeof point.totalCirculating).toBe('object');
              expect(point.totalCirculating).not.toBeNull();
              Object.values(point.totalCirculating).forEach((value) => {
                expectValidNumber(value);
                expectNonNegativeNumber(value);
              });
            });
          }
        });

        it('should have data points in chronological order', () => {
          const response = chainChartsResponses[chain];
          if (response.data.length > 1) {
            const dates = response.data.map((p) => p.date);
            const sortedDates = [...dates].sort((a, b) => a - b);
            expect(dates).toEqual(sortedDates);
          }
        });

        it('should have fresh data (most recent timestamp within 1 day)', () => {
          const response = chainChartsResponses[chain];
          if (response.data.length === 0) return; // Skip if empty

          const timestamps = response.data.map((point) => point.date);
          expectFreshData(timestamps);
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle non-existent chain gracefully', async () => {
      const endpoint = endpoints.STABLECOINS.CHARTS_BY_CHAIN('non-existent-chain-xyz-123');

      const response = await apiClient.get<StablecoinCharts>(endpoint);

      // API might return 200 with empty array, error object, or 4xx status
      if (response.status === 200) {
        // Accept either an array (empty or with data) or an error object/string
        const isValidResponse = Array.isArray(response.data) || 
                               typeof response.data === 'object' ||
                               typeof response.data === 'string';
        expect(isValidResponse).toBe(true);
      } else {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('should handle empty array for new chains', () => {
      const response = chainChartsResponses[testChains[0]];

      if (response.data.length === 0) {
        expect(Array.isArray(response.data)).toBe(true);
      }
    });
  });

  describe('Query Param Behavior', () => {
    const chain = testChains[0];

    it(`should filter by stablecoin id on ${chain} (USDT)`, async () => {
      const unfiltered = chainChartsResponses[chain];
      const usdt = await apiClient.get<StablecoinCharts>(
        `${endpoints.STABLECOINS.CHARTS_BY_CHAIN(chain)}?stablecoin=1`
      );
      expectSuccessfulResponse(usdt);
      const unfilteredTotal = sumPegged(unfiltered.data[unfiltered.data.length - 1]?.totalCirculating);
      const usdtTotal = sumPegged((usdt.data ?? [])[(usdt.data ?? []).length - 1]?.totalCirculating);
      expect(usdtTotal).toBeGreaterThan(0);
      expect(usdtTotal).toBeLessThan(unfilteredTotal);
    });

    it('should respect the `starts` param (filters out earlier timestamps)', async () => {
      const startTs = Math.floor(Date.now() / 1000) - 30 * 86400; // last 30 days
      const filtered = await apiClient.get<any[]>(
        `${endpoints.STABLECOINS.CHARTS_BY_CHAIN(chain)}?stablecoin=1&starts=${startTs}`
      );
      expectSuccessfulResponse(filtered);
      expect(Array.isArray(filtered.data)).toBe(true);
      if (filtered.data.length > 0) {
        filtered.data.forEach((point: any) => {
          const ts = Number(point.timestamp ?? point.date);
          expect(ts).toBeGreaterThanOrEqual(startTs);
        });
      }
    });

    it('should accept `startts` as an alias for `starts`', async () => {
      const startTs = Math.floor(Date.now() / 1000) - 30 * 86400;
      const [a, b] = await Promise.all([
        apiClient.get<any[]>(`${endpoints.STABLECOINS.CHARTS_BY_CHAIN(chain)}?stablecoin=1&starts=${startTs}`),
        apiClient.get<any[]>(`${endpoints.STABLECOINS.CHARTS_BY_CHAIN(chain)}?stablecoin=1&startts=${startTs}`),
      ]);
      expectSuccessfulResponse(a);
      expectSuccessfulResponse(b);
      expect(a.data.length).toBe(b.data.length);
    });
  });
});
