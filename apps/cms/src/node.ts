/**
 * Composable Node entry, exported from the package as `@lumibase/cms/node`.
 *
 * Importing this module has no side effects. A deployment entry that wraps the
 * CMS registers its platform seams and then starts the server itself:
 *
 * ```ts
 * import { registerPlatformSeams } from '@lumibase/cms/platform';
 * import { startNodeServer } from '@lumibase/cms/node';
 *
 * registerPlatformSeams({ entitlements: myResolver });
 * await startNodeServer();
 * ```
 *
 * The built-in entry (`serve.ts`) is unchanged: run directly, it still starts
 * on load. Node only — never import this from the Workers entry.
 */
import { disableNodeAutostart } from './node-autostart';

let started: Promise<void> | null = null;

/**
 * Start the HTTP server, cron and queue workers for this process — everything
 * `serve.ts` does when run directly. Resolves once startup has completed.
 * A second call returns the first call's promise; one process, one server.
 */
export function startNodeServer(): Promise<void> {
  started ??= (async () => {
    // Order matters: the switch must be off before `serve.ts` is evaluated.
    disableNodeAutostart();
    const { startNodeServer: start } = await import('./serve');
    await start();
  })();
  return started;
}
