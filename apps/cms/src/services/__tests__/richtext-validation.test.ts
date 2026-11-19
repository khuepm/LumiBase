import { describe, expect, it } from 'vitest';
import { validateItem } from '../validation';
import { buildSearchDocument } from '../search-document';
import { castKindForFieldType } from '../json-filter-cast';
import { decodeCell } from '../export-service';
import { cf } from './blocks-fixtures';
import { fileNeedles, matchingFields } from '../files/file-usage';

/** `richtext` field type (#695) and write-path sanitisation (#700). */

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });

describe('richtext validation', () => {
  const body = cf('body', 'richtext', { interface: 'richtext' });

  it('stores the sanitised document', () => {
    const r = validateItem([body], {
      body: doc({
        type: 'paragraph',
        content: [
          { type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'click' }] },
          { type: 'text', text: ' me\u0000', marks: ['italic', 'bold'] },
        ],
      }),
    });
    expect(r).toEqual({
      ok: true,
      data: { body: doc({ type: 'paragraph', content: [{ type: 'text', text: 'click' }, { type: 'text', text: ' me', marks: ['bold', 'italic'] }] }) },
    });
  });

  it('rejects HTML strings and malformed documents with a precise path', () => {
    const html = validateItem([body], { body: '<p onclick="x">hi</p>' });
    expect(html.ok).toBe(false);
    if (!html.ok) expect(html.issues[0]).toMatchObject({ field: 'body', code: 'invalid_richtext' });

    const bad = validateItem([body], { body: doc(p('ok'), { type: 'heading', level: 9, content: [] }) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatchObject({ field: 'body.content.1.level', code: 'invalid_richtext' });
  });

  it('enforces the field options on write', () => {
    const restricted = cf('body', 'richtext', { interface: 'richtext', options: { headingLevels: [2, 3], blocks: ['heading', 'list'], links: false } });
    const r = validateItem([restricted], { body: doc({ type: 'heading', level: 1, content: [] }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ field: 'body.content.0', code: 'richtext_not_allowed' });
    const table = validateItem([restricted], { body: doc({ type: 'table', rows: [] }) });
    expect(table.ok).toBe(false);
    expect(validateItem([restricted], { body: doc({ type: 'heading', level: 2, content: [] }, p('x')) }).ok).toBe(true);
  });

  it('treats null as empty and an empty document as missing for required fields', () => {
    expect(validateItem([body], { body: null })).toEqual({ ok: true, data: { body: null } });
    const required = cf('body', 'richtext', { required: true });
    expect(validateItem([required], { body: doc() }).ok).toBe(false);
    expect(validateItem([required], { body: null }).ok).toBe(false);
    expect(validateItem([required], { body: doc(p('x')) }).ok).toBe(true);
  });

  it('sanitises rich text kept in a json field with the richtext interface (migrated content)', () => {
    const legacy = cf('body', 'json', { interface: 'richtext' });
    const unsafe = doc({ type: 'paragraph', content: [{ type: 'link', href: 'vbscript:x', content: [{ type: 'text', text: 'y' }] }] });
    expect(validateItem([legacy], { body: unsafe })).toEqual({ ok: true, data: { body: doc(p('y')) } });
    expect(validateItem([legacy], { body: { en: unsafe, vi: doc(p('z')) } })).toEqual({ ok: true, data: { body: { en: doc(p('y')), vi: doc(p('z')) } } });
    // Anything else keeps plain json semantics.
    expect(validateItem([legacy], { body: { any: 'thing' } })).toEqual({ ok: true, data: { body: { any: 'thing' } } });
  });
});

describe('richtext elsewhere in the CMS', () => {
  it('indexes documents as plain text', () => {
    const d = buildSearchDocument('posts', 'i', { title: 't', body: doc({ type: 'heading', level: 2, content: [{ type: 'text', text: 'Hello' }] }, p('world')) });
    expect(d.body).toBe('Hello\nworld');
  });

  it('is a container for JSON filters and round-trips through CSV as JSON', () => {
    expect(castKindForFieldType('richtext')).toBeNull();
    expect(decodeCell(JSON.stringify(doc(p('x'))), 'richtext')).toEqual(doc(p('x')));
  });
});

describe('file usage (#697 / #706)', () => {
  it('finds a file embedded in rich text, so safe delete refuses it', () => {
    const file = { id: 'V1StGXR8_Z5jdHi6B-myT', filenameDisk: 'uploads/cat.png' };
    const data = {
      title: 'x',
      body: doc(p('a'), { type: 'embed', ref: { kind: 'file', id: file.id }, alt: 'cat' }),
      other: doc(p('no file here')),
    };
    expect(matchingFields(data, fileNeedles(file))).toEqual(['body']);
  });
});
