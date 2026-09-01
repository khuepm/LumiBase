/**
 * Public webhook receiver: `POST /api/v1/integrations/git/webhook/:provider/:siteId/:integrationId`.
 *
 * The route is un-authenticated (providers can't carry a session) but the
 * per-integration secret signature is the authenticity gate. siteId +
 * integrationId in the path let this un-tenanted handler scope its lookup; we
 * set the RLS session var to the path's siteId before reading (mirroring
 * `withRls`), so it can only ever touch that one site's rows.
 */
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { gitIntegrations, gitWebhookEvents } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../../../env';
import type { Database } from '@lumibase/database';
import { AuditLogger } from '../../audit/logger';
import { AutonomyService } from '../../../services/autonomy-service';
import { decryptSecretValue } from '../crypto';
import { getGitConfig } from '../config';
import { PreviewEnvManager } from '../preview';
import { processEvent, type ProcessEventResult } from './processor';
import type { WebhookProvider } from './verify';
import {
  extractRepoFullName,
  isWebhookProvider,
  normalizeHeaders,
  verifyWebhookSignature,
} from './verify';

export async function handleWebhook(c: Context<AppEnv>): Promise<Response> {
  const provider = c.req.param('provider');
  const siteId = c.req.param('siteId');
  const integrationId = c.req.param('integrationId');

  if (!provider || !isWebhookProvider(provider)) {
    return c.json({ errors: [{ code: 'UNKNOWN_PROVIDER' }] }, 404);
  }
  if (!siteId || !integrationId) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  // Scope RLS to the path's site before reading (defence-in-depth; signature
  // is the real gate). Best-effort, like `withRls`.
  const isDev =
    c.env.LUMIBASE_ENV === 'development' ||
    process.env.LUMIBASE_ENV === 'development';
  if (!isDev) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sql = c.get('runtime').database.getConnection() as any;
      await sql`SELECT set_config('app.site_id', ${siteId}, true)`;
    } catch (err) {
      console.warn('[git-webhook] failed to set app.site_id', {
        err: formatSafeError(err),
      });
    }
  }

  const db = c.get('db');
  const [integration] = await db
    .select()
    .from(gitIntegrations)
    .where(
      and(
        eq(gitIntegrations.siteId, siteId),
        eq(gitIntegrations.id, integrationId),
        eq(gitIntegrations.provider, provider),
      ),
    )
    .limit(1);

  if (!integration || !integration.webhookSecretEnc) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  const cfg = getGitConfig(c);
  if (!cfg.encryptionKey) {
    return c.json({ errors: [{ code: 'ENCRYPTION_NOT_CONFIGURED' }] }, 500);
  }

  let secret: string;
  try {
    secret = await decryptSecretValue(
      cfg.encryptionKey,
      integration.webhookSecretEnc,
      { siteId, integrationId },
      'webhook_secret',
    );
  } catch {
    return c.json({ errors: [{ code: 'SECRET_UNAVAILABLE' }] }, 500);
  }

  const rawBody = await c.req.text();
  const headers = normalizeHeaders(c.req.raw.headers);
  const result = await verifyWebhookSignature(provider, {
    rawBody,
    headers,
    secret,
  });
  if (!result.valid) {
    return c.json({ errors: [{ code: 'INVALID_SIGNATURE' }] }, 401);
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // keep empty payload; still log the raw event below
  }

  // Confirm the payload targets this integration's repository (when present).
  const repo = extractRepoFullName(provider, payload);
  if (repo && repo !== integration.repoFullName) {
    return c.json({ errors: [{ code: 'REPO_MISMATCH' }] }, 400);
  }

  // Persist the raw event idempotently by (provider, delivery_id).
  const inserted = await db
    .insert(gitWebhookEvents)
    .values({
      siteId,
      integrationId,
      provider,
      deliveryId: result.deliveryId,
      event: result.event ?? 'unknown',
      payload,
      processed: false,
    })
    .onConflictDoNothing({
      target: [gitWebhookEvents.provider, gitWebhookEvents.deliveryId],
    })
    .returning({ id: gitWebhookEvents.id });

  // Duplicate delivery → already handled.
  if (inserted.length === 0) {
    return c.json({ data: { duplicate: true } });
  }
  const eventRowId = inserted[0]!.id;

  try {
    const outcome = await processEvent({
      db,
      siteId,
      integrationId,
      provider,
      event: result.event ?? 'unknown',
      payload,
    });
    await runPreviewSideEffects(c, {
      db,
      siteId,
      integrationId,
      isDev,
      outcome,
      previewEnabled:
        (integration.syncConfig as Record<string, unknown> | null)?.preview ===
        true,
    });
    await runCiSideEffects({
      db,
      siteId,
      integrationId,
      provider,
      outcome,
      requestId: c.get('requestId') ?? null,
    });
    await db
      .update(gitWebhookEvents)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(gitWebhookEvents.id, eventRowId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(gitWebhookEvents)
      .set({ error: message.slice(0, 1000) })
      .where(eq(gitWebhookEvents.id, eventRowId));
    // 200 so the provider doesn't hammer retries; the row is kept for replay.
  }

  return c.json({ data: { received: true } });
}

