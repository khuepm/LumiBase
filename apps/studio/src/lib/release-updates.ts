import { studioBuildMetadata } from './build-metadata';

export const RELEASE_MANIFEST_URL = 'https://updates.lumibase.dev/releases.json';
export const UPGRADE_GUIDE_URL = 'https://docs.lumibase.dev/upgrade';
export const RELEASE_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const RELEASE_UPDATES_OPT_IN_KEY = 'lumibase.releaseUpdates.optIn';
const RELEASE_UPDATES_LAST_CHECK_KEY = 'lumibase.releaseUpdates.lastCheckAt';

export interface ReleaseChannelManifest {
  version: string;
  releaseDate: string;
  changelogUrl: string;
  minimumSafeUpgradeVersion: string;
  migrationWarning: boolean;
  upgradeGuideUrl?: string;
}

export interface ReleaseManifest {
  stable: ReleaseChannelManifest;
  edge: ReleaseChannelManifest;
}

export interface ReleaseUpdateStatus {
  manifest: ReleaseManifest;
  currentVersion: string;
  targetChannel: 'stable' | 'edge';
  target: ReleaseChannelManifest;
  updateAvailable: boolean;
  belowMinimumSafeUpgradeVersion: boolean;
}

export interface ReleaseUpdateCheckOptions {
  currentVersion?: string;
  manifestUrl?: string;
  fetchImpl?: typeof fetch;
}

type ManifestRecord = Record<string, unknown>;

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function isReleaseUpdateCheckEnabled(): boolean {
  return getStorage()?.getItem(RELEASE_UPDATES_OPT_IN_KEY) === 'true';
}

export function setReleaseUpdateCheckEnabled(enabled: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(RELEASE_UPDATES_OPT_IN_KEY, enabled ? 'true' : 'false');
}

export function getLastReleaseUpdateCheckAt(): string | null {
  return getStorage()?.getItem(RELEASE_UPDATES_LAST_CHECK_KEY) ?? null;
}

function setLastReleaseUpdateCheckAt(value: string): void {
  getStorage()?.setItem(RELEASE_UPDATES_LAST_CHECK_KEY, value);
}

function requireString(record: ManifestRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Release manifest field "${field}" must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoolean(record: ManifestRecord, field: string): boolean {
  const value = record[field];
  if (typeof value !== 'boolean') {
    throw new Error(`Release manifest field "${field}" must be a boolean.`);
  }
  return value;
}

function normalizeChannel(raw: unknown, channel: 'stable' | 'edge'): ReleaseChannelManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Release manifest channel "${channel}" must be an object.`);
  }

  const record = raw as ManifestRecord;
  const upgradeGuideUrl = record.upgradeGuideUrl;
  if (upgradeGuideUrl !== undefined && typeof upgradeGuideUrl !== 'string') {
    throw new Error(`Release manifest field "${channel}.upgradeGuideUrl" must be a string when present.`);
  }

  return {
    version: requireString(record, 'version'),
    releaseDate: requireString(record, 'releaseDate'),
    changelogUrl: requireString(record, 'changelogUrl'),
    minimumSafeUpgradeVersion: requireString(record, 'minimumSafeUpgradeVersion'),
    migrationWarning: requireBoolean(record, 'migrationWarning'),
    upgradeGuideUrl: upgradeGuideUrl?.trim() || undefined,
  };
}

export function normalizeReleaseManifest(raw: unknown): ReleaseManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Release manifest must be a JSON object.');
  }

  const record = raw as ManifestRecord;
  return {
    stable: normalizeChannel(record.stable, 'stable'),
    edge: normalizeChannel(record.edge, 'edge'),
  };
}

interface ParsedVersion {
  parts: number[];
  prerelease: string;
}

function parseVersion(version: string): ParsedVersion | null {
  const cleaned = version.trim().replace(/^v/i, '').split('+')[0] ?? '';
  const [core = '', prerelease = ''] = cleaned.split('-', 2);
  const parts = core.split('.');
  if (parts.length === 0) return null;
  const numbers = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return numbers.some(Number.isNaN) ? null : { parts: numbers, prerelease };
}

export function compareVersions(a: string, b: string): number {
  const aVersion = parseVersion(a);
  const bVersion = parseVersion(b);
  if (!aVersion || !bVersion) return a.localeCompare(b);

  const length = Math.max(aVersion.parts.length, bVersion.parts.length);
  for (let index = 0; index < length; index += 1) {
    const left = aVersion.parts[index] ?? 0;
    const right = bVersion.parts[index] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  if (aVersion.prerelease === bVersion.prerelease) return 0;
  if (!aVersion.prerelease) return 1;
  if (!bVersion.prerelease) return -1;
  return aVersion.prerelease.localeCompare(bVersion.prerelease, undefined, { numeric: true });
}

function selectTargetChannel(version: string): 'stable' | 'edge' {
  return /(?:^|[.+-])(?:edge|alpha|beta|canary|next|rc)(?:$|[.+-])/i.test(version) ? 'edge' : 'stable';
}

export function evaluateReleaseUpdate(manifest: ReleaseManifest, currentVersion = studioBuildMetadata.version): ReleaseUpdateStatus {
  const targetChannel = selectTargetChannel(currentVersion);
  const target = manifest[targetChannel];

  return {
    manifest,
    currentVersion,
    targetChannel,
    target,
    updateAvailable: compareVersions(target.version, currentVersion) > 0,
    belowMinimumSafeUpgradeVersion: compareVersions(currentVersion, target.minimumSafeUpgradeVersion) < 0,
  };
}

export async function checkReleaseManifest(options: ReleaseUpdateCheckOptions = {}): Promise<ReleaseUpdateStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.manifestUrl ?? RELEASE_MANIFEST_URL, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Release manifest request failed with HTTP ${response.status}.`);
  }

  const manifest = normalizeReleaseManifest(await response.json());
  setLastReleaseUpdateCheckAt(new Date().toISOString());
  return evaluateReleaseUpdate(manifest, options.currentVersion);
}
