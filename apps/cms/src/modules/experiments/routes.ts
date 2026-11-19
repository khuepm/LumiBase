/**
 * A/B experiments (#763).
 *
 * - {@link experimentsRouter}, mounted at `/api/v1/experiments`: site admins
 *   create, start and stop experiments and read the report (Insights). A
 *   winner is never promoted here directly: `POST /:id/promote` parks a
 *   `promoteExperimentWinner` approval, exactly as an agent proposing it does.
 * - The public event beacon lives in `./beacon.ts` (its own file, so the
 *   self-scoped mount never touches the request db).
 *
 * Every write drops the cached running list and purges the site's delivery
 * caches, so a change is live on the next request.
 */
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { items, pages } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { approvalRequesterFromAuth, resolveRequestCapabilities } from '../../services/governed-capabilities';
import { isUniqueViolation } from '../personalisation/repo';
import { invalidateExperiments } from './promote';
import { ExperimentRepository, type ArmInput, type ExperimentWithArms } from './repo';
import { CONTROL_ARM, buildReport } from './stats';

export const experimentsRouter = new Hono<AppEnv>();
experimentsRouter.use('*', requireSiteAdmin());

/** Running experiments per site: each multiplies the cached copies of the pages it touches. */
export const MAX_RUNNING_EXPERIMENTS = 5;
export const MAX_ARMS = 4;

type ErrStatus = 400 | 403 | 404 | 409;
const fail = (c: Context<AppEnv>, status: ErrStatus, code: string, message: string) => c.json({ errors: [{ code, message }] }, status);

const repoOf = (c: Context<AppEnv>) => new ExperimentRepository(c.get('db'), c.get('siteId'));
const depsOf = (c: Context<AppEnv>) => ({
  db: c.get('db'),
  siteId: c.get('siteId'),
  cache: c.get('runtime')?.cache,
  edgeCache: c.get('runtime')?.edgeCache,
});

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Symbol.for('invalid-json');
  }
}

function zodFail(c: Context<AppEnv>, err: z.ZodError) {
  return c.json({ errors: err.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
}

const slugKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Key must be 1–40 lowercase letters, digits or dashes.');
const pageOverrides = z
  .object({ title: z.string().trim().min(1).max(500).optional(), layoutConfig: z.record(z.string(), z.unknown()).optional() })
  .strict();
const itemOverrides = z.record(z.string(), z.unknown());

const armSchema = z
  .object({
    key: slugKey,
    name: z.string().trim().max(120).optional(),
    weight: z.number().int().min(0).max(100).default(50),
    overrides: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const armsSchema = z
  .array(armSchema)
  .min(2)
  .max(MAX_ARMS)
  .superRefine((arms, ctx) => {
    const keys = arms.map((a) => a.key);
    if (!keys.includes(CONTROL_ARM)) ctx.addIssue({ code: 'custom', message: 'One arm must be "control" (the published content).' });
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Arm keys must be unique.' });
    if (arms.reduce((s, a) => s + a.weight, 0) <= 0) ctx.addIssue({ code: 'custom', message: 'At least one arm needs a positive weight.' });
    const control = arms.find((a) => a.key === CONTROL_ARM);
    if (control && Object.keys(control.overrides).length > 0) ctx.addIssue({ code: 'custom', message: 'The control arm serves the published content; it has no overrides.' });
  });

const createSchema = z
  .object({
    key: slugKey,
    name: z.string().trim().min(1).max(120),
    hypothesis: z.string().trim().max(2000).optional(),
    subjectType: z.enum(['page', 'item']),
    subjectId: z.string().min(1).max(200),
    goal: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,59}$/, 'Goal must be 1–60 lowercase letters, digits, "_", "." or "-".'),
    minSampleSize: z.number().int().min(10).max(10_000_000).default(100),
    arms: armsSchema,
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    hypothesis: z.string().trim().max(2000).nullable().optional(),
    goal: createSchema.shape.goal.optional(),
    minSampleSize: z.number().int().min(10).max(10_000_000).optional(),
    arms: armsSchema.optional(),
  })
  .strict();

/** Arm overrides must fit the subject: page `{ title?, layoutConfig? }`, item a data patch without reserved keys. */
function checkArmOverrides(subjectType: 'page' | 'item', arms: z.infer<typeof armsSchema>): string | null {
  for (const arm of arms) {
    const schema = subjectType === 'page' ? pageOverrides : itemOverrides;
    const r = schema.safeParse(arm.overrides);
    if (!r.success) return `arms.${arm.key}.overrides: ${r.error.issues[0]?.message ?? 'invalid'}`;
    if (arm.key !== CONTROL_ARM && Object.keys(arm.overrides).length === 0) return `arms.${arm.key}.overrides: a challenger arm changes at least one field.`;
  }
  return null;
}

async function subjectExists(c: Context<AppEnv>, subjectType: 'page' | 'item', subjectId: string): Promise<boolean> {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const table = subjectType === 'page' ? pages : items;
  const [row] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.siteId, siteId), eq(table.id, subjectId)))
    .limit(1);
  return Boolean(row);
}

