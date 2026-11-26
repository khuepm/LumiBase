import { describe, expect, it } from 'vitest';
import { hasRetrievalGrant, type RetrievalGrant } from './ai-provider';

const scope = { siteId: 'site-a', dataClass: 'internal' } as const;
const index = { ...scope, action: 'index' } as const;
const transfer = { ...scope, action: 'transfer', destinationId: 'meili-a' } as const;

describe('retrieval grants', () => {
  it('requires independent grants for indexing and external transfer', () => {
    expect(hasRetrievalGrant([], transfer)).toBe(false);
    expect(hasRetrievalGrant([], index)).toBe(false);
    expect(hasRetrievalGrant([index], transfer)).toBe(false);
    expect(hasRetrievalGrant([transfer], index)).toBe(false);
    expect(hasRetrievalGrant([index, transfer], index)).toBe(true);
    expect(hasRetrievalGrant([index, transfer], transfer)).toBe(true);
  });

  it('matches every scope dimension', () => {
    const otherScopes: RetrievalGrant[] = [
      { ...transfer, siteId: 'site-b' }, { ...transfer, dataClass: 'pii' },
      { ...transfer, destinationId: 'meili-b' },
    ];
    for (const required of otherScopes) expect(hasRetrievalGrant([transfer], required)).toBe(false);
  });

  it('denies incomplete attribution even with a matching grant', () => {
    const invalid: RetrievalGrant[] = [
      { ...transfer, destinationId: ' ' }, { ...index, siteId: '' }, { ...index, dataClass: 'unclassified' },
    ];
    for (const required of invalid) expect(hasRetrievalGrant([required], required)).toBe(false);
  });
});
