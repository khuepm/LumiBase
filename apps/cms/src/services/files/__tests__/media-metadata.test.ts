import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  extractMediaMetadata,
  hasGpsMetadata,
  metadataSearchText,
  parseXmp,
  stripGpsMetadata,
} from '../media-metadata';
import { XMP_WITH_GPS, buildJpeg, buildPng, buildWebp, pngCrcsValid, tiffBlock } from './fixtures';

describe('extractMediaMetadata', () => {
  it('reads EXIF, GPS, IPTC and XMP from a JPEG and merges a searchable summary', () => {
    const m = extractMediaMetadata(buildJpeg({ gps: true, iptc: true, xmp: XMP_WITH_GPS }));
    expect(m).not.toBeNull();
    expect(m!.width).toBe(640);
    expect(m!.height).toBe(480);
    expect(m!.exif).toMatchObject({ make: 'LumiCam', orientation: 6, copyright: '(c) Exif Owner' });
    expect(m!.gps!.latitude).toBeCloseTo(37 + 46 / 60 + 30 / 3600, 5);
    expect(m!.gps!.longitude).toBeCloseTo(-(122 + 25 / 60), 5);
    expect(m!.iptc).toMatchObject({
      headline: 'Harbour at dawn',
      keywords: ['harbour', 'sunrise'],
      credit: 'Lumi Photo Agency',
      copyright: '(c) IPTC Owner',
      byline: ['Jane Photographer'],
    });
    expect(m!.xmp).toMatchObject({ credit: 'XMP Credit', subject: ['boats', 'harbour'], rights: '(c) XMP & Co', hasGps: true });
    // IPTC wins over XMP wins over EXIF; keywords are the de-duplicated union.
    expect(m!.summary).toEqual({
      title: 'Harbour at dawn',
      description: 'Boats leaving the harbour',
      creator: 'Jane Photographer',
      credit: 'Lumi Photo Agency',
      copyright: '(c) IPTC Owner',
      keywords: ['harbour', 'sunrise', 'boats'],
    });
  });

  it('reads PNG (eXIf + iTXt XMP) and WebP (VP8X + EXIF + XMP)', () => {
    const png = extractMediaMetadata(buildPng({ gps: true }))!;
    expect(png).toMatchObject({ width: 320, height: 200, exif: { make: 'LumiCam' } });
    expect(png.summary.credit).toBe('XMP Credit');
    const webp = extractMediaMetadata(buildWebp({ gps: true }))!;
    expect(webp).toMatchObject({ width: 800, height: 600, exif: { orientation: 6 } });
    expect(webp.gps?.latitude).toBeGreaterThan(37);
  });

  it('returns null for non-images and survives any truncation of a real file', () => {
    expect(extractMediaMetadata(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    const jpeg = buildJpeg({ gps: true, iptc: true, xmp: XMP_WITH_GPS });
    for (let n = 0; n <= jpeg.length; n += 7) {
      expect(() => extractMediaMetadata(jpeg.subarray(0, n))).not.toThrow();
    }
  });

  it('never throws on arbitrary bytes behind a valid magic number (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), fc.constantFrom('jpeg', 'png', 'webp', 'tiff'), (tail, kind) => {
        const head =
          kind === 'jpeg'
            ? [0xff, 0xd8, 0xff]
            : kind === 'png'
              ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
              : kind === 'webp'
                ? [...'RIFF\0\0\0\0WEBP'].map((ch) => ch.charCodeAt(0))
                : [0x4d, 0x4d, 0x00, 0x2a];
        const bytes = new Uint8Array([...head, ...tail]);
        extractMediaMetadata(bytes);
        stripGpsMetadata(bytes);
      }),
      { numRuns: 300 },
    );
  });

  it('never returns markup from XMP values (nested tags, encoded brackets)', () => {
    const x = parseXmp(
      '<x:xmpmeta><dc:title><rdf:Alt><rdf:li>A<<script>script>alert(1)<</script>/script>B</rdf:li></rdf:Alt></dc:title>' +
        '<rdf:Description photoshop:Credit="&lt;img src=x onerror=alert(1)&gt;"/></x:xmpmeta>',
    )!;
    expect(x.title).not.toMatch(/[<>]/);
    // Entity-encoded markup decodes to a tag and is dropped with it.
    expect(x.credit).toBeUndefined();
    expect(x.title).toBe('Aalert(1)B');
  });

  it('flattens the summary into lowercase search text', () => {
    const text = metadataSearchText(extractMediaMetadata(buildJpeg({ iptc: true })));
    expect(text).toContain('lumi photo agency');
    expect(text).toContain('sunrise');
    expect(metadataSearchText(null)).toBe('');
  });
});

describe('stripGpsMetadata', () => {
  it.each([
    ['jpeg', () => buildJpeg({ gps: true, iptc: true, xmp: XMP_WITH_GPS })],
    ['png', () => buildPng({ gps: true })],
    ['webp', () => buildWebp({ gps: true })],
    ['tiff', () => tiffBlock({ gps: true })],
  ])('removes every GPS position from %s and keeps the rest', (_kind, build) => {
    const input = build();
    expect(hasGpsMetadata(input)).toBe(true);
    const before = extractMediaMetadata(input)!;
    const out = stripGpsMetadata(input);
    expect(out).not.toBe(input);
    expect(out.length).toBe(input.length);
    expect(hasGpsMetadata(out)).toBe(false);
    const after = extractMediaMetadata(out)!;
    // Orientation and copyright survive — the image still renders upright.
    expect(after.exif).toEqual(before.exif);
    expect(after.summary.copyright).toBe(before.summary.copyright);
    expect(after.width).toBe(before.width);
    // No coordinate bytes remain anywhere in the file.
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toMatch(/GPSLatitude|GPSLongitude|122,25/);
    // The input buffer was not mutated.
    expect(hasGpsMetadata(input)).toBe(true);
  });

  it('keeps PNG chunk CRCs valid after rewriting', () => {
    const out = stripGpsMetadata(buildPng({ gps: true }));
    expect(pngCrcsValid(out)).toBe(true);
  });

  it('returns the same reference when there is nothing to strip', () => {
    const clean = buildJpeg({ iptc: true });
    expect(stripGpsMetadata(clean)).toBe(clean);
    const text = new TextEncoder().encode('hello');
    expect(stripGpsMetadata(text)).toBe(text);
  });
});
