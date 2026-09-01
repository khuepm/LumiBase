import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { cdcEventType, EventEnvelopeSchema } from '@lumibase/contracts';
import { buildEnvelope } from '../modules/cdc/change-feed/dispatcher';
import {
  OutboxWriter,
  MASKED_VALUE,
  type OutboxWriterDeps,
} from '../modules/cdc/change-feed/outbox-writer';
import type { StoredChangeEvent } from '../modules/cdc/change-feed/feed-reader';
import type { Database } from '@lumibase/database';

/**
 * Feature: cdc-extension-integration (follow-up: capture collections/fields/
 * settings). The outbox gained a `resource` discriminator so schema DDL rides
 * the same feed as content changes. This pins:
 *  - the envelope `type` is `<plural>.<operation>` for every resource kind,
 *  - a stored event with no `resource` still reads as `items.*` (back-compat),
 *  - masking is item-only: schema/setting payloads are stored verbatim.
 */

interface CapturedRow {
  resource: string;
  collection: string;
  itemId: string;
  operation: string;
  payload: Record<string, unknown> | null;
}

function makeWriter(captured: CapturedRow[], sensitive: Set<string>): OutboxWriter {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => [{ id: 'sub1' }], // feed enabled
  };
  const db = {
    select: () => selectChain,
    insert: () => ({
      values: (row: CapturedRow) => ({
        returning: async () => {
          captured.push(row);
          return [{ id: `evt_${captured.length}` }];
        },
      }),
    }),
  } as unknown as Database;
  const deps: OutboxWriterDeps = {
    db,
    siteId: 'site_A',
    getSensitiveFields: async () => sensitive,
  };
  return new OutboxWriter(deps);
}

describe('cdcEventType', () => {
  it('maps every resource kind to its plural namespace', () => {
    expect(cdcEventType('item', 'create')).toBe('items.create');
    expect(cdcEventType('collection', 'update')).toBe('collections.update');
    expect(cdcEventType('field', 'delete')).toBe('fields.delete');
    expect(cdcEventType('setting', 'update')).toBe('settings.update');
  });

  it('always produces a type accepted by EventEnvelopeSchema', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('item', 'collection', 'field', 'setting'),
        fc.constantFrom('create', 'update', 'delete'),
        (resource, operation) => {
          const type = cdcEventType(resource as never, operation as never);
          // The envelope regex must accept every generated type.
          expect(() =>
            EventEnvelopeSchema.shape.type.parse(type),
          ).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('buildEnvelope resource → type', () => {
  const base: StoredChangeEvent = {
    id: 'evt_1',
    siteId: 'site_A',
    collection: 'posts',
    itemId: 'posts',
    operation: 'create',
    payload: null,
    changedFields: null,
    schemaVersion: 1,
    actorType: 'user',
    actorId: 'u1',
    source: 'api',
    occurredAt: new Date('2026-07-11T00:00:00.000Z'),
  };

  it('uses the resource discriminator for the envelope type', () => {
    expect(buildEnvelope({ ...base, resource: 'collection' }, 'reference').type).toBe(
      'collections.create',
    );
    expect(
      buildEnvelope({ ...base, resource: 'field', operation: 'delete' }, 'reference').type,
    ).toBe('fields.delete');
  });

  it('defaults to items.* when the stored row has no resource (back-compat)', () => {
    const { resource: _omit, ...noResource } = { ...base, resource: undefined };
    expect(buildEnvelope(noResource as StoredChangeEvent, 'reference').type).toBe('items.create');
  });
});

describe('OutboxWriter resource capture', () => {
  it('persists the resource kind on the stored row', async () => {
    const captured: CapturedRow[] = [];
    const writer = makeWriter(captured, new Set());
    await writer.write(
      { resource: 'collection', collection: 'posts', itemId: 'posts', operation: 'create', payload: { name: 'posts' } },
      { type: 'user', id: 'u1' },
      'api',
    );
    expect(captured[0]!.resource).toBe('collection');
  });

  it('defaults resource to item when omitted', async () => {
    const captured: CapturedRow[] = [];
    const writer = makeWriter(captured, new Set());
    await writer.write(
      { collection: 'posts', itemId: 'itm1', operation: 'create', payload: { title: 'x' } },
      { type: 'user', id: 'u1' },
      'api',
    );
    expect(captured[0]!.resource).toBe('item');
  });

  it('masks item payloads but stores schema/setting payloads verbatim', async () => {
    const sensitive = new Set(['secret']);
    const payload = { secret: 'TOP', name: 'posts' };

    const itemCaptured: CapturedRow[] = [];
    await makeWriter(itemCaptured, sensitive).write(
      { resource: 'item', collection: 'posts', itemId: 'itm1', operation: 'update', payload },
      { type: 'user', id: 'u1' },
      'api',
    );
    // item: sensitive value masked
    expect(itemCaptured[0]!.payload).toEqual({ secret: MASKED_VALUE, name: 'posts' });

    const schemaCaptured: CapturedRow[] = [];
    await makeWriter(schemaCaptured, sensitive).write(
      { resource: 'collection', collection: 'posts', itemId: 'posts', operation: 'update', payload },
      { type: 'user', id: 'u1' },
      'api',
    );
    // collection: no per-field classification applies → stored verbatim
    expect(schemaCaptured[0]!.payload).toEqual({ secret: 'TOP', name: 'posts' });
  });
});
