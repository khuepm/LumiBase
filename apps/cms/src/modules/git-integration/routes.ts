/**
 * HTTP routes for Git integration.
 *
 * - `gitRouter`        — authenticated + admin; mounted under the `api` sub-app
 *                        at `/integrations/git` (inherits tenant/auth/db/rls).
 * - `gitPublicRouter`  — public; mounted at `/api/v1/integrations/git` BEFORE
 *                        the authenticated sub-app. Holds the OAuth callback
 *                        (bound to a single-use cache `state`) and the webhook
 *                        receiver (signature-verified). Both leaf paths are
 *                        disjoint from the authenticated routes, so the public
 *                        mount cannot shadow them.
 */
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { and, desc, eq } from 'drizzle-orm';
import { gitCiRuns, gitPullRequests } from '@lumibase/database';
import {
  GitIntegrationCreateSchema,
  GitIntegrationUpdateSchema,
  type CiRunResource,
  type PullRequestResource,
} from '@lumibase/contracts/schemas';
import type { AppEnv } from '../../env';
import { withDb } from '../../middleware/db';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { AuditLogger } from '../audit/logger';
import { getGitConfig } from './config';
import {
  GitIntegrationConflictError,
  GitIntegrationService,
} from './service';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  type OAuthProvider,
} from './oauth';
import { getProvider, type ProviderDeps } from './providers/factory';
import { parseRepoFullName } from './providers/types';
import { getOrFetchLog } from './ci-log-store';
import { validatePullRequest } from './validation';
import { queryProvenance } from './provenance';
import { syncFromRepo } from './gitops';
import { ensureGitSyncAutonomyBaseline } from './autonomy';
import { handleWebhook } from './webhook/handler';

const OAUTH_STATE_TTL_SECONDS = 600;

function service(c: Parameters<typeof getGitConfig>[0], siteId: string) {
  const cfg = getGitConfig(c);
  if (!cfg.encryptionKey) {
    return null;
  }
  return new GitIntegrationService({
    db: c.get('db'),
    siteId,
    encryptionKey: cfg.encryptionKey,
    publicBaseUrl: cfg.publicBaseUrl,
  });
}

function notConfigured(c: Parameters<typeof getGitConfig>[0]) {
  return c.json(
    {
      errors: [
        {
          code: 'ENCRYPTION_NOT_CONFIGURED',
          message: 'ENCRYPTION_KEY must be set to manage Git integrations.',
        },
      ],
    },
    500,
  );
}

function providerDeps(c: Parameters<typeof getGitConfig>[0]): ProviderDeps {
  const cfg = getGitConfig(c);
  return {
    encryptionKey: cfg.encryptionKey ?? '',
    cache: c.get('runtime').cache,
    githubApp: cfg.githubApp,
  };
}

function mapPrRow(
  row: typeof gitPullRequests.$inferSelect,
): PullRequestResource {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    state: row.state as PullRequestResource['state'],
    ciStatus: row.ciStatus as PullRequestResource['ciStatus'],
    mergeable: row.mergeable,
    headSha: row.headSha,
    author: row.author,
    previewUrl: row.previewUrl,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCiRow(row: typeof gitCiRuns.$inferSelect): CiRunResource {
  return {
    id: row.id,
    providerRunId: row.providerRunId,
    status: row.status as CiRunResource['status'],
    jobs: (row.jobs as CiRunResource['jobs']) ?? [],
    durationMs: row.durationMs,
    hasStoredLog: Boolean(row.logRef),
  };
}

// ── Authenticated router ──────────────────────────────────────────────────

export const gitRouter = new Hono<AppEnv>();
gitRouter.use('*', requireSiteAdmin());

gitRouter.get('/', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  return c.json({ data: await svc.list() });
});

gitRouter.post('/', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const parsed = GitIntegrationCreateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }
  try {
    const resource = await svc.create(parsed.data);
    await audit(c, 'git_integration_connected', resource.id, {
      provider: resource.provider,
      repo: resource.repoFullName,
    });
    // Seed conservative L1 autonomy for git-sync on first connect (best-effort).
    try {
      await ensureGitSyncAutonomyBaseline(c.get('db'), c.get('siteId'));
    } catch {
      // non-fatal
    }
    return c.json({ data: resource }, 201);
  } catch (e) {
    if (e instanceof GitIntegrationConflictError) {
      return c.json({ errors: [{ code: 'CONFLICT', message: e.message }] }, 409);
    }
    throw e;
  }
});

gitRouter.get('/:id', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const resource = await svc.get(c.req.param('id'));
  if (!resource) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: resource });
});

gitRouter.patch('/:id', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const parsed = GitIntegrationUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION_ERROR',
            details: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        ],
      },
      400,
    );
  }
  const resource = await svc.update(c.req.param('id'), parsed.data);
  if (!resource) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: resource });
});

gitRouter.delete('/:id', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const ok = await svc.delete(c.req.param('id'));
  if (!ok) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  await audit(c, 'git_integration_disconnected', c.req.param('id'), {});
  return c.json({ data: { id: c.req.param('id') } });
});

