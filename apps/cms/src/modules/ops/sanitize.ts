/**
 * Error sanitizer for the operator error capture
 * (`.kiro/specs/ops-diagnostics/design.md` §1).
 *
 * Keeps what diagnoses a fault (error class, message, SQL statement text,
 * Postgres SQLSTATE and the object it names) and drops what can carry data:
 *
 * - `DrizzleQueryError.params` and the `\nparams: …` tail of its message;
 * - Postgres `detail` / `where` (they echo row values, e.g.
 *   `Key (domain)=(acme.com) already exists`);
 * - bearer tokens, LumiBase API keys and JWT-shaped strings anywhere in text.
 *
 * Recurses through `cause` (Drizzle wraps the driver error there), so the
 * SQLSTATE that `formatSafeError` loses is kept.
 */

export interface SanitizedError {
  name?: string;
  message?: string;
  /** SQL statement text (no values) when the error is a failed query. */
  query?: string;
  /** Postgres SQLSTATE, e.g. `42703` undefined column, `42501` insufficient privilege. */
  code?: string;
  severity?: string;
  table?: string;
  column?: string;
  constraint?: string;
  schema?: string;
  routine?: string;
  hint?: string;
  cause?: SanitizedError;
}

const MAX_TEXT = 2048;
const MAX_DEPTH = 4;
export const MAX_STACK = 4096;

const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // JWT: three base64url segments, the first starting with `eyJ`.
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  // LumiBase API keys (`lb_…`, `lbo_…`, `lbs_…`) and generic `sk-`/`pk_` secrets.
  [/\b(?:lb[a-z]?_|sk-|sk_|pk_)[A-Za-z0-9_-]{12,}/g, '[redacted-key]'],
  // postgres://user:password@host
  [/(\w+:\/\/[^:/\s]+:)[^@\s]+@/g, '$1[redacted]@'],
];

export function redactText(input: string, max = MAX_TEXT): string {
  let out = input;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out.length > max ? `${out.slice(0, max)}…[truncated]` : out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Drizzle's message is `Failed query: <sql>\nparams: <values>`. Keep the SQL only. */
function splitDrizzleMessage(message: string): { message: string; query?: string } {
  const m = /^Failed query: ([\s\S]*?)(?:\nparams:[\s\S]*)?$/.exec(message);
  if (!m) return { message };
  return { message: 'Failed query', query: m[1] };
}

export function sanitizeError(err: unknown, depth = 0): SanitizedError {
  if (err === null || err === undefined) return { message: String(err) };
  if (typeof err !== 'object') return { message: redactText(String(err)) };

  const e = err as Record<string, unknown>;
  const out: SanitizedError = {};
  const name = str(e.name) ?? (err instanceof Error ? err.constructor.name : undefined);
  if (name) out.name = name;

  const rawMessage = str(e.message);
  if (rawMessage) {
    const { message, query } = splitDrizzleMessage(rawMessage);
    out.message = redactText(message);
    const q = query ?? str(e.query);
    if (q) out.query = redactText(q);
  } else if (str(e.query)) {
    out.query = redactText(e.query as string);
  }

  // postgres.js PostgresError fields (snake_case) and node-postgres (camel/short).
  const code = str(e.code);
  if (code) out.code = code;
  const severity = str(e.severity);
  if (severity) out.severity = severity;
  const table = str(e.table_name) ?? str(e.table);
  if (table) out.table = table;
  const column = str(e.column_name) ?? str(e.column);
  if (column) out.column = column;
  const constraint = str(e.constraint_name) ?? str(e.constraint);
  if (constraint) out.constraint = constraint;
  const schema = str(e.schema_name) ?? str(e.schema);
  if (schema) out.schema = schema;
  const routine = str(e.routine);
  if (routine) out.routine = routine;
  const hint = str(e.hint);
  if (hint) out.hint = redactText(hint);

  if (depth < MAX_DEPTH && e.cause !== undefined && e.cause !== err) {
    out.cause = sanitizeError(e.cause, depth + 1);
  }
  return out;
}

export function sanitizeStack(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  return stack ? redactText(stack, MAX_STACK) : undefined;
}

/** The innermost SQLSTATE in the chain — usually the one that names the fault. */
export function rootSqlState(e: SanitizedError | undefined): string | undefined {
  let found: string | undefined;
  for (let cur = e; cur; cur = cur.cause) if (cur.code && /^[0-9A-Z]{5}$/.test(cur.code)) found = cur.code;
  return found;
}
