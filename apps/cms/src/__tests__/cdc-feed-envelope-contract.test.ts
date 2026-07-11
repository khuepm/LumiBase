import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../modules/cdc/change-feed/dispatcher';
import { EventEnvelopeSchema, decodeCdcCursor } from '@lumibase/shared';

/**
 * Envelope v1 golden contract (task 15.2, Req 9.4).
 *
 * This test pins the EXACT wire shape of schemaVersion 1. An unintentional
 * field rename/removal fails here before it reaches a consumer; intentional
 * breaking changes must bump `schemaVersion` and update this fixture.
 */

const GOLDEN_V1 = {
  id: 'evt_golden_00001',
  type: 'items.update',
  schemaVersion: 1,
  siteId: 'site_A',
  collection: 'posts',
  itemId: 'itm_42',
  operation: 'update',
  occurredAt: '2026-07-11T00:00:00.000Z',
  actor: { type: 'api_key', id: 'key_1' },
  source: 'api',
  changedFields: ['title'],
  data: { title: 'hello', ssn: '[masked]' },
  cursor: 'MTc4MzcyODAwMDAwMDpldnRfZ29sZGVuXzAwMDAx',
};

describe('cdc-feed envelope v1 contract (golden)', () => {
  it('buildEnvelope produces exactly the golden wire shape', () => {
    const envelope = buildEnvelope(
      {
        id: 'evt_golden_00001',
        siteId: 'site_A',
        collection: 'posts',
        itemId: 'itm_42',
        operation: 'update',
        payload: { title: 'hello', ssn: '[masked]' },
        changedFields: ['title'],
        schemaVersion: 1,
        actorType: 'api_key',
        actorId: 'key_1',
        source: 'api',
        occurredAt: new Date('2026-07-11T00:00:00.000Z'),
      },
      'snapshot',
    );
    expect(envelope).toEqual(GOLDEN_V1);
    expect(EventEnvelopeSchema.parse(envelope)).toEqual(GOLDEN_V1);
  });

  it('the golden cursor decodes to the event keyset', () => {
    expect(decodeCdcCursor(GOLDEN_V1.cursor)).toEqual({
      occurredAtMs: new Date('2026-07-11T00:00:00.000Z').getTime(),
      eventId: 'evt_golden_00001',
    });
  });

  it('reference mode omits data but is otherwise identical', () => {
    const envelope = buildEnvelope(
      {
        id: 'evt_golden_00001',
        siteId: 'site_A',
        collection: 'posts',
        itemId: 'itm_42',
        operation: 'update',
        payload: { title: 'hello' },
        changedFields: ['title'],
        schemaVersion: 1,
        actorType: 'api_key',
        actorId: 'key_1',
        source: 'api',
        occurredAt: new Date('2026-07-11T00:00:00.000Z'),
      },
      'reference',
    );
    const { data: _omitted, ...expected } = GOLDEN_V1;
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(expected);
    expect(envelope.data).toBeUndefined();
  });
});
