/**
 * CDC API routes — RESTful control plane for the ClickHouse CDC system
 * (ClickHouse CDC — task 12.1; design "CDC API Routes" §7, Requirements
 * 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 7.4, 7.5, 7.6, 8.5).
 *
 * Mounted under `/api/v1/cdc/` (task 12.2 wires this router into the
 * authenticated `api` Hono in `apps/cms/src/index.ts`). The endpoints are:
 *
 *   POST   /pipelines                 — create a pipeline (with validation)
 *   GET    /pipelines                 — list pipelines for the active site
 *   GET    /pipelines/:id             — get pipeline details
 *   PATCH  /pipelines/:id             — update pipeline config
 *   DELETE /pipelines/:id             — delete pipeline (+ slot cleanup, Req 1.8)
 *   POST   /pipelines/:id/start       — start replication
 *   POST   /pipelines/:id/stop        — stop replication
 *   GET    /pipelines/:id/health      — run connectivity health check (Req 8.5)
 *   GET    /pipelines/:id/metrics     — current metrics
 *   GET    /pipelines/:id/metrics/history — historical metrics
 *   POST   /deploy                    — trigger AI deployment flow
 *   POST   /deploy/validate-env       — validate env vars (Req 7.4, 7.5)
 *   POST   /deploy/:id/rollback       — rollback a deployment (Req 7.6)
 *
 * ── Auth + tenant scoping (SECURITY) ─────────────────────────────────────
 *
 * These are network-exposed control-plane endpoints. This router is designed
 * to be mounted UNDER the authenticated `api` Hono (task 12.2), where
 * `withTenant` + `withAuth` + `withDb` + `withRls` run upstream — so a
 * missing principal is already a 401 and `siteId` / `db` are populated before
 * any handler runs. On top of that, this router enforces TWO gates on EVERY
 * route via a shared middleware (mirroring `routes/admin-security.ts`'s
 * `requireAdmin`):
 *
 *   1. **Admin role** — `c.get('auth').roles` must contain `'admin'`, else a
 *      flat `403 { errors: [{ code: 'FORBIDDEN' }] }`. CDC pipelines move
 *      tenant data between data stores, so the surface is admin-only.
 *   2. **Site context** — `c.get('siteId')` must be present (set by
 *      `withTenant`), else `400 { errors: [{ code: 'TENANT_REQUIRED' }] }`.
 *   3. **Site-bound admin access** — because `siteId` may be selected by an
 *      `X-Lumi-Site` header, the guard resolves the principal's permission
 *      bundle for that exact site and requires `adminAccess` before any
 *      registry call receives the site id.
 *
 * NOTE FOR TASK 12.2: this router MUST be mounted on the AUTHENTICATED `api`
 * Hono (e.g. `api.route('/cdc', cdcRouter)`), NOT on the public top-level
 * `app`, so `withAuth`/`withTenant` actually run. If wired onto the public
 * app the admin/site gates here would still reject (no `auth`/`siteId`), but
 * the intended upstream auth middleware would be bypassed.
 *
 * ── Connection secrets are write-only ────────────────────────────────────
 *
 * The Pipeline Registry decrypts `source`/`sink`/`intermediary` connection
 * strings when it maps a row to a {@link PipelineRecord}. This router NEVER
 * echoes those plaintext secrets back over the API: {@link serializePipeline}
 * projects a pipeline to a safe view that omits all connection strings.
 * Connections are supplied on create/update (write) and are never returned.
 *
 * ── Error → HTTP mapping (design "Error Handling" tables) ─────────────────
 *
 * Pipeline registration (design "Pipeline Registration Errors"):
 *   - missing required fields → 400 VALIDATION_ERROR with the field list
 *   - name > 128 chars         → 400 VALIDATION_ERROR (same Zod path)
 *   - duplicate name           → 409 PIPELINE_NAME_CONFLICT
 *   - site at 50 limit         → 403 PIPELINE_LIMIT_EXCEEDED
 *   - connectivity unreachable → 400 CONNECTIVITY_CHECK_FAILED (+ endpoint)
 *   - connectivity timeout     → 408 CONNECTIVITY_TIMEOUT (+ endpoint)
 *   - not found                → 404 PIPELINE_NOT_FOUND
 *   - slot cleanup fails       → 409 REPLICATION_SLOT_CLEANUP_FAILED (record
 *     kept so the orphaned slot is not forgotten — Req 1.8)
 *
 * Env var validation (Req 7.5): invalid fields + violated constraints are
 * returned with `400 ENV_VALIDATION_ERROR`.
 *
 * ── Testable service injection (task 12.3) ───────────────────────────────
 *
 * The router is built by {@link createCdcRouter}, which takes an optional
 * per-request services factory. The factory returns a (partial)
 * {@link CdcRouteServices}; any field it omits falls back to the real
 * implementation built from the request context ({@link defaultCdcServicesFactory}).
 * This lets task 12.3 inject a fake `registry` (to drive the 400 field-list,
 * 409 duplicate, 403 limit, and 408 timeout responses) without a live
 * Postgres, while production uses {@link cdcRouter} (the default instance).
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 7.4, 7.5, 7.6, 8.5
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { cdcDeployments, users } from '@lumibase/database';
import { PipelineCreateSchema, CdcConnectorTypeSchema } from '@lumibase/shared';

import type { AppEnv } from '../../env';
import { PermissionService } from '../../services/permission-service';
import type {
  CdcConnector,
  CdcConnectorType,
  HealthCheckResult,
  PipelineMetrics,
} from './connectors/types';
import { DebeziumKafkaConnector } from './connectors/debezium-kafka';
import { MaterializedEngineConnector } from './connectors/materialized-engine';
import { AirbyteConnector } from './connectors/airbyte';
import {
  PipelineRegistry,
  PipelineLimitExceededError,
  PipelineNameConflictError,
  ConnectivityCheckError,
  PipelineNotFoundError,
  ReplicationSlotCleanupError,
  type ConnectorResolver,
  type PipelineCreateInput,
  type PipelinePatchInput,
  type PipelineRecord,
  type PipelineRegistryService,
} from './registry/pipeline-registry';
import {
  HealthMonitor,
  DrizzleHealthHistoryStore,
  DEFAULT_RETENTION_DAYS,
  MS_PER_DAY,
  type HealthMetricEntry,
} from './health-monitor';
import {
  generateConfig,
  type DeploymentTarget,
  type EnvironmentConfig,
  type EnvVarDefinition as GeneratorVarDef,
  type EnvVarValidation as GeneratorValidation,
} from './ai-flow/config-generator';
import {
  validateEnvVars,
  type EnvVarDefinition as ValidatorVarDef,
  type EnvVarValidationRule,
  type ValidationResult,
} from './ai-flow/env-validator';
import {
  DeploymentOrchestrator,
  type DeploymentResult,
  type DeploymentStep,
} from './ai-flow/deployment-orchestrator';
import {
  RollbackManager,
  type RollbackInput,
  type RollbackResult,
} from './ai-flow/rollback-manager';

/**
 * Thrown when CDC is used without an `ENCRYPTION_KEY` configured. There is no
 * in-repo fallback key on purpose (CWE-321): a committed default would let
 * anyone with the source decrypt stored connection strings.
 */
