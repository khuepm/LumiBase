/**
 * Bulk upload queue (#702): concurrency-limited, per-file progress, automatic
 * retry with backoff, manual retry/cancel, and a duplicate check (#706) that
 * pauses a file until the editor decides. Framework-free so it is unit-tested
 * without a DOM; the React panel subscribes to `onChange` snapshots.
 *
 * UI freeze guard: state changes are coalesced and emitted at most once per
 * `notifyIntervalMs`, so 100 files reporting progress do not trigger
 * thousands of React renders.
 */

export type UploadStatus = 'queued' | 'hashing' | 'duplicate' | 'uploading' | 'done' | 'failed' | 'cancelled';

export interface DuplicateHit {
  id: string;
  filenameDownload: string;
  folder: string | null;
}

export interface UploadTask<TResult = unknown> {
  id: string;
  file: File;
  folder: string | null;
  status: UploadStatus;
  /** 0..1 */
  progress: number;
  attempts: number;
  error?: string;
  duplicates?: DuplicateHit[];
  result?: TResult;
}

export interface UploadQueueDeps<TResult> {
  /** Upload one file into `folder`; report 0..1 progress. */
  upload: (task: UploadTask<TResult>, onProgress: (p: number) => void, signal: AbortSignal) => Promise<TResult>;
  /** Optional duplicate lookup run before uploading; empty = no duplicates. */
  findDuplicates?: (file: File) => Promise<DuplicateHit[]>;
  concurrency?: number;
  maxRetries?: number;
  /** Delay before retry `attempt` (1-based). */
  backoffMs?: (attempt: number) => number;
  onChange?: (tasks: ReadonlyArray<UploadTask<TResult>>) => void;
  notifyIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

let seq = 0;

export class UploadQueue<TResult = unknown> {
  private tasks: UploadTask<TResult>[] = [];
  private active = 0;
  private controllers = new Map<string, AbortController>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: UploadQueueDeps<TResult>) {}

  get concurrency(): number {
    return Math.max(1, this.deps.concurrency ?? 3);
  }

  snapshot(): ReadonlyArray<UploadTask<TResult>> {
    return this.tasks.map((t) => ({ ...t }));
  }

  /** Queue files for one target folder — the folder applies to every file. */
  add(files: Iterable<File>, folder: string | null): string[] {
    const ids: string[] = [];
    for (const file of files) {
      const id = `up_${Date.now().toString(36)}_${(seq++).toString(36)}`;
      this.tasks.push({ id, file, folder, status: 'queued', progress: 0, attempts: 0 });
      ids.push(id);
    }
    this.changed(true);
    this.pump();
    return ids;
  }

  retry(id: string): void {
    const t = this.find(id);
    if (!t || (t.status !== 'failed' && t.status !== 'cancelled')) return;
    Object.assign(t, { status: 'queued', progress: 0, attempts: 0, error: undefined });
    this.changed(true);
    this.pump();
  }

  retryFailed(): void {
    for (const t of this.tasks) if (t.status === 'failed') Object.assign(t, { status: 'queued', progress: 0, attempts: 0, error: undefined });
    this.changed(true);
    this.pump();
  }

  cancel(id: string): void {
    const t = this.find(id);
    if (!t || t.status === 'done') return;
    this.controllers.get(id)?.abort();
    t.status = 'cancelled';
    this.changed(true);
    this.pump();
  }

  /** Resolve a paused duplicate: upload anyway, or skip. */
  resolveDuplicate(id: string, action: 'upload' | 'skip'): void {
    const t = this.find(id);
    if (!t || t.status !== 'duplicate') return;
    t.status = action === 'upload' ? 'queued' : 'cancelled';
    // Mark the duplicate check as answered so it is not asked again.
    t.duplicates = action === 'upload' ? [] : t.duplicates;
    this.changed(true);
    this.pump();
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    this.changed(true);
  }

  /** Resolves when nothing is queued or running (paused duplicates don't count). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.active === 0 && !this.tasks.some((t) => t.status === 'queued');
  }

  private find(id: string): UploadTask<TResult> | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  private changed(immediate = false): void {
    const emit = () => {
      this.notifyTimer = null;
      this.deps.onChange?.(this.snapshot());
    };
    const interval = this.deps.notifyIntervalMs ?? 100;
    if (immediate || interval <= 0) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      emit();
      return;
    }
    if (!this.notifyTimer) this.notifyTimer = setTimeout(emit, interval);
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const next = this.tasks.find((t) => t.status === 'queued');
      if (!next) break;
      this.active++;
      void this.run(next).finally(() => {
        this.active--;
        this.pump();
        if (this.isIdle()) {
          const waiters = this.idleWaiters.splice(0);
          waiters.forEach((w) => w());
        }
      });
    }
  }

  private async run(task: UploadTask<TResult>): Promise<void> {
    if (this.deps.findDuplicates && task.duplicates === undefined) {
      task.status = 'hashing';
      this.changed(true);
      try {
        task.duplicates = await this.deps.findDuplicates(task.file);
      } catch {
        task.duplicates = [];
      }
      if ((task.status as UploadStatus) === 'cancelled') return;
      if (task.duplicates.length > 0) {
        task.status = 'duplicate';
        this.changed(true);
        return;
      }
    }
    const maxRetries = this.deps.maxRetries ?? 2;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    while ((task.status as UploadStatus) !== 'cancelled') {
      task.attempts++;
      task.status = 'uploading';
      task.progress = 0;
      this.changed(true);
      const controller = new AbortController();
      this.controllers.set(task.id, controller);
      try {
        task.result = await this.deps.upload(
          task,
          (p) => {
            task.progress = Math.max(0, Math.min(1, p));
            this.changed();
          },
          controller.signal,
        );
        if ((task.status as UploadStatus) === 'cancelled') return;
        task.status = 'done';
        task.progress = 1;
        task.error = undefined;
        this.changed(true);
        return;
      } catch (err) {
        if ((task.status as UploadStatus) === 'cancelled') return;
        task.error = err instanceof Error ? err.message : String(err);
        // Client errors (bad type, too large…) will not succeed on retry.
        const permanent = (err as { permanent?: boolean }).permanent === true;
        if (permanent || task.attempts > maxRetries) {
          task.status = 'failed';
          this.changed(true);
          return;
        }
        await sleep(this.deps.backoffMs?.(task.attempts) ?? 500 * 2 ** (task.attempts - 1));
      } finally {
        this.controllers.delete(task.id);
      }
    }
  }
}

/** Mark an error as not worth retrying (4xx from the upload guard). */
export class PermanentUploadError extends Error {
  readonly permanent = true;
}

/** SHA-256 of a browser File (hex). Large files are skipped to bound memory. */
export async function sha256OfFile(file: Blob, maxBytes = 64 * 1024 * 1024): Promise<string | null> {
  if (file.size > maxBytes || typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
