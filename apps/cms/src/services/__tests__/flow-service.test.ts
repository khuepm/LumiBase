import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFlow, type FlowGraph } from '../flow-service';

describe('flow-service http operation SSRF protections', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'http://127.0.0.1/metadata',
    'http://10.0.0.5/metadata',
    'http://172.16.0.10/metadata',
    'http://192.168.1.20/metadata',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/admin',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.internal/metadata',
    'http://redis/metadata',
    'http://[::1]/metadata',
    'http://[::ffff:127.0.0.1]/metadata',
    'http://[fd00::1]/metadata',
  ])('blocks local or private network target %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const graph: FlowGraph = {
      nodes: [{ id: 'fetch-internal', key: 'http', options: { url } }],
    };

    const result = await runFlow(graph, {});

    expect(result.status).toBe('error');
    expect(result.error).toBe('http operation cannot target local or private network addresses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows public http(s) targets and preserves response body output', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: vi.fn().mockResolvedValue('public response'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const graph: FlowGraph = {
      nodes: [{ id: 'fetch-public', key: 'http', options: { url: 'https://example.com/api' } }],
    };

    const result = await runFlow(graph, {});

    expect(result).toEqual({
      status: 'success',
      steps: {
        'fetch-public': { status: 200, ok: true, body: 'public response' },
        previous: { status: 200, ok: true, body: 'public response' },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/api', expect.any(Object));
  });
});
