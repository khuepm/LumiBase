import path from 'node:path';
import type { Plugin } from 'vite';

// NOTE: `@lumibase/extensions` is imported LAZILY inside the `load()` hook
// (see below), NOT at the top level. The package ships as `.ts` source with
// `"type": "module"`, and a static top-level import here forces Node's native
// ESM loader to resolve that source chain when it merely *loads this config* —
// which it cannot transpile, so its extensionless relative imports
// (`./discovery`) throw ERR_MODULE_NOT_FOUND and break `vite build`. Because
// the package is only touched inside the dev-guarded branch of `load()`, the
// dynamic import runs through Vite's own (TS-aware) pipeline at dev time and
// never participates in config resolution for production builds.

/**
 * Dev-only Vite plugin: auto-detect UI extensions from the source `extensions/`
 * folder (the `lumibase-ai/extensions` submodule) and expose them to Studio
 * through a virtual module.
 *
 * This is LumiBase's answer to Directus's filesystem extension auto-loading.
 * In production, Studio loads extensions from the CMS API (DB-backed, served
 * from R2). In dev, we want to iterate on extension SOURCE without publishing a
 * bundle — so this plugin scans the folder, validates manifests via the shared
 * discovery util, and generates a module that statically imports each UI
 * extension's source entrypoint. Vite then HMR-compiles that source like any
 * other app code.
 *
 * The virtual module shape (consumed by `extension-loader.tsx`):
 *   export const devExtensions: Array<{
 *     name: string; type: UiExtensionType; load: () => Promise<unknown>;
 *   }>;
 *
 * When the folder is missing or empty (e.g. CI without the submodule), the
 * module resolves to an empty array — a harmless no-op.
 */

const VIRTUAL_ID = 'virtual:lumibase-extensions';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const UNSAFE_JS_CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeUnsafeJsChars(str: string): string {
  return str.replace(/[<>/\u2028\u2029]/g, (ch) => UNSAFE_JS_CHAR_MAP[ch] ?? ch);
}

export interface DevExtensionsPluginOptions {
  /** Absolute path to the extensions root folder. */
  extensionsRoot: string;
}

export function devExtensionsPlugin(options: DevExtensionsPluginOptions): Plugin {
  const { extensionsRoot } = options;
  let isDev = false;

  return {
    name: 'lumibase:dev-extensions',
    // Registered in BOTH serve and build (no `apply: 'serve'`): the production
    // build must still RESOLVE the `virtual:lumibase-extensions` module that
    // `extension-loader.tsx` dynamically imports — otherwise Rollup fails with
    // "failed to resolve import virtual:lumibase-extensions". The dev-only
    // BEHAVIOUR is preserved by the `isDev` guard in `load()` below: under
    // `build` the virtual module resolves to an empty `devExtensions` array
    // (production loads extensions from the CMS API instead), and
    // `@lumibase/extensions` is never imported off the source folder.
    configResolved(config) {
      isDev = config.command === 'serve';
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      if (!isDev) return `export const devExtensions = [];`;

      // Lazy import (see top-of-file note): keeps `@lumibase/extensions` out of
      // Node's config-load resolution and inside Vite's TS-aware pipeline.
      const { discoverExtensions, UI_EXTENSION_TYPES } = await import(
        '@lumibase/extensions'
      );

      const { extensions, errors } = await discoverExtensions(extensionsRoot, {
        types: [...UI_EXTENSION_TYPES],
      });

      for (const err of errors) {
        this.warn(`[dev-extensions] skipped ${err.sourceDir}: ${err.reason}`);
      }

      // Build static dynamic-import entries. Posix-normalize paths so the
      // generated import specifiers work on every platform.
      const entries = extensions
        .map((ext) => {
          const spec = escapeUnsafeJsChars(
            JSON.stringify(ext.entryPath.split(path.sep).join('/')),
          );
          return `  { name: ${JSON.stringify(ext.name)}, type: ${JSON.stringify(
            ext.type,
          )}, load: () => import(/* @vite-ignore */ ${spec}) }`;
        })
        .join(',\n');

      return `export const devExtensions = [\n${entries}\n];`;
    },
  };
}
