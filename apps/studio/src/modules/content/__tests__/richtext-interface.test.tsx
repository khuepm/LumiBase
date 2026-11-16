// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { FieldResource } from '@lumibase/sdk';
import type { RichTextDocument } from '@lumibase/contracts/richtext';
vi.mock('@/lib/extension-loader', () => ({ getExtension: () => undefined }));
import { RichTextInterface, richTextEntries } from '../interfaces/richtext';
import { resolveInterface } from '../interfaces/registry';

const field = { id: 'f', name: 'body', type: 'json', interface: 'richtext' } as FieldResource;
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
  it('is registered for the richtext interface', () => {
    expect(resolveInterface(field)).toBe(RichTextInterface);
  });

  it('splits single and localized values', () => {
    expect(richTextEntries(doc('a')).map(([l]) => l)).toEqual(['']);
    expect(richTextEntries({ en: doc('a'), vi: doc('b'), junk: 1 }).map(([l]) => l)).toEqual(['en', 'vi']);
    expect(richTextEntries('nope')).toEqual([]);
  });

  it('previews the document and switches locales', () => {
    render(<RichTextInterface field={field} value={{ en: doc('Hello'), vi: doc('Xin chào') }} onChange={vi.fn()} />);
    expect(screen.getByTestId('richtext-preview').innerHTML).toContain('<strong>Hello</strong>');
    fireEvent.click(screen.getByRole('button', { name: 'vi' }));
    expect(screen.getByTestId('richtext-preview').innerHTML).toContain('<strong>Xin chào</strong>');
  });

  it('never renders unsafe links or raw markup', () => {
    render(<RichTextInterface field={field} value={doc('<img src=x onerror=alert(1)>', 'javascript:alert(1)')} onChange={vi.fn()} />);
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
