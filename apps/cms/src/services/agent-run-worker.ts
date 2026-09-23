import type { Database } from '@lumibase/database';
import type { CacheProvider, KeyProvider, QueueProvider, SearchProvider } from '@lumibase/runtime';
import { AISecureHarness } from './ai-harness';
import { AgentRunService } from './agent-run-service';
import {
  EffectiveCapabilityService,
  type AuthenticatedPrincipalRef,
} from './effective-capability-service';
import {
  resolvePrincipalCapabilities,
  type GovernedCapabilityResolution,
} from './governed-capabilities';
import { itemServiceForSystem } from './item-service-factory';
import { createConfiguredLLMProvider, type LLMProviderEnv } from './llm-provider';
import { SchemaService } from './schema-service';

/**
 * Async agent run execution (Content OS task 3 / Req 3.2).
 *
 * `POST /api/v1/agent/goals` with `execution: 'async'` creates the goal and
 * a `queued` run, then enqueues this job on the `agent-runs` queue. The
 * worker picks it up outside the request runtime limit and drives the run
 * through the same harness codepath as synchronous execution — capability
 * checks, risk policy, budgets and audit all apply identically.
 */

export const AGENT_RUNS_QUEUE = 'agent-runs';

export interface AgentRunJobPayload {
  siteId: string;
  goalId: string;
  runId: string;
  skillName: string;
  arguments: Record<string, unknown>;
  /**
   * @deprecated Since #472 this is a compatibility field for jobs enqueued
   * before `principal` existed. A capability snapshot stays valid for as long as
   * the job sits in the queue, so a role change or a revoked key would not take
   * effect until the run finally executed. New enqueues send `principal` and the
   * worker re-resolves at pickup.
   */
  capabilities?: string[];
  /**
   * Server-issued principal reference. Carries no capabilities on purpose — the
   * worker resolves them from current database state when the job is picked up.
   */
  principal?: AuthenticatedPrincipalRef | null;
  userId?: string | null;
  contextMessage?: string;
  /**
   * Governance envelope for reconciler-originated work (#455).
   *
   * A reconciler run has no human principal — it is authorised by the intent
   * that declared the rule. These fields are what makes that authorisation
   * auditable and enforceable at pickup rather than implied:
   *
   * - `origin` keeps backpressure able to pause reconciler work only (Req 9.4).
   * - `intentId` scopes write budgets to the governing intent.
   * - `driftFingerprint` ties the run back to the exact violation it repairs.
   * - `autonomyCap` is the intent's ceiling; the resolver takes min(cap, grant).
   * - `agentRole` is the capability boundary, re-read at pickup (see
   *   {@link resolveWorkerCapabilities}) so disabling a role stops queued work.
   */
  origin?: string;
  intentId?: string | null;
  driftFingerprint?: string | null;
  autonomyCap?: number | null;
  agentRole?: string | null;
  /**
   * Run budget, read by the harness as `envelope.budget`. The per-intent
   * `maxWritesPerMinute` limit lives here: without it in the payload the limit is
   * stored on the intent and consulted nowhere, so a reconciler run would write
   * at an unlimited rate while the intent claimed a cap.
   */
  budget?: Record<string, unknown>;
}

export interface AgentRunWorkerDeps {
  db: Database;
  cache?: CacheProvider;
  search?: SearchProvider;
  queue?: QueueProvider;
  /**
   * KeyProvider for skills that decrypt stored provider secrets (deployment
   * targets). Without it the harness fails those skills with
   * `DEPLOYMENTS_NOT_CONFIGURED`, so a queued run must receive the same
   * provider the request path gets from `c.get('runtime').keys`.
   */
  keys?: KeyProvider;
  env: LLMProviderEnv & Record<string, string | undefined>;
}

/**
 * Resolves the capabilities a queued run executes with.
 *
 * Prefers the persisted principal reference and re-reads the grant from the
 * database. Falls back to the deprecated `capabilities` snapshot only for jobs
 * that predate `principal`; a job carrying neither resolves to no capabilities,
 * which the harness then denies.
 */
