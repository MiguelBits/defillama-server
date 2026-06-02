import { ApiResponse } from './config/apiClient';

const ALLOWED_ORIGINS = new Set(['*', 'https://defillama.com']);

/**
 * Assert that CORS headers are present on a response we already fetched.
 * Reuses the existing response so we don't make an extra HTTP call.
 *
 * Usage in a test file that already has `response` from beforeAll:
 *   it('should expose CORS headers', () => expectCorsHeaders(response));
 */
export function expectCorsHeaders<T>(response: ApiResponse<T>): void {
  const headers = response.headers ?? {};
  const acao = headers['access-control-allow-origin'] ?? headers['Access-Control-Allow-Origin'];
  expect(acao).toBeDefined();
  expect(ALLOWED_ORIGINS.has(acao as string)).toBe(true);
}
