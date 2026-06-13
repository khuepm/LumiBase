import { z } from 'zod';

export type TracingProvider = 'none' | 'skywalking' | 'otlp';

export interface TracingConfig {
  enabled: boolean;
  provider: TracingProvider;
  serviceName: string;
  endpoint?: string;
  samplingRatio: number;
}

const truthy = new Set(['1', 'true', 'yes', 'on']);
const falsy = new Set(['0', 'false', 'no', 'off', '']);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  return fallback;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const tracingConfigSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['none', 'skywalking', 'otlp']),
  serviceName: z.string().min(1),
  endpoint: z.string().url().optional(),
  samplingRatio: z.number().min(0).max(1),
}).superRefine((value, ctx) => {
  if (value.enabled && value.provider !== 'none' && !value.endpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'OTEL_EXPORTER_OTLP_ENDPOINT is required when tracing is enabled.',
    });
  }
});

export function loadTracingConfig(env: Record<string, string | undefined>): TracingConfig {
  const provider = (env.LUMIBASE_TRACING_PROVIDER || (parseBoolean(env.LUMIBASE_TRACING_ENABLED, false) ? 'skywalking' : 'none')).trim().toLowerCase();
  const enabled = parseBoolean(env.LUMIBASE_TRACING_ENABLED, provider !== 'none');

  return tracingConfigSchema.parse({
    enabled,
    provider,
    serviceName: env.LUMIBASE_SERVICE_NAME?.trim() || env.OTEL_SERVICE_NAME?.trim() || 'lumibase-cms',
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || env.LUMIBASE_TRACING_ENDPOINT?.trim() || undefined,
    samplingRatio: parseNumber(env.LUMIBASE_TRACING_SAMPLING_RATIO, 1),
  });
}
