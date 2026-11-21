// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileListQuery, FileResource } from '@lumibase/sdk';

/**
 * End to end through the real picker (#708 review): the "Insert from library"
 * actions open on All types, so a document can be chosen and lands as a link,
 * next to an image that lands as <img>.
 */

const file = (id: string, mime: string, name: string): FileResource => ({
  id,
  siteId: 's',
  storage: 'r2',
  filenameDisk: `key_${id}`,
  filenameDownload: name,
  mime,
  filesize: 10,
  width: mime.startsWith('image/') ? 800 : null,
  height: mime.startsWith('image/') ? 600 : null,
  duration: null,
  folder: null,
  metadata: {},
  uploadedBy: null,
  version: 1,
  createdAt: '2026-01-01',
});

const LIBRARY = [file('img1', 'image/png', 'logo.png'), file('doc1', 'application/pdf', 'spec.pdf')];
const list = vi.fn(async (q?: FileListQuery) => {
  let rows = LIBRARY;
  if (q?.mime) rows = rows.filter((f) => q.mime!.some((m) => (m.endsWith('/*') ? f.mime.startsWith(m.slice(0, -1)) : f.mime === m)));
  return { data: rows, meta: { total: rows.length } };
});

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({ files: { list }, folders: { tree: async () => ({ data: [] }) } }),
}));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => 'https://cms' }));

import { MediaPickerProvider } from '../media-picker';
import { MarkdownInterface } from '../../content/interfaces/markdown';
import { WysiwygInterface } from '../../content/interfaces/wysiwyg';

afterEach(() => {
  cleanup();
  list.mockClear();
});

function withPicker(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MediaPickerProvider>{ui}</MediaPickerProvider>
    </QueryClientProvider>,
  );
}

async function pickBoth() {
  const dialog = await screen.findByRole('dialog');
  // Opens on All types: no mime filter, both files listed.
  expect(within(dialog).getByRole('button', { name: 'All types' }).getAttribute('aria-pressed')).toBe('true');
  expect(list.mock.calls[0]![0]?.mime).toBeUndefined();
  fireEvent.click(await within(dialog).findByText('logo.png'));
  fireEvent.click(within(dialog).getByText('spec.pdf'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select' }));
}

describe('editors insert any library file through the shared picker', () => {
  it('markdown: image as ![alt](url), PDF as [name](url)', async () => {
    const onChange = vi.fn();
    const field = { id: 'f', name: 'body', type: 'text', interface: 'markdown', options: {} } as never;
    withPicker(<MarkdownInterface value="" field={field} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert from library' }));
    await pickBoth();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toBe(
      '![logo](https://cms/api/v1/files/img1/content?v=1)\n[spec.pdf](https://cms/api/v1/files/doc1/content?v=1)',
    );
  });

  it('wysiwyg: image as <img>, PDF as a link', async () => {
    const calls: Array<string | undefined> = [];
    (document as unknown as { execCommand: (c: string, u: boolean, a?: string) => boolean }).execCommand = (_c, _u, a) => {
      calls.push(a);
      return true;
    };
    withPicker(<WysiwygInterface value="" field={{} as never} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert from library' }));
    await pickBoth();
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toBe(
      '<img src="https://cms/api/v1/files/img1/content?v=1" alt="logo" width="800" height="600"> <a href="https://cms/api/v1/files/doc1/content?v=1">spec.pdf</a>',
    );
  });
});
