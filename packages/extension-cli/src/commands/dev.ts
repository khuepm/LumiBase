import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { discoverExtensionAt } from '@lumibase/extensions';
import {
  EXTENSION_DEV_DEFAULT_PORT,
  isExtensionDevServerType,
} from '@lumibase/contracts/extensions';
import { createExtensionBuilder } from '../dev/builder';
import { startDevHub } from '../dev/hub';
import { createDevPipeline } from '../dev/pipeline';
import { assertUsableToken, defaultTokenFilePath, generateSessionToken } from '../dev/session';

/**
 * Watch an extension, rebuild it incrementally and hot-swap it into a running
 * Studio (UI slots) and CMS (hooks / endpoints / operations) — no restart.
 *
 *   lumibase-ext dev [--dir .] [--port 4790] [--site <siteId>]
 *                    [--studio http://localhost:2026] [--token <hex>]
 *                    [--token-file <path> | --no-token-file]
 *
 * LOCAL DEVELOPMENT ONLY. The hub binds to loopback, every request needs the
 * per-session token printed below, and the CMS side refuses to subscribe in
 * production. Hot reload is a Node/Docker feature — a Cloudflare Workers
 * deployment never loads code from the hub.
 */
export async function dev(args: Map<string, string | boolean>): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('lumibase-ext dev refuses to run with NODE_ENV=production');
  }

  const str = (key: string): string | undefined => {
    const v = args.get(key);
    return typeof v === 'string' ? v : undefined;
  };

  const dir = resolve(str('dir') ?? process.cwd());
  const ext = await discoverExtensionAt(dir);
  if (!ext) throw new Error(`no lumibase-extension.json in ${dir}`);

  const port = Number.parseInt(str('port') ?? String(EXTENSION_DEV_DEFAULT_PORT), 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
  const host = str('host') ?? '127.0.0.1';
  const pinned = str('token') ?? process.env.LUMIBASE_EXTENSION_DEV_TOKEN;
  const token = pinned ? assertUsableToken(pinned) : generateSessionToken();
  const siteId = str('site') ?? null;
  const studio = (str('studio') ?? 'http://localhost:2026').replace(/\/+$/, '');

  const hub = await startDevHub({ token, host, port });
  const builder = await createExtensionBuilder({ entryPath: ext.entryPath, type: ext.type, cwd: dir });
  const pipeline = createDevPipeline({
    name: ext.name,
    type: ext.type,
    capabilities: ext.manifest.capabilities,
    siteId,
    builder,
    hub,
    onBuilt: ({ event, buildMs }) =>
      process.stdout.write(
        `[lumibase-ext] ${ext.name} v${event.version} built in ${buildMs.toFixed(0)}ms → ${hub.subscriberCount()} client(s)\n`,
      ),
    onFailed: (errors) => process.stderr.write(`[lumibase-ext] build failed:\n  ${errors.join('\n  ')}\n`),
  });

  // Token file: lets a CMS started with LUMIBASE_EXTENSION_DEV=1 pick up this
  // session's token without a restart. 0600, removed on exit.
  const tokenFile = args.get('no-token-file') === true ? null : (str('token-file') ?? defaultTokenFilePath(hub.port));
  if (tokenFile) {
    mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  }

  await pipeline.build();
  pipeline.watch(dir);

  const studioLink = `${studio}/#lumibase-ext-dev=${encodeURIComponent(JSON.stringify({ url: hub.url, token }))}`;
  const lines = [
    '',
    `  lumibase-ext dev — ${ext.name} (${ext.type})`,
    `  hub:    ${hub.url}  (loopback only)`,
    `  token:  ${token}`,
    `          per-session secret — do not share; required on every hub request`,
    '',
  ];
  if (isExtensionDevServerType(ext.type)) {
    lines.push(
      '  CMS (Node/Docker dev only — not Workers): start it with',
      `    NODE_ENV=development LUMIBASE_EXTENSION_DEV=1 LUMIBASE_EXTENSION_DEV_URL=${hub.url}`,
      tokenFile
        ? `    (token is read from ${tokenFile}; or set LUMIBASE_EXTENSION_DEV_TOKEN)`
        : '    LUMIBASE_EXTENSION_DEV_TOKEN=<token above>',
      siteId ? `  hooks apply to site ${siteId} only` : '  hooks apply to every site of the local CMS (use --site <id> to narrow)',
    );
  } else {
    lines.push('  Studio (vite dev server): open', `    ${studioLink}`);
  }
  lines.push('', '  watching for changes — Ctrl+C to stop', '');
  process.stdout.write(`${lines.join('\n')}\n`);

  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  await pipeline.close();
  await hub.close();
  if (tokenFile) rmSync(tokenFile, { force: true });
}
