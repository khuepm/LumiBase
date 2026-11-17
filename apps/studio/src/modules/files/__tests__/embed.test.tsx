// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PickedAsset } from '@lumibase/extension-sdk';
import { assetHtml, assetMarkdown } from '../embed';

/** Rich text + markdown reuse the shared media picker (#708). */

const picked: PickedAsset[] = [];
vi.mock('@/modules/files/media-picker', () => ({
  useMediaPicker: () => async () => picked,
}));

import { MarkdownInterface } from '../../content/interfaces/markdown';
import { WysiwygInterface } from '../../content/interfaces/wysiwyg';

afterEach(cleanup);

const asset = (over: Partial<PickedAsset> = {}): PickedAsset => ({
  id: 'f1',
  filenameDisk: 'k',
  filenameDownload: 'harbour.jpg',
  mime: 'image/jpeg',
  filesize: 1,
  width: 640,
  height: 480,
  folder: null,
  metadata: {},
  url: 'https://cms/api/v1/files/f1/content?v=2',
  ...over,
});

describe('embed markup', () => {
  it('images become <img> with escaped alt and size; other files become links', () => {
    expect(assetHtml(asset({ alt: 'Boats "at" <dawn>' }))).toBe(
      '<img src="https://cms/api/v1/files/f1/content?v=2" alt="Boats &quot;at&quot; &lt;dawn&gt;" width="640" height="480">',
    );
    expect(assetHtml(asset({ mime: 'application/pdf', filenameDownload: 'a&b.pdf' }))).toBe(
      '<a href="https://cms/api/v1/files/f1/content?v=2">a&amp;b.pdf</a>',
    );
  });

  it('markdown uses ![alt](url) / [name](url), alt falls back to the file name', () => {
    expect(assetMarkdown(asset())).toBe('![harbour](https://cms/api/v1/files/f1/content?v=2)');
    expect(assetMarkdown(asset({ alt: 'a [b]' }))).toBe('![a \\[b\\]](https://cms/api/v1/files/f1/content?v=2)');
    expect(assetMarkdown(asset({ mime: 'application/pdf' }))).toBe('[harbour.jpg](https://cms/api/v1/files/f1/content?v=2)');
  });
});

describe('markdown interface', () => {
  const field = { id: 'f', name: 'body', type: 'text', interface: 'markdown', options: {} } as never;

  it('inserts picked files at the caret and previews images', async () => {
    picked.splice(0, picked.length, asset());
    const onChange = vi.fn();
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <MarkdownInterface value="Hello world" field={field} onChange={onChange} />
      </QueryClientProvider>,
    );
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    ta.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Insert from library' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0]![0]).toBe('Hello![harbour](https://cms/api/v1/files/f1/content?v=2) world');

    cleanup();
    render(
      <QueryClientProvider client={qc}>
        <MarkdownInterface value={'![harbour](https://cms/x.jpg) and [doc](https://cms/d.pdf)'} field={field} onChange={onChange} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('Preview'));
    const img = document.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://cms/x.jpg');
    expect(img.getAttribute('alt')).toBe('harbour');
    expect(document.querySelector('a')!.getAttribute('href')).toBe('https://cms/d.pdf');
  });

  it('never renders a javascript: image source', () => {
    render(<MarkdownInterface value={'![x](javascript:alert(1))'} field={field} onChange={() => undefined} />);
    fireEvent.click(screen.getByText('Preview'));
    expect(document.querySelector('img')?.getAttribute('src') ?? '').not.toMatch(/javascript/i);
  });
});

describe('wysiwyg interface', () => {
  it('embeds picked images as <img> through insertHTML', async () => {
    picked.splice(0, picked.length, asset(), asset({ id: 'f2', mime: 'application/pdf', filenameDownload: 'spec.pdf', url: 'https://cms/f2' }));
    const calls: Array<[string, string | undefined]> = [];
    (document as unknown as { execCommand: (c: string, u: boolean, a?: string) => boolean }).execCommand = (c, _u, a) => {
      calls.push([c, a]);
      return true;
    };
    render(<WysiwygInterface value="<p>Hi</p>" field={{} as never} onChange={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Insert from library' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]![0]).toBe('insertHTML');
    expect(calls[0]![1]).toBe(
      '<img src="https://cms/api/v1/files/f1/content?v=2" alt="harbour" width="640" height="480"> <a href="https://cms/f2">spec.pdf</a>',
    );
  });
});
