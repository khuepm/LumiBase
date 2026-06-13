import type { Bindings } from '../env';

export function parseAllowedOrigins(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  env: Pick<Bindings, 'CORS_ALLOWED_ORIGINS' | 'LUMIBASE_ENV'>,
): string | undefined {
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  if (allowedOrigins.length === 0) {
    return env.LUMIBASE_ENV === 'production' ? undefined : requestOrigin ?? '*';
  }

  if (!requestOrigin) {
    return allowedOrigins.includes('*') && env.LUMIBASE_ENV !== 'production'
      ? '*'
      : undefined;
  }

  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;

  if (allowedOrigins.includes('*') && env.LUMIBASE_ENV !== 'production') {
    return requestOrigin;
  }

  return undefined;
}
