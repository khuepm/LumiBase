/**
 * Public A/B event beacon (#763), mounted at `/api/v1/experiment-events` with
 * `withDb()` + `withRateLimit()` like the pageview beacon. Unauthenticated:
 * the site comes from the path and every query goes through `scopedDbFor`.
 * The site's frontend reports exposures and conversions here, with analytics
 * consent and the visitor id it was assigned with.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { shouldRecord } from '../pageviews/bot-filter';
import { parseConsentHeader } from '../personalisation/context';
import { VISITOR_RE, visitorHash } from './delivery';
import { assignArm } from './stats';
import { ExperimentRepository } from './repo';

const slugKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

async function body(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return Symbol.for('invalid-json');
  }
}

const eventsSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            experiment: slugKey,
            arm: slugKey,
            kind: z.enum(['exposure', 'conversion']),
            /** Required for a conversion, and must equal the experiment's goal. */
            goal: z.string().min(1).max(60).optional(),
          })
          .strict()
          .refine((e) => e.kind !== 'conversion' || e.goal !== undefined, { message: 'A conversion must name its goal.', path: ['goal'] }),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const experimentEventsPublicRouter = new Hono<AppEnv>();

/**
 * `POST /:site_id` — report what a visitor saw and did.
 *
 * The metric is per visitor, as the report's two-proportion test assumes:
 * - the request carries the same `X-Lumi-Visitor` used for assignment
 *   (stored only as a salted one-way hash);
 * - an event counts only for the arm deterministic assignment gives that
 *   visitor, so a client cannot credit another arm;
 * - an exposure counts once per visitor (replays are no-ops);
 * - a conversion needs the experiment's goal, an earlier exposure of the same
 *   arm, and counts once — so conversions never exceed exposures.
 *
 * Answers 204 whether or not the events counted (bots, missing consent,
 * unknown experiments, replays, a goal that is not the experiment's), like the
 * pageview beacon. 400 only for a malformed request: bad body, a conversion
 * without `goal`, or a missing / malformed `X-Lumi-Visitor`.
 */
experimentEventsPublicRouter.post('/:site_id', async (c) => {
  const siteId = c.req.param('site_id');
  const gate = shouldRecord({ userAgent: c.req.header('user-agent'), dnt: c.req.header('dnt'), gpc: c.req.header('sec-gpc') });
  if (!gate.record || !parseConsentHeader(c.req.header('x-lumi-consent')).analytics) return c.body(null, 204);
  const visitor = c.req.header('x-lumi-visitor') ?? '';
  if (!VISITOR_RE.test(visitor)) return c.json({ errors: [{ code: 'VISITOR_REQUIRED', message: 'X-Lumi-Visitor (8–128 URL-safe characters) is required.' }] }, 400);
  const parsed = eventsSchema.safeParse(await body(c));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'INVALID_BODY', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
  }
  const repo = new ExperimentRepository(scopedDbFor(c, siteId), siteId);
  try {
    const running = new Map<string, Awaited<ReturnType<ExperimentRepository['runningByKey']>>>();
    // Exposures first, so a batch carrying both still attributes the conversion.
    const ordered = [...parsed.data.events].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'exposure' ? -1 : 1));
    for (const ev of ordered) {
      if (!running.has(ev.experiment)) running.set(ev.experiment, await repo.runningByKey(ev.experiment));
      const exp = running.get(ev.experiment);
      if (!exp) continue;
      // Attribution: only the arm this visitor is assigned to.
      if (assignArm(exp.key, visitor, exp.arms) !== ev.arm) continue;
      const hash = await visitorHash(exp.id, visitor);
      if (ev.kind === 'exposure') await repo.recordExposure(exp.id, hash, ev.arm);
      else if (ev.goal === exp.goal) await repo.recordConversion(exp.id, hash, ev.arm);
    }
  } catch (err) {
    // Fail-open: counting must never break the visitor's page.
    console.warn('[experiments] event beacon failed', err instanceof Error ? err.message : err);
  }
  return c.body(null, 204);
});
