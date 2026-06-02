import { createApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { ChartArray, isChartArray } from './types';
import { chartArraySchema } from './schemas';
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

const apiClient = createApiClient(endpoints.FEES_V2.BASE_URL);
const FEES_V2_ENDPOINTS = endpoints.FEES_V2;

describe('Fees V2 API - Chart', () => {
  const testProtocols = ['aave-v3'];
  const responses: Record<string, ApiResponse<ChartArray>> = {};

  beforeAll(async () => {
    await Promise.all(
      testProtocols.map(async (slug) => {
        responses[slug] = await apiClient.get<ChartArray>(
          FEES_V2_ENDPOINTS.CHARTS(slug)
        );
      })
    );
  }, 60000);

  it('should expose CORS headers', () => {
    expectCorsHeaders(responses[testProtocols[0]]);
  });

  describe('Basic Response Validation', () => {
    testProtocols.forEach((protocolSlug) => {
      describe(`Protocol: ${protocolSlug}`, () => {
        it('should return successful response', () => {
          const response = responses[protocolSlug];
          expectSuccessfulResponse(response);
        });

        it('should return an array', () => {
          const response = responses[protocolSlug];
          expectArrayResponse(response);
          expect(isChartArray(response.data)).toBe(true);
        });

        it('should validate against Zod schema', () => {
          const response = responses[protocolSlug];
          const result = validate(response.data, chartArraySchema, `Chart-${protocolSlug}`);
          expect(result.success).toBe(true);
          if (!result.success) {
            console.error('Validation errors:', result.errors);
          }
        });
      });
    });
  });

  describe('Data Validation', () => {
    testProtocols.forEach((protocolSlug) => {
      describe(`Protocol: ${protocolSlug}`, () => {
        it('should have non-empty data', () => {
          const data = responses[protocolSlug].data;
          expectNonEmptyArray(data);
          expect(data.length).toBeGreaterThan(100);
        });

        it('should have [timestamp, feeValue] tuples', () => {
          const data = responses[protocolSlug].data;
          const sample = data.slice(0, 10);
          sample.forEach(([timestamp, feeValue]) => {
            expectValidNumber(timestamp);
            expectValidNumber(feeValue);
          });
        });

        it('should have valid timestamps', () => {
          const data = responses[protocolSlug].data;
          const sample = data.slice(0, 10);
          sample.forEach(([timestamp]) => {
            expectValidTimestamp(timestamp);
          });
        });

        it('should have non-negative fee values', () => {
          const data = responses[protocolSlug].data;
          const sample = data.slice(0, 10);
          sample.forEach(([, feeValue]) => {
            expectNonNegativeNumber(feeValue);
          });
        });

        it('should be in chronological order', () => {
          const data = responses[protocolSlug].data;
          for (let i = 1; i < data.length; i++) {
            expect(data[i][0]).toBeGreaterThanOrEqual(data[i - 1][0]);
          }
        });

        it('should have a fresh latest datapoint (within 2 days)', () => {
          const data = responses[protocolSlug].data;
          if (data.length === 0) return;
          // Fee charts can lag a day on weekends; 2-day budget is the de-facto floor.
          expectFreshData(data.map(([ts]) => ts), 86400 * 2);
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle non-existent protocol gracefully', async () => {
      const response = await apiClient.get<ChartArray>(
        FEES_V2_ENDPOINTS.CHARTS('non-existent-protocol-xyz-123')
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });
});
