import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../env';
import { createCdcRouter } from '../modules/cdc/routes';
import {
  PipelineNameConflictError,
  PipelineLimitExceededError,
  ConnectivityCheckError,
  type PipelineCreateInput,
  type PipelinePatchInput,
  type PipelineRecord,
  type PipelineRegistryService,
  type PipelineStatus,
} from '../modules/cdc/registry/pipeline-registry';

/**
 * Unit tests for the CDC API route handlers (ClickHouse CDC — task 12.3;
 * design "CDC API Routes" §7 + "Pipeline Registration Errors" table).
 *
 * These exercise {@link createCdcRouter} with an injected fake
 * {@link PipelineRegistryService}, so the handlers never touch a real
 * Postgres. Per {@link createCdcRouter}, the per-request services factory
 * returns a PARTIAL {@link CdcRouteServices}; supplying only `registry` is
 * enough because every test below hits `POST /pipelines`, whose handler only
 * uses `services.registry`. (The base `defaultCdcServicesFactory` still runs
 * to fill the other fields, but it is side-effect-free with an undefined db.)
 *
 * The CDC router enforces an admin-role + site gate on EVERY route, so each
 * request flows through a tiny parent Hono that sets `auth` and `siteId` on
 * the context BEFORE the cdc router runs — mirroring how `withAuth`/
 * `withTenant` populate them upstream in production.
 *
 * Validates: Requirements 1.3, 1.5, 1.6, 1.7
 */

// ── fakes ──────────────────────────────────────────────────────────────

const SITE_ID = 'site-1';

/** A valid create body (all required fields present). */
function validCreateBody(): Record<string, unknown> {
  return {
    pipeline_name: 'analytics-pipeline',
    cdc_connector_type: 'debezium_kafka',
    source_database_connection: 'postgresql://user:pass@db.internal:5432/app',
    clickhouse_sink_connection: 'clickhouse://user:pass@ch.internal:8123/olap',
    replication_tables: ['public.items', 'public.orders'],
  };
}

/** Build a {@link PipelineRecord} for happy-path assertions. */
function fakeRecord(overrides: Partial<PipelineRecord> = {}): PipelineRecord {
  const now = new Date('2024-01-01T00:00:00.000Z');
  return {
    id: 'pipe_abc123',
    siteId: SITE_ID,
    pipelineName: 'analytics-pipeline',
    connectorType: 'debezium_kafka',
    status: 'provisioning' as PipelineStatus,
    statusMessage: null,
    sourceConnection: 'postgresql://user:pass@db.internal:5432/app',
    sinkConnection: 'clickhouse://user:pass@ch.internal:8123/olap',
    intermediaryConnection: null,
    replicationTables: ['public.items', 'public.orders'],
    config: {},
    lastSyncAt: null,
    lastSyncRecordCount: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Minimal fake registry whose `create` is driven by the test. The other
 * methods throw to make accidental use obvious — these tests only call
 * `POST /pipelines`.
 */
function fakeRegistry(
  onCreate: (
    siteId: string,
    input: PipelineCreateInput,
  ) => Promise<PipelineRecord>,
): PipelineRegistryService {
  return {
    create: onCreate,
    get: () => {
      throw new Error('get() not expected in this test');
    },
    list: () => {
      throw new Error('list() not expected in this test');
    },
    update: (_s: string, _id: string, _p: PipelinePatchInput) => {
      throw new Error('update() not expected in this test');
    },
    delete: () => {
      throw new Error('delete() not expected in this test');
    },
    updateStatus: () => {
      throw new Error('updateStatus() not expected in this test');
    },
  };
}

/**
 * Mount the cdc router (built with the given fake registry) under a parent
 * Hono that seeds `auth`/`siteId` on the context. Set `seedContext` to false
 * to omit them and exercise the auth/site gate directly.
 */
function buildApp(
  registry: PipelineRegistryService,
  opts: { roles?: string[]; siteId?: string | null; siteAdmin?: boolean } = {},
): Hono<AppEnv> {
  const { roles = ['admin'], siteId = SITE_ID, siteAdmin = true } = opts;

  const parent = new Hono<AppEnv>();
  parent.use('*', async (c, next) => {
    // CDC requires an encryption key (fail-closed, CWE-321). Provide a test key
    // so the default services factory constructs its registry; the actual
    // registry used by these tests is injected via the override below.
    c.env = { ...(c.env ?? {}), ENCRYPTION_KEY: 'test-cdc-encryption-key' } as AppEnv['Bindings'];
    c.set('auth', { roles, raw: {} });
    if (siteId) c.set('siteId', siteId);
    await next();
  });

  const cdc = createCdcRouter(() => ({
    registry,
    authorizeSiteAdmin: async () => siteAdmin,
  }));
  parent.route('/cdc', cdc);
  return parent;
}

/** POST /cdc/pipelines with a JSON body. */
async function postPipelines(
  app: Hono<AppEnv>,
  body: unknown,
): Promise<Response> {
  return app.request('/cdc/pipelines', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

type ErrorEntry = {
  code: string;
  message?: string;
  fields?: string[];
  endpoint?: string;
  [k: string]: unknown;
};

type ErrorEnvelope = {
  errors: [ErrorEntry, ...ErrorEntry[]];
};

// ── 1. Validation errors → 400 with field list (Req 1.3) ─────────────────

describe('POST /pipelines — validation errors (Req 1.3)', () => {
  it('rejects a body missing every required field with 400 listing exactly those fields', async () => {
    // Never reaches the registry: the Zod parse fails first.
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run on a validation error');
      }),
    );

    const res = await postPipelines(app, {});
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrorEnvelope;
    expect(body.errors[0].code).toBe('VALIDATION_ERROR');

    const fields = body.errors[0].fields ?? [];
    // Exactly the five required fields, regardless of order.
    expect([...fields].sort()).toEqual(
      [
        'pipeline_name',
        'cdc_connector_type',
        'source_database_connection',
        'clickhouse_sink_connection',
        'replication_tables',
      ].sort(),
    );
  });

  it('lists exactly the single missing field when only one is omitted', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run on a validation error');
      }),
    );

    const body = validCreateBody();
    delete body.replication_tables;

    const res = await postPipelines(app, body);
    expect(res.status).toBe(400);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('VALIDATION_ERROR');
    expect(json.errors[0].fields).toEqual(['replication_tables']);
  });

  it('rejects a pipeline_name longer than 128 characters with 400 listing pipeline_name (Req 1.7)', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run on a validation error');
      }),
    );

    const body = validCreateBody();
    body.pipeline_name = 'x'.repeat(129);

    const res = await postPipelines(app, body);
    expect(res.status).toBe(400);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('VALIDATION_ERROR');
    expect(json.errors[0].fields).toContain('pipeline_name');
  });
});