gitRouter.post('/:id/rotate-secret', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const resource = await svc.rotateSecret(c.req.param('id'));
  if (!resource) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  await audit(c, 'git_webhook_secret_rotated', resource.id, {});
  return c.json({ data: resource });
});

gitRouter.get('/:id/oauth/authorize', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const cfg = getGitConfig(c);
  const integration = await svc.get(c.req.param('id'));
  if (!integration) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const provider = integration.provider as OAuthProvider;
  const oauth = provider === 'github' ? cfg.github : cfg.gitlab;
  if (!oauth) {
    return c.json(
      {
        errors: [
          {
            code: 'OAUTH_NOT_CONFIGURED',
            message: `${provider} OAuth client is not configured.`,
          },
        ],
      },
      400,
    );
  }
  const state = nanoid(32);
  await c.get('runtime').cache.set(
    `git:oauth:${state}`,
    JSON.stringify({
      siteId: c.get('siteId'),
      integrationId: integration.id,
      provider,
    }),
    { ttl: OAUTH_STATE_TTL_SECONDS },
  );
  const redirectUri = `${cfg.publicBaseUrl}/api/v1/integrations/git/oauth/${provider}/callback`;
  return c.json({
    data: { authorizeUrl: buildAuthorizeUrl(provider, oauth, redirectUri, state) },
  });
});

gitRouter.get('/:id/pull-requests', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const integration = await svc.get(c.req.param('id'));
  if (!integration) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const rows = await c
    .get('db')
    .select()
    .from(gitPullRequests)
    .where(
      and(
        eq(gitPullRequests.siteId, c.get('siteId')),
        eq(gitPullRequests.integrationId, integration.id),
      ),
    )
    .orderBy(desc(gitPullRequests.updatedAt));
  return c.json({
    data: rows.map(mapPrRow),
    meta: { total: rows.length, limit: rows.length, offset: 0 },
  });
});

gitRouter.post('/:id/pull-requests/refresh', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const row = await svc.getRow(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  let provider;
  try {
    provider = await getProvider(row, providerDeps(c));
  } catch (e) {
    return c.json(
      { errors: [{ code: 'PROVIDER_ERROR', message: (e as Error).message }] },
      502,
    );
  }
  const repo = parseRepoFullName(row.repoFullName);
  const prs = await provider.listPullRequests(repo, { state: 'open' });
  for (const pr of prs) {
    await c
      .get('db')
      .insert(gitPullRequests)
      .values({
        siteId: c.get('siteId'),
        integrationId: row.id,
        number: pr.number,
        title: pr.title,
        state: pr.state,
        ciStatus: pr.ciStatus,
        mergeable: pr.mergeable,
        headSha: pr.headSha,
        author: pr.author,
      })
      .onConflictDoUpdate({
        target: [gitPullRequests.integrationId, gitPullRequests.number],
        set: {
          title: pr.title,
          state: pr.state,
          mergeable: pr.mergeable,
          headSha: pr.headSha,
          author: pr.author,
          updatedAt: new Date(),
        },
      });
  }
  return c.json({ data: prs });
});

gitRouter.get('/:id/pull-requests/:number/ci', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const integration = await svc.get(c.req.param('id'));
  if (!integration) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const rows = await c
    .get('db')
    .select()
    .from(gitCiRuns)
    .where(
      and(
        eq(gitCiRuns.siteId, c.get('siteId')),
        eq(gitCiRuns.integrationId, integration.id),
      ),
    )
    .orderBy(desc(gitCiRuns.updatedAt));
  return c.json({ data: rows.map(mapCiRow) });
});

gitRouter.get('/:id/ci-runs/:runId/logs', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const row = await svc.getRow(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  let provider;
  try {
    provider = await getProvider(row, providerDeps(c));
  } catch (e) {
    return c.json(
      { errors: [{ code: 'PROVIDER_ERROR', message: (e as Error).message }] },
      502,
    );
  }
  try {
    const text = await getOrFetchLog(
      {
        db: c.get('db'),
        storage: c.get('runtime').storage,
        siteId: c.get('siteId'),
        integrationId: row.id,
      },
      provider,
      parseRepoFullName(row.repoFullName),
      c.req.param('runId'),
      c.req.query('jobId'),
    );
    return c.json({ data: { log: text } });
  } catch (e) {
    return c.json(
      { errors: [{ code: 'LOG_FETCH_FAILED', message: (e as Error).message }] },
      502,
    );
  }
});

