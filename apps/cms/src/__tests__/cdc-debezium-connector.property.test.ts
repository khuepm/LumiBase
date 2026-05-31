import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  DebeziumKafkaConnector,
  InMemoryKafkaPublisher,
  deriveTopicName,
  topicPrefixFor,
  type DebeziumChangeEvent,
} from '../modules/cdc/connectors/debezium-kafka';
import type { ConnectorConfig } from '../modules/cdc/connectors/types';

/**
 * Feature: clickhouse-cdc, Property 5: Kafka topic routing by table name
 *
 * For any table name in the replication configuration, change events from
 * that table SHALL be published to a Kafka topic whose name is
 * deterministically derived from the table name, and events from different
 * tables SHALL never share a topic.
 *
 * **Validates: Requirements 2.2**
 */

/**
 * Feature: clickhouse-cdc, Property 6: Event ordering preservation during outages
 *
 * For any sequence of CDC events, if the downstream sink (Kafka broker or
 * ClickHouse) becomes temporarily unavailable, events SHALL be buffered and
 * delivered in their original order upon recovery.
 *
 * **Validates: Requirements 2.4, 2.6**
 */

// ── Arbitraries ──────────────────────────────────────────────────────────

/** A pipeline identifier (nanoid-like, but any non-empty string is valid). */
const arbPipelineId = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => s.trim().length > 0);

/**
 * An arbitrary table name. Mixes free-form unicode (the "for any"
 * obligation) with realistically-shaped `schema.table` identifiers so the
 * routing is exercised across both adversarial and representative inputs.
 */
const arbTableName = fc.oneof(
  fc.string({ minLength: 1, maxLength: 64 }).filter((s) => s.length >= 1),
  fc
    .tuple(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
      fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
    )
    .map(([schema, table]) => `${schema}.${table}`),
);

/** A non-empty set of distinct table names. */
const arbDistinctTables = fc.uniqueArray(arbTableName, {
  minLength: 1,
  maxLength: 12,
});

/** Build a complete connector config for the given pipeline + tables. */
function makeConfig(
  pipelineId: string,
  replicationTables: readonly string[],
): ConnectorConfig {
  return {
    pipelineId,
    tenantId: 'site_test',
    sourceConnection: 'postgresql://u:p@localhost:5432/db',
    sinkConnection: 'clickhouse://u:p@localhost:8123/db',
    intermediaryConnection: 'kafka://localhost:9092',
    replicationTables,
  };
}

/** Build a change event for a table at a given ordinal position. */
function makeEvent(table: string, seq: number): DebeziumChangeEvent {
  const ops = ['INSERT', 'UPDATE', 'DELETE'] as const;
  return {
    table,
    operation: ops[seq % ops.length]!,
    recordId: `rec-${seq}`,
    payload: { n: seq },
    sequence: seq,
    timestamp: 1_700_000_000_000 + seq,
  };
}

