import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { NodeClamdClient, clamdFromEnv } from '../adapters/docker/clamd';

/**
 * A fake clamd that decodes the real zINSTREAM framing (command, 4-byte
 * big-endian chunk sizes, zero terminator) and answers like clamd does.
 */
function fakeClamd(verdict: (payload: Buffer) => string): Promise<{ server: Server; port: number; received: Buffer[] }> {
  const received: Buffer[] = [];
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let commandSeen = false;
    const chunks: Buffer[] = [];
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!commandSeen) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        expect(buf.subarray(0, nul).toString()).toBe('zINSTREAM');
        buf = buf.subarray(nul + 1);
        commandSeen = true;
      }
      while (buf.length >= 4) {
        const size = buf.readUInt32BE(0);
        if (size === 0) {
          const payload = Buffer.concat(chunks);
          received.push(payload);
          sock.end(`${verdict(payload)}\0`);
          return;
        }
        if (buf.length < 4 + size) return;
        chunks.push(buf.subarray(4, 4 + size));
        buf = buf.subarray(4 + size);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0, received });
    }),
  );
}

let server: Server | undefined;
afterEach(() => server?.close());

describe('NodeClamdClient (#707)', () => {
  it('streams the whole body in length-prefixed chunks and returns the verdict', async () => {
    const fake = await fakeClamd((p) => (p.includes('EICAR') ? 'stream: Eicar-Signature FOUND' : 'stream: OK'));
    server = fake.server;
    const client = new NodeClamdClient({ host: '127.0.0.1', port: fake.port });
    const big = Buffer.alloc(200 * 1024, 7); // spans several 64 KiB chunks
    expect(await client.instream(big)).toBe('stream: OK');
    expect(fake.received[0]!.equals(big)).toBe(true);
    expect(await client.instream(new TextEncoder().encode('xx EICAR xx'))).toBe('stream: Eicar-Signature FOUND');
  });

  it('rejects when the daemon is unreachable', async () => {
    const fake = await fakeClamd(() => 'stream: OK');
    const port = fake.port;
    await new Promise<void>((r) => fake.server.close(() => r()));
    await expect(new NodeClamdClient({ host: '127.0.0.1', port }).instream(new Uint8Array([1]))).rejects.toThrow();
  });

  it('times out instead of hanging', async () => {
    server = createServer(() => undefined);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await expect(new NodeClamdClient({ host: '127.0.0.1', port, timeoutMs: 100 }).instream(new Uint8Array([1]))).rejects.toThrow(/timed out/);
  });

  it('is only built when CLAMD_HOST is set', () => {
    expect(clamdFromEnv({})).toBeUndefined();
    expect(clamdFromEnv({ CLAMD_HOST: 'clamav', CLAMD_PORT: '3310' })).toBeInstanceOf(NodeClamdClient);
  });
});