const toArmInputs = (arms: z.infer<typeof armsSchema>): ArmInput[] =>
  arms.map((a) => ({ key: a.key, name: a.name ?? null, weight: a.weight, overrides: a.overrides }));

async function withReport(repo: ExperimentRepository, e: ExperimentWithArms) {
  const counts = await repo.totals(e.id, e.arms.map((a) => a.key));
  return { ...e, report: buildReport(counts, { minSampleSize: e.minSampleSize }) };
}

// --- admin -------------------------------------------------------------------

experimentsRouter.get('/', async (c) => {
  const status = c.req.query('status');
  const parsed = z.enum(['draft', 'running', 'stopped', 'completed']).optional().safeParse(status || undefined);
  if (!parsed.success) return fail(c, 400, 'VALIDATION', 'status must be draft, running, stopped or completed.');
  return c.json({ data: await repoOf(c).list({ status: parsed.data }) });
});

experimentsRouter.post('/', async (c) => {
  const parsed = createSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  const input = parsed.data;
  const armIssue = checkArmOverrides(input.subjectType, input.arms);
  if (armIssue) return fail(c, 400, 'VALIDATION', armIssue);
  if (!(await subjectExists(c, input.subjectType, input.subjectId))) {
    return fail(c, 404, 'SUBJECT_NOT_FOUND', `No ${input.subjectType} "${input.subjectId}" in this site.`);
  }
  try {
    const row = await repoOf(c).create(
      {
        key: input.key,
        name: input.name,
        hypothesis: input.hypothesis ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        goal: input.goal,
        minSampleSize: input.minSampleSize,
        createdBy: c.get('auth')?.userId ?? null,
      },
      toArmInputs(input.arms),
    );
    return c.json({ data: row }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, 'EXPERIMENT_KEY_TAKEN', `An experiment with key "${input.key}" already exists.`);
    throw err;
  }
});

experimentsRouter.get('/:id', async (c) => {
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  return c.json({ data: await withReport(repo, row) });
});

experimentsRouter.patch('/:id', async (c) => {
  const parsed = patchSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  if (row.status === 'completed') return fail(c, 409, 'INVALID_STATE', 'A completed experiment is read-only.');
  const { arms, ...rest } = parsed.data;
  if (arms) {
    if (row.status !== 'draft') return fail(c, 409, 'INVALID_STATE', 'Arms can only change while the experiment is a draft.');
    const armIssue = checkArmOverrides(row.subjectType as 'page' | 'item', arms);
    if (armIssue) return fail(c, 400, 'VALIDATION', armIssue);
    await repo.replaceArms(row.id, toArmInputs(arms));
  }
  if (Object.keys(rest).length > 0 || arms) await repo.update(row.id, rest);
  if (row.status === 'running') await invalidateExperiments(depsOf(c));
  return c.json({ data: await repo.get(row.id) });
});