class EncryptionKeyMissingError extends Error {
  readonly code = 'ENCRYPTION_KEY_MISSING' as const;
  constructor() {
    super(
      'CDC requires ENCRYPTION_KEY to be configured. Set it before creating or reading pipelines.',
    );
    this.name = 'EncryptionKeyMissingError';
  }
}

// ── connector singletons (Req 1.2) ──────────────────────────────────────

/**
 * Process-shared connector instances. The CDC connectors keep per-pipeline
 * state in-process (populated by `provision`), so a single shared instance
 * per type is used rather than a fresh instance per request — otherwise a
 * pipeline provisioned on one request would be invisible to the next. A
 * production deployment that runs connectors out-of-process would inject a
 * resolver backed by that shared state via {@link createCdcRouter}.
 */
const debeziumConnector = new DebeziumKafkaConnector();
const materializedConnector = new MaterializedEngineConnector();
const airbyteConnector = new AirbyteConnector();

/** Default {@link ConnectorResolver} mapping a connector type to its instance. */
const defaultConnectorResolver: ConnectorResolver = (type) => {
  switch (type) {
    case 'debezium_kafka':
      return debeziumConnector;
    case 'materialized_engine':
      return materializedConnector;
    case 'airbyte':
      return airbyteConnector;
    default:
      return null;
  }
};

