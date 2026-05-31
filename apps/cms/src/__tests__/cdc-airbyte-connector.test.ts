import { describe, it, expect, vi } from 'vitest';

import {
  AirbyteConnector,
  InMemoryAirbyteApiClient,
  SyncScheduleValidationError,
  airbyteSyncModeFor,
  buildScheduleConfig,
  buildSyncMetadata,
  resolveSyncSchedule,
  validateSyncSchedule,
  MAX_SYNC_RETRIES,
  SYNC_INTERVAL_MIN_SECONDS,
  SYNC_INTERVAL_MAX_SECONDS,
  type AirbyteApiClient,
} from '../modules/cdc/connectors/airbyte';
import type { ConnectorConfig } from '../modules/cdc/connectors/types';

// ── helpers ──────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<ConnectorConfig> = {},
): ConnectorConfig {
  return {
    pipelineId: 'pipe_test_1',
    tenantId: 'site_test',
    sourceConnection: 'postgresql://u:p@pg-host:5432/appdb',
    sinkConnection: 'clickhouse://u:p@ch-host:8123/analytics',
    intermediaryConnection: 'https://airbyte.example.com/api',
    replicationTables: ['public.users', 'public.orders'],
    connectorSpecificConfig: {
      syncSchedule: { interval_seconds: 3_600, sync_mode: 'incremental_cdc' },
    },
    ...overrides,
  };
}

/** No-op sleep so backoff retries don't actually wait. */
const instantSleep = () => Promise.resolve();

// ── sync mode mapping (Req 4.2) ──────────────────────────────────────────

describe('airbyteSyncModeFor (Req 4.2)', () => {
  it('maps both supported sync modes to concrete Airbyte modes', () => {
    expect(airbyteSyncModeFor('full_refresh')).toBe('full_refresh_overwrite');
    expect(airbyteSyncModeFor('incremental_cdc')).toBe('incremental_append');
  });
});

// ── schedule validation (Req 4.3, 4.7) ───────────────────────────────────

describe('validateSyncSchedule (Req 4.3, 4.7)', () => {
  it('accepts intervals at the inclusive boundaries', () => {
    expect(
      validateSyncSchedule({
        interval_seconds: SYNC_INTERVAL_MIN_SECONDS,
        sync_mode: 'full_refresh',
      }).interval_seconds,
    ).toBe(SYNC_INTERVAL_MIN_SECONDS);
    expect(
      validateSyncSchedule({
        interval_seconds: SYNC_INTERVAL_MAX_SECONDS,
        sync_mode: 'incremental_cdc',
      }).interval_seconds,
    ).toBe(SYNC_INTERVAL_MAX_SECONDS);
  });

  it('rejects intervals below the minimum', () => {
    expect(() =>
      validateSyncSchedule({
        interval_seconds: SYNC_INTERVAL_MIN_SECONDS - 1,
        sync_mode: 'full_refresh',
      }),
    ).toThrow(SyncScheduleValidationError);
  });

  it('rejects intervals above the maximum', () => {
    expect(() =>
      validateSyncSchedule({
        interval_seconds: SYNC_INTERVAL_MAX_SECONDS + 1,
        sync_mode: 'incremental_cdc',
      }),
    ).toThrow(SyncScheduleValidationError);
  });

  it('resolveSyncSchedule rejects an out-of-range config interval', () => {
    expect(() =>
      resolveSyncSchedule(
        makeConfig({
          connectorSpecificConfig: {
            syncSchedule: { interval_seconds: 60, sync_mode: 'full_refresh' },
          },
        }),
      ),
    ).toThrow(SyncScheduleValidationError);
  });
});

describe('buildScheduleConfig', () => {
  it('expresses hour-aligned intervals in hours', () => {
    expect(buildScheduleConfig(7_200)).toEqual({
      scheduleType: 'basic',
      timeUnit: 'hours',
      units: 2,
    });
  });

  it('expresses sub-hour intervals in minutes', () => {
    expect(buildScheduleConfig(900)).toEqual({
      scheduleType: 'basic',
      timeUnit: 'minutes',
      units: 15,
    });
  });
});

