// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { FieldResource } from '@lumibase/sdk';
const ext = vi.hoisted(() => ({ entries: new Map<string, { slot: string; component: unknown }>() }));
vi.mock('@/lib/extension-loader', () => ({ getExtension: (name: string) => ext.entries.get(name) }));

import { resolveInterface } from '../interfaces/registry';
import { TextMultilineInterface } from '../interfaces/text';
import { JsonRawInterface } from '../interfaces/json-raw';

const field = (type: string, iface: string) => ({ name: 'body', type, interface: iface }) as FieldResource;

describe('resolveInterface', () => {
  it('gives a text field with an unknown interface a textarea, not the JSON editor', () => {
    // The RC.3 starter created `body` as { type: 'text', interface: 'textarea' }.
    // `textarea` is not a registered interface; falling through to json-raw
    // made Studio reject plain prose as "not valid JSON".
    expect(resolveInterface(field('text', 'textarea'))).toBe(TextMultilineInterface);
    expect(resolveInterface(field('text', ''))).toBe(TextMultilineInterface);
  });

  it('still honours an explicit interface on a text field', () => {
    expect(resolveInterface(field('text', 'input-multiline'))).toBe(TextMultilineInterface);
    expect(resolveInterface(field('text', 'json-raw'))).toBe(JsonRawInterface);
  });

  it('keeps json-raw as the fallback for types with no editor', () => {
    expect(resolveInterface(field('json', 'nope'))).toBe(JsonRawInterface);
  });

  it('an extension interface beats the by-type default on string/text/number/boolean fields', () => {
    const Ext = () => null;
    ext.entries.set('color-picker', { slot: 'interface', component: Ext });
    try {
      for (const type of ['string', 'text', 'number', 'boolean']) {
        expect(resolveInterface(field(type, 'color-picker'))).toBe(Ext);
      }
      // Another slot with the same name is not an interface.
      ext.entries.set('color-picker', { slot: 'panel', component: Ext });
      expect(resolveInterface(field('text', 'color-picker'))).toBe(TextMultilineInterface);
    } finally {
      ext.entries.clear();
    }
  });
});
