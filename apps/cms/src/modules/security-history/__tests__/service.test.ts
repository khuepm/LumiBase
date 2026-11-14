import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';

import { decodeCursor } from '../../audit/routes';
import type { HistoryAuditRow } from '../events';
import {
  exportSecurityHistory,
  historyToCsv,
  HISTORY_EXPORT_MAX_ROWS,
  querySecurityHistory,
  subjectPredicate,
} from '../service';

/**
 * #739 — the history query: only the caller's rows (subject predicate), only
 * sites in scope, only allow-listed events, keyset pagination, bounded export
 * and a formula-safe CSV.
 */

const dialect = new PgDialect();
const render = (s: SQL) => dialect.sqlToQuery(s);

const subject = { userId: 'usr_1', email: 'Me@Example.com', createdAt: new Date('2026-01-01T00:00:00Z') };

function auditRow(i: number): HistoryAuditRow {
  return {
    id: `aud_${String(i).padStart(5, '0')}`,
    timestamp: new Date(Date.UTC(2026, 10, 14, 0, 0, 0) - i * 1000),
    siteId: 'site-a',
    event: i % 2 === 0 ? 'login_success' : 'login_failed',
    actorEmail: 'me@example.com',
    targetEmail: 'me@example.com',
    ip: '203.0.113.5',
    userAgent: 'curl/8.0',
    countryCode: null,
    metadata: {},
  };
}

/** A fake Drizzle client: records every WHERE and serves `rows` in order. */
function fakeDb(rows: HistoryAuditRow[]) {
  const wheres: SQL[] = [];
  const takes: number[] = [];
  let served = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: SQL) => {
          wheres.push(cond);
          return {
            orderBy: () => ({
              limit: async (n: number) => {
                takes.push(n);
                // Emulate keyset continuation: the next call continues where
                // the previous page ended (the cursor in WHERE is asserted
                // separately via the rendered SQL).
                const out = rows.slice(served, served + n);
                return out;
              },
            }),
          };
        },
      }),
    }),
  };
  return {
    db: db as unknown as Database,
    wheres,
    takes,
    advance(n: number) {
      served += n;
    },
  };
}

describe('subjectPredicate', () => {
  it('resolves the subject by targetUserId, then userId, then target, then actor email', () => {
    const q = render(subjectPredicate(subject));
    expect(q.sql).toMatch(/->> 'targetUserId'\) IS NOT NULL\s+THEN \("lumibase_audit_log"\."metadata" ->> 'targetUserId'\) = \$1/);
    expect(q.sql).toMatch(/->> 'userId'\) = \$2/);
    expect(q.sql).toMatch(/lower\("lumibase_audit_log"\."target_email"\) = \$3/);
    expect(q.sql).toMatch(/ELSE lower\("lumibase_audit_log"\."actor_email"\) = \$4/);
    expect(q.params).toEqual(['usr_1', 'usr_1', 'me@example.com', 'me@example.com']);
  });
});

describe('querySecurityHistory', () => {
  it('filters on the allow-list, the sites in scope, the subject and the account age', async () => {
    const f = fakeDb([auditRow(0)]);
    await querySecurityHistory(f.db, { subject, siteIds: ['site-a'], limit: 10 });
    const q = render(f.wheres[0]!);
    expect(q.sql).toContain('"lumibase_audit_log"."event" in (');
    expect(q.sql).toContain('"lumibase_audit_log"."site_id" in ($');
    expect(q.sql).toContain('"lumibase_audit_log"."timestamp" >= $');
    expect(q.params).toContain('site-a');
    expect(q.params).toContain('login_success');
    expect(q.params).not.toContain('setup_completed');
    expect(f.takes).toEqual([11]);
  });

  it('returns no rows and runs no query for an empty site scope', async () => {
    const f = fakeDb([auditRow(0)]);
    expect(await querySecurityHistory(f.db, { subject, siteIds: [], limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(f.wheres).toHaveLength(0);
  });

  it('returns a cursor only when there is a further page, pointing at the last item', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => auditRow(i));
    const page = await querySecurityHistory(fakeDb(rows).db, { subject, siteIds: ['site-a'], limit: 2 });
    expect(page.items.map((i) => i.id)).toEqual(['aud_00000', 'aud_00001']);
    expect(decodeCursor(page.nextCursor)).toEqual({ timestamp: rows[1]!.timestamp, id: 'aud_00001' });

    const last = await querySecurityHistory(fakeDb(rows.slice(0, 2)).db, { subject, siteIds: ['site-a'], limit: 2 });
    expect(last.nextCursor).toBeNull();
  });

  it('adds the keyset predicate for a cursor', async () => {
    const f = fakeDb([]);
    const cursor = { timestamp: new Date('2026-11-14T00:00:00Z'), id: 'aud_9' };
    await querySecurityHistory(f.db, { subject, siteIds: ['site-a'], limit: 5, cursor });
    const q = render(f.wheres[0]!);
    expect(q.sql).toMatch(/"timestamp" < \$\d+ or \("lumibase_audit_log"\."timestamp" = \$\d+ and "lumibase_audit_log"\."id" < \$\d+\)/);
    expect(q.params).toContain('aud_9');
  });

  it('clamps the limit', async () => {
    const f = fakeDb([]);
    await querySecurityHistory(f.db, { subject, siteIds: ['site-a'], limit: 10_000 });
    expect(f.takes).toEqual([101]);
  });
});

describe('exportSecurityHistory', () => {
  it('walks keyset batches until a short batch', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => auditRow(i));
    const f = fakeDb(rows);
    // The fake serves sequentially; advance between calls like a real cursor.
    const db = f.db as unknown as { select: () => unknown };
    const origSelect = db.select;
    let call = 0;
    db.select = () => {
      if (call > 0) f.advance(500);
      call += 1;
      return origSelect();
    };
    const out = await exportSecurityHistory(f.db, { subject, siteIds: ['site-a'] });
    expect(out.items).toHaveLength(1200);
    expect(out.truncated).toBe(false);
    expect(f.takes).toEqual([500, 500, 500]);
    // Every batch after the first carries a cursor.
    expect(render(f.wheres[1]!).params).toContain('aud_00499');
  });

  it('caps the export and reports truncation', async () => {
    const rows = Array.from({ length: HISTORY_EXPORT_MAX_ROWS + 1 }, (_, i) => auditRow(i));
    const f = fakeDb(rows);
    const db = f.db as unknown as { select: () => unknown };
    const origSelect = db.select;
    let call = 0;
    db.select = () => {
      if (call > 0) f.advance(500);
      call += 1;
      return origSelect();
    };
    const out = await exportSecurityHistory(f.db, { subject, siteIds: ['site-a'] });
    expect(out.items).toHaveLength(HISTORY_EXPORT_MAX_ROWS);
    expect(out.truncated).toBe(true);
  });
});

describe('historyToCsv', () => {
  it('neutralises spreadsheet formulas and quotes per RFC 4180', () => {
    const csv = historyToCsv([
      {
        id: 'a',
        kind: 'sign_in',
        occurredAt: '2026-11-14T00:00:00.000Z',
        siteId: 'site-a',
        ipApprox: '203.0.113.x',
        userAgent: '=HYPERLINK("http://evil","x")',
        countryCode: null,
        details: { method: 'password' },
      },
    ]);
    const [header, line] = csv.trimEnd().split('\r\n');
    expect(header).toBe('occurredAt,kind,siteId,ipApprox,countryCode,userAgent,details');
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(line).toContain('"{""method"":""password""}"');
    expect(line).not.toMatch(/,=/);
  });
});