experimentsRouter.post('/:id/start', async (c) => {
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  if (row.status !== 'draft' && row.status !== 'stopped') return fail(c, 409, 'INVALID_STATE', `A ${row.status} experiment cannot start.`);
  if (!(await subjectExists(c, row.subjectType as 'page' | 'item', row.subjectId))) {
    return fail(c, 404, 'SUBJECT_NOT_FOUND', 'The experiment subject no longer exists.');
  }
  if (await repo.runningOn(row.subjectType as 'page' | 'item', row.subjectId)) {
    return fail(c, 409, 'SUBJECT_BUSY', 'Another experiment is already running on this subject.');
  }
  if ((await repo.list({ status: 'running' })).length >= MAX_RUNNING_EXPERIMENTS) {
    return fail(c, 409, 'TOO_MANY_RUNNING', `At most ${MAX_RUNNING_EXPERIMENTS} experiments may run at once.`);
  }
  const updated = await repo.update(row.id, { status: 'running', startedAt: row.startedAt ?? new Date(), endedAt: null });
  await invalidateExperiments(depsOf(c));
  return c.json({ data: updated });
});

experimentsRouter.post('/:id/stop', async (c) => {
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  if (row.status !== 'running') return fail(c, 409, 'INVALID_STATE', 'Only a running experiment can stop.');
  const updated = await repo.update(row.id, { status: 'stopped', endedAt: new Date() });
  await invalidateExperiments(depsOf(c));
  return c.json({ data: updated });
});

experimentsRouter.delete('/:id', async (c) => {
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  if (row.status === 'running') return fail(c, 409, 'INVALID_STATE', 'Stop the experiment before deleting it.');
  await repo.delete(row.id);
  return c.json({ data: { id: row.id, deleted: true } });
});

/** The Insights report: totals, rates, significance and the recommendation, plus the daily series. */
experimentsRouter.get('/:id/report', async (c) => {
  const repo = repoOf(c);
  const row = await repo.get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  const { report, ...experiment } = await withReport(repo, row);
  return c.json({ data: { experiment, report, daily: await repo.daily(row.id) } });
});

const promoteSchema = z.object({ arm: slugKey, rationale: z.string().trim().max(2000).optional() }).strict();

/**
 * Ask for the winner to be promoted. Never promotes directly: this parks a
 * `promoteExperimentWinner` approval (HITL), decided like any agent action.
 */
experimentsRouter.post('/:id/promote', async (c) => {
  const parsed = promoteSchema.safeParse(await body(c));
  if (!parsed.success) return zodFail(c, parsed.error);
  const row = await repoOf(c).get(c.req.param('id'));
  if (!row) return fail(c, 404, 'NOT_FOUND', 'Experiment not found.');
  if (row.status !== 'running' && row.status !== 'stopped') return fail(c, 409, 'INVALID_STATE', `A ${row.status} experiment cannot be promoted.`);
  if (!row.arms.some((a) => a.key === parsed.data.arm)) return fail(c, 404, 'ARM_NOT_FOUND', `Experiment has no arm "${parsed.data.arm}".`);
  const { buildAuthorizedHarness } = await import('../../routes/ai');
  const harness = await buildAuthorizedHarness(c);
  const capabilities = (await resolveRequestCapabilities(c)).capabilities;
  const result = await harness.execute(
    'promoteExperimentWinner',
    { experimentId: row.id, arm: parsed.data.arm, ...(parsed.data.rationale ? { rationale: parsed.data.rationale } : {}) },
    capabilities,
    `Promote arm "${parsed.data.arm}" of experiment "${row.key}"`,
    {
      // Provenance (#472): the approver's decision re-checks the requester's
      // current rights, exactly as for an agent-proposed promotion.
      requestId: c.get('requestId'),
      requestedByPrincipal: approvalRequesterFromAuth(c.get('auth'), c.get('siteId')),
    },
  );
  if (result.status === 'denied') return fail(c, 403, 'DENIED', result.message ?? 'Promotion was denied.');
  return c.json({ data: result }, result.status === 'pending_approval' ? 202 : 200);
});
