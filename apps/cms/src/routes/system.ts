import { Hono } from 'hono';
import type { BuildMetadata } from '@lumibase/shared';
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

export function resolveBuildMetadata(
  env: Partial<Bindings> = {},
  processEnv: Record<string, string | undefined> = getProcessEnv(),
): BuildMetadata {
  return {
    version: valueOrUnknown(env.LUMIBASE_VERSION ?? processEnv.LUMIBASE_VERSION),
    gitSha: valueOrUnknown(env.LUMIBASE_GIT_SHA ?? processEnv.LUMIBASE_GIT_SHA),
    buildTime: valueOrUnknown(env.LUMIBASE_BUILD_TIME ?? processEnv.LUMIBASE_BUILD_TIME),
    releaseChannel: valueOrUnknown(env.LUMIBASE_RELEASE_CHANNEL ?? processEnv.LUMIBASE_RELEASE_CHANNEL),
  };
}

export const systemRouter = new Hono<AppEnv>();

systemRouter.get('/version', (c) => {
  return c.json(resolveBuildMetadata(c.env), 200);
});
