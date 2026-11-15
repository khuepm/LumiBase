/**
 * Dev-only extension override registry (#754 — extension hot reload).
 *
 * Holds the latest hot-reloaded build of each server-side extension
 * (`hook` / `endpoint` / `operation`) pushed by `lumibase-ext dev`. The
 * `ExtensionSandbox` consults it so a rebuilt bundle takes effect without a
 * CMS restart.
 *
 * Atomicity: the registry state is ONE immutable map. A reload builds a new
 * map and swaps the reference (copy-on-write), so a reader sees either the
 * whole old generation or the whole new one, never a mix. Each sandbox (one
 * per request) captures a snapshot when it is constructed and keeps it for its
 * lifetime: a request that started on version N finishes every hook on
 * version N, while requests that start after the swap get N+1.
 *
 * Production safety: the registry is inert until `activate()` is called, and
 * `activate()` throws in production. Only the guarded Node dev client
 * (`./client.ts`, started from `serve.ts`) calls it. While inactive,
 * `snapshot()` is always empty, so no override can ever apply. This module has
 * no Node-only imports — it is part of the sandbox's import graph, which also
 * ships in the Workers bundle, where it simply stays inactive.
 */
import { supersedesDevBuild } from '@lumibase/contracts/extensions';

export interface DevExtensionBuild {
  readonly name: string;
  readonly type: string;
  /** `lumibase-ext dev` run that built it; versions restart per session. */
  readonly session: string;
  /** Per-session monotonically increasing build number from the CLI. */
  readonly version: number;
  readonly sha256: string;
  readonly capabilities: readonly string[];
  /** `null` = applies to every site of the local CMS. */
  readonly siteId: string | null;
  /** The imported ES module namespace of the bundle. */
  readonly module: Readonly<Record<string, unknown>>;
}

export type DevExtensionSnapshot = ReadonlyMap<string, DevExtensionBuild>;

export class ExtensionDevRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionDevRefusedError';
  }
}

interface EnvLike {
  NODE_ENV?: string;
  LUMIBASE_ENV?: string;
}

const EMPTY: DevExtensionSnapshot = new Map();

function processEnv(): EnvLike {
  const proc = (globalThis as { process?: { env?: EnvLike } }).process;
  return proc?.env ?? {};
}

function isProduction(env: EnvLike): boolean {
  return env.NODE_ENV === 'production' || env.LUMIBASE_ENV === 'production';
}

export class DevExtensionRegistry {
  private active = false;
  private current: DevExtensionSnapshot = EMPTY;

  /**
   * Turn the registry on. Refuses (throws) when either the supplied env or the
   * live process env says production — defence in depth behind the config
   * guard in `./config.ts`.
   */
  activate(env: EnvLike): void {
    if (isProduction(env) || isProduction(processEnv())) {
      throw new ExtensionDevRefusedError('extension hot reload cannot be activated in production');
    }
    this.active = true;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Current generation; always empty while inactive. */
  snapshot(): DevExtensionSnapshot {
    return this.active ? this.current : EMPTY;
  }

  /**
   * Publish a new build. Returns false (and changes nothing) when a build of
   * the same or a newer version is already installed — reload events can
   * arrive twice (`hello` replay after a reconnect).
   */
  swap(build: DevExtensionBuild): boolean {
    if (!this.active) throw new ExtensionDevRefusedError('extension hot reload is not active');
    if (!supersedesDevBuild(this.current.get(build.name), build)) return false;
    const next = new Map(this.current);
    next.set(build.name, Object.freeze({ ...build, capabilities: Object.freeze([...build.capabilities]) }));
    this.current = next;
    return true;
  }

  /** Drop every override and go inert again (shutdown / tests). */
  deactivate(): void {
    this.active = false;
    this.current = EMPTY;
  }
}

/** Process-wide registry. Inactive unless the dev client activated it. */
export const devExtensionRegistry = new DevExtensionRegistry();

/** True when `build` should apply to a request for `siteId`. */
export function devBuildAppliesToSite(build: DevExtensionBuild, siteId: string | null | undefined): boolean {
  return build.siteId === null || build.siteId === siteId;
}
