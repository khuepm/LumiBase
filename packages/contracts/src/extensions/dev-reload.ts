/**
 * Extension hot-reload wire protocol (#754).
 *
 * `lumibase-ext dev` runs a small dev hub on a loopback port. Studio (browser)
 * and the CMS (Node process) are both CLIENTS of that hub: they subscribe to a
 * Server-Sent-Events stream, and on a `reload` event fetch the freshly built
 * bundle from the hub and hot-swap it. Nothing in this file touches the
 * network or the filesystem — it is the shared vocabulary only, so it is safe
 * on every runtime (Workers included). The hot-reload path itself is Node /
 * Docker local development only.
 *
 * Security invariants every participant enforces:
 *   - the hub URL must be loopback (`isLoopbackUrl`), never a routable host;
 *   - every request carries the per-session token the CLI printed;
 *   - the CMS refuses to subscribe in production (see the CMS dev-reload guard).
 */

/** Default loopback port of the `lumibase-ext dev` hub. */
export const EXTENSION_DEV_DEFAULT_PORT = 4790;

/** Bumped on breaking changes to the event shape below. */
export const EXTENSION_DEV_PROTOCOL = 1;

/** Minimum session-token length (hex chars) any participant accepts. */
export const EXTENSION_DEV_MIN_TOKEN_LENGTH = 32;

/** Extension types the CMS process hot-swaps (the rest render in Studio). */
export const EXTENSION_DEV_SERVER_TYPES = ['hook', 'endpoint', 'operation'] as const;

/** Extension types Studio hot-swaps. Mirrors `UI_EXTENSION_TYPES`. */
export const EXTENSION_DEV_UI_TYPES = ['interface', 'display', 'layout', 'panel', 'module'] as const;

export type ExtensionDevServerType = (typeof EXTENSION_DEV_SERVER_TYPES)[number];
export type ExtensionDevUiType = (typeof EXTENSION_DEV_UI_TYPES)[number];

/**
 * One rebuilt extension bundle. `version` is a per-session monotonically
 * increasing build number; it is also the cache-busting key of the bundle URL.
 */
export interface ExtensionDevReloadEvent {
  protocol: typeof EXTENSION_DEV_PROTOCOL;
  name: string;
  type: ExtensionDevServerType | ExtensionDevUiType;
  version: number;
  /** ISO timestamp of the build that produced `version`. */
  builtAt: string;
  /** Lowercase hex SHA-256 of the bundle bytes served for `version`. */
  sha256: string;
  /** Declared manifest capabilities (the CMS sandbox gates on these). */
  capabilities: string[];
  /** Restrict a server-side extension to one site; `null` = every local site. */
  siteId: string | null;
}

/** Sent once per subscription: the latest build of every watched extension. */
export interface ExtensionDevHelloEvent {
  protocol: typeof EXTENSION_DEV_PROTOCOL;
  extensions: ExtensionDevReloadEvent[];
}

/** Build failed — clients keep the previous version and may surface the error. */
export interface ExtensionDevErrorEvent {
  protocol: typeof EXTENSION_DEV_PROTOCOL;
  name: string;
  message: string;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True for `localhost`, `::1` and the whole `127.0.0.0/8` block. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (LOOPBACK_NAMES.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** True when `raw` is an http(s) URL whose host is loopback. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isLoopbackHostname(url.hostname);
}

/** Path (relative to the hub base URL) that serves `name` at `version`. */
export function extensionDevBundlePath(name: string, version: number): string {
  return `/bundle/${encodeURIComponent(name)}?v=${version}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const ALL_TYPES: readonly string[] = [...EXTENSION_DEV_SERVER_TYPES, ...EXTENSION_DEV_UI_TYPES];

/** Validate an untrusted (parsed JSON) reload event. Returns null when malformed. */
export function parseExtensionDevReloadEvent(raw: unknown): ExtensionDevReloadEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.protocol !== EXTENSION_DEV_PROTOCOL) return null;
  if (typeof r.name !== 'string' || !/^[a-z0-9][a-z0-9-_/]*$/.test(r.name)) return null;
  if (typeof r.type !== 'string' || !ALL_TYPES.includes(r.type)) return null;
  if (typeof r.version !== 'number' || !Number.isSafeInteger(r.version) || r.version < 1) return null;
  if (typeof r.builtAt !== 'string') return null;
  if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  if (!isStringArray(r.capabilities)) return null;
  if (r.siteId !== null && typeof r.siteId !== 'string') return null;
  return {
    protocol: EXTENSION_DEV_PROTOCOL,
    name: r.name,
    type: r.type as ExtensionDevReloadEvent['type'],
    version: r.version,
    builtAt: r.builtAt,
    sha256: r.sha256,
    capabilities: [...r.capabilities],
    siteId: r.siteId as string | null,
  };
}

/** True when the reload targets the CMS process rather than Studio. */
export function isExtensionDevServerType(type: string): type is ExtensionDevServerType {
  return (EXTENSION_DEV_SERVER_TYPES as readonly string[]).includes(type);
}
