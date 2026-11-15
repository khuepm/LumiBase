// Stand-ins for what Astro generates in `.astro/types.d.ts`, so the smoke
// example type-checks without an Astro install. The `virtual:lumibase`
// declaration is exactly what the integration injects (`VIRTUAL_MODULE_TYPES`).

declare module 'astro:content' {
  export function defineCollection<T>(config: T): T;
}

declare module 'virtual:lumibase' {
  import type { LumiClient } from '@lumibase/sdk';
  export const config: { url: string; siteId: string };
  export function createClient(token?: string): LumiClient;
  export const lumi: LumiClient;
}

interface ImportMetaEnv {
  readonly LUMIBASE_TOKEN?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