// ── 2. Duplicate name → 409 (Req 1.6) ────────────────────────────────────

describe('POST /pipelines — duplicate name (Req 1.6)', () => {
  it('maps PipelineNameConflictError to 409 PIPELINE_NAME_CONFLICT', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new PipelineNameConflictError('analytics-pipeline');
      }),
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(409);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('PIPELINE_NAME_CONFLICT');
    // The conflicting name surfaces in the message.
    expect(json.errors[0].message).toContain('analytics-pipeline');
  });
});

// ── 3. Pipeline limit → 403 (Req 1.7) ────────────────────────────────────

describe('POST /pipelines — site pipeline limit (Req 1.7)', () => {
  it('maps PipelineLimitExceededError to 403 PIPELINE_LIMIT_EXCEEDED', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new PipelineLimitExceededError(SITE_ID);
      }),
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(403);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('PIPELINE_LIMIT_EXCEEDED');
    expect(json.errors[0].message).toContain('50');
  });
});

// ── 4. Connectivity check → 408 timeout / 400 unreachable (Req 1.5) ──────

describe('POST /pipelines — connectivity check (Req 1.5)', () => {
  it('maps a timeout ConnectivityCheckError to 408 CONNECTIVITY_TIMEOUT and surfaces the endpoint', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        // The registry wraps the underlying reason into the message; a
        // "timed out" reason routes to 408 (see routes.ts `isTimeout`).
        throw new ConnectivityCheckError('source', 'Connection timed out');
      }),
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(408);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('CONNECTIVITY_TIMEOUT');
    expect(json.errors[0].endpoint).toBe('source');
  });

  it('maps a non-timeout ConnectivityCheckError to 400 CONNECTIVITY_CHECK_FAILED and surfaces the endpoint', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new ConnectivityCheckError('sink', 'ECONNREFUSED');
      }),
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(400);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('CONNECTIVITY_CHECK_FAILED');
    expect(json.errors[0].endpoint).toBe('sink');
  });
});

// ── 5. Auth + tenant gate (SECURITY) ─────────────────────────────────────

describe('POST /pipelines — auth + tenant gate', () => {
  it('returns 403 FORBIDDEN when the principal lacks the admin role', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run when the guard rejects');
      }),
      { roles: ['editor'] },
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(403);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('FORBIDDEN');
  });

  it('returns 403 FORBIDDEN when the principal is not an admin for the selected site', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run when the guard rejects');
      }),
      { siteAdmin: false },
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(403);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('FORBIDDEN');
    expect(json.errors[0].message).toContain('requested site');
  });

  it('returns 400 TENANT_REQUIRED when no siteId is set (admin but no site context)', async () => {
    const app = buildApp(
      fakeRegistry(async () => {
        throw new Error('registry.create must not run when the guard rejects');
      }),
      { siteId: null },
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(400);

    const json = (await res.json()) as ErrorEnvelope;
    expect(json.errors[0].code).toBe('TENANT_REQUIRED');
  });
});

// ── 6. Happy path → 201 with a connection-secret-free body ───────────────

describe('POST /pipelines — happy path', () => {
  it('returns 201 with the serialized pipeline and never echoes connection secrets', async () => {
    const app = buildApp(
      fakeRegistry(async (siteId, input) => {
        expect(siteId).toBe(SITE_ID);
        expect(input.pipeline_name).toBe('analytics-pipeline');
        return fakeRecord();
      }),
    );

    const res = await postPipelines(app, validCreateBody());
    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      data: Record<string, unknown>;
    };
    expect(json.data.id).toBe('pipe_abc123');
    expect(json.data.pipelineName).toBe('analytics-pipeline');
    expect(json.data.status).toBe('provisioning');
    // Write-only secrets must not be projected back over the API.
    expect(json.data).not.toHaveProperty('sourceConnection');
    expect(json.data).not.toHaveProperty('sinkConnection');
    expect(json.data).not.toHaveProperty('intermediaryConnection');
  });
});
