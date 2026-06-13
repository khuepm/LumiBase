import { describe, expect, it } from 'vitest';
import { compileField } from '../schema-service';

describe('SchemaService field metadata', () => {
  it('preserves Directus-style field metadata in compiled schema fields', () => {
    const field = compileField({
      id: 'field_1',
      siteId: 'site_1',
      collectionId: 'collection_1',
      name: 'price',
      type: 'decimal',
      interface: 'input',
      display: 'formatted-value',
      label: 'Price',
      note: 'Shown in storefront lists',
      defaultValue: '0.00',
      nullable: false,
      unique: true,
      indexed: true,
      searchable: false,
      length: 12,
      precision: 10,
      scale: 2,
      special: ['cast-decimal'],
      options: { min: 0 },
      displayOptions: { style: 'currency' },
      validation: { rules: [{ _gte: 0 }] },
      conditions: [{ name: 'readonly-archived' }],
      translations: {},
      required: true,
      readonly: false,
      hidden: false,
      encrypted: false,
      versioned: true,
      rawEnabled: true,
      width: 'half',
      group: 'commerce',
      sortOrder: 7,
      createdAt: new Date('2026-06-05T00:00:00.000Z'),
      updatedAt: new Date('2026-06-05T00:00:00.000Z'),
    });

    expect(field).toMatchObject({
      name: 'price',
      label: 'Price',
      note: 'Shown in storefront lists',
      defaultValue: '0.00',
      nullable: false,
      unique: true,
      indexed: true,
      searchable: false,
      length: 12,
      precision: 10,
      scale: 2,
      special: ['cast-decimal'],
      options: { min: 0 },
      displayOptions: { style: 'currency' },
      validation: { rules: [{ _gte: 0 }] },
      conditions: [{ name: 'readonly-archived' }],
    });
  });
});
