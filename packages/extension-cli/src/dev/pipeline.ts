import { readdirSync, watch, type FSWatcher } from 'node:fs';
import { join, relative } from 'node:path';
import type { ExtensionDevReloadEvent } from '@lumibase/contracts/extensions';
import type { ExtensionBuilder } from './builder';
import type { DevHub } from './hub';

/**
 * Watch → rebuild → notify loop for one extension.
 *
 * File events are debounced (editors write a file in several syscalls), the
 * rebuild is serialised (a change during a build schedules exactly one
 * follow-up build), and only a SUCCESSFUL build bumps the version and is
 * published. A failed build is broadcast as `build-error`; clients keep the
 * previous version running.
 */

export interface PipelineOptions {
  name: string;
  type: ExtensionDevReloadEvent['type'];
  capabilities: string[];
  siteId: string | null;
  builder: ExtensionBuilder;
  hub: DevHub;
  /** Debounce window for file-change bursts (ms). */
  debounceMs?: number;
  onBuilt?: (info: { event: ExtensionDevReloadEvent; buildMs: number }) => void;
  onFailed?: (errors: string[]) => void;
}

export interface DevPipeline {
  /** Rebuild now and publish on success. Resolves with the event, or null on failure. */
  build(): Promise<ExtensionDevReloadEvent | null>;
  /** Start watching `dir` and every subdirectory (new ones included). */
  watch(dir: string): void;
  close(): Promise<void>;
}

const IGNORED = /(^|[\\/])(node_modules|dist|\.git|\.lumibase|\.turbo)([\\/]|$)/;

export function createDevPipeline(options: PipelineOptions): DevPipeline {
  const debounceMs = options.debounceMs ?? 20;
  let version = 0;
  let running: Promise<ExtensionDevReloadEvent | null> | null = null;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // One NON-recursive watcher per directory. Node's recursive fs.watch on
  // Linux tracks files individually and silently stops reporting a file that
  // was replaced by a rename (atomic saves: vim, JetBrains safe write,
  // formatters, `sed -i`). A directory watch sees in-place writes and renames
  // of its children alike, so replaced files keep reloading.
  const watchers = new Map<string, FSWatcher>();
  let root: string | null = null;

  async function buildOnce(): Promise<ExtensionDevReloadEvent | null> {
    const result = await options.builder.rebuild();
    if (!result.ok) {
      options.hub.publishError(options.name, result.errors.join('\n'));
      options.onFailed?.(result.errors);
      return null;
    }
    version += 1;
    const event = options.hub.publish({
      name: options.name,
      type: options.type,
      version,
      capabilities: options.capabilities,
      siteId: options.siteId,
      code: result.code,
    });
    options.onBuilt?.({ event, buildMs: result.durationMs });
    return event;
  }

  function build(): Promise<ExtensionDevReloadEvent | null> {
    if (running) {
      pending = true;
      return running;
    }
    running = buildOnce().finally(() => {
      running = null;
      if (pending) {
        pending = false;
        void build();
      }
    });
    return running;
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void build();
    }, debounceMs);
  }

  /** Directories under `root` that should be watched (ignored trees skipped). */
  function listDirs(dir: string, out: string[]): string[] {
    out.push(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out; // removed meanwhile
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (root && IGNORED.test(relative(root, child))) continue;
      listDirs(child, out);
    }
    return out;
  }

  /** Watch every current directory; drop watchers of removed ones. */
  function syncWatchers(): void {
    if (!root) return;
    const wanted = new Set(listDirs(root, []));
    for (const [dir, w] of watchers) {
      if (!wanted.has(dir)) {
        w.close();
        watchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, (event, filename) => {
          if (filename && root && IGNORED.test(relative(root, join(dir, String(filename))))) return;
          // A rename can add or remove a subdirectory: re-sync before building.
          if (event === 'rename') syncWatchers();
          schedule();
        });
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        // Directory vanished between listing and watching.
      }
    }
  }

  return {
    build,
    watch(dir) {
      root = dir;
      syncWatchers();
    },
    async close() {
      if (timer) clearTimeout(timer);
      root = null;
      for (const w of watchers.values()) w.close();
      watchers.clear();
      await running;
      await options.builder.dispose();
    },
  };
}
