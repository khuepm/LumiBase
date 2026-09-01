import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';

/**
 * Minimal HTTP server for `LUMIBASE_PROCESS_ROLE=worker` processes.
 * Exposes only health endpoints so orchestrators can probe background workers.
 */
export function startWorkerHealthServer(port: number): HttpServer {
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      role: 'worker',
      service: 'lumibase-cms',
    }),
  );
  app.get('/health/ready', (c) =>
    c.json({
      status: 'ok',
      role: 'worker',
      service: 'lumibase-cms',
    }),
  );

  const server = serve({ fetch: app.fetch, port }) as unknown as HttpServer;
  console.log(`[lumibase-cms] Worker health server listening on port ${port}`);
  return server;
}
