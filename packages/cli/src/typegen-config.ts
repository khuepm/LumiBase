/**
 * Types for `lumibase.typegen.config.{ts,mts,js,mjs,json}` (#753).
 *
 * Platform-neutral on purpose: `lib.ts` re-exports these so a project can
 * write `import { defineTypegenConfig } from 'lumibase'` in its config file.
 */

/** Plain TypeScript interfaces — the existing `generateTypes` output. */
export interface TsTarget {
  type: 'ts';
  out: string;
  /** Branded primary-key types. Default `true`. */
  branded?: boolean;
  /** Module the file imports `ID` / `Locale` / `Brand` from. Default `lumibase`. */
  importFrom?: string;
}

/** Zod runtime validators mirroring the TS types. */
export interface ZodTarget {
  type: 'zod';
  out: string;
  /** Module `z` is imported from. Default `zod`. */
  importFrom?: string;
}

/** GraphQL SDL matching the schema the CMS serves at `/graphql`. */
export interface GraphQLSdlTarget {
  type: 'graphql-sdl';
  out: string;
}

/** OpenAPI 3.1 `components/schemas` document (JSON). */
export interface OpenApiTarget {
  type: 'openapi';
  out: string;
  title?: string;
  version?: string;
}

/** The raw manifest (JSON) — commit it to generate offline later. */
export interface ManifestTarget {
  type: 'manifest';
  out: string;
}

export type TypegenTarget = TsTarget | ZodTarget | GraphQLSdlTarget | OpenApiTarget | ManifestTarget;

export type TypegenTargetType = TypegenTarget['type'];

export const TYPEGEN_TARGET_TYPES: readonly TypegenTargetType[] = [
  'ts',
  'zod',
  'graphql-sdl',
  'openapi',
  'manifest',
];

/**
 * Fetch the manifest from a running CMS. Every value is optional and falls
 * back to the usual resolution (flag > environment > `lumibase.config.json`).
 * The token is never written here: name the environment variable that holds
 * it with `tokenEnv`.
 */
export interface TypegenLiveSource {
  url?: string;
  site?: string;
  /** Environment variable holding the URL (e.g. `STAGING_LUMIBASE_URL`). */
  urlEnv?: string;
  /** Environment variable holding the site id. */
  siteEnv?: string;
  /** Environment variable holding the bearer token. Default `LUMIBASE_TOKEN`. */
  tokenEnv?: string;
}

/** Read a saved manifest file instead of calling a CMS (path relative to the config file). */
export interface TypegenFileSource {
  manifest: string;
}

export type TypegenSource = TypegenLiveSource | TypegenFileSource;

export interface TypegenConfig {
  /** Label used in log lines. Defaults to `config #<n>`. */
  name?: string;
  source?: TypegenSource;
  /** Only these collections. */
  include?: string[];
  /** Skip these collections. */
  exclude?: string[];
  /** One or more outputs; paths are relative to the config file. */
  targets: TypegenTarget[];
}

export type TypegenConfigExport = TypegenConfig | TypegenConfig[];

/** Identity helper that gives a config file editor completion and type checking. */
export function defineTypegenConfig<T extends TypegenConfigExport>(config: T): T {
  return config;
}
