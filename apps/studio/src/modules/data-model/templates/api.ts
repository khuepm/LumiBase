import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

/**
 * Backend templates API (#908, epic #900 BT08): thin typed calls over
 * `/api/v1/backend-templates` — the same routes, services and checks every
 * other client uses. Nothing here decides anything; the server does.
 *
 * Every call names its site explicitly. The catalog is read from the active
 * site, but a plan and its install go to the TARGET site the admin picked,
 * which may be another site they administer. The origin comes from
 * `getApiBaseUrl()` and the token from the `api.ts` accessors, so the desktop
 * and mobile shell keep working (shell contracts C1, C2).
 */

export interface TemplateSummary {
  id: string;
  source: 'site' | 'official';
  slug: string;
  displayName: string;
  draftRevision: number | null;
  versions: string[];
}

export interface TemplateIssue {
  code: string;
  path?: string | string[];
  message: string;
}

export interface TemplateDetail extends TemplateSummary {
  draft: unknown;
  validation: { ok: true } | { ok: false; errors: TemplateIssue[] };
  revisions: Array<{ id: string; templateVersion: string; digest: string; createdAt: string }>;
}

export interface PlanReport {
  template: { source: 'official' | 'site'; sourceSiteId: string | null; slug: string; version: string; digest: string; displayName: string };
  targetSiteId: string;
  namespace: Record<string, string>;
  components: { collections: string[]; fields: number; relations: Array<{ from: string; to: string; type: string }> };
  counts: { collections: number; fields: number; relations: number; seedRecords: number };
  seedPack: string | null;
  storage: { modes: string[]; transactional: boolean };
  conflicts: string[];
  unrelatedCollections: number;
  warnings: string[];
}

export interface PlanResult {
  id: string;
  status: string;
  expiresAt: string;
  targetFingerprint: string;
  report: PlanReport;
}

export interface Installation {
  id: string;
  planId: string;
  slug: string;
  templateVersion: string;
  digest: string;
  seedPack: string | null;
  resources: { collections: string[]; fields: number; relations: number; seedRecords: number };
}

export interface PlanRequest {
  template: { source: 'official' | 'site'; sourceSiteId?: string; slug: string; version: string };
  targetSiteId: string;
  namespace?: { prefix?: string };
  seedMode: 'none' | 'pack';
  seedPack?: string;
}

/** A refusal from the API, with the server's own code. */
export class TemplateApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: { conflicts?: string[]; issues?: TemplateIssue[] } = {},
  ) {
    super(message);
    this.name = 'TemplateApiError';
  }
}

async function call<T>(
  site: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ data: T; meta?: Record<string, unknown> }> {
  const token = getActiveToken();
  let res: Response;
  try {
    res = await fetch(`${getApiBaseUrl()}/api/v1/backend-templates${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'X-Lumi-Site': site,
        'X-Lumi-Client': 'studio',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (err) {
    throw new TemplateApiError('NETWORK', err instanceof Error ? err.message : 'The server could not be reached.', 0);
  }
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    meta?: Record<string, unknown>;
    errors?: Array<{ code?: string; message?: string; path?: string | string[]; conflicts?: string[] }>;
  };
  if (!res.ok) {
    const errors = body.errors ?? [];
    const first = errors[0];
    throw new TemplateApiError(
      first?.code ?? `HTTP_${res.status}`,
      first?.message ?? `Request failed: ${res.status}`,
      res.status,
      {
        conflicts: first?.conflicts,
        issues: errors.filter((e) => e.path !== undefined).map((e) => ({ code: e.code ?? 'INVALID', path: e.path, message: e.message ?? '' })),
      },
    );
  }
  return { data: body.data as T, ...(body.meta ? { meta: body.meta } : {}) };
}

export const templatesApi = {
  official: (site = getActiveSite()) => call<TemplateSummary[]>(site, '/official').then((r) => r.data),
  list: (site = getActiveSite()) => call<TemplateSummary[]>(site, '/?limit=100').then((r) => r.data),
  get: (id: string, site = getActiveSite()) => call<TemplateDetail>(site, `/${encodeURIComponent(id)}`).then((r) => r.data),
  revision: (id: string, version: string, site = getActiveSite()) =>
    call<{ document: unknown; digest: string; templateVersion: string }>(
      site,
      `/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}`,
    ).then((r) => r.data),
  /** `document` is raw JSON text, so the server checks it for duplicate keys. */
  create: (document: string, site = getActiveSite()) => call<TemplateDetail>(site, '/', { method: 'POST', body: { document } }).then((r) => r.data),
  publish: (id: string, draftRevision: number, site = getActiveSite()) =>
    call<{ templateVersion: string; digest: string }>(site, `/${encodeURIComponent(id)}/publish`, { method: 'POST', body: { draftRevision } }),
  capture: (input: { collections: string[]; slug: string; displayName: string; templateVersion?: string }, site = getActiveSite()) =>
    call<TemplateDetail>(site, '/capture', { method: 'POST', body: input }).then((r) => r.data),
  /** Sent to the TARGET site: a plan always belongs to the site it installs into. */
  plan: (input: PlanRequest) => call<PlanResult>(input.targetSiteId, '/plans', { method: 'POST', body: input }).then((r) => r.data),
  install: (targetSiteId: string, planId: string, idempotencyKey: string) =>
    call<Installation>(targetSiteId, '/installations', { method: 'POST', body: { planId, idempotencyKey } }),
};
