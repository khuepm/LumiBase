import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  EXTENSION_DEV_DEFAULT_PORT,
  EXTENSION_DEV_PROTOCOL,
  isLoopbackHostname,
  isLoopbackUrl,
  type ExtensionDevErrorEvent,
  type ExtensionDevHelloEvent,
  type ExtensionDevReloadEvent,
} from '@lumibase/contracts/extensions';
import { assertUsableToken, tokensMatch } from './session';

/**
 * The `lumibase-ext dev` hub: a loopback-only HTTP server that
 *   - streams reload events over SSE (`GET /events`), and
 *   - serves each rebuilt bundle (`GET /bundle/<name>?v=<version>`).
 *
 * Studio and the CMS are clients. Every request must present the session
 * token (`Authorization: Bearer <token>`, or `?token=` for EventSource /
 * dynamic `import()`, which cannot set headers). Requests whose `Host` or
 * `Origin` is not loopback are refused, which also defeats DNS rebinding.
 */

export interface DevHubOptions {
  token: string;
  /** Interface to bind. Must be loopback; default `127.0.0.1`. */
  host?: string;
  /** Port to bind; `0` picks a free one. Default {@link EXTENSION_DEV_DEFAULT_PORT}. */
  port?: number;
  /** How many past builds per extension stay fetchable (in-flight imports). */
  retainVersions?: number;
  /** SSE heartbeat interval (ms). */
  heartbeatMs?: number;
}

export interface PublishInput {
  name: string;
  type: ExtensionDevReloadEvent['type'];
  version: number;
  capabilities: string[];
  siteId: string | null;
  code: string;
}

export interface DevHub {
  /** Base URL, e.g. `http://127.0.0.1:4790`. */
  readonly url: string;
  readonly port: number;
  /** Random id of this hub run, stamped on every reload event. */
  readonly session: string;
  /** Store a new build and broadcast its reload event. */
  publish(input: PublishInput): ExtensionDevReloadEvent;
  /** Broadcast a build failure (clients keep the previous version). */
  publishError(name: string, message: string): void;
  /** Number of connected SSE subscribers. */
  subscriberCount(): number;
  close(): Promise<void>;
}

interface StoredBuild {
  event: ExtensionDevReloadEvent;
  code: string;
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  return url.searchParams.get('token');
}

function hostIsLoopback(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  // Strip the port, keeping bracketed IPv6 intact.
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0] ?? '';
  return isLoopbackHostname(hostname);
}

export async function startDevHub(options: DevHubOptions): Promise<DevHub> {
  const token = assertUsableToken(options.token);
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHostname(host)) {
    throw new Error(`refusing to bind the dev hub to non-loopback host "${host}"`);
  }
  const retain = Math.max(1, options.retainVersions ?? 5);
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const builds = new Map<string, StoredBuild[]>();
  // Versions restart at 1 with each CLI run; the session id lets clients that
  // reconnect after a restart tell the new v1 from the old one.
  const session = randomBytes(8).toString('hex');
  const subscribers = new Set<ServerResponse>();

  const latestEvents = (): ExtensionDevReloadEvent[] =>
    [...builds.values()]
      .map((list) => list[list.length - 1]?.event)
      .filter((e): e is ExtensionDevReloadEvent => Boolean(e));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const origin = req.headers.origin;

    if (!hostIsLoopback(req) || (typeof origin === 'string' && !isLoopbackUrl(origin))) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
      return;
    }
    const cors: Record<string, string> =
      typeof origin === 'string'
        ? { 'access-control-allow-origin': origin, vary: 'Origin' }
        : {};

    if (req.method === 'OPTIONS') {
      res
        .writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'GET',
          'access-control-allow-headers': 'Authorization',
          'access-control-max-age': '600',
        })
        .end();
      return;
    }

    if (!tokensMatch(token, presentedToken(req, url))) {
      res.writeHead(401, { ...cors, 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { ...cors, allow: 'GET, OPTIONS' }).end();
      return;
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        ...cors,
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write('retry: 500\n\n');
      const hello: ExtensionDevHelloEvent = { protocol: EXTENSION_DEV_PROTOCOL, extensions: latestEvents() };
      sse(res, 'hello', hello);
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      return;
    }

    const bundleMatch = /^\/bundle\/(.+)$/.exec(url.pathname);
    if (bundleMatch?.[1]) {
      const name = decodeURIComponent(bundleMatch[1]);
      const list = builds.get(name) ?? [];
      const wanted = url.searchParams.get('v');
      const build = wanted === null ? list[list.length - 1] : list.find((b) => String(b.event.version) === wanted);
      if (!build) {
        res.writeHead(404, { ...cors, 'content-type': 'text/plain' }).end('unknown build');
        return;
      }
      res
        .writeHead(200, {
          ...cors,
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-lumibase-ext-version': String(build.event.version),
        })
        .end(build.code);
      return;
    }

    res.writeHead(404, { ...cors, 'content-type': 'text/plain' }).end('not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? EXTENSION_DEV_DEFAULT_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const heartbeat = setInterval(() => {
    for (const res of subscribers) res.write(':hb\n\n');
  }, heartbeatMs);
  heartbeat.unref();

  const port = (server.address() as AddressInfo).port;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${port}`,
    port,
    session,
    publish(input) {
      const event: ExtensionDevReloadEvent = {
        protocol: EXTENSION_DEV_PROTOCOL,
        name: input.name,
        type: input.type,
        session,
        version: input.version,
        builtAt: new Date().toISOString(),
        sha256: createHash('sha256').update(input.code).digest('hex'),
        capabilities: [...input.capabilities],
        siteId: input.siteId,
      };
      const list = builds.get(input.name) ?? [];
      list.push({ event, code: input.code });
      while (list.length > retain) list.shift();
      builds.set(input.name, list);
      for (const res of subscribers) sse(res, 'reload', event);
      return event;
    },
    publishError(name, message) {
      const event: ExtensionDevErrorEvent = { protocol: EXTENSION_DEV_PROTOCOL, name, message };
      for (const res of subscribers) sse(res, 'build-error', event);
    },
    subscriberCount: () => subscribers.size,
    close() {
      clearInterval(heartbeat);
      for (const res of subscribers) res.end();
      subscribers.clear();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
