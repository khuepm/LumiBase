import { describe, expect, it } from 'vitest';
import { PermanentUploadError, UploadQueue, sha256OfFile, type UploadTask } from '../upload-queue';

const file = (name: string, body = name) => new File([body], name, { type: 'image/png' });
const noSleep = async () => undefined;

describe('UploadQueue (#702)', () => {
  it('uploads 100 files with bounded concurrency, applying the folder to every file', async () => {
    let running = 0;
    let peak = 0;
    const folders = new Set<string | null>();
    const q = new UploadQueue<string>({
      concurrency: 4,
      notifyIntervalMs: 50,
      upload: async (task, onProgress) => {
        running++;
        peak = Math.max(peak, running);
        folders.add(task.folder);
        onProgress(0.5);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        return task.file.name;
      },
    });
    q.add(Array.from({ length: 100 }, (_, i) => file(`f${i}.png`)), 'fold_1');
    await q.idle();
    const snap = q.snapshot();
    expect(snap.filter((t) => t.status === 'done')).toHaveLength(100);
    expect(peak).toBe(4);
    expect([...folders]).toEqual(['fold_1']);
  });

  it('coalesces progress notifications instead of emitting per progress tick', async () => {
    let emits = 0;
    const q = new UploadQueue({
      concurrency: 2,
      notifyIntervalMs: 1000,
      onChange: () => emits++,
      upload: async (_t, onProgress) => {
        for (let i = 0; i < 100; i++) onProgress(i / 100);
        return null;
      },
    });
    q.add([file('a.png'), file('b.png')], null);
    await q.idle();
    // Status transitions only (queued, uploading×2, done×2) — not 200 progress events.
    expect(emits).toBeLessThan(10);
  });

  it('retries transient failures and reports permanent ones individually', async () => {
    const calls = new Map<string, number>();
    const q = new UploadQueue({
      maxRetries: 2,
      sleep: noSleep,
      upload: async (task: UploadTask) => {
        const n = (calls.get(task.file.name) ?? 0) + 1;
        calls.set(task.file.name, n);
        if (task.file.name === 'flaky.png' && n < 3) throw new Error('network');
        if (task.file.name === 'bad.exe') throw new PermanentUploadError('type not allowed');
        if (task.file.name === 'down.png') throw new Error('503');
        return null;
      },
    });
    q.add([file('flaky.png'), file('bad.exe'), file('down.png'), file('ok.png')], null);
    await q.idle();
    const by = Object.fromEntries(q.snapshot().map((t) => [t.file.name, t]));
    expect(by['flaky.png']).toMatchObject({ status: 'done', attempts: 3 });
    expect(by['bad.exe']).toMatchObject({ status: 'failed', attempts: 1, error: 'type not allowed' });
    expect(by['down.png']).toMatchObject({ status: 'failed', attempts: 3, error: '503' });
    expect(by['ok.png']!.status).toBe('done');
    // Manual retry re-queues just that file.
    calls.clear();
    q.retry(by['down.png']!.id);
    await q.idle();
    expect([...calls.keys()]).toEqual(['down.png']);
  });

  it('pauses duplicates for a decision (#706) and honours upload-anyway / skip', async () => {
    const uploaded: string[] = [];
    const q = new UploadQueue({
      findDuplicates: async (f) => (f.name.startsWith('dup') ? [{ id: 'file_1', filenameDownload: 'orig.png', folder: null }] : []),
      upload: async (t) => {
        uploaded.push(t.file.name);
        return null;
      },
    });
    const [a, b] = q.add([file('dup-a.png'), file('dup-b.png'), file('new.png')], null);
    await q.idle();
    expect(uploaded).toEqual(['new.png']);
    expect(q.snapshot().filter((t) => t.status === 'duplicate')).toHaveLength(2);
    q.resolveDuplicate(a!, 'upload');
    q.resolveDuplicate(b!, 'skip');
    await q.idle();
    expect(uploaded).toEqual(['new.png', 'dup-a.png']);
    expect(q.snapshot().find((t) => t.id === b)!.status).toBe('cancelled');
  });

  it('cancels an in-flight upload via its AbortSignal', async () => {
    let aborted = false;
    const q = new UploadQueue({
      upload: (_t, _p, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    });
    const [id] = q.add([file('big.mov')], null);
    await new Promise((r) => setTimeout(r, 0));
    q.cancel(id!);
    await q.idle();
    expect(aborted).toBe(true);
    expect(q.snapshot()[0]!.status).toBe('cancelled');
  });

  it('hashes files with Web Crypto', async () => {
    expect(await sha256OfFile(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256OfFile(new Blob(['abc']), 1)).toBeNull();
  });
});
