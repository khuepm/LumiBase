import { describe, expect, it } from 'vitest';
import {
  emptyPipelineForm,
  toCreatePayload,
  validatePipelineForm,
  validateSyncInterval,
  type PipelineFormValues,
} from '../pipeline-form';
import { recommendApproach } from '../recommender';
import { deletionResources, remediationSteps } from '../presentation';
import type { PipelineSummary } from '../types';

/**
 * Example-based unit tests for the CDC panel's pure logic (task 13.3).
 *
 * The exhaustive "errors only for invalid fields, valid values preserved"
 * universal property is covered separately by the property test in task 13.4
 * (Property 16). These tests pin down concrete examples and the
 * requirement-specific helpers (Req 6.4, 6.5).
 */

function validDebeziumForm(): PipelineFormValues {
  return {
    pipelineName: 'analytics-replica',
    connectorType: 'debezium_kafka',
    sourceConnection: 'postgresql://u:p@host:5432/db',
    sinkConnection: 'clickhouse://u:p@host:8123/db',
    replicationTables: ['public.users'],
    intermediaryConnection: 'kafka://host:9092',
    syncIntervalSeconds: '',
    syncMode: '',
  };
}

describe('validatePipelineForm', () => {
  it('accepts a fully valid Debezium form', () => {
    const result = validatePipelineForm(validDebeziumForm());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('flags missing required fields on an empty form', () => {
    const result = validatePipelineForm(emptyPipelineForm());
    expect(result.valid).toBe(false);
    expect(result.errors.pipelineName).toBeDefined();
    expect(result.errors.connectorType).toBeDefined();
    expect(result.errors.sourceConnection).toBeDefined();
    expect(result.errors.sinkConnection).toBeDefined();
    expect(result.errors.replicationTables).toBeDefined();
  });

  it('preserves entered values when some fields are invalid (Req 6.7)', () => {
    const values: PipelineFormValues = {
      ...validDebeziumForm(),
      sinkConnection: '', // invalid
    };
    const result = validatePipelineForm(values);
    expect(result.valid).toBe(false);
    expect(result.errors.sinkConnection).toBeDefined();
    // Valid fields must NOT be flagged and the input must be returned intact.
    expect(result.errors.pipelineName).toBeUndefined();
    expect(result.values).toBe(values);
    expect(result.values.pipelineName).toBe('analytics-replica');
  });

  it('does not require an intermediary connection for materialized_engine', () => {
    const result = validatePipelineForm({
      ...validDebeziumForm(),
      connectorType: 'materialized_engine',
      intermediaryConnection: '',
    });
    expect(result.errors.intermediaryConnection).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it('requires sync schedule fields for airbyte', () => {
    const result = validatePipelineForm({
      ...validDebeziumForm(),
      connectorType: 'airbyte',
      intermediaryConnection: 'https://airbyte/api',
      syncIntervalSeconds: '',
      syncMode: '',
    });
    expect(result.errors.syncIntervalSeconds).toBeDefined();
    expect(result.errors.syncMode).toBeDefined();
  });
});

describe('validateSyncInterval', () => {
  it('accepts the boundary values 300 and 86400', () => {
    expect(validateSyncInterval('300')).toBeNull();
    expect(validateSyncInterval('86400')).toBeNull();
  });

  it('rejects values outside [300, 86400] and non-integers', () => {
    expect(validateSyncInterval('299')).not.toBeNull();
    expect(validateSyncInterval('86401')).not.toBeNull();
    expect(validateSyncInterval('12.5')).not.toBeNull();
    expect(validateSyncInterval('abc')).not.toBeNull();
  });
});

describe('toCreatePayload', () => {
  it('drops blank tables and folds the Airbyte sync schedule into config', () => {
    const payload = toCreatePayload({
      ...validDebeziumForm(),
      connectorType: 'airbyte',
      intermediaryConnection: 'https://airbyte/api',
      replicationTables: ['public.users', '  ', 'public.orders'],
      syncIntervalSeconds: '600',
      syncMode: 'incremental_cdc',
    });
    expect(payload.replication_tables).toEqual(['public.users', 'public.orders']);
    expect(payload.config).toEqual({
      sync_schedule: { interval_seconds: 600, sync_mode: 'incremental_cdc' },
    });
    expect(payload.intermediary_connection).toBe('https://airbyte/api');
  });

  it('omits intermediary_connection for materialized_engine', () => {
    const payload = toCreatePayload({
      ...validDebeziumForm(),
      connectorType: 'materialized_engine',
      intermediaryConnection: '',
    });
    expect(payload.intermediary_connection).toBeUndefined();
    expect(payload.config).toBeUndefined();
  });
});

describe('recommendApproach', () => {
  it('recommends Debezium for high volume', () => {
    expect(
      recommendApproach({
        estimatedRowsPerSecond: 50_000,
        maxLatencySeconds: 30,
        hasKafkaInfrastructure: false,
        preferManagedService: false,
      }).recommended,
    ).toBe('debezium_kafka');
  });

  it('recommends Airbyte when a managed service is preferred', () => {
    expect(
      recommendApproach({
        estimatedRowsPerSecond: 100,
        maxLatencySeconds: 60,
        hasKafkaInfrastructure: false,
        preferManagedService: true,
      }).recommended,
    ).toBe('airbyte');
  });

  it('recommends Materialized Engine for low volume, no Kafka, relaxed latency', () => {
    expect(
      recommendApproach({
        estimatedRowsPerSecond: 100,
        maxLatencySeconds: 20,
        hasKafkaInfrastructure: false,
        preferManagedService: false,
      }).recommended,
    ).toBe('materialized_engine');
  });
});

describe('deletion + remediation helpers', () => {
  function pipeline(overrides: Partial<PipelineSummary>): PipelineSummary {
    return {
      id: 'p1',
      siteId: 'site_demo',
      pipelineName: 'demo',
      connectorType: 'debezium_kafka',
      status: 'error',
      statusMessage: null,
      replicationTables: ['public.users'],
      config: {},
      lastSyncAt: null,
      lastSyncRecordCount: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('lists replication slot cleanup for slot-based approaches (Req 6.5)', () => {
    const resources = deletionResources(pipeline({ connectorType: 'materialized_engine' }));
    expect(resources.some((r) => r.toLowerCase().includes('replication slot'))).toBe(true);
  });

  it('does not list replication slots for Airbyte', () => {
    const resources = deletionResources(pipeline({ connectorType: 'airbyte' }));
    expect(resources.some((r) => r.toLowerCase().includes('replication slot'))).toBe(false);
    expect(resources.some((r) => r.toLowerCase().includes('airbyte'))).toBe(true);
  });

  it('always returns at least one remediation step (Req 6.4)', () => {
    expect(remediationSteps(pipeline({ statusMessage: null })).length).toBeGreaterThan(0);
    expect(
      remediationSteps(pipeline({ statusMessage: 'replication slot failure' })).length,
    ).toBeGreaterThan(0);
  });
});
