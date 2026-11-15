/**
 * API explorer (#745): a bundled Swagger UI pointed at a URL the reader
 * types. Pins: nothing loads until Load is pressed, no query-string URL is
 * honoured, only http(s) URLs are accepted, and credentials are attached only
 * to requests bound for the document's own origin.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { buildRequestInterceptor, parseSpecUrl } from '../lib/api-explorer';

const swagger = vi.fn();
vi.mock('swagger-ui-dist/swagger-ui-es-bundle.js', () => ({ default: swagger }));
vi.mock('swagger-ui-dist/swagger-ui.css', () => ({}));

import { routes } from '../routes';

beforeAll(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(), takeRecords: () => [] };
    }),
  );
});
afterEach(() => {
  cleanup();
  swagger.mockReset();
});

describe('parseSpecUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(parseSpecUrl(' https://cms.example.test/api/v1/openapi.json ')?.host).toBe('cms.example.test');
    expect(parseSpecUrl('http://localhost:1989/api/v1/openapi.json')).not.toBeNull();
    for (const bad of ['', '/api/v1/openapi.json', 'javascript:alert(1)', 'data:application/json,{}', 'file:///etc/passwd']) {
      expect(parseSpecUrl(bad)).toBeNull();
    }
  });
});

describe('buildRequestInterceptor', () => {
  const spec = new URL('https://cms.example.test/api/v1/openapi.json');
  const intercept = buildRequestInterceptor(spec, { site: 'site-a', token: 'tok' });

  it('adds site + bearer to requests for the document origin (relative servers included)', () => {
    expect(intercept({ url: '/api/v1/items/posts', headers: {} }).headers).toEqual({
      'X-Lumi-Site': 'site-a',
      Authorization: 'Bearer tok',
    });
    const headers: Record<string, string> = intercept({ url: 'https://cms.example.test/api/v1/openapi.json', headers: {} }).headers;
    expect(headers['Authorization']).toBe('Bearer tok');
  });

  it('never sends credentials to another origin', () => {
    expect(intercept({ url: 'https://evil.example/collect', headers: { a: '1' } }).headers).toEqual({ a: '1' });
  });
});

describe('ApiExplorerPage', () => {
  it('ignores ?url= and loads nothing until the reader presses Load', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/en/api-explorer?url=https://evil.example/x.json'] });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { level: 1, name: 'API explorer' });
    expect(swagger).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Document URL') as HTMLInputElement).value).toBe('');
  });

  it('rejects a non-http URL and mounts Swagger UI for a valid one', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/vi/api-explorer'] });
    render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { level: 1, name: 'Trình khám phá API' });

    fireEvent.change(screen.getByLabelText('URL tài liệu'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nạp' }));
    expect(await screen.findByText('Hãy nhập một URL http(s) tuyệt đối.')).toBeTruthy();
    expect(swagger).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('URL tài liệu'), { target: { value: 'https://cms.example.test/api/v1/openapi.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Nạp' }));
    await waitFor(() => expect(swagger).toHaveBeenCalledTimes(1));
    expect(swagger.mock.calls[0]![0]).toMatchObject({
      url: 'https://cms.example.test/api/v1/openapi.json',
      queryConfigEnabled: false,
    });
  });
});