/** Thrown internally when no connector backs a pipeline's connector type. */
class ConnectorUnavailableError extends Error {
  readonly code = 'CONNECTOR_UNAVAILABLE' as const;
  constructor(connectorType: string) {
    super(`No connector is available for type "${connectorType}"`);
    this.name = 'ConnectorUnavailableError';
  }
}

// ── request body schemas ─────────────────────────────────────────────────

/**
 * PATCH body for a pipeline update. Mirrors {@link PipelinePatchInput}: every
 * field is optional, `intermediary_connection` is nullable (explicit `null`
 * clears it), and the same constraints as create apply (name ≤ 128 chars,
 * non-empty connection strings, ≥ 1 replication table).
 */
const PipelinePatchSchema = z.object({
  pipeline_name: z.string().min(1).max(128).optional(),
  source_database_connection: z.string().min(1).optional(),
  clickhouse_sink_connection: z.string().min(1).optional(),
  intermediary_connection: z.string().min(1).nullable().optional(),
  replication_tables: z.array(z.string().min(1)).min(1).optional(),
  config: z.record(z.unknown()).optional(),
});

/** Deployment target enum (mirrors {@link DeploymentTarget}). */
const DeploymentTargetSchema = z.enum(['docker_compose', 'cloudflare_workers']);

/** POST /deploy body. */
const DeployBodySchema = z.object({
  approach: CdcConnectorTypeSchema,
  target: DeploymentTargetSchema,
  pipeline_id: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
});

/** POST /deploy/validate-env body. */
const ValidateEnvBodySchema = z.object({
  approach: CdcConnectorTypeSchema,
  target: DeploymentTargetSchema,
  env: z.record(z.string()),
});

// ── injectable services (task 12.3) ──────────────────────────────────────

/**
 * The collaborators each CDC route handler needs. Built per-request from the
 * context by {@link defaultCdcServicesFactory}; a (partial) override may be
 * supplied to {@link createCdcRouter} for testing.
 */
export interface CdcRouteServices {
  /** Pipeline CRUD + lifecycle (site-scoped). */
  readonly registry: PipelineRegistryService;
  /** Resolves the connector implementation for a connector type. */
  readonly resolveConnector: ConnectorResolver;
  /** Verify the authenticated principal has admin access for this request's site. */
  authorizeSiteAdmin(siteId: string): Promise<boolean>;
  /** Run a connectivity health check for a pipeline (Req 8.5). */
  checkHealth(pipeline: PipelineRecord): Promise<HealthCheckResult>;
  /** Fetch current operational metrics for a pipeline (Req 8.1). */
  getMetrics(pipeline: PipelineRecord): Promise<PipelineMetrics>;
  /** Fetch retained health history for a pipeline since a timestamp (Req 8.4). */
  getHistory(pipelineId: string, since: Date): Promise<HealthMetricEntry[]>;
  /** Generate a deployment env config for an approach + target (Req 7.1). */
  generateConfig(
    approach: CdcConnectorType,
    target: DeploymentTarget,
  ): EnvironmentConfig;
  /** Validate submitted env vars against a definition set (Req 7.4, 7.5). */
  validateEnvVars(
    definitions: readonly ValidatorVarDef[],
    vars: Record<string, string>,
  ): ValidationResult;
  /** Run the deployment orchestrator for a config (Req 7.2, 7.3, 7.7). */
  deploy(config: EnvironmentConfig): Promise<DeploymentResult>;
  /** Roll back a deployment's completed steps in reverse order (Req 7.6). */
  rollback(input: RollbackInput): Promise<RollbackResult>;
}

/** A per-request factory producing (a subset of) {@link CdcRouteServices}. */
export type CdcServicesFactory = (
  c: Context<AppEnv>,
) => Partial<CdcRouteServices>;

/**
 * Build the real {@link CdcRouteServices} from the request context: a
 * {@link PipelineRegistry} bound to the per-request Drizzle client and the
 * configured `ENCRYPTION_KEY`, the connector singletons, and the AI-flow
 * services. The health operations delegate to {@link HealthMonitor} (Req 8.5,
 * 8.4) backed by a {@link DrizzleHealthHistoryStore}.
 */
