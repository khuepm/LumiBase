import type { Bindings } from '../env';

/**
 * Sentry options for the Cloudflare Workers build.
 *
 * Resolved from per-request `env` (the Worker has no `process.env`), so the
 * DSN and sampling ratio come from wrangler `[vars]` / secrets. When
 * `SENTRY_DSN` is unset the DSN is an empty string, which makes `withSentry`
 * a no-op — keeping local dev, Docker (Node build), and tests clean without a
 * separate code path.
 *
 * Mirrors the env-driven shape of `observability/config.ts`. The Node/Docker
 * entry (`serve.ts`) does NOT use this — `@sentry/cloudflare` is Workers-only.
 */
export interface SentryOptions {
  dsn: string;
  tracesSampleRate: number;
  enableLogs: boolean;
  environment: string;
  release?: string;
}

function parseSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  // Clamp to Sentry's valid [0, 1] range.
  return Math.min(1, Math.max(0, parsed));
}

export function resolveSentryOptions(env: Bindings): SentryOptions {
  return {
    dsn: env.SENTRY_DSN ?? '',
    // Capture 100% of spans by default; override per environment to control cost.
    tracesSampleRate: parseSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 1.0),
    // Send structured logs to Sentry.
    enableLogs: true,
    environment: env.LUMIBASE_ENV || 'development',
    release: env.LUMIBASE_VERSION && env.LUMIBASE_VERSION !== 'unknown'
      ? env.LUMIBASE_VERSION
      : undefined,
  };
}
