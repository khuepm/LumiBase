import { loadTracingConfig, type TracingConfig } from './config';

export interface NodeObservabilityHandle {
  config: TracingConfig;
  shutdown(): Promise<void>;
}

type DynamicImport = <T = unknown>(specifier: string) => Promise<T>;
const dynamicImport = new Function('specifier', 'return import(specifier)') as DynamicImport;

function missingDependencyError(cause: unknown): Error {
  const error = new Error(
    'Tracing is enabled, but the optional OpenTelemetry Node packages are not installed. ' +
      'Install @opentelemetry/sdk-node, @opentelemetry/exporter-trace-otlp-grpc, ' +
      '@opentelemetry/auto-instrumentations-node, @opentelemetry/resources, ' +
      '@opentelemetry/semantic-conventions, and @opentelemetry/sdk-trace-base.',
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

export async function bootstrapNodeObservability(
  env: Record<string, string | undefined> = process.env,
): Promise<NodeObservabilityHandle> {
  const config = loadTracingConfig(env);

  if (!config.enabled || config.provider === 'none') {
    console.log('[observability] tracing disabled');
    return { config, shutdown: async () => {} };
  }

  if (!config.endpoint) {
    throw new Error('Tracing endpoint is required when tracing is enabled.');
  }

  let modules: {
    sdkNode: { NodeSDK: new (options: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> } };
    exporter: { OTLPTraceExporter: new (options: { url: string }) => unknown };
    auto: { getNodeAutoInstrumentations: () => unknown };
    semantic: { ATTR_SERVICE_NAME: string };
    resources: { resourceFromAttributes: (attributes: Record<string, unknown>) => unknown };
    traceBase: { TraceIdRatioBasedSampler: new (ratio: number) => unknown };
  };

  try {
    const [sdkNode, exporter, auto, semantic, resources, traceBase] = await Promise.all([
      dynamicImport<typeof modules.sdkNode>('@opentelemetry/sdk-node'),
      dynamicImport<typeof modules.exporter>('@opentelemetry/exporter-trace-otlp-grpc'),
      dynamicImport<typeof modules.auto>('@opentelemetry/auto-instrumentations-node'),
      dynamicImport<typeof modules.semantic>('@opentelemetry/semantic-conventions'),
      dynamicImport<typeof modules.resources>('@opentelemetry/resources'),
      dynamicImport<typeof modules.traceBase>('@opentelemetry/sdk-trace-base'),
    ]);
    modules = { sdkNode, exporter, auto, semantic, resources, traceBase };
  } catch (err) {
    throw missingDependencyError(err);
  }

  const sdk = new modules.sdkNode.NodeSDK({
    resource: modules.resources.resourceFromAttributes({
      [modules.semantic.ATTR_SERVICE_NAME]: config.serviceName,
      'deployment.environment': env.LUMIBASE_ENV || env.NODE_ENV || 'development',
    }),
    traceExporter: new modules.exporter.OTLPTraceExporter({ url: config.endpoint }),
    sampler: new modules.traceBase.TraceIdRatioBasedSampler(config.samplingRatio),
    instrumentations: [modules.auto.getNodeAutoInstrumentations()],
  });

  sdk.start();
  console.log(`[observability] tracing enabled provider=${config.provider} service=${config.serviceName} endpoint=${config.endpoint}`);

  return {
    config,
    shutdown: async () => {
      await sdk.shutdown();
      console.log('[observability] tracing shutdown complete');
    },
  };
}
