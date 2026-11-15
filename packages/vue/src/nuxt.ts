/**
 * `@lumibase/vue/nuxt` — Nuxt 3/4 module.
 *
 * ```ts
 * // nuxt.config.ts
 * export default defineNuxtConfig({
 *   modules: ['@lumibase/vue/nuxt'],
 *   lumibase: { url: 'https://cms.example.com', siteId: 'site_123', realtime: true },
 * })
 * ```
 *
 * Secrets never go through module options: the server token is read from the
 * private runtime config (`NUXT_LUMIBASE_TOKEN`), which Nuxt never serialises
 * to the client. Only `publicToken` (a read-only delivery token, if you use
 * one) reaches the browser.
 *
 * Written without `@nuxt/kit` on purpose: a Nuxt module is a plain function
 * `(options, nuxt)`, and the three things this one does (runtime config, one
 * plugin, auto-imports) are plain option/hook writes. That keeps the adapter
 * free of a build-time dependency tree and lets its tests run without Nuxt.
 */
import { fileURLToPath } from "node:url";

export interface LumiBaseNuxtOptions {
  /** CMS base URL. Public. Env: `NUXT_PUBLIC_LUMIBASE_URL`. */
  url: string;
  /** Site (tenant) id. Public. Env: `NUXT_PUBLIC_LUMIBASE_SITE_ID`. */
  siteId: string;
  /**
   * Optional read-only token used in the browser (and on the server when no
   * private token is set). Env: `NUXT_PUBLIC_LUMIBASE_PUBLIC_TOKEN`. Never put
   * an admin token here — it ships in the page payload.
   */
  publicToken: string;
  /** Create a `RealtimeClient` in the browser. Default `false`. */
  realtime: boolean;
  /** Register auto-imports for the composables and SDK commands. Default `true`. */
  autoImports: boolean;
}

/** Shape the plugin reads back from `runtimeConfig.public.lumibase`. */
export type LumiBasePublicRuntimeConfig = Pick<LumiBaseNuxtOptions, "url" | "siteId" | "publicToken" | "realtime">;

/** Minimal structural view of the Nuxt instance this module touches. */
export interface NuxtLike {
  options: {
    runtimeConfig: Record<string, unknown> & { public?: Record<string, unknown> };
    plugins: Array<string | { src: string; mode?: "all" | "server" | "client" }>;
    build: { transpile: Array<string | RegExp | ((...args: never[]) => unknown)> };
    lumibase?: Partial<LumiBaseNuxtOptions>;
  };
  hook(name: "imports:sources", fn: (sources: ImportSource[]) => void): unknown;
}

export interface ImportSource {
  from: string;
  imports: string[];
}

export const NUXT_AUTO_IMPORTS: readonly ImportSource[] = [
  {
    from: "@lumibase/vue",
    imports: ["useLumiBase", "useLumiClient", "useItems", "useItem", "useRealtime", "usePresence"],
  },
  { from: "@lumibase/sdk", imports: ["readItems", "readItem"] },
];

const DEFAULTS: LumiBaseNuxtOptions = {
  url: "",
  siteId: "",
  publicToken: "",
  realtime: false,
  autoImports: true,
};

/** Absolute path of the runtime plugin next to this file (`.ts` in the repo, `.js` in dist). */
export function pluginPath(moduleUrl: string = import.meta.url): string {
  const ext = /\.ts$/.test(new URL(moduleUrl).pathname) ? ".ts" : ".js";
  return fileURLToPath(new URL(`./nuxt-plugin${ext}`, moduleUrl));
}

function lumibaseNuxtModule(inlineOptions: Partial<LumiBaseNuxtOptions> | undefined, nuxt: NuxtLike): void {
  const options: LumiBaseNuxtOptions = { ...DEFAULTS, ...nuxt.options.lumibase, ...inlineOptions };

  // Private (server-only) key. Left empty so `NUXT_LUMIBASE_TOKEN` fills it at runtime.
  const existingPrivate = (nuxt.options.runtimeConfig.lumibase ?? {}) as Record<string, unknown>;
  nuxt.options.runtimeConfig.lumibase = { token: "", ...existingPrivate };

  const pub = (nuxt.options.runtimeConfig.public ??= {});
  const existingPublic = (pub.lumibase ?? {}) as Partial<LumiBasePublicRuntimeConfig>;
  const publicConfig: LumiBasePublicRuntimeConfig = {
    url: options.url,
    siteId: options.siteId,
    publicToken: options.publicToken,
    realtime: options.realtime,
    ...existingPublic,
  };
  pub.lumibase = publicConfig;

  nuxt.options.build.transpile.push("@lumibase/vue");
  nuxt.options.plugins.push({ src: pluginPath(), mode: "all" });

  if (options.autoImports) {
    nuxt.hook("imports:sources", (sources) => {
      for (const source of NUXT_AUTO_IMPORTS) sources.push({ from: source.from, imports: [...source.imports] });
    });
  }
}

const meta = { name: "@lumibase/vue", configKey: "lumibase", compatibility: { nuxt: ">=3.10.0" } };

/** The module: a function plus the `getMeta` Nuxt reads for name/compat. */
const lumibase = Object.assign(lumibaseNuxtModule, {
  meta,
  getMeta: async () => meta,
});

export default lumibase;
