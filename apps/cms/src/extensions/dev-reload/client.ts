import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXTENSION_DEV_MIN_TOKEN_LENGTH,
  extensionDevBundlePath,
  isExtensionDevServerType,
  parseExtensionDevReloadEvent,
  supersedesDevBuild,
  type ExtensionDevReloadEvent,
} from '@lumibase/contracts/extensions';
import type { ExtensionDevConfig } from './config';
import type { DevExtensionRegistry } from './registry';

/**
 * CMS side of extension hot reload (#754). NODE-ONLY — imported dynamically
 * from `serve.ts` after `resolveExtensionDevConfig` allowed it; never part of
 * the Workers bundle.
 *
 * Subscribes to the `lumibase-ext dev` hub's SSE stream on loopback, and for
 * each server-side `reload` event: fetches the bundle at that version,
 * verifies its SHA-256 against the event, imports it as a fresh ES module
 * (a `data:` URL — every version is a distinct module, so Node's module cache
 * is bypassed without touching disk) and atomically swaps it into the
 * registry. In-flight requests keep the generation they started with (see
 * `registry.ts`). Reconnects with a short backoff, re-reading the token file
 * each time, so the CMS can start before or after the CLI.
 */

type EnabledConfig = Extract<ExtensionDevConfig, { enabled: true }>;

export interface ExtensionDevClientOptions {
  config: EnabledConfig;
  registry: DevExtensionRegistry;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Turns bundle source into a module namespace. Default: data-URL import. */
  importModule?: (code: string) => Promise<Record<string, unknown>>;
  reconnectMs?: number;
  log?: (line: string) => void;
}

export interface ExtensionDevClient {
  stop(): void;
  /** Resolves after each successful swap with the applied event (tests). */
  readonly applied: ReadonlyArray<ExtensionDevReloadEvent>;
}

/** Same path the CLI writes (`packages/extension-cli/src/dev/session.ts`). */
export function defaultExtensionDevTokenFile(port: number): string {
  return join(tmpdir(), 'lumibase-ext-dev', `${port}.token`);
}

function readToken(config: EnabledConfig): string | null {
  if (config.token) return config.token;
  try {
    const raw = readFileSync(config.tokenFile ?? defaultExtensionDevTokenFile(config.hubPort), 'utf8').trim();
    return raw.length >= EXTENSION_DEV_MIN_TOKEN_LENGTH ? raw : null;
  } catch {
    return null;
  }
}

/** Message only — never a stack or cause, which could carry the token-bearing URL. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/token=[0-9a-f]+/gi, 'token=[redacted]');
}

function importFromSource(code: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>;
}

export function startExtensionDevClient(options: ExtensionDevClientOptions): ExtensionDevClient {
  const { config, registry } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const importModule = options.importModule ?? importFromSource;
  const reconnectMs = options.reconnectMs ?? 1000;
  const log = options.log ?? ((line: string) => console.log(`[extension-dev] ${line}`));
  const applied: ExtensionDevReloadEvent[] = [];
  const abort = new AbortController();
  let stopped = false;
  // Serialise swaps so versions are applied in arrival order.
  let chain: Promise<void> = Promise.resolve();

  registry.activate(options.env);
  log(`hot reload ENABLED (dev only) — subscribing to ${config.hubUrl}`);

  async function apply(event: ExtensionDevReloadEvent, token: string): Promise<void> {
    if (!isExtensionDevServerType(event.type)) return; // UI slots are Studio's job
    if (!supersedesDevBuild(registry.snapshot().get(event.name), event)) return;

    const res = await doFetch(`${config.hubUrl}${extensionDevBundlePath(event.name, event.version)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`bundle ${event.name}@${event.version}: HTTP ${res.status}`);
    const code = await res.text();
    const digest = createHash('sha256').update(code, 'utf8').digest('hex');
    if (digest !== event.sha256) throw new Error(`bundle ${event.name}@${event.version}: sha256 mismatch`);

    const module = await importModule(code);
    if (registry.swap({ ...event, module })) {
      applied.push(event);
      log(`${event.name} → v${event.version} (${event.type}) swapped in`);
    }
  }

  function enqueue(event: ExtensionDevReloadEvent, token: string): void {
    chain = chain
      .then(() => apply(event, token))
      .catch((err) => log(`reload of ${event.name} failed: ${errorMessage(err)}`));
  }

  function handleBlock(block: string, token: string): void {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'hello') {
      const list = (parsed as { extensions?: unknown }).extensions;
      for (const raw of Array.isArray(list) ? list : []) {
        const ev = parseExtensionDevReloadEvent(raw);
        if (ev) enqueue(ev, token);
      }
    } else if (event === 'reload') {
      const ev = parseExtensionDevReloadEvent(parsed);
      if (ev) enqueue(ev, token);
    } else if (event === 'build-error') {
      const { name } = parsed as { name?: unknown };
      log(`build of ${typeof name === 'string' ? name : 'extension'} failed — keeping the previous version`);
    }
  }

  async function connectOnce(): Promise<void> {
    const token = readToken(config);
    if (!token) throw new Error('no session token yet (start `lumibase-ext dev`)');
    const res = await doFetch(`${config.hubUrl}/events`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`hub refused the subscription: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        handleBlock(buffer.slice(0, idx), token);
        buffer = buffer.slice(idx + 2);
      }
    }
  }

  void (async () => {
    let lastError = '';
    while (!stopped) {
      try {
        await connectOnce();
        lastError = '';
      } catch (err) {
        if (stopped) break;
        const msg = errorMessage(err);
        if (msg !== lastError) log(`waiting for hub: ${msg}`);
        lastError = msg;
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, reconnectMs).unref?.());
    }
  })();

  return {
    applied,
    stop() {
      stopped = true;
      abort.abort();
      registry.deactivate();
    },
  };
}
