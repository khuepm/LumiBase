import type { BuildMetadata } from '@lumibase/shared';

const UNKNOWN_METADATA_VALUE = 'unknown';

type StudioEnv = Pick<
  ImportMetaEnv,
  | 'VITE_LUMIBASE_VERSION'
  | 'VITE_LUMIBASE_GIT_SHA'
  | 'VITE_LUMIBASE_BUILD_TIME'
  | 'VITE_LUMIBASE_RELEASE_CHANNEL'
>;

function valueOrUnknown(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : UNKNOWN_METADATA_VALUE;
}

export function getStudioBuildMetadata(env: StudioEnv = import.meta.env): BuildMetadata {
  return {
    version: valueOrUnknown(env.VITE_LUMIBASE_VERSION),
    gitSha: valueOrUnknown(env.VITE_LUMIBASE_GIT_SHA),
    buildTime: valueOrUnknown(env.VITE_LUMIBASE_BUILD_TIME),
    releaseChannel: valueOrUnknown(env.VITE_LUMIBASE_RELEASE_CHANNEL),
  };
}

export const studioBuildMetadata = getStudioBuildMetadata();