gitRouter.post('/:id/pull-requests/:number/validate', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const row = await svc.getRow(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const number = Number(c.req.param('number'));

  let provider;
  try {
    provider = await getProvider(row, providerDeps(c));
  } catch (e) {
    return c.json(
      { errors: [{ code: 'PROVIDER_ERROR', message: (e as Error).message }] },
      502,
    );
  }
  const repo = parseRepoFullName(row.repoFullName);
  let pr;
  try {
    pr = await provider.getPullRequest(repo, number);
  } catch (e) {
    return c.json(
      { errors: [{ code: 'PROVIDER_ERROR', message: (e as Error).message }] },
      502,
    );
  }

  const result = await validatePullRequest(provider, repo, pr.headSha);

  // Post the result back as a commit status; tolerate missing write scope.
  let posted = true;
  try {
    await provider.postCommitStatus(repo, pr.headSha, {
      state: result.state,
      context: 'lumibase/content-validation',
      description: result.summary.slice(0, 140),
    });
  } catch {
    posted = false;
  }
  await audit(c, 'git_pr_validated', row.id, {
    number,
    state: result.state,
    posted,
  });
  return c.json({ data: { ...result, statusPosted: posted } });
});

gitRouter.post('/:id/gitops/sync', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const row = await svc.getRow(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  let provider;
  try {
    provider = await getProvider(row, providerDeps(c));
  } catch (e) {
    return c.json(
      { errors: [{ code: 'PROVIDER_ERROR', message: (e as Error).message }] },
      502,
    );
  }
  const ref = c.req.query('ref') || undefined;
  const result = await syncFromRepo(
    provider,
    parseRepoFullName(row.repoFullName),
    {
      db: c.get('db'),
      siteId: c.get('siteId'),
      integrationId: row.id,
      userId: c.get('auth')?.userId ?? null,
    },
    ref,
  );
  await audit(c, 'git_gitops_synced', row.id, {
    found: result.found,
    applied: result.applied.length,
    goalsCreated: result.goalsCreated,
  });
  return c.json({ data: result });
});

gitRouter.get('/:id/provenance', async (c) => {
  const svc = service(c, c.get('siteId'));
  if (!svc) return notConfigured(c);
  const integration = await svc.get(c.req.param('id'));
  if (!integration) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  const rows = await queryProvenance(c.get('db'), {
    siteId: c.get('siteId'),
    integrationId: integration.id,
    collection: c.req.query('collection') || undefined,
    itemId: c.req.query('itemId') || undefined,
  });
  return c.json({ data: rows });
});

async function audit(
  c: Parameters<typeof getGitConfig>[0],
  event: string,
  integrationId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const logger = new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') });
    await logger.write({
      event,
      actorEmail: c.get('auth')?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: { integrationId, ...metadata },
    });
  } catch {
    // Audit is best-effort; never block the request.
  }
}

// ── Public router (OAuth callback + webhook) ──────────────────────────────

export const gitPublicRouter = new Hono<AppEnv>();
gitPublicRouter.use('*', withDb());

gitPublicRouter.get('/oauth/:provider/callback', async (c) => {
  const provider = c.req.param('provider') as OAuthProvider;
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) {
    return c.html(callbackHtml('Missing code or state.'), 400);
  }
  const raw = await c.get('runtime').cache.get<string>(`git:oauth:${state}`);
  if (!raw) {
    return c.html(callbackHtml('This authorization link has expired.'), 400);
  }
  await c.get('runtime').cache.delete(`git:oauth:${state}`);
  const parsed = JSON.parse(raw) as {
    siteId: string;
    integrationId: string;
    provider: OAuthProvider;
  };
  if (parsed.provider !== provider) {
    return c.html(callbackHtml('Provider mismatch.'), 400);
  }

  const cfg = getGitConfig(c);
  const oauth = provider === 'github' ? cfg.github : cfg.gitlab;
  if (!cfg.encryptionKey || !oauth) {
    return c.html(callbackHtml('Server is not configured for OAuth.'), 500);
  }
  const svc = new GitIntegrationService({
    db: c.get('db'),
    siteId: parsed.siteId,
    encryptionKey: cfg.encryptionKey,
    publicBaseUrl: cfg.publicBaseUrl,
  });
  const integration = await svc.getRow(parsed.integrationId);
  if (!integration) {
    return c.html(callbackHtml('Integration no longer exists.'), 404);
  }
  const redirectUri = `${cfg.publicBaseUrl}/api/v1/integrations/git/oauth/${provider}/callback`;
  try {
    const { accessToken, scopes } = await exchangeCodeForToken(
      provider,
      oauth,
      code,
      redirectUri,
    );
    await svc.update(parsed.integrationId, { token: accessToken, scopes });
    return c.html(callbackHtml('Connected. You can close this window.', true));
  } catch {
    await svc.update(parsed.integrationId, {
      status: 'error',
    });
    return c.html(callbackHtml('Failed to exchange the authorization code.'), 502);
  }
});

gitPublicRouter.post('/webhook/:provider/:siteId/:integrationId', (c) =>
  handleWebhook(c),
);

function callbackHtml(message: string, ok = false): string {
  const color = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html><html><head><meta charset="utf-8"><title>LumiBase</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center"><p style="color:${color};font-size:16px">${message}</p>
<script>setTimeout(function(){window.close()},2000)</script></div></body></html>`;
}
