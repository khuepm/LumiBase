/**
 * Whether importing `serve.ts` starts the server.
 *
 * On by default: `serve.ts` is the Node entry point and starts on load. A
 * deployment entry that wraps the CMS needs the start function without that
 * side effect, so `./node` switches this off before it loads `serve.ts`.
 *
 * Kept in its own dependency-free module so flipping the switch never pulls the
 * server (and its Node-only imports) into the module graph early.
 */
let autostart = true;

export function disableNodeAutostart(): void {
  autostart = false;
}

export function nodeAutostartEnabled(): boolean {
  return autostart;
}