async function resolveWorkerCapabilities(
  deps: AgentRunWorkerDeps,
  payload: AgentRunJobPayload,
): Promise<GovernedCapabilityResolution> {
  if (payload.principal) {
    const service = new EffectiveCapabilityService({
      db: deps.db,
      siteId: payload.siteId,
      ...(deps.cache ? { cache: deps.cache } : {}),
      ...(deps.env.LUMIBASE_ENV ? { environment: deps.env.LUMIBASE_ENV } : {}),
    });
    return resolvePrincipalCapabilities(service, payload.principal);
  }

  // Reconciler-originated work (#455) has no human principal: the intent that
  // declared the rule is the authority, and the agent role is the capability
  // boundary. Resolving it HERE rather than trusting an enqueue-time snapshot is
  // what lets an operator disable the role and stop work already in the queue.
  // `AgentRoleService.effectiveCapabilities` returns [] for an unknown or
  // disabled role, which the harness then denies — fail closed, not fail open.
  if (payload.agentRole) {
    const { AgentRoleService } = await import('./agent-role-service');
    const roles = new AgentRoleService({ db: deps.db, siteId: payload.siteId });
    // The role library is seeded lazily, and until now the only thing that
    // triggered it was `list()` from the Studio roles page. A site where nobody
    // had opened that page had an empty `agent_roles` table, so every
    // reconciler run resolved to zero capabilities and failed
    // `capabilities_denied` — a background path silently gated on someone having
    // visited a UI. Seeding here makes the worker self-sufficient.
    await roles.ensureSeeded();
    // Grant `*` means "whatever the role allows": the role library is the
    // ceiling for agent work, and widening it is a human decision in Studio.
    const capabilities = await roles.effectiveCapabilities(payload.agentRole, ['*']);
    if (capabilities.length === 0) {
      return {
        allowed: false,
        capabilities: [],
        controlPlaneAdmin: false,
        code: 'PRINCIPAL_UNRESOLVED',
        message: `Agent role "${payload.agentRole}" is unknown or disabled; the run has no capabilities.`,
      };
    }
    return { allowed: true, capabilities, controlPlaneAdmin: false };
  }

  return {
    allowed: true,
    capabilities: payload.capabilities ?? [],
    controlPlaneAdmin: false,
  };
}

/**
 * Denials that mean "not now", not "no".
 *
 * The write-rate budget and the load guard deliberately do not fail a run: the
 * design is that the caller retries when quota or headroom returns. On the
 * synchronous path the caller is a human who can retry. On the queue path there is
 * no caller, and the run had already been moved to `running` by the claim — so
 * it stayed `running` forever, and a dispatcher that treats a live run as
 * "in flight" would skip its goal on every later pass. A deferral silently became
 * a permanently stuck goal, which is the exact failure mode #455 exists to remove.
 *
 * Settling these as `cancelled` with `stopReason: 'deferred'` makes the run
 * terminal, so dispatch can re-issue the phase, and keeps them out of the
 * repeated-failure dead-letter path — three deferrals are not three failures.
 */
const DEFERRAL_MARKERS = ['write_budget_exceeded', 'load_guard', 'backpressure'];

export const DEFERRED_STOP_REASON = 'deferred';

async function settleDeferralIfAny(
  runService: AgentRunService,
  runId: string,
  result: { status: string; message?: string } | undefined,
): Promise<void> {
  if (!result || result.status !== 'denied') return;
  const message = result.message ?? '';
  if (!DEFERRAL_MARKERS.some((marker) => message.includes(marker))) return;
  await runService.cancelRun(runId, DEFERRED_STOP_REASON);
}

/**
 * Executes one queued agent run. Cancellation between enqueue and pickup is
 * honoured (the run stays `cancelled`, nothing executes — Req 3.5). The
 * harness itself transitions the run to `awaiting_approval`, `succeeded`,
 * or `failed`.
 */
