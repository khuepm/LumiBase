/**
 * Library entry of the `lumibase` package.
 *
 * `import { createLumiClient } from 'lumibase'` is the same client as
 * `@lumibase/sdk` — this package re-exports it so a project needs one name in
 * `dependencies` for both the runtime client and the `lumibase` CLI. The SDK
 * stays a separate, dependency-free package underneath; nothing here is
 * Node-specific, so this entry is safe to import from browser and edge code.
 */
export * from '@lumibase/sdk';
export {
  defineTypegenConfig,
  type TypegenConfig,
  type TypegenConfigExport,
  type TypegenFileSource,
  type TypegenLiveSource,
  type TypegenSource,
  type TypegenTarget,
  type TypegenTargetType,
  type TsTarget,
  type ZodTarget,
  type GraphQLSdlTarget,
  type OpenApiTarget,
  type ManifestTarget,
} from './typegen-config.js';
