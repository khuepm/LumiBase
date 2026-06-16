import path from 'node:path';
import type { Plugin } from 'vite';
import { discoverExtensions, UI_EXTENSION_TYPES } from '@lumibase/extensions';

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

export interface DevExtensionsPluginOptions {
  /** Absolute path to the extensions root folder. */
  extensionsRoot: string;
}

export function devExtensionsPlugin(options: DevExtensionsPluginOptions): Plugin {
  const { extensionsRoot } = options;
  let isDev = false;

  return {
    name: 'lumibase:dev-extensions',
    apply: 'serve', // dev server only; never affects production builds
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
          const spec = JSON.stringify(ext.entryPath.split(path.sep).join('/'));
          return `  { name: ${JSON.stringify(ext.name)}, type: ${JSON.stringify(
            ext.type,
          )}, load: () => import(/* @vite-ignore */ ${spec}) }`;
        })
        .join(',\n');

      return `export const devExtensions = [\n${entries}\n];`;
    },
  };
}
