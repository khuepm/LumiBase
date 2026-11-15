import { watch, type FSWatcher } from 'node:fs';
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
  /** Start watching `dir` recursively. */
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
  let watcher: FSWatcher | null = null;

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

  return {
    build,
    watch(dir) {
      watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && IGNORED.test(String(filename))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void build();
        }, debounceMs);
      });
    },
    async close() {
      if (timer) clearTimeout(timer);
      watcher?.close();
      await running;
      await options.builder.dispose();
    },
  };
}
