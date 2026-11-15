/**
 * Test stand-in for the dev-only `virtual:lumibase-extensions` module that the
 * `lumibase:dev-extensions` Vite plugin generates. jsdom suites transform
 * `extension-loader.tsx` in client mode, where an unresolvable import fails
 * the whole file, so vitest aliases the id to this empty list.
 */
export const devExtensions: Array<{ name: string; type: string; load: () => Promise<unknown> }> = [];
