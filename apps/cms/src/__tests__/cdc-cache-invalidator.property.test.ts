import { describe, it, expect } from 'vitest';
import * as cdc from '../modules/cdc';

/**
 * CDC CacheInvalidator was removed per ADR-012 (high-load-cache-readiness task 19).
 * Content cache invalidation is handled at the API write path via tag purge (Req 8).
 */
describe('CDC CacheInvalidator removal (ADR-012)', () => {
  it('does not export cacheInvalidator from the CDC barrel', () => {
    expect('cacheInvalidator' in cdc).toBe(false);
  });
});
