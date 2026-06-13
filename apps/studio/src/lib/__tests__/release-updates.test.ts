import { beforeEach, describe, expect, it, vi } from 'vitest';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
  };
}
import {
  RELEASE_MANIFEST_URL,
  checkReleaseManifest,
  compareVersions,
  evaluateReleaseUpdate,
  isReleaseUpdateCheckEnabled,
  normalizeReleaseManifest,
  setReleaseUpdateCheckEnabled,
} from '../release-updates';

const manifest = {
  stable: {
    version: '1.2.0',
    releaseDate: '2026-06-06',
    changelogUrl: 'https://docs.lumibase.dev/changelog/1.2.0',
    minimumSafeUpgradeVersion: '1.0.0',
    migrationWarning: true,
  },
  edge: {
    version: '1.3.0-edge.2',
    releaseDate: '2026-06-06',
    changelogUrl: 'https://docs.lumibase.dev/changelog/1.3.0-edge.2',
    minimumSafeUpgradeVersion: '1.2.0',
    migrationWarning: false,
  },
};

describe('release update helpers', () => {
  beforeEach(() => {
    const localStorage = createStorage();
    vi.stubGlobal('window', { localStorage });
  });

  it('keeps manifest checks disabled until an admin opts in', () => {
    expect(isReleaseUpdateCheckEnabled()).toBe(false);

    setReleaseUpdateCheckEnabled(true);
    expect(isReleaseUpdateCheckEnabled()).toBe(true);

    setReleaseUpdateCheckEnabled(false);
    expect(isReleaseUpdateCheckEnabled()).toBe(false);
  });

  it('normalizes the required stable and edge manifest fields', () => {
    expect(normalizeReleaseManifest(manifest)).toEqual(manifest);
  });

  it('rejects manifests missing required safety metadata', () => {
    expect(() => normalizeReleaseManifest({ ...manifest, stable: { version: '1.2.0' } })).toThrow(/releaseDate/);
  });

  it('compares semver-like versions without treating 1.10 as older than 1.2', () => {
    expect(compareVersions('1.10.0', '1.2.0')).toBe(1);
    expect(compareVersions('v1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.0', '1.2.1')).toBe(-1);
  });

  it('selects stable releases for stable builds and includes migration safety state', () => {
    expect(evaluateReleaseUpdate(normalizeReleaseManifest(manifest), '0.9.0')).toMatchObject({
      targetChannel: 'stable',
      updateAvailable: true,
      belowMinimumSafeUpgradeVersion: true,
      target: manifest.stable,
    });
  });

  it('selects edge releases for edge/canary-style builds', () => {
    expect(evaluateReleaseUpdate(normalizeReleaseManifest(manifest), '1.3.0-edge.1')).toMatchObject({
      targetChannel: 'edge',
      updateAvailable: true,
      target: manifest.edge,
    });
  });

  it('fetches only the public manifest with anonymous request options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(manifest),
    });

    await expect(checkReleaseManifest({ currentVersion: '1.0.0', fetchImpl })).resolves.toMatchObject({
      updateAvailable: true,
      target: manifest.stable,
    });

    expect(fetchImpl).toHaveBeenCalledWith(RELEASE_MANIFEST_URL, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/json',
      },
    });
  });
});
