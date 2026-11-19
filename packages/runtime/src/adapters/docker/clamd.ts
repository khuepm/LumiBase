import { connect } from 'node:net';
import type { ClamdClient } from '../../interfaces/clamd';

/** Bytes per INSTREAM chunk; well under clamd's default StreamMaxLength. */
const CHUNK = 64 * 1024;

export interface NodeClamdOptions {
  host: string;
  port?: number;
  /** Whole-exchange timeout (connect + stream + verdict), ms. */
  timeoutMs?: number;
}

/**
 * clamd `zINSTREAM` over TCP: the command, then length-prefixed chunks
 * (4-byte big-endian size + data), then a zero-length chunk; clamd answers
 * with one NUL-terminated line.
 */
export class NodeClamdClient implements ClamdClient {
  constructor(private readonly opts: NodeClamdOptions) {}

  instream(bytes: Uint8Array): Promise<string> {
    const { host, port = 3310, timeoutMs = 60_000 } = this.opts;
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const replies: Buffer[] = [];
      let settled = false;
      const finish = (err: Error | null, reply?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(reply ?? '');
      };
      socket.setTimeout(timeoutMs, () => finish(new Error(`clamd timed out after ${timeoutMs}ms`)));
      socket.on('error', (err) => finish(err));
      socket.on('data', (d: Buffer) => replies.push(d));
      socket.on('end', () => finish(null, Buffer.concat(replies).toString('utf8').replace(/\0+$/, '').trim()));
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let o = 0; o < bytes.byteLength; o += CHUNK) {
          const part = bytes.subarray(o, Math.min(o + CHUNK, bytes.byteLength));
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.byteLength, 0);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** Build the client from `CLAMD_HOST` / `CLAMD_PORT`; undefined when not configured. */
export function clamdFromEnv(env: Record<string, unknown>): ClamdClient | undefined {
  const host = typeof env.CLAMD_HOST === 'string' && env.CLAMD_HOST.length > 0 ? env.CLAMD_HOST : undefined;
  if (!host) return undefined;
  const port = Number(env.CLAMD_PORT ?? 3310);
  return new NodeClamdClient({ host, port: Number.isFinite(port) && port > 0 ? port : 3310 });
}
