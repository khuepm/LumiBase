import { describe, expect, it, vi } from 'vitest';
import { conversionsFor, experimentsFromHeaders, exposuresFor, sendExperimentEvents } from './experiments';

describe('experiment reporting (#763)', () => {
  it('parses X-Lumi-Experiments and drops malformed pairs', () => {
    const h = new Headers({ 'x-lumi-experiments': 'hero=b, cta=control,Bad=x,broken' });
    expect(experimentsFromHeaders(h)).toEqual([
      { key: 'hero', arm: 'b' },
      { key: 'cta', arm: 'control' },
    ]);
    expect(experimentsFromHeaders(new Headers())).toEqual([]);
  });

  it('sends nothing without an analytics grant', async () => {
    const fetch = vi.fn();
    expect(await sendExperimentEvents('denied', exposuresFor([{ key: 'hero', arm: 'b' }]), { cmsUrl: 'https://cms.example', siteId: 's1', fetch })).toBe(false);
    expect(await sendExperimentEvents(null, exposuresFor([{ key: 'hero', arm: 'b' }]), { cmsUrl: 'https://cms.example', siteId: 's1', fetch })).toBe(false);
    expect(await sendExperimentEvents('granted', [], { cmsUrl: 'https://cms.example', siteId: 's1', fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts exposures and conversions to the beacon with the consent header', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const arms = [{ key: 'hero', arm: 'b' }];
    const ok = await sendExperimentEvents('granted', [...exposuresFor(arms), ...conversionsFor(arms, 'signup')], { cmsUrl: 'https://cms.example/', siteId: 's 1', fetch });
    expect(ok).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://cms.example/api/v1/experiment-events/s%201');
    expect(init.headers['X-Lumi-Consent']).toBe('analytics');
    expect(JSON.parse(init.body)).toEqual({
      events: [
        { experiment: 'hero', arm: 'b', kind: 'exposure' },
        { experiment: 'hero', arm: 'b', kind: 'conversion', goal: 'signup' },
      ],
    });
    expect(await sendExperimentEvents('granted', exposuresFor(arms), { cmsUrl: 'x', siteId: 's', fetch: vi.fn().mockRejectedValue(new Error('offline')) })).toBe(false);
  });
});
