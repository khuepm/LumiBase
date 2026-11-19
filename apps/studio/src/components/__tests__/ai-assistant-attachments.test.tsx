// @vitest-environment jsdom
/**
 * #709: the Copilot panel attaches media-library images / PDFs to a turn and
 * sends their ids — never their bytes — with the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const picked = [
  { id: 'f_img', filenameDownload: 'hero.png', mime: 'image/png' },
  { id: 'f_pdf', filenameDownload: 'invoice.pdf', mime: 'application/pdf' },
  { id: 'f_svg', filenameDownload: 'logo.svg', mime: 'image/svg+xml' },
];
const openPicker = vi.fn(async () => picked);

vi.mock('@/modules/files/media-picker', () => ({ useMediaPicker: () => openPicker }));
vi.mock('@/lib/api', () => ({
  getActiveSite: () => 'site_1',
  getActiveToken: () => 'tok',
  getApiClient: () => ({}),
}));
vi.mock('@/lib/api-base', () => ({ getApiBaseUrl: () => 'https://cms.test' }));

import { AIAssistant, MAX_ATTACHMENTS, mergeAttachments } from '../ai-assistant';

describe('mergeAttachments', () => {
  const a = (fileId: string, mimeType = 'image/png') => ({ fileId, name: fileId, mimeType });

  it('drops duplicates and types the model cannot read, and caps the count', () => {
    expect(mergeAttachments([a('x')], [a('x'), a('y', 'application/pdf'), a('z', 'video/mp4')]).map((f) => f.fileId)).toEqual(['x', 'y']);
    const many = Array.from({ length: 9 }, (_, i) => a(`f${i}`));
    expect(mergeAttachments([], many)).toHaveLength(MAX_ATTACHMENTS);
  });
});

// jsdom has no layout, so it does not implement `scrollIntoView`. The panel
// scrolls 50 ms after each message; without this stub that timer can fire
// after a test and surface as an unhandled TypeError that fails the run.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

describe('AIAssistant attachments', () => {
  let bodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/ai/chat')) {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ data: { status: 'denied', message: 'A sunrise over the harbour.', conversationId: 'c1' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    openPicker.mockClear();
  });

  it('picks from the library, shows removable chips and sends only file ids', async () => {
    render(<AIAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Attach an image or PDF from the media library' }));

    await screen.findByRole('list', { name: 'Files to send' });
    expect(openPicker).toHaveBeenCalledWith(expect.objectContaining({
      multiple: true,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'],
    }));
    expect(screen.getByText('hero.png')).toBeTruthy();
    expect(screen.queryByText('logo.svg')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove invoice.pdf' }));
    expect(screen.queryByText('invoice.pdf')).toBeNull();

    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Write alt text for this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ message: 'Write alt text for this', attachments: [{ fileId: 'f_img' }] });
    await screen.findByText('A sunrise over the harbour.');
    // Chips are cleared; the sent turn lists the file it carried.
    expect(screen.queryByRole('list', { name: 'Files to send' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Attached files' }).textContent).toContain('hero.png');
  });

  it('a turn without files sends no attachments key', async () => {
    render(<AIAssistant />);
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ message: 'hello' });
  });
});
