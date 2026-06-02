import { createApiClient } from '../../utils/config/apiClient';
import { endpoints } from '../../utils/config/endpoints';
import { Inflows, isInflows } from './types';
import { inflowsSchema } from './schemas';
import {
  expectSuccessfulResponse,
  expectObjectResponse,
  expectValidNumber,
  expectNonNegativeNumber,
  expectNonEmptyString,
  expectValidTimestamp,
} from '../../utils/testHelpers';
import { validate } from '../../utils/validation';
import { ApiResponse } from '../../utils/config/apiClient';
import { expectCorsHeaders } from '../../utils/corsHelpers';

const apiClient = createApiClient(endpoints.TVL_PRO.BASE_URL);
const TVL_ENDPOINTS = endpoints.TVL_PRO;

describe('TVL API - Inflows', () => {
  // Configure test protocols - keep just one for speed, add more for thoroughness
  // Note: not every protocol has inflows data; uniswap-v3 is a known-good slug.
  const testProtocols = ['uniswap-v3'];
  // const testProtocols = ['uniswap-v3', 'aave-v3', 'curve-dex'];
  const testTimestamp = Math.floor(Date.now() / 1000) - 86400 * 7; // 7 days ago
  const inflowsResponses: Record<string, ApiResponse<Inflows>> = {};

  beforeAll(async () => {
    // Fetch all test protocols in parallel once
    await Promise.all(
      testProtocols.map(async (slug) => {
        inflowsResponses[slug] = await apiClient.get<Inflows>(
          TVL_ENDPOINTS.INFLOWS(slug, testTimestamp)
        );
      })
    );
  }, 60000);

  it('should expose CORS headers', () => {
    expectCorsHeaders(inflowsResponses[testProtocols[0]]);
  });

  describe('Basic Response Validation', () => {
    testProtocols.forEach((protocolSlug) => {
      describe(`Protocol: ${protocolSlug}`, () => {
        it('should return successful response or 400 for unsupported protocols', () => {
          const response = inflowsResponses[protocolSlug];
          
          // Some protocols may not have inflows data
          if (response.status === 400) {
            expect(response.status).toBe(400);
            return;
          }
          
          expectSuccessfulResponse(response);
          expectObjectResponse(response);
          expect(isInflows(response.data)).toBe(true);
        });

        it('should validate against Zod schema', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          const result = validate(response.data, inflowsSchema, `Inflows-${protocolSlug}`);
          expect(result.success).toBe(true);
          if (!result.success) {
            console.error('Validation errors:', result.errors);
          }
        });

        it('should have required fields', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          const requiredFields = ['outflows', 'oldTokens', 'currentTokens'];
          requiredFields.forEach((field) => {
            expect(response.data).toHaveProperty(field);
          });
        });

        it('should have valid outflows value', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          expectValidNumber(response.data.outflows);
          expect(response.data.outflows).toBeLessThan(10_000_000_000_000); // Max reasonable value
          expect(response.data.outflows).toBeGreaterThan(-10_000_000_000_000); // Can be negative
        });

        it('should have valid token data structures', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols

          expect(response.data.oldTokens).toHaveProperty('tvl');
          expect(response.data.currentTokens).toHaveProperty('tvl');

          expect(typeof response.data.oldTokens.tvl).toBe('object');
          expect(typeof response.data.currentTokens.tvl).toBe('object');
        });
      });
    });
  });

  describe('Token Data Validation', () => {
    testProtocols.forEach((protocolSlug) => {
      describe(`Protocol: ${protocolSlug}`, () => {
        it('should have valid date strings when present', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols

          // `date` is optional on the Pro inflows response — only assert when present
          const oldDateRaw = response.data.oldTokens.date;
          const currentDateRaw = response.data.currentTokens.date;
          if (oldDateRaw === undefined && currentDateRaw === undefined) return;

          const oldDate = parseInt(oldDateRaw ?? '');
          const currentDate = parseInt(currentDateRaw ?? '');
          expect(!isNaN(oldDate)).toBe(true);
          expect(!isNaN(currentDate)).toBe(true);
          expectValidTimestamp(oldDate);
          expectValidTimestamp(currentDate);
          expect(currentDate).toBeGreaterThanOrEqual(oldDate);
        });

        it('should have valid token amounts in oldTokens', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          Object.entries(response.data.oldTokens.tvl).forEach(([token, amount]) => {
            expectNonEmptyString(token);
            expectValidNumber(amount);
            expectNonNegativeNumber(amount);
          });
        });

        it('should have valid token amounts in currentTokens', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          Object.entries(response.data.currentTokens.tvl).forEach(([token, amount]) => {
            expectNonEmptyString(token);
            expectValidNumber(amount);
            expectNonNegativeNumber(amount);
          });
        });

        it('should have consistent token sets', () => {
          const response = inflowsResponses[protocolSlug];
          if (response.status === 400) return; // Skip for unsupported protocols
          
          const oldTokenKeys = Object.keys(response.data.oldTokens.tvl);
          const currentTokenKeys = Object.keys(response.data.currentTokens.tvl);
          const allTokens = new Set([...oldTokenKeys, ...currentTokenKeys]);

          expect(allTokens.size).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle non-existent protocol gracefully', async () => {
      const response = await apiClient.get<Inflows>(
        TVL_ENDPOINTS.INFLOWS('non-existent-protocol-xyz-123', testTimestamp)
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle invalid timestamp gracefully', async () => {
      const response = await apiClient.get<Inflows>(
        TVL_ENDPOINTS.INFLOWS('ethereum', 0)
      );

      if (response.status === 200) {
        expect(isInflows(response.data)).toBe(true);
      } else {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }, 60000);

    it('should handle future timestamp', async () => {
      const futureTimestamp = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
      const response = await apiClient.get<Inflows>(
        TVL_ENDPOINTS.INFLOWS('ethereum', futureTimestamp)
      );

      if (response.status === 200) {
        expect(isInflows(response.data)).toBe(true);
      } else {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
    }, 60000);

    it('should handle empty token sets', () => {
      // Use first test protocol
      const response = inflowsResponses[testProtocols[0]];
      if (response.status === 400) return; // Skip for unsupported protocols

      const oldTokenCount = Object.keys(response.data.oldTokens.tvl).length;
      const currentTokenCount = Object.keys(response.data.currentTokens.tvl).length;

      if (oldTokenCount === 0 || currentTokenCount === 0) {
        expect(typeof response.data.outflows).toBe('number');
      } else {
        // Most protocols should have tokens
        expect(oldTokenCount).toBeGreaterThan(0);
        expect(currentTokenCount).toBeGreaterThan(0);
      }
    });

    it('should have reasonable outflows value', () => {
      // Use first test protocol
      const response = inflowsResponses[testProtocols[0]];
      if (response.status === 400) return; // Skip for unsupported protocols

      expectValidNumber(response.data.outflows);
      expect(response.data.outflows).toBeLessThan(10_000_000_000_000);
      expect(response.data.outflows).toBeGreaterThan(-10_000_000_000_000);
    });
  });
});