export function defaultCdcServicesFactory(
  c: Context<AppEnv>,
): CdcRouteServices {
  const db = c.get('db');
  const processEncryptionKey =
    typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined;
  const encryptionKey = c.env?.ENCRYPTION_KEY ?? processEncryptionKey;
  if (!encryptionKey) {
    // Fail closed: CDC connection parameters MUST be encrypted (Req 1.4). We do
    // NOT fall back to an in-repo default key — that would let anyone with the
    // source decrypt stored connection strings (CWE-321). Operators must set
    // ENCRYPTION_KEY.
    throw new EncryptionKeyMissingError();
  }

  const registry = new PipelineRegistry({
    db,
    encryptionKey,
    connectorResolver: defaultConnectorResolver,
  });

  return {
    registry,
    resolveConnector: defaultConnectorResolver,
    authorizeSiteAdmin: () => authorizeCurrentPrincipalForSite(c),
    async checkHealth(pipeline) {
      const connector = defaultConnectorResolver(pipeline.connectorType);
      if (!connector) throw new ConnectorUnavailableError(pipeline.connectorType);
      // Delegate to HealthMonitor.checkHealth (Req 8.5); the resolver returns
      // the already-resolved connector for this pipeline.
      const monitor = new HealthMonitor({
        metricsSourceResolver: () => connector,
        historyStore: new DrizzleHealthHistoryStore(db),
      });
      return monitor.checkHealth(pipeline.id);
    },
    async getMetrics(pipeline) {
      const connector = defaultConnectorResolver(pipeline.connectorType);
      if (!connector) throw new ConnectorUnavailableError(pipeline.connectorType);
      return connector.getMetrics(pipeline.id);
    },
    async getHistory(pipelineId, since) {
      const monitor = new HealthMonitor({
        historyStore: new DrizzleHealthHistoryStore(db),
      });
      return monitor.getHistory(pipelineId, since);
    },
    generateConfig,
    validateEnvVars,
    async deploy(config) {
      return new DeploymentOrchestrator().deploy(config);
    },
    async rollback(input) {
      return new RollbackManager().rollback(input);
    },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

type ErrorBody = {
  errors: Array<{ code: string; message?: string; [key: string]: unknown }>;
};

/** Build a standard error envelope. */
function errorBody(
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): ErrorBody {
  return { errors: [{ code, ...(message ? { message } : {}), ...(extra ?? {}) }] };
}

/**
 * Project a {@link PipelineRecord} to the API-safe shape. Connection strings
 * (`source`/`sink`/`intermediary`) are deliberately OMITTED — they are
 * write-only secrets and are never echoed back over the API.
 */
function serializePipeline(p: PipelineRecord) {
  return {
    id: p.id,
    siteId: p.siteId,
    pipelineName: p.pipelineName,
    connectorType: p.connectorType,
    status: p.status,
    statusMessage: p.statusMessage,
    replicationTables: p.replicationTables,
    config: p.config,
    lastSyncAt: p.lastSyncAt,
    lastSyncRecordCount: p.lastSyncRecordCount,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Resolve whether the authenticated principal is an admin for the selected
 * site. The tenant id may originate from a request header, so CDC control-plane
 * access must be tied back to site membership before handlers use it.
 */
async function authorizeCurrentPrincipalForSite(
  c: Context<AppEnv>,
): Promise<boolean> {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? auth.roles : [];
  const devAuthEnabled =
    c.env.LUMIBASE_DEV_AUTH === 'true' || process.env.LUMIBASE_DEV_AUTH === 'true';
  if (devAuthEnabled && auth?.raw?.dev === true && roles.includes('admin')) {
    return true;
  }

  const siteId = c.get('siteId');
  const userId = await resolveAuthUserId(c);
  if (!siteId || !userId) return false;

  const headers = collectRequestHeaders(c);
  const bundle = await new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime')?.cache,
    ctx: {
      userId,
      siteId,
      roleId: null,
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
      headers,
      apiKey: auth?.apiKey ?? null,
    },
  }).bundle();

  return bundle.admin;
}

/** Resolve a DB user id for JWT or Cloudflare Access principals. */
async function resolveAuthUserId(c: Context<AppEnv>): Promise<string | null> {
  const auth = c.get('auth');
  if (auth?.userId) return auth.userId;
  if (!auth?.externalId) return null;

  const [row] = await c
    .get('db')
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalId, auth.externalId))
    .limit(1);
  return row?.id ?? null;
}

function collectRequestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/** Whether a connectivity error was a timeout (→ 408) vs. unreachable (→ 400). */
function isTimeout(err: Error): boolean {
  return /timeout|timed out/i.test(err.message);
}

/** Human-readable message for an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a Zod parse failure to a `400 VALIDATION_ERROR` body whose `fields`
 * lists exactly the offending top-level field names (Req 1.3 / Property 2)
 * plus per-issue `details`.
 */
function zodErrorBody(error: z.ZodError): ErrorBody {
  const fields = [
    ...new Set(
      error.issues
        .map((i) => i.path[0])
        .filter((p): p is string => typeof p === 'string'),
    ),
  ];
  return {
    errors: [
      {
        code: 'VALIDATION_ERROR',
        fields,
        details: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      },
    ],
  };
}

/**
 * Map a Pipeline Registry error to its HTTP response (design "Pipeline
 * Registration Errors"). Returns `null` for an unrecognised error so the
 * caller can rethrow it to the global `onError` 500 handler.
 */
function registryErrorResponse(
  c: Context<AppEnv>,
  err: unknown,
): Response | null {
  if (err instanceof EncryptionKeyMissingError) {
    // Server misconfiguration: fail closed with a 503 rather than encrypting
    // with a weak/known default (CWE-321).
    return c.json(errorBody('ENCRYPTION_KEY_MISSING', err.message), 503);
  }
  if (err instanceof PipelineNameConflictError) {
    return c.json(errorBody('PIPELINE_NAME_CONFLICT', err.message), 409);
  }
  if (err instanceof PipelineLimitExceededError) {
    return c.json(errorBody('PIPELINE_LIMIT_EXCEEDED', err.message), 403);
  }
  if (err instanceof ConnectivityCheckError) {
    const timeout = isTimeout(err);
    return c.json(
      errorBody(
        timeout ? 'CONNECTIVITY_TIMEOUT' : 'CONNECTIVITY_CHECK_FAILED',
        err.message,
        { endpoint: err.endpoint },
      ),
      timeout ? 408 : 400,
    );
  }
  if (err instanceof PipelineNotFoundError) {
    return c.json(errorBody('PIPELINE_NOT_FOUND', err.message), 404);
  }
  if (err instanceof ReplicationSlotCleanupError) {
    // The registry keeps the record so the orphaned slot is not forgotten
    // (Req 1.8); surface the failure so the operator can retry the delete.
    return c.json(
      errorBody('REPLICATION_SLOT_CLEANUP_FAILED', err.message, {
        pipelineId: err.pipelineId,
      }),
      409,
    );
  }
  return null;
}

/**
 * Translate a config-generator {@link GeneratorValidation} into the
 * env-validator's discriminated {@link EnvVarValidationRule}. The generator
 * carries validation as `{ rule, pattern?, enum?, min?, max? }` (no `type`
 * discriminant), so this applies a small, deterministic heuristic:
 *   - an `enum` → an enum rule;
 *   - an integer-only `pattern` (`^[0-9]+$` / `^[1-9][0-9]*$`) → a number rule
 *     whose `min`/`max` are numeric bounds;
 *   - any other `pattern` → a string rule matching that pattern (with the
 *     human-readable `rule` as the description), treating `min`/`max` as
 *     length bounds;
 *   - otherwise → a length-bounded string rule.
 */
function generatorRuleToValidatorRule(
  v: GeneratorValidation,
): EnvVarValidationRule {
  if (v.enum && v.enum.length > 0) {
    return { type: 'enum', values: [...v.enum] };
  }
  const numericPattern =
    v.pattern === '^[0-9]+$' || v.pattern === '^[1-9][0-9]*$';
  if (numericPattern) {
    return { type: 'number', integer: true, min: v.min, max: v.max };
  }
  if (v.pattern) {
    return {
      type: 'string',
      pattern: v.pattern,
      patternDescription: v.rule,
      minLength: v.min,
      maxLength: v.max,
    };
  }
  return { type: 'string', minLength: v.min, maxLength: v.max };
}

/** Convert generated env-var definitions to the env-validator's def shape. */
function toValidatorDefs(
  vars: readonly GeneratorVarDef[],
): ValidatorVarDef[] {
  return vars.map((v) => ({
    key: v.key,
    required: v.required,
    validation: v.validation
      ? generatorRuleToValidatorRule(v.validation)
      : undefined,
  }));
}