// ── provisioning (Req 4.1, 4.6) ──────────────────────────────────────────

describe('AirbyteConnector.provision (Req 4.1, 4.6)', () => {
  it('provisions source + destination + connection', async () => {
    const api = new InMemoryAirbyteApiClient();
    const connector = new AirbyteConnector({ api });

    const result = await connector.provision(makeConfig());

    expect(result.success).toBe(true);
    expect(result.provisionedResources.map((r) => r.type)).toEqual([
      'airbyte_source',
      'airbyte_destination',
      'airbyte_connection',
    ]);
    expect(api.sources.size).toBe(1);
    expect(api.destinations.size).toBe(1);
    expect(api.connections.size).toBe(1);
  });

  it('rejects provisioning with an invalid schedule and allocates nothing', async () => {
    const api = new InMemoryAirbyteApiClient();
    const onStatusChange = vi.fn();
    const connector = new AirbyteConnector({ api, onStatusChange });

    const result = await connector.provision(
      makeConfig({
        connectorSpecificConfig: {
          syncSchedule: { interval_seconds: 10, sync_mode: 'full_refresh' },
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(api.sources.size).toBe(0);
    expect(api.destinations.size).toBe(0);
    expect(onStatusChange).toHaveBeenCalledWith(
      'pipe_test_1',
      'error',
      expect.stringContaining('Invalid sync schedule'),
    );
  });

  it('releases partial resources and errors when provisioning fails midway (Req 4.6)', async () => {
    const inner = new InMemoryAirbyteApiClient();
    const deleted: string[] = [];
    // Fail at connection creation, after source + destination are created.
    const api: AirbyteApiClient = {
      isAvailable: () => inner.isAvailable(),
      createSource: (r) => inner.createSource(r),
      createDestination: (r) => inner.createDestination(r),
      createConnection: () => Promise.reject(new Error('connection boom')),
      setConnectionActive: (id, a) => inner.setConnectionActive(id, a),
      triggerSync: (id) => inner.triggerSync(id),
      deleteConnection: async (id) => {
        deleted.push(`conn:${id}`);
      },
      deleteSource: async (id) => {
        deleted.push(`src:${id}`);
        await inner.deleteSource(id);
      },
      deleteDestination: async (id) => {
        deleted.push(`dst:${id}`);
        await inner.deleteDestination(id);
      },
    };
    const onStatusChange = vi.fn();
    const connector = new AirbyteConnector({ api, onStatusChange });

    const result = await connector.provision(makeConfig());

    expect(result.success).toBe(false);
    expect(result.message).toContain('connection boom');
    // Both the created source and destination were released.
    expect(deleted.some((d) => d.startsWith('src:'))).toBe(true);
    expect(deleted.some((d) => d.startsWith('dst:'))).toBe(true);
    expect(inner.sources.size).toBe(0);
    expect(inner.destinations.size).toBe(0);
    expect(onStatusChange).toHaveBeenCalledWith(
      'pipe_test_1',
      'error',
      expect.stringContaining('connection boom'),
    );
  });

  it('treats a provisioning timeout as a failure and releases resources (Req 4.6)', async () => {
    const inner = new InMemoryAirbyteApiClient();
    const deleted: string[] = [];
    const api: AirbyteApiClient = {
      isAvailable: () => inner.isAvailable(),
      createSource: (r) => inner.createSource(r),
      createDestination: (r) => inner.createDestination(r),
      // Never resolves → forces the provisioning timeout to fire.
      createConnection: () => new Promise(() => {}),
      setConnectionActive: (id, a) => inner.setConnectionActive(id, a),
      triggerSync: (id) => inner.triggerSync(id),
      deleteConnection: async () => {},
      deleteSource: async (id) => {
        deleted.push(`src:${id}`);
        await inner.deleteSource(id);
      },
      deleteDestination: async (id) => {
        deleted.push(`dst:${id}`);
        await inner.deleteDestination(id);
      },
    };
    const connector = new AirbyteConnector({ api, provisionTimeoutMs: 20 });

    const result = await connector.provision(makeConfig());

    expect(result.success).toBe(false);
    expect(result.message).toContain('timeout');
    expect(inner.sources.size).toBe(0);
    expect(inner.destinations.size).toBe(0);
  });
});

// ── sync metadata (Req 4.5) ──────────────────────────────────────────────

describe('AirbyteConnector.completeSync (Req 4.5)', () => {
  it('records the exact record count and notifies the metadata listener', async () => {
    const api = new InMemoryAirbyteApiClient();
    const onSyncMetadata = vi.fn();
    const fixedNow = 1_700_000_000_000;
    const connector = new AirbyteConnector({
      api,
      onSyncMetadata,
      clock: () => fixedNow,
    });
    await connector.provision(makeConfig());

    const metadata = connector.completeSync('pipe_test_1', 4_242);

    expect(metadata.recordCount).toBe(4_242);
    expect(metadata.lastSyncAt).toBe(new Date(fixedNow).toISOString());
    expect(connector.getSyncMetadata('pipe_test_1')).toEqual(metadata);
    expect(onSyncMetadata).toHaveBeenCalledWith('pipe_test_1', metadata);
  });

  it('buildSyncMetadata preserves the count without rounding', () => {
    const md = buildSyncMetadata(0, 0);
    expect(md.recordCount).toBe(0);
    expect(md.lastSyncAt).toBe(new Date(0).toISOString());
  });
});

// ── retry behaviour (Req 4.4) ────────────────────────────────────────────

describe('AirbyteConnector.runSync (Req 4.4)', () => {
  it('records metadata on first-attempt success', async () => {
    const api = new InMemoryAirbyteApiClient();
    api.enqueueSyncResult({ status: 'succeeded', recordsSynced: 100 });
    const connector = new AirbyteConnector({ api, sleep: instantSleep });
    await connector.provision(makeConfig());

    const result = await connector.runSync('pipe_test_1');

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.metadata?.recordCount).toBe(100);
  });

  it('retries failures then succeeds, recording the successful count', async () => {
    const api = new InMemoryAirbyteApiClient();
    api.enqueueSyncResult({ status: 'failed', recordsSynced: 0, failureReason: 'x' });
    api.enqueueSyncResult({ status: 'failed', recordsSynced: 0, failureReason: 'y' });
    api.enqueueSyncResult({ status: 'succeeded', recordsSynced: 7 });
    const connector = new AirbyteConnector({ api, sleep: instantSleep });
    await connector.provision(makeConfig());

    const result = await connector.runSync('pipe_test_1');

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.metadata?.recordCount).toBe(7);
  });

  it('errors after exhausting all retries and emits an error status (Req 4.4)', async () => {
    const api = new InMemoryAirbyteApiClient();
    for (let i = 0; i < MAX_SYNC_RETRIES + 1; i += 1) {
      api.enqueueSyncResult({
        status: 'failed',
        recordsSynced: 0,
        failureReason: 'always fails',
      });
    }
    const onStatusChange = vi.fn();
    const connector = new AirbyteConnector({
      api,
      sleep: instantSleep,
      onStatusChange,
    });
    await connector.provision(makeConfig());

    const result = await connector.runSync('pipe_test_1');

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(MAX_SYNC_RETRIES + 1);
    expect(result.failureReason).toContain('always fails');
    expect(onStatusChange).toHaveBeenCalledWith(
      'pipe_test_1',
      'error',
      expect.stringContaining('Airbyte sync failed after'),
    );
  });
});

// ── destroy (no replication-slot cleanup) ────────────────────────────────

describe('AirbyteConnector.destroy', () => {
  it('removes connection, source, and destination without slot cleanup', async () => {
    const api = new InMemoryAirbyteApiClient();
    const connector = new AirbyteConnector({ api });
    await connector.provision(makeConfig());

    await connector.destroy('pipe_test_1');

    expect(api.connections.size).toBe(0);
    expect(api.sources.size).toBe(0);
    expect(api.destinations.size).toBe(0);
  });

  it('is an idempotent no-op for an unknown pipeline', async () => {
    const connector = new AirbyteConnector();
    await expect(connector.destroy('nope')).resolves.toBeUndefined();
  });
});
