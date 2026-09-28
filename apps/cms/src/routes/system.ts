import { Hono } from 'hono';
import type { BuildMetadata } from '@lumibase/contracts';
import type { AppEnv, Bindings } from '../env';

const UNKNOWN_METADATA_VALUE = 'unknown';

type ProcessLike = {
  env?: Record<string, string | undefined>;
};

function valueOrUnknown(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNKNOWN_METADATA_VALUE;
}

function getProcessEnv(): Record<string, string | undefined> {
  return ((globalThis as typeof globalThis & { process?: ProcessLike }).process?.env) ?? {};
}

/**
 * Metadata baked into the Node bundle at build time by
 * `scripts/with-build-metadata.mjs` (`--define`). The Worker gets the same
 * values as `wrangler --var` bindings, but the Docker image runs
 * `dist/serve.cjs` with whatever env the operator passes — which never
 * includes the version — so every published image answered
 * `version: "unknown"`, and the "determine your current version" step of the
 * upgrade runbook could not work. Runtime env still wins when set.
 */
declare const __LUMIBASE_BUILD_METADATA__: Record<string, string | undefined> | undefined;

function getBakedMetadata(): Record<string, string | undefined> {
  return typeof __LUMIBASE_BUILD_METADATA__ === 'object' && __LUMIBASE_BUILD_METADATA__
    ? __LUMIBASE_BUILD_METADATA__
    : {};
}

export function resolveBuildMetadata(
  env: Partial<Bindings> = {},
  processEnv: Record<string, string | undefined> = getProcessEnv(),
  baked: Record<string, string | undefined> = getBakedMetadata(),
): BuildMetadata {
  const pick = (key: keyof BuildMetadataEnv) =>
    valueOrUnknown(firstKnown(env[key], processEnv[key], baked[key]));
  return {
    version: pick('LUMIBASE_VERSION'),
    gitSha: pick('LUMIBASE_GIT_SHA'),
    buildTime: pick('LUMIBASE_BUILD_TIME'),
    releaseChannel: pick('LUMIBASE_RELEASE_CHANNEL'),
  };
}

type BuildMetadataEnv = Pick<
  Bindings,
  'LUMIBASE_VERSION' | 'LUMIBASE_GIT_SHA' | 'LUMIBASE_BUILD_TIME' | 'LUMIBASE_RELEASE_CHANNEL'
>;

/**
 * First value that is set and not the `unknown` placeholder. `wrangler.toml`
 * ships `LUMIBASE_VERSION = "unknown"` as a default var, so a plain `??`
 * would let that placeholder shadow a real baked value.
 */
function firstKnown(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && trimmed !== UNKNOWN_METADATA_VALUE) return trimmed;
  }
  return undefined;
}

export const systemRouter = new Hono<AppEnv>();

systemRouter.get('/version', (c) => {
  return c.json(resolveBuildMetadata(c.env), 200);
});
