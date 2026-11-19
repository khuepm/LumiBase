import { describe, expect, it } from 'vitest';
import { richTextValueSchema } from '../../schemas/richtext';
import { checkRichTextOptions, readRichTextFieldOptions, type RichTextDocument } from '../index';

const doc = (content: unknown): RichTextDocument => ({ type: 'doc', version: 1, content }) as RichTextDocument;
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

describe('richtext field options', () => {
  it('reads stored options defensively', () => {
    expect(readRichTextFieldOptions({ headingLevels: [2, 9, '3'], marks: ['bold', 'blink'], blocks: ['table', 'video'], maxLength: -1 })).toEqual({
      headingLevels: [2],
      marks: ['bold'],
      blocks: ['table'],
    });
    expect(readRichTextFieldOptions(null)).toEqual({});
  });

  it('rejects content the field does not allow', () => {
    expect(checkRichTextOptions(doc([{ type: 'heading', level: 1, content: [] }]), { headingLevels: [2, 3], blocks: ['heading'] })?.message).toMatch(
      /Heading level 1/,
    );
    expect(checkRichTextOptions(doc([{ type: 'table', rows: [] }]), { blocks: ['list'] })?.path).toEqual(['content', 0]);
    expect(
      checkRichTextOptions(doc([{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: ['code'] }] }]), { marks: ['bold'] })?.message,
    ).toMatch(/"code" mark/);
    expect(
      checkRichTextOptions(doc([{ type: 'paragraph', content: [{ type: 'link', href: '/x', content: [{ type: 'text', text: 'x' }] }] }]), { links: false })
        ?.message,
    ).toMatch(/Links/);
    expect(
      checkRichTextOptions(doc([{ type: 'embed', ref: { kind: 'item', collection: 'secrets', id: '1' } }]), { referenceCollections: ['posts'] })?.message,
    ).toMatch(/"secrets"/);
    expect(checkRichTextOptions(doc([{ type: 'custom', name: 'x', data: {} }]), { customBlocks: ['callout'] })?.message).toMatch(/"x"/);
    expect(checkRichTextOptions(doc([p('héllo')]), { maxLength: 4 })?.message).toMatch(/5 characters/);
    expect(checkRichTextOptions(doc([p('ok'), { type: 'heading', level: 2, content: [] }]), { headingLevels: [2] })).toBeNull();
  });
});

describe('richTextValueSchema', () => {
  it('returns the sanitised document', () => {
    const parsed = richTextValueSchema().parse(
      doc([{ type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: 'x' }] }] }]),
    );
    expect(parsed.content).toEqual([p('x')]);
  });

  it('reports structural and option issues with paths', () => {
    const bad = richTextValueSchema().safeParse({ type: 'doc', version: 1, content: [{ type: 'script' }] });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['content', 0]);
    const notAllowed = richTextValueSchema({ blocks: [] }).safeParse(doc([{ type: 'rule' }]));
    expect(notAllowed.error?.issues[0]?.message).toMatch(/"rule" blocks are not enabled/);
  });
});
