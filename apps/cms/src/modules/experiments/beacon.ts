/**
 * Public A/B event beacon (#763), mounted at `/api/v1/experiment-events` with
 * `withDb()` + `withRateLimit()` like the pageview beacon. Unauthenticated:
 * the site comes from the path and every query goes through `scopedDbFor`.
 * The site's frontend reports exposures and conversions here, with analytics
 * consent.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { shouldRecord } from '../pageviews/bot-filter';
import { parseConsentHeader } from '../personalisation/context';
import { utcDay } from '../personalisation/delivery';
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
            /** Conversions only: must equal the experiment's goal. */
            goal: z.string().max(60).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

export const experimentEventsPublicRouter = new Hono<AppEnv>();

/**
 * `POST /:site_id` — count exposures / conversions. 204 whatever happens
 * (bots, missing consent, unknown experiments are dropped silently, like the
 * pageview beacon), 400 only for a malformed body.
 */
experimentEventsPublicRouter.post('/:site_id', async (c) => {
  const siteId = c.req.param('site_id');
  const gate = shouldRecord({ userAgent: c.req.header('user-agent'), dnt: c.req.header('dnt'), gpc: c.req.header('sec-gpc') });
  if (!gate.record || !parseConsentHeader(c.req.header('x-lumi-consent')).analytics) return c.body(null, 204);
  const parsed = eventsSchema.safeParse(await body(c));
  if (!parsed.success) return c.json({ errors: [{ code: 'INVALID_BODY' }] }, 400);
  const repo = new ExperimentRepository(scopedDbFor(c, siteId), siteId);
  const day = utcDay();
  try {
    const seen = new Map<string, { id: string; arms: string[]; goal: string } | null>();
    for (const ev of parsed.data.events) {
      if (!seen.has(ev.experiment)) {
        const running = await repo.runningByKey(ev.experiment);
        seen.set(ev.experiment, running);
      }
      const exp = seen.get(ev.experiment);
      if (!exp || !exp.arms.includes(ev.arm)) continue;
      if (ev.kind === 'conversion' && ev.goal !== undefined && ev.goal !== exp.goal) continue;
      await repo.recordEvent(exp.id, ev.arm, ev.kind, day);
    }
  } catch (err) {
    // Fail-open: counting must never break the visitor's page.
    console.warn('[experiments] event beacon failed', err instanceof Error ? err.message : err);
  }
  return c.body(null, 204);
});