// ── router factory ───────────────────────────────────────────────────────

/**
 * Build the CDC router. The optional `servicesFactory` lets callers (tests)
 * inject a partial {@link CdcRouteServices}; any omitted field falls back to
 * {@link defaultCdcServicesFactory}. The default export {@link cdcRouter} is
 * built with the production factory.
 */
export function createCdcRouter(
  servicesFactory?: CdcServicesFactory,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /** Resolve the per-request services (defaults merged with any override). */
  const resolveServices = (c: Context<AppEnv>): CdcRouteServices => {
    const base = defaultCdcServicesFactory(c);
    const override = servicesFactory?.(c);
    return override ? { ...base, ...override } : base;
  };

  // ── auth + tenant gate on every CDC route (SECURITY) ──────────────────
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const auth = c.get('auth');
    const roles = Array.isArray(auth?.roles) ? auth.roles : [];
    if (!roles.includes('admin')) {
      return c.json(errorBody('FORBIDDEN', 'Admin role required.'), 403);
    }
    const siteId = c.get('siteId');
    if (!siteId) {
      return c.json(
        errorBody('TENANT_REQUIRED', 'X-Lumi-Site header is required.'),
        400,
      );
    }
    let services: CdcRouteServices;
    try {
      services = resolveServices(c);
    } catch (err) {
      // Surface server misconfiguration (e.g. missing ENCRYPTION_KEY) as a clean
      // response on every CDC route instead of a bare 500.
      const mapped = registryErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
    if (!(await services.authorizeSiteAdmin(siteId))) {
      return c.json(
        errorBody('FORBIDDEN', 'Admin access for the requested site is required.'),
        403,
      );
    }
    return next();
  };
  router.use('*', guard);

  // ── POST /pipelines — create (Req 1.1, 1.2, 1.3, 1.5, 1.6, 1.7) ───────
  router.post('/pipelines', async (c) => {
    const siteId = c.get('siteId');
    const services = resolveServices(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody('VALIDATION_ERROR', 'invalid JSON'), 400);
    }

    const parsed = PipelineCreateSchema.safeParse(raw);
    if (!parsed.success) {
      // Lists exactly the missing/invalid field names (Req 1.3 / Property 2).
      return c.json(zodErrorBody(parsed.error), 400);
    }

    try {
      const pipeline = await services.registry.create(
        siteId,
        parsed.data as PipelineCreateInput,
      );
      return c.json({ data: serializePipeline(pipeline) }, 201);
    } catch (err) {
      const mapped = registryErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // ── GET /pipelines — list for site (Req 6.1 surface) ──────────────────
  router.get('/pipelines', async (c) => {
    const siteId = c.get('siteId');
    const services = resolveServices(c);
    const pipelines = await services.registry.list(siteId);
    return c.json({ data: { pipelines: pipelines.map(serializePipeline) } }, 200);
  });

  // ── GET /pipelines/:id — details ──────────────────────────────────────
  router.get('/pipelines/:id', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);
    const pipeline = await services.registry.get(siteId, id);
    if (!pipeline) {
      return c.json(errorBody('PIPELINE_NOT_FOUND', `Pipeline "${id}" not found`), 404);
    }
    return c.json({ data: serializePipeline(pipeline) }, 200);
  });

  // ── PATCH /pipelines/:id — update config (Req 1.5, 1.6) ───────────────
  router.patch('/pipelines/:id', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody('VALIDATION_ERROR', 'invalid JSON'), 400);
    }

    const parsed = PipelinePatchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(zodErrorBody(parsed.error), 400);
    }

    try {
      const pipeline = await services.registry.update(
        siteId,
        id,
        parsed.data as PipelinePatchInput,
      );
      return c.json({ data: serializePipeline(pipeline) }, 200);
    } catch (err) {
      const mapped = registryErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // ── DELETE /pipelines/:id — delete (+ slot cleanup, Req 1.8) ──────────
  router.delete('/pipelines/:id', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);
    try {
      await services.registry.delete(siteId, id);
      return c.json({ data: { deleted: true, id } }, 200);
    } catch (err) {
      const mapped = registryErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // ── POST /pipelines/:id/start — start replication ─────────────────────
  router.post('/pipelines/:id/start', (c) => transition(c, resolveServices(c), 'start'));

  // ── POST /pipelines/:id/stop — stop replication ───────────────────────
  router.post('/pipelines/:id/stop', (c) => transition(c, resolveServices(c), 'stop'));

  // ── GET /pipelines/:id/health — connectivity health check (Req 8.5) ───
  router.get('/pipelines/:id/health', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);

    const pipeline = await services.registry.get(siteId, id);
    if (!pipeline) {
      return c.json(errorBody('PIPELINE_NOT_FOUND', `Pipeline "${id}" not found`), 404);
    }

    try {
      const health = await services.checkHealth(pipeline);
      return c.json({ data: health }, 200);
    } catch (err) {
      if (err instanceof ConnectorUnavailableError) {
        return c.json(errorBody('CONNECTOR_UNAVAILABLE', err.message), 503);
      }
      return c.json(errorBody('CONNECTOR_ERROR', errorMessage(err)), 502);
    }
  });

  // ── GET /pipelines/:id/metrics — current metrics (Req 8.1) ────────────
  router.get('/pipelines/:id/metrics', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);

    const pipeline = await services.registry.get(siteId, id);
    if (!pipeline) {
      return c.json(errorBody('PIPELINE_NOT_FOUND', `Pipeline "${id}" not found`), 404);
    }

    try {
      const metrics = await services.getMetrics(pipeline);
      return c.json({ data: metrics }, 200);
    } catch (err) {
      if (err instanceof ConnectorUnavailableError) {
        return c.json(errorBody('CONNECTOR_UNAVAILABLE', err.message), 503);
      }
      return c.json(errorBody('CONNECTOR_ERROR', errorMessage(err)), 502);
    }
  });

  // ── GET /pipelines/:id/metrics/history — historical metrics (Req 8.4) ─
  router.get('/pipelines/:id/metrics/history', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);

    const pipeline = await services.registry.get(siteId, id);
    if (!pipeline) {
      return c.json(errorBody('PIPELINE_NOT_FOUND', `Pipeline "${id}" not found`), 404);
    }

    // Default window: the full retention period (7 days, Req 8.4).
    let since = new Date(Date.now() - DEFAULT_RETENTION_DAYS * MS_PER_DAY);
    const sinceParam = c.req.query('since');
    if (sinceParam) {
      const parsed = new Date(sinceParam);
      if (Number.isNaN(parsed.getTime())) {
        return c.json(
          errorBody('VALIDATION_ERROR', '"since" must be an ISO-8601 date-time.'),
          400,
        );
      }
      since = parsed;
    }

    const history = await services.getHistory(id, since);
    return c.json({ data: { history, since: since.toISOString() } }, 200);
  });

  // ── POST /deploy — trigger AI deployment flow (Req 7.1, 7.2, 7.7) ─────
  router.post('/deploy', async (c) => {
    const siteId = c.get('siteId');
    const services = resolveServices(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody('VALIDATION_ERROR', 'invalid JSON'), 400);
    }

    const parsed = DeployBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(zodErrorBody(parsed.error), 400);
    }
    const { approach, target, pipeline_id, env } = parsed.data;

    const config = services.generateConfig(approach, target);

    // If env values were supplied, validate them before deploying (Req 7.4).
    if (env) {
      const result = services.validateEnvVars(
        toValidatorDefs(config.variables),
        env,
      );
      if (!result.valid) {
        return c.json(
          errorBody('ENV_VALIDATION_ERROR', 'Environment variable validation failed.', {
            invalidFields: result.invalidFields,
          }),
          400,
        );
      }
    }

    const deployment = await services.deploy(config);

    // Persist the deployment record so it can later be rolled back by id.
    const db = c.get('db');
    if (db) {
      await db.insert(cdcDeployments).values({
        id: deployment.deploymentId,
        siteId,
        pipelineId: pipeline_id ?? null,
        approach,
        target,
        status: deployment.status,
        steps: deployment.steps,
        envConfig: env ?? {},
        errorMessage: deployment.error?.description ?? null,
        completedAt: new Date(deployment.completedAt),
      });
    }

    return c.json({ data: deployment }, 201);
  });

  // ── POST /deploy/validate-env — validate env vars (Req 7.4, 7.5) ──────
  router.post('/deploy/validate-env', async (c) => {
    const services = resolveServices(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody('VALIDATION_ERROR', 'invalid JSON'), 400);
    }

    const parsed = ValidateEnvBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(zodErrorBody(parsed.error), 400);
    }
    const { approach, target, env } = parsed.data;

    const config = services.generateConfig(approach, target);
    const result = services.validateEnvVars(
      toValidatorDefs(config.variables),
      env,
    );

    if (!result.valid) {
      // Return the invalid fields with their violated constraints (Req 7.5).
      return c.json(
        errorBody('ENV_VALIDATION_ERROR', 'Environment variable validation failed.', {
          invalidFields: result.invalidFields,
        }),
        400,
      );
    }
    return c.json({ data: { valid: true } }, 200);
  });

  // ── POST /deploy/:id/rollback — rollback a deployment (Req 7.6) ───────
  router.post('/deploy/:id/rollback', async (c) => {
    const siteId = c.get('siteId');
    const id = c.req.param('id');
    const services = resolveServices(c);

    const db = c.get('db');
    if (!db) {
      return c.json(
        errorBody('SERVICE_UNAVAILABLE', 'Deployment store is unavailable.'),
        503,
      );
    }

    const rows = await db
      .select()
      .from(cdcDeployments)
      .where(and(eq(cdcDeployments.id, id), eq(cdcDeployments.siteId, siteId)))
      .limit(1);
    const deployment = rows[0];
    if (!deployment) {
      return c.json(
        errorBody('DEPLOYMENT_NOT_FOUND', `Deployment "${id}" not found`),
        404,
      );
    }

    // Reconstruct the rollback input from the persisted steps: the completed
    // steps are undone in reverse order; the failed step (if any) seeds the
    // failure report (Req 7.6).
    const steps = (deployment.steps as DeploymentStep[]) ?? [];
    const completedSteps = steps
      .filter((s) => s.status === 'completed' || s.status === 'rolled_back')
      .map((s) => ({ name: s.name }));
    const failed = steps.find((s) => s.status === 'failed');
    const input: RollbackInput = {
      completedSteps,
      failedStep: {
        name: failed?.name ?? id,
        error: new Error(
          deployment.errorMessage ?? 'Deployment rolled back by request.',
        ),
      },
    };

    const result = await services.rollback(input);

    await db
      .update(cdcDeployments)
      .set({ status: 'rolled_back', completedAt: new Date() })
      .where(and(eq(cdcDeployments.id, id), eq(cdcDeployments.siteId, siteId)));

    return c.json({ data: result }, 200);
  });

  return router;
}

