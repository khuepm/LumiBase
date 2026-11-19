// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';
import type { RichTextDocument } from '@lumibase/contracts/richtext';
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
vi.mock('@/modules/files/media-picker', () => ({ useMediaPicker: () => undefined }));
import { RichTextInterface, richTextEntries } from '../interfaces/richtext';
import { resolveInterface } from '../interfaces/registry';
import { resolveDisplay } from '../displays/registry';
import { RichTextDisplay, richTextExcerpt } from '../displays/richtext';

const field = { id: 'f', name: 'body', type: 'json', interface: 'richtext' } as FieldResource;
const typed = { id: 'g', name: 'body', type: 'richtext', interface: 'richtext' } as FieldResource;
const doc = (text: string, href = 'https://example.com'): RichTextDocument => ({
  type: 'doc',
  version: 1,
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text, marks: ['bold'] },
        { type: 'link', href, content: [{ type: 'text', text: ' link' }] },
      ],
    },
  ],
});

afterEach(cleanup);

describe('richtext interface', () => {
  it('is registered for the richtext interface and field type', () => {
    expect(resolveInterface(field)).toBe(RichTextInterface);
    expect(resolveInterface({ ...typed, interface: '' } as FieldResource)).toBe(RichTextInterface);
    expect(resolveDisplay(typed)).toBe(RichTextDisplay);
  });

  it('splits single and localized values', () => {
    expect(richTextEntries(doc('a')).map(([l]) => l)).toEqual(['']);
    expect(richTextEntries({ en: doc('a'), vi: doc('b'), junk: 1 }).map(([l]) => l)).toEqual(['en', 'vi']);
    expect(richTextEntries('nope')).toEqual([]);
  });

  it('opens the block editor by default (lazy chunk)', async () => {
    render(<RichTextInterface field={typed} value={doc('Hello')} onChange={vi.fn()} />);
    expect(await screen.findByTestId('richtext-editor')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'body' }).textContent).toContain('Hello');
  });

  it('previews the document and switches locales', () => {
    render(<RichTextInterface field={field} value={{ en: doc('Hello'), vi: doc('Xin chào') }} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('richtext-preview').innerHTML).toContain('<strong>Hello</strong>');
    fireEvent.click(screen.getByRole('button', { name: 'vi' }));
    expect(screen.getByTestId('richtext-preview').innerHTML).toContain('<strong>Xin chào</strong>');
  });

  it('shows a read-only preview for disabled fields', () => {
    render(<RichTextInterface field={typed} value={doc('Locked')} onChange={vi.fn()} disabled />);
    expect(screen.getByTestId('richtext-preview').innerHTML).toContain('Locked');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('never renders unsafe links or raw markup', () => {
    render(<RichTextInterface field={field} value={doc('<img src=x onerror=alert(1)>', 'javascript:alert(1)')} onChange={vi.fn()} disabled />);
    const html = screen.getByTestId('richtext-preview').innerHTML;
    expect(html).not.toContain('javascript');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('falls back to the raw JSON editor for invalid values and on toggle', () => {
    render(<RichTextInterface field={field} value={{ not: 'a doc' } as never} onChange={vi.fn()} />);
    expect(screen.getByText(/Not a rich-text document/)).toBeTruthy();
    cleanup();
    render(<RichTextInterface field={field} value={doc('x')} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON' }));
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});

describe('richtext display', () => {
  it('shows a plain-text excerpt, never markup', () => {
    expect(richTextExcerpt(doc('<b>Hi</b>'))).toBe('<b>Hi</b> link');
    expect(richTextExcerpt({ en: doc('Hello') })).toBe('Hello link');
    expect(richTextExcerpt('x')).toBeNull();
    expect(richTextExcerpt(doc('a'.repeat(300)), 10)).toBe('aaaaaaaaa…');
  });
});
