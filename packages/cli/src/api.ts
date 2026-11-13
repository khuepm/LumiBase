import type { TypegenManifest } from '@lumibase/sdk';
import { CliError } from './errors.js';

export interface Connection {
  url: string;
  siteId: string;
  token: string;
}

export interface RequestOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Internal per-call extras — kept out of {@link RequestOptions}, which is the test/injection seam. */
interface RequestExtras {
  method?: 'GET' | 'POST';
  /** Sent as JSON when present. */
  body?: unknown;
  /** Replaces the generic 403 hint with one that names the permission this endpoint needs. */
  forbiddenHint?: string;
  timeoutMs?: number;
}

async function request(
  connection: Connection,
  path: string,
  query: Record<string, string | undefined> = {},
  options: RequestOptions = {},
  init: RequestExtras = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const target = new URL(path, `${connection.url}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value) target.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const hasBody = init.body !== undefined;

  let response: Response;
  try {
    response = await fetcher(target, {
      ...(init.method && init.method !== 'GET' ? { method: init.method } : {}),
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'X-Lumi-Site': connection.siteId,
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new CliError(`Request to ${target.href} timed out.`);
    }
    throw new CliError(
      `Could not reach ${target.href}: ${err instanceof Error ? err.message : String(err)}`,
      'Is the CMS running, and is --url / LUMIBASE_URL pointing at it?',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new CliError(
      describeHttpError(response.status, target.href, await serverErrorMessage(response)),
      hintForStatus(response.status, init.forbiddenHint),
    );
  }

  return response.json();
}

/** The first `errors[].message` of a LumiBase error envelope, when the body is one. */
async function serverErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { errors?: unknown } | null;
    const first = Array.isArray(body?.errors) ? (body.errors[0] as unknown) : undefined;
    const message =
      typeof first === 'object' && first !== null ? (first as { message?: unknown }).message : undefined;
    return typeof message === 'string' && message.trim() ? message.trim() : undefined;
  } catch {
    return undefined;
  }
}

function describeHttpError(status: number, href: string, serverMessage?: string): string {
  const detail = serverMessage ? ` — ${serverMessage}` : '.';
  if (status === 401) return `Unauthorized (401) from ${href}${detail}`;
  if (status === 403) return `Forbidden (403) from ${href}${detail}`;
  if (status === 404) return `Not found (404) at ${href}${detail}`;
  return `Request to ${href} failed with HTTP ${status}${detail}`;
}

function hintForStatus(status: number, forbiddenHint?: string): string | undefined {
  if (status === 401) return 'The token is missing, expired, or not valid for this site.';
  if (status === 403) {
    return forbiddenHint ?? 'The token is valid but lacks permission for this endpoint.';
  }
  if (status === 404) {
    return 'Check the base URL — it should point at the CMS root (e.g. http://localhost:1989), not at an endpoint.';
  }
  return undefined;
}

/** Fetches the collection manifest that `generateTypes` turns into TypeScript. */
export async function fetchTypegenManifest(
  connection: Connection,
  filters: { include?: string[]; exclude?: string[] } = {},
  options: RequestOptions = {},
): Promise<TypegenManifest> {
  const body = await request(
    connection,
    'api/v1/typegen/schema',
    {
      include: filters.include?.join(','),
      exclude: filters.exclude?.join(','),
    },
    options,
    { forbiddenHint: 'The token is valid but lacks permission to read the schema.' },
  );

  const manifest = (body as { data?: unknown } | null)?.data;

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !Array.isArray((manifest as TypegenManifest).collections)
  ) {
    throw new CliError(
      'The schema endpoint returned an unexpected payload.',
      'Make sure the CMS is a LumiBase instance and its version supports GET /api/v1/typegen/schema.',
    );
  }

  return manifest as TypegenManifest;
}

/** Probes the unauthenticated health endpoint. Never throws — `doctor` reports the outcome. */
export async function probeHealth(
  url: string,
  options: RequestOptions = {},
): Promise<{ ok: boolean; status?: string; detail: string }> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const target = new URL('health', `${url}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetcher(target, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status} from ${target.href}` };
    }

    const body = (await response.json()) as { status?: unknown };
    const status = typeof body.status === 'string' ? body.status : undefined;

    return {
      ok: status !== 'unhealthy',
      status,
      detail: status ? `reachable — status: ${status}` : `reachable at ${target.href}`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, detail: `timed out reaching ${target.href}` };
    }
    return {
      ok: false,
      detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Site Skills — /api/v1/agent/skills
// ---------------------------------------------------------------------------

const SKILLS_PATH = 'api/v1/agent/skills';

const SKILLS_FORBIDDEN_HINT =
  'Site Skills live on the admin-only /api/v1/agent surface: reading and writing them both need a token with control-plane admin access to the site.';

/** Importing writes one skill at a time on the server, so a full batch can be slow. */
const SKILLS_IMPORT_TIMEOUT_MS = 60_000;

/** The server rejects an import carrying more documents than this. */
export const SKILLS_IMPORT_BATCH_SIZE = 100;

export interface ExportedSkill {
  slug: string;
  filename: string;
  content: string;
}

export interface SkillImportDocument {
  path?: string;
  content: string;
}

export interface SkillImportOptions {
  activate?: boolean;
  dryRun?: boolean;
  /** Allow content changes to skills that are already active (live). Only `push` sets it. */
  updateActive?: boolean;
  source?: 'cli' | 'package';
  sourceRef?: string;
}

export type SkillImportAction = 'created' | 'updated' | 'unchanged' | 'error';

export interface SkillImportResult {
  path?: string;
  slug?: string;
  action: SkillImportAction;
  version?: number;
  status?: string;
  code?: string;
  message?: string;
}

function unexpectedSkillsPayload(): CliError {
  return new CliError(
    'The skills endpoint returned an unexpected payload.',
    'Make sure the CMS is a LumiBase instance and its version supports /api/v1/agent/skills.',
  );
}

function dataRows(body: unknown): Record<string, unknown>[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw unexpectedSkillsPayload();
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) throw unexpectedSkillsPayload();
  }
  return data as Record<string, unknown>[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Skill rows exactly as the server sent them — `skills list --json` prints these untouched. */
export async function listSkills(
  connection: Connection,
  filters: { status?: string } = {},
  options: RequestOptions = {},
): Promise<Record<string, unknown>[]> {
  const body = await request(connection, SKILLS_PATH, { status: filters.status }, options, {
    forbiddenHint: SKILLS_FORBIDDEN_HINT,
  });
  return dataRows(body);
}

export async function exportSkills(
  connection: Connection,
  filters: { status?: string } = {},
  options: RequestOptions = {},
): Promise<ExportedSkill[]> {
  const body = await request(connection, `${SKILLS_PATH}/export`, { status: filters.status }, options, {
    forbiddenHint: SKILLS_FORBIDDEN_HINT,
  });

  return dataRows(body).map((row) => {
    if (typeof row['filename'] !== 'string' || typeof row['content'] !== 'string') {
      throw unexpectedSkillsPayload();
    }
    return { slug: text(row['slug']), filename: row['filename'], content: row['content'] };
  });
}

const IMPORT_ACTIONS: readonly string[] = ['created', 'updated', 'unchanged', 'error'];

/**
 * Upserts Markdown skill documents by slug, in batches the server accepts.
 * Results come back in document order. A failing document is a result with
 * `action: 'error'`, not a thrown error — only transport/HTTP failures throw.
 */
export async function importSkills(
  connection: Connection,
  documents: SkillImportDocument[],
  importOptions: SkillImportOptions = {},
  options: RequestOptions = {},
): Promise<SkillImportResult[]> {
  const results: SkillImportResult[] = [];

  for (let start = 0; start < documents.length; start += SKILLS_IMPORT_BATCH_SIZE) {
    const batch = documents.slice(start, start + SKILLS_IMPORT_BATCH_SIZE);
    const body = await request(
      connection,
      `${SKILLS_PATH}/import`,
      {},
      options,
      {
        method: 'POST',
        body: {
          documents: batch,
          ...(importOptions.activate ? { activate: true } : {}),
          ...(importOptions.dryRun ? { dryRun: true } : {}),
          ...(importOptions.updateActive ? { updateActive: true } : {}),
          ...(importOptions.source ? { source: importOptions.source } : {}),
          ...(importOptions.sourceRef ? { sourceRef: importOptions.sourceRef } : {}),
        },
        forbiddenHint: SKILLS_FORBIDDEN_HINT,
        timeoutMs: SKILLS_IMPORT_TIMEOUT_MS,
      },
    );

    const rows = dataRows(body);
    // Results are matched to files by position, so a short or long answer
    // cannot be reported truthfully.
    if (rows.length !== batch.length) throw unexpectedSkillsPayload();

    rows.forEach((row, index) => {
      const action = row['action'];
      if (typeof action !== 'string' || !IMPORT_ACTIONS.includes(action)) {
        throw unexpectedSkillsPayload();
      }
      results.push({
        path: optionalText(row['path']) ?? batch[index]?.path,
        slug: optionalText(row['slug']),
        action: action as SkillImportAction,
        version: typeof row['version'] === 'number' ? row['version'] : undefined,
        status: optionalText(row['status']),
        code: optionalText(row['code']),
        message: optionalText(row['message']),
      });
    });
  }

  return results;
}
