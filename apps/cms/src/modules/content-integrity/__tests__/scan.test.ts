import { describe, expect, it } from 'vitest';
import { scanContent, siteKey } from '../scan';

/**
 * #989 — the scan looks for what FBI FLASH CC-111626-MW describes on
 * compromised sites: lure pages handing out a ZIP / JavaScript download, and
 * search signals pointing somewhere else. It must find them anywhere in the
 * content, and stay quiet on the site's own links.
 */
const SITE = { siteHosts: ['cms.acme.com'] };

describe('scanContent', () => {
  it('flags an off-site archive download in a plain field', () => {
    expect(scanContent({ body: 'Download the template: https://files.evil.example/contract-template.zip' }, SITE)).toEqual([
      { kind: 'download_link', field: 'body', host: 'files.evil.example', extension: 'zip' },
    ]);
  });

  it('finds links nested in rich text documents and HTML', () => {
    const doc = {
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'link', attrs: { href: 'https://x.example/get/Agreement.js' } }] }] }] },
      html: '<p><a href="https://cdn.other.example/a/setup.EXE?x=1">here</a></p>',
    };
    const kinds = scanContent(doc, SITE).map((s) => `${s.host}:${s.extension}`);
    expect(kinds).toEqual(expect.arrayContaining(['x.example:js', 'cdn.other.example:exe']));
  });

  it('ignores downloads on the site’s own registrable domain', () => {
    expect(scanContent({ body: 'https://www.acme.com/files/brochure.zip and https://assets.acme.com/app.js' }, SITE)).toEqual([]);
  });

  it('ignores ordinary links and documents', () => {
    expect(scanContent({ body: 'See https://wikipedia.org/wiki/Zoning and https://other.example/report.pdf' }, SITE)).toEqual([]);
  });

  it('flags a canonical or OG URL on another host', () => {
    const signals = scanContent({ seo: { canonical: 'https://spam.example/legal/zoning', og_url: 'https://www.acme.com/ok' } }, SITE);
    expect(signals).toEqual([{ kind: 'offsite_seo_url', field: 'seo.canonical', host: 'spam.example' }]);
  });

  it('does not judge SEO URLs when the site has no known hosts', () => {
    expect(scanContent({ canonical: 'https://anything.example/' }, { siteHosts: [] })).toEqual([]);
  });

  it('still flags downloads when the site has no known hosts', () => {
    expect(scanContent({ a: 'https://a.example/x.zip' }, { siteHosts: [] })).toHaveLength(1);
  });

  it('caps the number of signals and survives hostile input', () => {
    const many = Array.from({ length: 100 }, (_, i) => `https://h${i}.example/f.zip`).join(' ');
    expect(scanContent({ body: many }, SITE)).toHaveLength(20);
    let deep: unknown = 'https://deep.example/x.zip';
    for (let i = 0; i < 100; i++) deep = { n: deep };
    expect(() => scanContent(deep, SITE)).not.toThrow();
  });
});

describe('siteKey', () => {
  it.each([
    ['www.acme.com', 'acme.com'],
    ['cms.acme.com', 'acme.com'],
    ['acme.com', 'acme.com'],
    ['shop.acme.co.uk', 'acme.co.uk'],
    ['ACME.COM.', 'acme.com'],
  ])('%s → %s', (host, key) => {
    expect(siteKey(host)).toBe(key);
  });
});
