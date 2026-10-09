import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchSchema } from '../patch-schema';

const create = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  tags: z.array(z.string()).default(['initial']),
  budget: z.object({ limit: z.number().positive().default(10) }).prefault({}),
  note: z.string().nullable().optional(),
});

describe('PATCH omission semantics (B85/B86)', () => {
  it('does not write omitted defaults, including on empty patches', () => {
    expect(patchSchema(create).parse({ name: 'renamed' })).toEqual({ name: 'renamed' });
    expect(patchSchema(create).parse({})).toEqual({});
    expect(create.parse({ name: 'created' })).toMatchObject({ enabled: true, tags: ['initial'], budget: { limit: 10 } });
  });
  it('retains explicit false, null, empty arrays and nested replacement defaults', () => {
    expect(patchSchema(create).parse({ enabled: false, tags: [], note: null, budget: {} }))
      .toEqual({ enabled: false, tags: [], note: null, budget: { limit: 10 } });
  });
  it('preserves validation and unknown-key policy', () => {
    for (const input of [null, [], 'x', { name: '' }, { budget: { limit: -1 } }]) {
      expect(patchSchema(create).safeParse(input).success).toBe(false);
    }
    expect(patchSchema(create).parse({ name: 'x', siteId: 'other' })).toEqual({ name: 'x' });
    expect(patchSchema(create.strict()).safeParse({ siteId: 'other' }).success).toBe(false);
  });
  it('routes and services use the omission-safe helper instead of raw partial()', () => {
    const src = resolve(import.meta.dirname, '../..');
    const offenders: string[] = [];
    for (const directory of ['routes', 'services']) {
      for (const file of readdirSync(resolve(src, directory))) {
        if (!file.endsWith('.ts') || /\.(test|spec)\.ts$/.test(file)) continue;
        if (/\.partial\s*\(/.test(readFileSync(resolve(src, directory, file), 'utf8'))) {
          offenders.push(`${directory}/${file}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
