import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { TypegenService } from '../services/typegen-service';
import { formatSafeError } from '@lumibase/contracts/utils';

const buildService = (c: { get: AppEnv['Variables'] extends infer V ? (k: keyof V) => V[keyof V] : never }) =>
  new TypegenService({
    db: c.get('db') as never,
    siteId: c.get('siteId') as unknown as string,
  });

export const typegenRouter = new Hono<AppEnv>();

typegenRouter.get('/schema', async (c) => {
  const include = c.req.query('include')?.split(',').filter(Boolean);
  const exclude = c.req.query('exclude')?.split(',').filter(Boolean);

  try {
    const data = await buildService(c).getManifest(include, exclude);
    return c.json({ data });
  } catch (err) {
    console.error('[typegen] error', formatSafeError(err));
    return c.json({ errors: [{ code: 'INTERNAL', message: 'Type generation failed.' }] }, 500);
  }
});
