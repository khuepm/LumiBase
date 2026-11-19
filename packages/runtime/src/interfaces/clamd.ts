/**
 * Native ClamAV daemon client (#707). Docker/Node only: clamd speaks a TCP
 * protocol, so the Docker runtime provides it when `CLAMD_HOST` is set and the
 * Cloudflare runtime leaves it undefined (Workers use the HTTP scanner).
 * Business logic sees only this port, never `node:net`.
 */
export interface ClamdClient {
  /**
   * Stream `bytes` to clamd with `zINSTREAM` and return its raw reply, e.g.
   * `stream: OK` or `stream: Eicar-Signature FOUND`. Rejects when the daemon
   * is unreachable or times out.
   */
  instream(bytes: Uint8Array): Promise<string>;
}