// ── Property 5 ───────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 5: Kafka topic routing by table name', () => {
  it('topic derivation is deterministic for a given (prefix, table)', () => {
    fc.assert(
      fc.property(arbPipelineId, arbTableName, (pipelineId, table) => {
        const prefix = topicPrefixFor(pipelineId);
        const a = deriveTopicName(prefix, table);
        const b = deriveTopicName(prefix, table);
        expect(a).toBe(b);
      }),
      { numRuns: 100 },
    );
  });

  it('distinct tables never collide on the same topic (injective routing)', () => {
    fc.assert(
      fc.property(arbPipelineId, arbDistinctTables, (pipelineId, tables) => {
        const prefix = topicPrefixFor(pipelineId);
        const topics = tables.map((t) => deriveTopicName(prefix, t));

        // Each distinct table maps to a distinct topic.
        expect(new Set(topics).size).toBe(tables.length);
      }),
      { numRuns: 100 },
    );
  });

  it('events are published to the deterministically-derived topic for their table', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbDistinctTables,
        async (pipelineId, tables) => {
          const kafka = new InMemoryKafkaPublisher();
          const connector = new DebeziumKafkaConnector({ kafka });

          const provision = await connector.provision(
            makeConfig(pipelineId, tables),
          );
          expect(provision.success).toBe(true);

          // Publish one event per table.
          for (let i = 0; i < tables.length; i += 1) {
            await connector.ingestEvent(pipelineId, makeEvent(tables[i]!, i));
          }

          // Every event landed on its table's derived topic, and topics map
          // 1:1 with tables (no cross-table sharing).
          const prefix = topicPrefixFor(pipelineId);
          const usedTopics = new Set<string>();
          for (const table of tables) {
            const expectedTopic = deriveTopicName(prefix, table);
            const delivered = kafka.published.get(expectedTopic) ?? [];
            expect(delivered).toHaveLength(1);
            expect(delivered[0]!.table).toBe(table);
            usedTopics.add(expectedTopic);
          }
          expect(usedTopics.size).toBe(tables.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 6 ───────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 6: Event ordering preservation during outages', () => {
  it('events captured during an outage are delivered in original order on recovery', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbDistinctTables,
        fc.array(fc.integer({ min: 0, max: 5 }), {
          minLength: 1,
          maxLength: 60,
        }),
        async (pipelineId, tables, tableIdxSeq) => {
          const kafka = new InMemoryKafkaPublisher();
          const connector = new DebeziumKafkaConnector({ kafka });
          await connector.provision(makeConfig(pipelineId, tables));

          // Build the event sequence, mapping each step to one of the tables.
          const events = tableIdxSeq.map((idx, seq) =>
            makeEvent(tables[idx % tables.length]!, seq),
          );

          // Broker goes down → all events are buffered.
          kafka.setAvailable(false);
          for (const event of events) {
            await connector.ingestEvent(pipelineId, event);
          }
          expect(connector.getBufferDepth(pipelineId)).toBe(events.length);

          // Broker recovers → replay buffered backlog.
          kafka.setAvailable(true);
          await connector.flushBuffer(pipelineId);
          expect(connector.getBufferDepth(pipelineId)).toBe(0);

          // Within every topic, delivered events preserve their original
          // relative order (by source sequence number).
          for (const [, delivered] of kafka.published) {
            const seqs = delivered.map((e) => e.sequence);
            const sorted = [...seqs].sort((a, b) => a - b);
            expect(seqs).toEqual(sorted);
          }

          // Globally, the multiset of delivered events equals the input.
          const allDelivered = [...kafka.published.values()]
            .flat()
            .map((e) => e.sequence)
            .sort((a, b) => a - b);
          const allInput = events.map((e) => e.sequence).sort((a, b) => a - b);
          expect(allDelivered).toEqual(allInput);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a single-table outage replays the exact original order with no loss or reordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbTableName,
        fc.integer({ min: 1, max: 80 }),
        async (pipelineId, table, count) => {
          const kafka = new InMemoryKafkaPublisher();
          const connector = new DebeziumKafkaConnector({ kafka });
          await connector.provision(makeConfig(pipelineId, [table]));

          const events = Array.from({ length: count }, (_, seq) =>
            makeEvent(table, seq),
          );

          kafka.setAvailable(false);
          for (const event of events) {
            await connector.ingestEvent(pipelineId, event);
          }

          kafka.setAvailable(true);
          await connector.flushBuffer(pipelineId);

          const topic = connector.getTopicForTable(pipelineId, table);
          const delivered = kafka.published.get(topic) ?? [];

          // Exact order preservation: delivered sequence === input sequence.
          expect(delivered.map((e) => e.sequence)).toEqual(
            events.map((e) => e.sequence),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('intermittent recovery (publish fails mid-flush) still preserves order', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPipelineId,
        arbTableName,
        fc.integer({ min: 2, max: 40 }),
        async (pipelineId, table, count) => {
          // A publisher that fails the first publish of each flush attempt,
          // forcing the connector to re-buffer the remaining events in order.
          let failNext = false;
          const kafka = new InMemoryKafkaPublisher();
          const realPublish = kafka.publish.bind(kafka);
          kafka.publish = async (topic, event) => {
            if (failNext) {
              failNext = false;
              throw new Error('transient publish failure');
            }
            return realPublish(topic, event);
          };

          const connector = new DebeziumKafkaConnector({ kafka });
          await connector.provision(makeConfig(pipelineId, [table]));

          const events = Array.from({ length: count }, (_, seq) =>
            makeEvent(table, seq),
          );

          kafka.setAvailable(false);
          for (const event of events) {
            await connector.ingestEvent(pipelineId, event);
          }
          kafka.setAvailable(true);

          // Retry flushing, injecting a transient failure before each attempt,
          // until the backlog fully drains.
          let guard = 0;
          while (connector.getBufferDepth(pipelineId) > 0 && guard < count + 5) {
            failNext = true;
            try {
              await connector.flushBuffer(pipelineId);
            } catch {
              // Expected transient failure — remaining events were re-buffered.
            }
            guard += 1;
          }
          // Final clean flush.
          await connector.flushBuffer(pipelineId);

          const topic = connector.getTopicForTable(pipelineId, table);
          const delivered = kafka.published.get(topic) ?? [];
          expect(delivered.map((e) => e.sequence)).toEqual(
            events.map((e) => e.sequence),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