/**
 * On a failed CI run, record an agent incident (no capability → no autonomy
 * demotion, since a red build is not the agent's fault) and an audit entry.
 * Best-effort.
 */
async function runCiSideEffects(args: {
  db: Database;
  siteId: string;
  integrationId: string;
  provider: WebhookProvider;
  outcome: ProcessEventResult;
  requestId: string | null;
}): Promise<void> {
  const ci = args.outcome.ci;
  if (!ci || ci.status !== 'failure') return;
  try {
    await new AutonomyService({ db: args.db, siteId: args.siteId }).recordIncident({
      agentRole: 'git-sync',
      source: 'runtime_error',
      severity: 'medium',
      detail: {
        source: 'ci_failure',
        provider: args.provider,
        integrationId: args.integrationId,
        providerRunId: ci.providerRunId,
      },
    });
  } catch {
    // incidents are advisory; never block the webhook
  }
  try {
    await new AuditLogger({ db: args.db, siteId: args.siteId }).write({
      event: 'git_ci_failed',
      requestId: args.requestId,
      metadata: {
        integrationId: args.integrationId,
        provider: args.provider,
        providerRunId: ci.providerRunId,
      },
    });
  } catch {
    // audit is best-effort
  }
}

const CLOSED_ACTIONS = new Set(['closed', 'close', 'merge', 'merged']);

/**
 * Drive preview-environment provisioning from a processed PR event. Opt-in via
 * `integration.syncConfig.preview === true`. Best-effort: errors are swallowed
 * so the webhook still acknowledges (the event row is already persisted).
 */
async function runPreviewSideEffects(
  c: Context<AppEnv>,
  args: {
    db: Database;
    siteId: string;
    integrationId: string;
    isDev: boolean;
    outcome: ProcessEventResult;
    previewEnabled: boolean;
  },
): Promise<void> {
  if (!args.previewEnabled || !args.outcome.pr) return;
  const cfg = getGitConfig(c);
  const manager = new PreviewEnvManager({
    db: args.db,
    runtime: c.get('runtime'),
    siteId: args.siteId,
    integrationId: args.integrationId,
    publicBaseUrl: cfg.publicBaseUrl,
    isDev: args.isDev,
  });
  const pr = args.outcome.pr;
  try {
    if (CLOSED_ACTIONS.has(pr.action) || pr.state === 'closed' || pr.state === 'merged') {
      await manager.destroy(pr.id);
    } else {
      await manager.ensureForPullRequest({
        prId: pr.id,
        number: pr.number,
        state: pr.state,
      });
    }
  } catch (err) {
    console.warn('[git-preview] side-effect failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
