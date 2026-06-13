import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { activity, agentFreezes, type Database } from '@lumibase/database';
import { KillSwitchService, resolveFreezeScope, type FreezeView } from '../kill-switch-service';

/**
 * Feature: content-os, Property 10: kill switch.
 *
 * - A site freeze blocks every agent role; a role freeze blocks exactly
 *   that role; lifted freezes never block. Enforcement happens at the
 *   tool-call boundary by construction: the harness consults
 *   `frozenScopeFor` before each tool call, so an in-flight handler
 *   finishes while the next call is denied.
 * - Freezing is idempotent; lifting restores execution; everything is
 *   recorded (the freezes table is the audit trail).
 *
 * **Validates: Requirements 14.2, 14.5**
 */

const roleArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/);

const freezeArb: fc.Arbitrary<FreezeView> = fc.record({
  scope: fc.constantFrom('site', 'role') as fc.Arbitrary<'site' | 'role'>,
  targetRole: fc.option(roleArb, { nil: null }),
  liftedAt: fc.option(fc.constant(new Date()), { nil: null }),
});

describe('Feature: content-os, Property 10: freeze resolution', () => {
  it('site freeze dominates, role freeze matches exactly, lifted never blocks', () => {
    fc.assert(
      fc.property(fc.array(freezeArb, { maxLength: 15 }), roleArb, (freezes, agentRole) => {
        const scope = resolveFreezeScope(freezes, agentRole);
        const active = freezes.filter((f) => !f.liftedAt);
        const hasSite = active.some((f) => f.scope === 'site');
        const hasRole = active.some((f) => f.scope === 'role' && f.targetRole === agentRole);

        if (hasSite) {
          expect(scope).toBe('site');
        } else if (hasRole) {
          expect(scope).toBe('role');
        } else {
          expect(scope).toBeNull();
        }
      }),
      { numRuns: 300 },
    );
  });

  it('an all-lifted history blocks nothing', () => {
    fc.assert(
      fc.property(fc.array(freezeArb, { maxLength: 15 }), roleArb, (freezes, agentRole) => {
        const lifted = freezes.map((f) => ({ ...f, liftedAt: new Date() }));
        expect(resolveFreezeScope(lifted, agentRole)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Service behaviour against a minimal drizzle stand-in
// ---------------------------------------------------------------------------

interface FreezeRow extends Record<string, unknown> {
  id: string;
  siteId: string;
  scope: string;
  targetRole: string | null;
  liftedAt: Date | null;
}

function fakeDb(): Database & { freezes: FreezeRow[]; audits: Array<Record<string, unknown>> } {
  const freezes: FreezeRow[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;

  const db = {
    freezes,
    audits,
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            // listActive filters liftedAt IS NULL via the where clause we
            // can't interpret — emulate it: the service only queries either
            // active or full history; both are served correctly because
            // lifted rows are filtered again by resolveFreezeScope and the
            // idempotency check below matches on liftedAt === null.
            limit: async () => freezes.filter((row) => row.liftedAt === null).map((row) => ({ ...row })),
          }),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === agentFreezes) {
          const row: FreezeRow = {
            id: `freeze_${++seq}`,
            siteId: values['siteId'] as string,
            scope: values['scope'] as string,
            targetRole: (values['targetRole'] as string | null) ?? null,
            liftedAt: null,
            ...values,
          };
          freezes.push(row);
          return Object.assign(Promise.resolve([row]), { returning: async () => [{ ...row }] });
        }
        if (table === activity) {
          audits.push(values);
        }
        return Object.assign(Promise.resolve([]), { returning: async () => [] });
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // The service lifts one freeze at a time by id; emulate by
          // lifting the first still-active row (sufficient for these tests).
          const target = freezes.find((row) => row.liftedAt === null);
          if (target) Object.assign(target, patch);
          return Object.assign(Promise.resolve(undefined), { returning: async () => [] });
        },
      }),
    }),
  };
  return db as unknown as Database & { freezes: FreezeRow[]; audits: Array<Record<string, unknown>> };
}

describe('Feature: content-os, Req 14.2/14.5: KillSwitchService behaviour', () => {
  it('freeze site blocks every role until lifted; everything is audited', async () => {
    const db = fakeDb();
    const service = new KillSwitchService({ db, siteId: 'site_1' });

    expect(await service.frozenScopeFor('writer')).toBeNull();

    await service.freeze('site', { reason: 'incident response', actor: 'user_1' });
    expect(await service.frozenScopeFor('writer')).toBe('site');
    expect(await service.frozenScopeFor('translator')).toBe('site');
    expect(await service.isSiteFrozen()).toBe(true);

    // Idempotent: a second site freeze re-uses the active one.
    await service.freeze('site', { actor: 'user_1' });
    expect(db.freezes.filter((row) => row.liftedAt === null)).toHaveLength(1);

    await service.lift('site', { actor: 'user_1' });
    expect(await service.frozenScopeFor('writer')).toBeNull();
    expect(await service.isSiteFrozen()).toBe(false);

    const actions = db.audits.map((entry) => entry['action']);
    expect(actions).toContain('kill_switch.freeze');
    expect(actions).toContain('kill_switch.lift');
  });

  it('freeze role blocks exactly that role', async () => {
    const db = fakeDb();
    const service = new KillSwitchService({ db, siteId: 'site_1' });

    await service.freeze('role', { targetRole: 'writer', reason: 'bad outputs' });
    expect(await service.frozenScopeFor('writer')).toBe('role');
    expect(await service.frozenScopeFor('translator')).toBeNull();
    expect(await service.isSiteFrozen()).toBe(false);
  });

  it('rejects role freezes without a target and lifts of nothing', async () => {
    const db = fakeDb();
    const service = new KillSwitchService({ db, siteId: 'site_1' });

    await expect(service.freeze('role', {})).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.lift('site', {})).rejects.toMatchObject({ code: 'NOT_FROZEN' });
  });
});
