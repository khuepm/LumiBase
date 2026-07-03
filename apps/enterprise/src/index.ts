import { Hono } from 'hono';
import { nanoid } from 'nanoid';

/**
 * LumiBase Enterprise — standalone Hono Worker.
 *
 * This app depends on @lumibase/* packages (one-way: enterprise → core).
 * Core packages (cms/studio/...) MUST NOT import from this app — that would
 * break the public build, which never has this submodule checked out.
 */
const app = new Hono();

app.get('/', (c) =>
  c.json({
    data: {
      edition: 'enterprise',
      service: 'lumibase-enterprise',
      requestId: nanoid(),
    },
  }),
);

app.get('/health', (c) => c.json({ data: { ok: true } }));

export default app;
