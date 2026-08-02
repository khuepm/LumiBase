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

async function request(
  connection: Connection,
  path: string,
  query: Record<string, string | undefined> = {},
  options: RequestOptions = {},
): Promise<unknown> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const target = new URL(path, `${connection.url}/`);

  for (const [key, value] of Object.entries(query)) {
    if (value) target.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetcher(target, {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'X-Lumi-Site': connection.siteId,
        Accept: 'application/json',
      },
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
    throw new CliError(describeHttpError(response.status, target.href), hintForStatus(response.status));
  }

  return response.json();
}

function describeHttpError(status: number, href: string): string {
  if (status === 401) return `Unauthorized (401) from ${href}.`;
  if (status === 403) return `Forbidden (403) from ${href}.`;
  if (status === 404) return `Not found (404) at ${href}.`;
  return `Request to ${href} failed with HTTP ${status}.`;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401) return 'The token is missing, expired, or not valid for this site.';
  if (status === 403) return 'The token is valid but lacks permission to read the schema.';
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
