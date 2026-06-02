import { createApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { BatchHistoricalResponse, isBatchHistoricalResponse } from './types';
import { batchHistoricalResponseSchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectValidNumber,
  expectValidTimestamp,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { ApiResponse } from '../../utils/config/apiClient';
import { expectCorsHeaders } from '../../utils/corsHelpers';

const apiClient = createApiClient(endpoints.COINS.BASE_URL);

describe('Coins API - Batch Historical', () => {
  const now = Math.floor(Date.now() / 1000);
  const oneDayAgo = now - 86400;
  const sevenDaysAgo = now - 86400 * 7;
  const thirtyDaysAgo = now - 86400 * 30;

  const batchRequest = {
    'coingecko:ethereum': [oneDayAgo, sevenDaysAgo, thirtyDaysAgo],
    'coingecko:bitcoin': [oneDayAgo, sevenDaysAgo],
    'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': [oneDayAgo],
  };

  describe('Basic Batch Historical Request', () => {
    let response: ApiResponse<BatchHistoricalResponse>;

    beforeAll(async () => {
      response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: {
            coins: JSON.stringify(batchRequest),
            searchWidth: '600',
          },
        }
      );
    }, 30000);

    describe('Basic Response Validation', () => {
      it('should expose CORS headers', () => {
        expectCorsHeaders(response);
      });

      it('should return successful response with valid structure', () => {
        expectSuccessfulResponse(response);
        expect(response.data).toHaveProperty('coins');
        expect(typeof response.data.coins).toBe('object');
        expect(isBatchHistoricalResponse(response.data)).toBe(true);
      });

      it('should validate against Zod schema', () => {
        const result = validate(
          response.data,
          batchHistoricalResponseSchema,
          'BatchHistorical'
        );
        expect(result.success).toBe(true);
        if (!result.success) {
          console.error('Validation errors:', result.errors.slice(0, 5));
        }
      });

      it('should return data for requested coins', () => {
        const coinKeys = Object.keys(response.data.coins);
        expect(coinKeys.length).toBeGreaterThan(0);
      });
    });

    describe('Batch Historical Data Validation', () => {
      it('should have a prices array for each coin', () => {
        Object.entries(response.data.coins).forEach(([_, data]) => {
          expect(Array.isArray(data.prices)).toBe(true);
          expect(data.prices.length).toBeGreaterThan(0);
        });
      });

      it('should have valid price values', () => {
        Object.entries(response.data.coins).forEach(([_, data]) => {
          data.prices.forEach((pt) => {
            expectValidNumber(pt.price);
            expect(pt.price).toBeGreaterThan(0);
            expect(pt.price).toBeLessThan(1e12);
          });
        });
      });

      it('should have valid timestamps', () => {
        Object.entries(response.data.coins).forEach(([_, data]) => {
          data.prices.forEach((pt) => {
            expectValidNumber(pt.timestamp);
            expectValidTimestamp(pt.timestamp);
          });
        });
      });

      it('should have valid symbols', () => {
        Object.entries(response.data.coins).forEach(([_, data]) => {
          expect(typeof data.symbol).toBe('string');
          expect(data.symbol.length).toBeGreaterThan(0);
        });
      });

      it('should have valid confidence scores when present', () => {
        Object.entries(response.data.coins).forEach(([_, data]) => {
          data.prices.forEach((pt) => {
            if (pt.confidence !== undefined) {
              expectValidNumber(pt.confidence);
              expect(pt.confidence).toBeGreaterThanOrEqual(0);
              expect(pt.confidence).toBeLessThanOrEqual(1);
            }
          });
        });
      });

      it('should return prices near requested timestamps (within searchWidth)', () => {
        const searchWidth = 600;
        Object.entries(response.data.coins).forEach(([coinId, data]) => {
          const requested = (batchRequest as Record<string, number[]>)[coinId];
          if (!requested) return;
          data.prices.forEach((pt) => {
            const nearest = requested.reduce((best, ts) =>
              Math.abs(ts - pt.timestamp) < Math.abs(best - pt.timestamp) ? ts : best
            , requested[0]);
            expect(Math.abs(pt.timestamp - nearest)).toBeLessThanOrEqual(searchWidth);
          });
        });
      });
    });
  });

  describe('Specific Batch Tests', () => {
    it('should return BTC price for one timestamp', async () => {
      const ts = Math.floor(Date.now() / 1000) - 86400 * 365;
      const response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: {
            coins: JSON.stringify({ 'coingecko:bitcoin': [ts] }),
            searchWidth: '600',
          },
        }
      );

      expect(response.status).toBe(200);
      const btc = response.data.coins['coingecko:bitcoin'];
      expect(btc).toBeDefined();
      expect(btc.prices.length).toBeGreaterThan(0);
      expect(btc.prices[0].price).toBeGreaterThan(1000);
    });

    it('should handle a mix of chain and coingecko coin keys', async () => {
      const ts = Math.floor(Date.now() / 1000) - 86400;
      const request = {
        'coingecko:ethereum': [ts],
        'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': [ts],
      };

      const response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: { coins: JSON.stringify(request), searchWidth: '600' },
        }
      );

      expect(response.status).toBe(200);
      expect(Object.keys(response.data.coins).length).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle a single coin with a single timestamp', async () => {
      const ts = Math.floor(Date.now() / 1000) - 86400;
      const response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: {
            coins: JSON.stringify({ 'coingecko:ethereum': [ts] }),
            searchWidth: '600',
          },
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.coins).toBeDefined();
    });

    it('should handle future timestamps gracefully', async () => {
      const futureTs = Math.floor(Date.now() / 1000) + 86400;
      const response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: {
            coins: JSON.stringify({ 'coingecko:bitcoin': [futureTs] }),
            searchWidth: '600',
          },
        }
      );

      expect(response.status).toBeGreaterThanOrEqual(200);
    });

    it('should handle wider searchWidth values', async () => {
      const ts = Math.floor(Date.now() / 1000) - 86400 * 30;
      const response = await apiClient.get<BatchHistoricalResponse>(
        endpoints.COINS.BATCH_HISTORICAL,
        {
          params: {
            coins: JSON.stringify({ 'coingecko:bitcoin': [ts] }),
            searchWidth: '4h',
          },
        }
      );

      expect(response.status).toBe(200);
      expect(response.data.coins).toBeDefined();
    });
  });
});