/**
 * Shared start/stop handler. Verifies the pipeline belongs to the active site
 * (404 otherwise), drives the resolved connector's lifecycle method, then
 * records the new status in the registry (`active` for start, `paused` for
 * stop). A missing connector → 503; a connector error → 502.
 */
async function transition(
  c: Context<AppEnv>,
  services: CdcRouteServices,
  action: 'start' | 'stop',
): Promise<Response> {
  const siteId = c.get('siteId');
  const id = c.req.param('id');
  if (!id) {
    return c.json(errorBody('PIPELINE_NOT_FOUND', 'Pipeline id is required'), 404);
  }

  const pipeline = await services.registry.get(siteId, id);
  if (!pipeline) {
    return c.json(errorBody('PIPELINE_NOT_FOUND', `Pipeline "${id}" not found`), 404);
  }

  const connector: CdcConnector | null | undefined = services.resolveConnector(
    pipeline.connectorType,
  );
  if (!connector) {
    return c.json(
      errorBody('CONNECTOR_UNAVAILABLE', `No connector available for "${pipeline.connectorType}"`),
      503,
    );
  }

  try {
    if (action === 'start') {
      await connector.start(id);
    } else {
      await connector.stop(id);
    }
  } catch (err) {
    return c.json(errorBody('CONNECTOR_ERROR', errorMessage(err)), 502);
  }

  const nextStatus = action === 'start' ? 'active' : 'paused';
  await services.registry.updateStatus(id, nextStatus);

  const updated = await services.registry.get(siteId, id);
  return c.json({ data: serializePipeline(updated ?? pipeline) }, 200);
}

/** Production CDC router (built with the real, context-derived services). */
export const cdcRouter = createCdcRouter();
