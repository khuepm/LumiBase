import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  AirbyteConnector,
  InMemoryAirbyteApiClient,
  buildSyncMetadata,
  type SyncMetadata,
} from '../modules/cdc/connectors/airbyte';
import type { ConnectorConfig } from '../modules/cdc/connectors/types';

/**
 * Feature: clickhouse-cdc, Property 10: Sync metadata update on completion
 *
 * For any non-negative integer record count N (and any clock value),
 * completing a sync updates the recorded metadata in the Pipeline_Registry
 * with the EXACT count N and the correct ISO-8601 timestamp derived from the
 * clock, and the `onSyncMetadata` listener is invoked with the same metadata.
 *
 * **Validates: Requirements 4.5**
 */

// ── Arbitraries ──────────────────────────────────────────────────────────

/**
 * Any non-negative integer record count. `fc.nat()` covers 0 through
 * 2^31 - 1, so the "exact count" obligation is exercised across small and
 * very large synced-record counts.
 */
const arbRecordCount = fc.nat();

/**
 * Any clock reading, expressed in milliseconds since the epoch. Generated as
 * whole seconds scaled to milliseconds so the value spans a broad, realistic
 * range (epoch through ~year 2038) while always landing inside the valid
 * JavaScript `Date` range, so `toISOString()` never throws.
 */
const arbClockMs = fc.integer({ min: 0, max: 2_147_483_647 }).map((s) => s * 1000);

/** A pipeline identifier — any non-empty, non-blank string is valid. */
const arbPipelineId = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a complete connector config for the given pipeline. */
function makeConfig(pipelineId: string): ConnectorConfig {
  return {
    pipelineId,
    tenantId: 'site_test',
    sourceConnection: 'postgresql://u:p@pg-host:5432/appdb',
    sinkConnection: 'clickhouse://u:p@ch-host:8123/analytics',
    intermediaryConnection: 'https://airbyte.example.com/api',
    replicationTables: ['public.users', 'public.orders'],
    connectorSpecificConfig: {
      syncSchedule: { interval_seconds: 3_600, sync_mode: 'incremental_cdc' },
    },
  };
}

/** No-op sleep so backoff retries don't actually wait. */
const instantSleep = () => Promise.resolve();

// ── Property 10 ──────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 10: Sync metadata update on completion', () => {
  it('buildSyncMetadata preserves the exact count and derives the ISO timestamp from the clock', () => {
    fc.assert(
      fc.property(arbRecordCount, arbClockMs, (recordCount, nowMs) => {
        const metadata = buildSyncMetadata(recordCount, nowMs);

        // Exact count — no rounding, clamping, or coercion.
        expect(metadata.recordCount).toBe(recordCount);
        // Timestamp is exactly the ISO-8601 rendering of the clock reading.
        expect(metadata.lastSyncAt).toBe(new Date(nowMs).toISOString());
      }),
      { numRuns: 200 },
    );
  });

  it('completeSync records the exact count + clock timestamp and notifies the listener with the same metadata', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbRecordCount,
        arbClockMs,
        async (pipelineId, recordCount, nowMs) => {
          const notified: Array<{ pipelineId: string; metadata: SyncMetadata }> =
            [];
          const connector = new AirbyteConnector({
            api: new InMemoryAirbyteApiClient(),
            clock: () => nowMs,
            onSyncMetadata: (id, metadata) => {
              notified.push({ pipelineId: id, metadata });
            },
          });
          await connector.provision(makeConfig(pipelineId));

          const expected: SyncMetadata = {
            lastSyncAt: new Date(nowMs).toISOString(),
            recordCount,
          };

          const metadata = connector.completeSync(pipelineId, recordCount);

          // Returned metadata carries the exact count and correct timestamp.
          expect(metadata).toEqual(expected);
          // The registry-facing read reflects the same recorded metadata.
          expect(connector.getSyncMetadata(pipelineId)).toEqual(expected);
          // The listener was invoked exactly once with the same pipeline +
          // metadata, so the Pipeline_Registry update is driven by Req 4.5.
          expect(notified).toEqual([{ pipelineId, metadata: expected }]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a successful sync job updates the recorded metadata with the exact synced count and clock timestamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbRecordCount,
        arbClockMs,
        async (pipelineId, recordCount, nowMs) => {
          const api = new InMemoryAirbyteApiClient();
          // Program the next sync job to succeed having synced exactly N records.
          api.enqueueSyncResult({ status: 'succeeded', recordsSynced: recordCount });

          const notified: Array<{ pipelineId: string; metadata: SyncMetadata }> =
            [];
          const connector = new AirbyteConnector({
            api,
            clock: () => nowMs,
            sleep: instantSleep,
            onSyncMetadata: (id, metadata) => {
              notified.push({ pipelineId: id, metadata });
            },
          });
          await connector.provision(makeConfig(pipelineId));

          const expected: SyncMetadata = {
            lastSyncAt: new Date(nowMs).toISOString(),
            recordCount,
          };

          const result = await connector.runSync(pipelineId);

          // The sync completed and recorded the exact count + timestamp.
          expect(result.success).toBe(true);
          expect(result.metadata).toEqual(expected);
          expect(connector.getSyncMetadata(pipelineId)).toEqual(expected);
          expect(notified).toEqual([{ pipelineId, metadata: expected }]);
        },
      ),
      { numRuns: 100 },
    );
  });
});
