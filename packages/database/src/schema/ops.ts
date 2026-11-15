import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Operator error capture (`.kiro/specs/ops-diagnostics/design.md` §1).
 *
 * One row per 5xx response, keyed by the `requestId` the client already sees
 * in the error body and `x-request-id`. Platform data, not tenant data: no
 * `site_id` FK (a failing request may have no resolved site, and a deleted
 * site must not erase the evidence). Ids are uuidv7, supplied by the writer.
 *
 * `error` holds the sanitized cause chain (no query params, no Postgres
 * `detail`, tokens redacted). RLS is enabled and forced with NO policy, so the
 * app role sees nothing; only the BYPASSRLS system role reads or writes it.
 * Retention is 14 days, pruned by the writer.
 */
export const opsErrors = pgTable(
  'lumibase_ops_errors',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    method: text('method').notNull(),
    /** Path only, never the query string. */
    path: text('path').notNull(),
    status: integer('status').notNull(),
    siteId: text('site_id'),
    /** `user:<id>` | `apikey:<id>` | null. Never a token. */
    principal: text('principal'),
    /** `LUMIBASE_VERSION+LUMIBASE_GIT_SHA` of the code that served the request. */
    release: text('release'),
    /** `errors[0].code` of the response body (`INTERNAL`, `RLS_MISCONFIGURED`…). */
    errorCode: text('error_code'),
    error: jsonb('error').$type<unknown>(),
    stack: text('stack'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    createdIdx: index('ops_errors_created_idx').on(t.createdAt),
    requestIdx: index('ops_errors_request_idx').on(t.requestId),
  }),
);

export type OpsErrorRow = typeof opsErrors.$inferSelect;
