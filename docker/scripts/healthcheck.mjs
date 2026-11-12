/**
 * Container health probe (#734). The runtime image is distroless — no shell,
 * no curl, no wget — so the HEALTHCHECK runs this with the image's own Node.
 *
 * Probes `/health` on the port this process role serves: `PORT` for `web` and
 * `all`, the worker health port for `LUMIBASE_PROCESS_ROLE=worker` (the old
 * inline check always probed 1989, so a worker container was reported
 * unhealthy forever). Exits 0 on a 2xx, 1 otherwise. Writes nothing to disk.
 */
import { healthPort } from './entrypoint-lib.mjs';

const url = `http://127.0.0.1:${healthPort(process.env)}/health`;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
  process.exit(res.ok ? 0 : 1);
} catch {
  process.exit(1);
}
