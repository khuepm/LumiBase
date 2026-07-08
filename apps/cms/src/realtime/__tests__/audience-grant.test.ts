import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '../../env';
import {
  resolveAudienceGrant,
  resolveSubjectId,
  subjectChannel,
} from '../audience-grant';

function fe(raw: Record<string, unknown> = {}, extra: Partial<AuthPrincipal> = {}): AuthPrincipal {
  return { isFrontendUser: true, raw, ...extra };
}

describe('resolveSubjectId', () => {
  it('returns null for a non-frontend (admin) principal', () => {
    expect(resolveSubjectId({ isFrontendUser: false, userId: 'u1', raw: {} })).toBeNull();
  });

  it('prefers an explicit citizenID claim', () => {
    expect(resolveSubjectId(fe({ citizenID: 'C-123' }, { externalId: 'ext' }))).toBe('C-123');
  });

  it('falls back to externalId then userId', () => {
    expect(resolveSubjectId(fe({}, { externalId: 'ext-9' }))).toBe('ext-9');
    expect(resolveSubjectId(fe({}, { userId: 'u-9' }))).toBe('u-9');
  });
});

describe('resolveAudienceGrant', () => {
  it('rejects a principal with no resolvable subject', () => {
    expect(resolveAudienceGrant({ isFrontendUser: false, raw: {} })).toBeNull();
    expect(resolveAudienceGrant(fe({}))).toBeNull(); // FE but no id anywhere
  });

  it('always grants the subject self channel', () => {
    const grant = resolveAudienceGrant(fe({ citizenID: 'C-1' }));
    expect(grant?.subjectId).toBe('C-1');
    expect(grant?.channels).toEqual([subjectChannel('C-1')]);
  });

  it('grants only requested channels that are in the verified allowlist', () => {
    const principal = fe({ citizenID: 'C-1', channels: ['order:1', 'order:2'] });
    const grant = resolveAudienceGrant(principal, ['order:1', 'order:999']);
    expect(grant?.channels).toContain('order:1');
    expect(grant?.channels).not.toContain('order:999'); // not in allowlist
    expect(grant?.channels).toContain(subjectChannel('C-1'));
  });

  it('ignores requested channels when the principal carries no allowlist claim', () => {
    const grant = resolveAudienceGrant(fe({ citizenID: 'C-1' }), ['order:1']);
    expect(grant?.channels).toEqual([subjectChannel('C-1')]);
  });
});
