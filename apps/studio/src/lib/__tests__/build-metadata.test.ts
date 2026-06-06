import { describe, expect, it } from 'vitest';
import { getStudioBuildMetadata } from '../build-metadata';

describe('getStudioBuildMetadata', () => {
  it('reads Studio build metadata from Vite env values', () => {
    expect(
      getStudioBuildMetadata({
        VITE_LUMIBASE_VERSION: '1.2.3',
        VITE_LUMIBASE_GIT_SHA: 'abc123def456',
        VITE_LUMIBASE_BUILD_TIME: '2026-06-06T00:00:00.000Z',
      }),
    ).toEqual({
      version: '1.2.3',
      gitSha: 'abc123def456',
      buildTime: '2026-06-06T00:00:00.000Z',
      releaseChannel: 'studio',
    });
  });

  it('falls back to unknown for missing or blank env values', () => {
    expect(
      getStudioBuildMetadata({
        VITE_LUMIBASE_VERSION: '',
        VITE_LUMIBASE_GIT_SHA: '   ',
        VITE_LUMIBASE_BUILD_TIME: undefined,
      }),
    ).toEqual({
      version: 'unknown',
      gitSha: 'unknown',
      buildTime: 'unknown',
      releaseChannel: 'studio',
    });
  });
});
