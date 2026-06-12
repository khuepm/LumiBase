import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { AgentRoleService } from '../agent-role-service';
import { ConstitutionService } from '../constitution-service';
import { PlannerService } from '../planner-service';
import { ReviewerService } from '../reviewer-service';
import { maskSecrets } from '../agent-run-service';

/**
 * Feature: content-os, Property 1: tenant isolation for the new Module C/D
 * services, plus the Req 17.6 secret-masking invariant.
 *
 * Instead of faking row visibility, this test inspects the REAL conditions
 * each service hands to the database: every select/update/delete WHERE
 * clause must constrain `site_id` to exactly the service's own siteId, and
 * every insert must stamp the row with it. A service that forgets the site
 * filter fails here regardless of what the database would return.
 *
 * **Validates: Requirements 17.1, 17.6**
 */

const dialect = new PgDialect();

interface Captured {
  wheres: Array<{ sql: string; params: unknown[] }>;
  insertedSiteIds: unknown[];
}

/** Site-guard fake: records every WHERE condition and inserted siteId. */
function makeCapturingDb(captured: Captured): Database {
  const renderWhere = (condition: unknown) => {
    if (condition) {
      const query = dialect.sqlToQuery((condition as SQL).getSQL());
      captured.wheres.push({ sql: query.sql, params: query.params as unknown[] });
    }
  };

  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    chain['where'] = (condition: unknown) => {
      renderWhere(condition);
      return chain;
    };
    chain['orderBy'] = () => chain;
    chain['limit'] = async () => [];
    // Awaiting the chain directly (no limit) resolves to [].
    chain['then'] = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    return chain;
  };

  return {
    select: () => ({ from: () => selectChain() }),
    insert: () => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const rows = Array.isArray(values) ? values : [values];
        for (const row of rows) captured.insertedSiteIds.push(row['siteId']);
        const tail = {
          returning: async () => rows.map((row, i) => ({ id: `row_${i}`, ...row })),
          onConflictDoNothing: () => tail,
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return tail;
      },
    }),
    update: () => ({
      set: () => ({
        where: (condition: unknown) => {
          renderWhere(condition);
          return {
            returning: async () => [],
            then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
          };
        },
      }),
    }),
    delete: () => ({
      where: (condition: unknown) => {
        renderWhere(condition);
        return { returning: async () => [] };
      },
    }),
  } as unknown as Database;
}

function expectAllSiteScoped(captured: Captured, siteId: string) {
  expect(captured.wheres.length).toBeGreaterThan(0);
  for (const where of captured.wheres) {
    expect(where.sql).toContain('site_id');
    expect(where.params).toContain(siteId);
  }
  for (const inserted of captured.insertedSiteIds) {
    expect(inserted).toBe(siteId);
  }
}

const siteIdArb = fc.stringMatching(/^site_[a-z0-9]{4,12}$/);
const nameArb = fc.stringMatching(/^[a-z][a-z0-9_]{2,16}$/);

describe('Feature: content-os, Property 1: tenant isolation (new services)', () => {
  it('AgentRoleService scopes every query and stamps inserts with its siteId', async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, nameArb, async (siteId, roleName) => {
        const captured: Captured = { wheres: [], insertedSiteIds: [] };
        const service = new AgentRoleService({ db: makeCapturingDb(captured), siteId });

        await service.getRole(roleName);
        await service.effectiveCapabilities(roleName, ['*']);
        await service.list(); // triggers ensureSeeded → inserts library roles
        await service.update(roleName, { enabled: false }).catch(() => undefined);
        await service.delete(roleName).catch(() => undefined);

        expectAllSiteScoped(captured, siteId);
      }),
      { numRuns: 50 },
    );
  });

  it('PlannerService scopes goal reads and child listings to its siteId', async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, nameArb, async (siteId, goalId) => {
        const captured: Captured = { wheres: [], insertedSiteIds: [] };
        const service = new PlannerService({ db: makeCapturingDb(captured), siteId });

        await service.listChildren(goalId);
        await service
          .decompose(goalId, [{ title: 'x', agentRole: 'writer' }])
          .catch(() => undefined); // parent not found — the lookup still ran
        await service.settleParent(goalId).catch(() => undefined);

        expectAllSiteScoped(captured, siteId);
      }),
      { numRuns: 50 },
    );
  });

  it('ConstitutionService scopes versions, active lookups and run pinning', async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, nameArb, async (siteId, runId) => {
        const captured: Captured = { wheres: [], insertedSiteIds: [] };
        const service = new ConstitutionService({ db: makeCapturingDb(captured), siteId });

        await service.listVersions();
        await service.getActive();
        await service.pinToRun(runId).catch(() => undefined);
        await service.publishGate({ title: 'x' });
        await service
          .createDraft([{ id: 'e1', type: 'rule', rule: { field: 'title', op: 'required' } }], null)
          .catch(() => undefined);

        expectAllSiteScoped(captured, siteId);
      }),
      { numRuns: 50 },
    );
  });

  it('ReviewerService scopes config and approval lookups', async () => {
    await fc.assert(
      fc.asyncProperty(siteIdArb, nameArb, async (siteId, approvalId) => {
        const captured: Captured = { wheres: [], insertedSiteIds: [] };
        const service = new ReviewerService({ db: makeCapturingDb(captured), siteId });

        await service.getConfig();
        await service
          .decide({
            approvalId,
            reviewerRunId: 'run_r',
            decision: 'approved',
            confidence: 1,
            capabilities: ['*'],
          })
          .catch(() => undefined); // disabled/not-found — lookups still ran

        expectAllSiteScoped(captured, siteId);
      }),
      { numRuns: 50 },
    );
  });
});

describe('Feature: content-os, Req 17.6: secrets are masked in guard/denial audit payloads', () => {
  const secretKeyArb = fc.constantFrom(
    'apiKey',
    'api_key',
    'token',
    'secret',
    'password',
    'authorization',
    'credential',
    'ACCESS_TOKEN',
  );
  const valueArb = fc.string({ minLength: 1, maxLength: 30 });

  it('any secret-named key is masked at any nesting depth', () => {
    fc.assert(
      fc.property(secretKeyArb, valueArb, fc.string({ maxLength: 10 }), (key, secret, plain) => {
        const payload = {
          reason: plain,
          [key]: secret,
          nested: { detail: { [key]: secret, safe: plain } },
          list: [{ [key]: secret }],
        };
        const masked = maskSecrets(payload) as Record<string, unknown>;
        expect(masked[key]).toBe('[masked]');
        const nested = (masked['nested'] as Record<string, Record<string, unknown>>)['detail']!;
        expect(nested[key]).toBe('[masked]');
        expect(nested['safe']).toBe(plain);
        expect((masked['list'] as Array<Record<string, unknown>>)[0]![key]).toBe('[masked]');
      }),
      { numRuns: 150 },
    );
  });

  it('non-secret keys survive masking untouched', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom('reason', 'comment', 'detail', 'status'), valueArb), (payload) => {
        expect(maskSecrets(payload)).toEqual(payload);
      }),
      { numRuns: 50 },
    );
  });
});