export async function processAgentRunJob(
  deps: AgentRunWorkerDeps,
  payload: AgentRunJobPayload,
): Promise<void> {
  const runService = new AgentRunService(deps.db, payload.siteId, deps.queue);

  // Exclusive claim, not a status check (#455 F3). At-least-once delivery means
  // this function can run twice for one job, concurrently; the conditional UPDATE
  // inside `claimQueuedRun` is what makes the second one a no-op instead of a
  // second execution. It also skips a run cancelled while queued, and a run parked
  // at `awaiting_approval` — resuming that belongs to the approval flow, and a
  // redelivery doing it is how a duplicate pending approval appeared.
  const started = await runService.claimQueuedRun(payload.runId);
  if (!started) {
    return;
  }

  // The agent identity is read from the persisted run, not the payload. The
  // harness keys the kill switch and the autonomy grant on `agentName`; without
  // it both fell back to `lumibase-copilot`, so a frozen or L0-capped translator
  // still drafted from the queue. The row is authoritative for jobs enqueued
  // before this field was threaded through, and for the async `/agent` route,
  // whose payload never carried `assigneeAgent`.
  const persistedRun = await runService.getRun(payload.runId);
  const agentName = persistedRun?.agentName ?? payload.agentRole ?? undefined;

  const schemaService = new SchemaService({
    db: deps.db,
    siteId: payload.siteId,
    cache: deps.cache,
  });
  // System context: a governed agent run enforces autonomy/HITL gating in the
  // AISecureHarness (write/delete skills route to approvals), not via per-user
  // row/field RBAC — the run executes with system privileges under that gate.
  const itemService = itemServiceForSystem(
    {
      db: deps.db,
      siteId: payload.siteId,
      userId: payload.userId ?? null,
      cache: deps.cache,
      search: deps.search,
      queue: deps.queue,
    },
    'background-worker',
  );

  const harness = new AISecureHarness({
    db: deps.db,
    siteId: payload.siteId,
    schemaService,
    itemService,
    llm: createConfiguredLLMProvider(deps.env),
    queue: deps.queue,
    // Deployment skills need the KeyProvider to decrypt target tokens; a
    // queued run must be able to do exactly what the sync path does.
    keys: deps.keys,
  });

  // Capabilities are resolved HERE, not at enqueue (#472). A queued job can sit
  // for minutes; re-reading the grant at pickup is what makes a revoked API key
  // or a demoted user take effect on work that was already accepted.
  const capabilities = await resolveWorkerCapabilities(deps, payload);
  if (!capabilities.allowed) {
    await runService.failRun(
      payload.runId,
      capabilities.message ?? 'Capability resolution denied',
      { stopReason: 'capabilities_denied', code: capabilities.code },
    );
    return;
  }

  try {
    const result = await harness.execute(
      payload.skillName,
      payload.arguments,
      capabilities.capabilities,
      payload.contextMessage,
      {
        goalId: payload.goalId,
        runId: payload.runId,
        // The governance envelope has to survive the queue hop (#455). Dropping
        // `autonomyCap` here would let a queued reconciler run execute at the
        // role's own grant level, ignoring the ceiling its intent declared —
        // the cap would look enforced in the dispatcher and not be enforced at
        // execution. Same for `intentId` (write-budget scope) and `origin`
        // (backpressure pauses reconciler work only).
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(payload.intentId ? { intentId: payload.intentId } : {}),
        ...(payload.autonomyCap !== undefined && payload.autonomyCap !== null
          ? { autonomyCap: payload.autonomyCap }
          : {}),
        ...(agentName ? { agentName } : {}),
        ...(payload.agentRole ? { agentRole: payload.agentRole } : {}),
        ...(payload.budget ? { budget: payload.budget } : {}),
        // Provenance for anything this run parks (#472). A queued run has no
        // human principal, so the authority is the agent role the intent routed
        // to — re-resolved when a human approves, which is what makes disabling
        // the role stop a parked action too.
        requestedByPrincipal: payload.principal
          ? { kind: 'principal', ref: payload.principal }
          : payload.agentRole
            ? {
                kind: 'agentRole',
                role: payload.agentRole,
                intentId: payload.intentId ?? null,
                autonomyCap: payload.autonomyCap ?? null,
              }
            : null,
      },
    );
    await settleDeferralIfAny(runService, payload.runId, result);
  } catch (err) {
    // The harness records expected failures itself; this guards the worker
    // against unexpected throws so the run never sticks in `running`.
    const message = err instanceof Error ? err.message : String(err);
    await runService.failRun(payload.runId, message, { stopReason: 'worker_error' });
  }
}

/**
 * Registers the agent-runs consumer on a long-lived runtime (Docker/Node).
 *
 * Cloudflare Workers would wire the same handler through a `queue()` consumer
 * export instead of `process()` — that export does not exist yet, so async
 * runs are Node/Docker-only for now (backlog `B9`). Whoever adds it must pass
 * `keys` (`createCloudflareKeyProvider(env)`) alongside the other providers.
 */
export function registerAgentRunWorker(deps: AgentRunWorkerDeps): void {
  deps.queue?.process<AgentRunJobPayload>(AGENT_RUNS_QUEUE, async (job) => {
    await processAgentRunJob(deps, job.data);
  });
}
