/**
 * `@lumibase/astro` — Astro integration.
 *
 * ```ts
 * // astro.config.mjs
 * import lumibase from '@lumibase/astro';
 * export default defineConfig({
 *   integrations: [lumibase({ url: 'https://cms.example.com', siteId: 'site_123' })],
 * });
 *
 * // src/pages/index.astro (frontmatter)
 * import { lumi } from 'virtual:lumibase';
 * import { readItems } from '@lumibase/sdk';
 * const posts = await lumi.request(readItems('posts', { limit: 10 }));
 * ```
 *
 * The integration adds one server-only virtual module, `virtual:lumibase`,
 * exporting a configured SDK client. The token is never an integration
 * option: the module reads `<tokenEnv>` (default `LUMIBASE_TOKEN`) with
 * `getSecret()` from `astro:env/server` when the server runs (never inlined at
 * build time), and importing it from browser code fails
 * the build instead of shipping the token.
 *
 * Typed structurally against Astro's integration API (5.x–7.x), so this
 * package does not depend on `astro`.
 */
export { lumibaseLoader } from "./loader";
export type { LumibaseLoaderOptions, LoaderContextLike, LumibaseLoader } from "./loader";

export const VIRTUAL_MODULE_ID = "virtual:lumibase";
const RESOLVED_VIRTUAL_MODULE_ID = `\0${VIRTUAL_MODULE_ID}`;

export interface LumibaseIntegrationOptions {
  /** CMS base URL. */
  url: string;
  /** Site (tenant) id. */
  siteId: string;
  /** Env var holding the server token. Default `LUMIBASE_TOKEN`. */
  tokenEnv?: string;
  /**
   * Extension point: module specifiers imported on every page via
   * `injectScript('page', …)`. This is where a future visual-editing client
   * (V03, `@lumibase/visual-editing`, #681) would hook in; the adapter ships
   * none itself.
   */
  pageScripts?: string[];
}

/** The parts of Astro's `astro:config:setup` / `astro:config:done` params used here. */
export interface AstroConfigSetupLike {
  updateConfig(config: { vite?: { plugins?: unknown[] } }): unknown;
  injectScript(stage: "head-inline" | "before-hydration" | "page" | "page-ssr", content: string): void;
}
export interface AstroConfigDoneLike {
  /** Astro ≥ 5. */
  injectTypes?(input: { filename: string; content: string }): unknown;
}

export interface LumibaseIntegration {
  name: string;
  hooks: {
    "astro:config:setup": (params: AstroConfigSetupLike) => void;
    "astro:config:done": (params: AstroConfigDoneLike) => void;
  };
}

/** Minimal Vite plugin shape (structural; no `vite` import). */
export interface VirtualModulePlugin {
  name: string;
  enforce: "pre";
  resolveId(id: string): string | undefined;
  load(
    this: { environment?: { config?: { consumer?: string } } } | void,
    id: string,
    options?: { ssr?: boolean },
  ): string | undefined;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validate(options: LumibaseIntegrationOptions): Required<Omit<LumibaseIntegrationOptions, "pageScripts">> {
  const tokenEnv = options.tokenEnv ?? "LUMIBASE_TOKEN";
  // The name is spliced into generated code, so only identifiers are allowed.
  if (!ENV_NAME.test(tokenEnv)) throw new Error(`[@lumibase/astro] tokenEnv must be an identifier, got ${JSON.stringify(tokenEnv)}`);
  if (!options.url || !options.siteId) throw new Error("[@lumibase/astro] `url` and `siteId` are required.");
  return { url: options.url, siteId: options.siteId, tokenEnv };
}

/** Source of `virtual:lumibase`. Contains the env var *name*, never a token. */
export function virtualModuleSource(options: LumibaseIntegrationOptions): string {
  const { url, siteId, tokenEnv } = validate(options);
  return [
    `import { createLumiClient } from "@lumibase/sdk";`,
    // `getSecret` reads the variable when the server runs, through the
    // adapter (Node `process.env`, Cloudflare bindings, …). `import.meta.env.X`
    // would be replaced by Vite at build time, baking the build machine's token
    // into `dist/server` of an SSR build.
    `import { getSecret } from "astro:env/server";`,
    `export const config = { url: ${JSON.stringify(url)}, siteId: ${JSON.stringify(siteId)} };`,
    `export function createClient(token = getSecret(${JSON.stringify(tokenEnv)}) ?? "") {`,
    `  return createLumiClient({ ...config, token });`,
    `}`,
    `export const lumi = createClient();`,
    ``,
  ].join("\n");
}

export const VIRTUAL_MODULE_TYPES = `declare module "${VIRTUAL_MODULE_ID}" {
  import type { LumiClient } from "@lumibase/sdk";
  export const config: { url: string; siteId: string };
  export function createClient(token?: string): LumiClient;
  export const lumi: LumiClient;
}
`;

/** Vite plugin serving `virtual:lumibase`; refuses to load it into a client bundle. */
export function lumibaseVitePlugin(options: LumibaseIntegrationOptions): VirtualModulePlugin {
  const source = virtualModuleSource(options);
  return {
    name: "lumibase:virtual-module",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_MODULE_ID ? RESOLVED_VIRTUAL_MODULE_ID : undefined;
    },
    load(id, loadOptions) {
      if (id !== RESOLVED_VIRTUAL_MODULE_ID) return undefined;
      const consumer = this && this.environment?.config?.consumer;
      const onServer = consumer ? consumer === "server" : loadOptions?.ssr === true;
      if (!onServer) {
        throw new Error(
          `[@lumibase/astro] "${VIRTUAL_MODULE_ID}" is server-only (it reads your LumiBase token). ` +
            "Import it from frontmatter, endpoints or middleware — not from a client <script> or island.",
        );
      }
      return source;
    },
  };
}

/** The Astro integration. */
export default function lumibase(options: LumibaseIntegrationOptions): LumibaseIntegration {
  validate(options);
  return {
    name: "@lumibase/astro",
    hooks: {
      "astro:config:setup": ({ updateConfig, injectScript }) => {
        updateConfig({ vite: { plugins: [lumibaseVitePlugin(options)] } });
        for (const spec of options.pageScripts ?? []) {
          injectScript("page", `import ${JSON.stringify(spec)};`);
        }
      },
      "astro:config:done": ({ injectTypes }) => {
        injectTypes?.({ filename: "lumibase.d.ts", content: VIRTUAL_MODULE_TYPES });
      },
    },
  };
}
