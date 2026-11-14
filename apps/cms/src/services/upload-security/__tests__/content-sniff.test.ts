import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareDeclaredMime,
  detectPolyglot,
  hasAppendedZipArchive,
  pdfHasActiveContent,
  pngHasTrailingData,
  sniffContentKind,
} from '../content-sniff';
import {
  bytes,
  pdfWithObjStm,
  pngTextChunk,
  realAvif,
  realGif,
  realJpeg,
  realMp4,
  realPdf,
  realPng,
  realWebm,
  realWebp,
  zipArchive,
} from './corpus';

const LEGIT: Array<[string, string, () => Uint8Array]> = [
  ['PNG', 'image/png', realPng],
  ['JPEG', 'image/jpeg', realJpeg],
  ['GIF', 'image/gif', realGif],
  ['WebP', 'image/webp', realWebp],
  ['AVIF', 'image/avif', realAvif],
  ['MP4', 'video/mp4', realMp4],
  ['WebM', 'video/webm', realWebm],
  ['PDF', 'application/pdf', () => realPdf()],
  ['PDF with compressed object stream', 'application/pdf', () => pdfWithObjStm('<< /Type /Annot /Subtype /Link >>')],
  ['PDF with a benign OpenAction', 'application/pdf', () => realPdf('/OpenAction [3 0 R /Fit] ')],
];

describe('legitimate uploads are accepted unchanged', () => {
  it.each(LEGIT)('%s sniffs as its declared type and carries no polyglot finding', async (_label, mime, make) => {
    const file = make();
    const before = Uint8Array.from(file);
    expect(compareDeclaredMime(file, mime)).toMatchObject({ ok: true });
    expect(await detectPolyglot(file, mime)).toBeNull();
    // The checks are read-only: the bytes handed to storage are the bytes uploaded.
    expect(file).toEqual(before);
  });

  it('accepts plain text and CSV as text', () => {
    expect(compareDeclaredMime(bytes('name,email\nA,a@example.test\n'), 'text/csv')).toMatchObject({ ok: true });
    expect(compareDeclaredMime(bytes('# Notes\n\nPlain markdown.\n'), 'text/plain')).toMatchObject({ ok: true });
  });

  it('accepts a PNG with ordinary text metadata chunks', async () => {
    const png = realPng([pngTextChunk('Comment', 'Created with GIMP <info@example.test>')]);
    expect(await detectPolyglot(png, 'image/png')).toBeNull();
  });

  it('property: random payloads behind real image headers never trip the archive / trailing detectors', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 4096 }), (noise) => {
        const png = realPng([bytesChunk(noise)]);
        expect(hasAppendedZipArchive(png)).toBe(false);
        expect(pngHasTrailingData(png)).toBe(false);
        expect(hasAppendedZipArchive(bytes(realJpeg(), noise))).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});

describe('MIME sniffing vs declared type', () => {
  it.each([
    ['HTML declared as PNG', bytes('<!DOCTYPE html><script>alert(1)</script>'), 'image/png'],
    ['HTML with BOM + whitespace declared as JPEG', bytes([0xef, 0xbb, 0xbf], '  \n<html><body>x</body></html>'), 'image/jpeg'],
    ['SVG declared as PNG', bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
    ['JavaScript declared as GIF', bytes('alert(document.cookie)'), 'image/gif'],
    ['PE executable declared as PDF', bytes('MZ', [0x90, 0, 3, 0]), 'application/pdf'],
    ['ELF declared as WebP', bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), 'image/webp'],
    ['Mach-O declared as AVIF', bytes([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), 'image/avif'],
    ['shell script declared as text', bytes('#!/bin/sh\nrm -rf /\n'), 'text/plain'],
    ['HTML declared as text', bytes('<html><script>alert(1)</script></html>'), 'text/plain'],
    ['PHP declared as CSV', bytes('<?php system($_GET[0]);'), 'text/csv'],
    ['ZIP declared as PNG', zipArchive(), 'image/png'],
    ['PNG declared as JPEG', realPng(), 'image/jpeg'],
    ['AVIF declared as MP4', realAvif(), 'video/mp4'],
    ['MP4 declared as AVIF', realMp4(), 'image/avif'],
  ])('rejects %s', (_label, file, mime) => {
    expect(compareDeclaredMime(file, mime).ok).toBe(false);
  });

  it('rejects an active document disguised as an operator-allowed, uncatalogued type', () => {
    expect(compareDeclaredMime(bytes('<html><script>x</script>'), 'application/zip')).toMatchObject({
      ok: false,
      reason: 'dangerous_disguised',
    });
    expect(compareDeclaredMime(zipArchive(), 'application/zip')).toMatchObject({ ok: true });
  });

  it('classifies the common signatures', () => {
    expect(sniffContentKind(realPng())).toBe('png');
    expect(sniffContentKind(realJpeg())).toBe('jpeg');
    expect(sniffContentKind(realGif())).toBe('gif');
    expect(sniffContentKind(realWebp())).toBe('webp');
    expect(sniffContentKind(realAvif())).toBe('avif');
    expect(sniffContentKind(realMp4())).toBe('mp4');
    expect(sniffContentKind(realWebm())).toBe('webm');
    expect(sniffContentKind(realPdf())).toBe('pdf');
    expect(sniffContentKind(zipArchive())).toBe('zip');
    expect(sniffContentKind(bytes('<?php echo 1;'))).toBe('php');
    expect(sniffContentKind(new Uint8Array())).toBe('unknown');
  });
});

describe('polyglot corpus is rejected', () => {
  it('GIFAR: GIF with a JAR appended', async () => {
    expect(await detectPolyglot(bytes(realGif(), zipArchive()), 'image/gif')).toBe('appended_archive');
  });

  it('JPEG and WebP with a ZIP appended', async () => {
    expect(await detectPolyglot(bytes(realJpeg(), zipArchive('payload.html', '<b>x</b>')), 'image/jpeg')).toBe(
      'appended_archive',
    );
    expect(await detectPolyglot(bytes(realWebp(), zipArchive()), 'image/webp')).toBe('appended_archive');
  });

  it('ZIP appended to a PNG (after IEND) and to a PDF', async () => {
    expect(await detectPolyglot(bytes(realPng(), zipArchive()), 'image/png')).not.toBeNull();
    expect(await detectPolyglot(bytes(realPdf(), zipArchive()), 'application/pdf')).toBe('appended_archive');
  });

  it('ZIP with a trailing archive comment is still found', async () => {
    const zip = zipArchive();
    // Patch the EOCD comment length and append a comment.
    zip[zip.length - 2] = 5;
    expect(hasAppendedZipArchive(bytes(realGif(), zip, 'hello'))).toBe(true);
  });

  it('HTML-in-PNG: script inside a tEXt chunk', async () => {
    const png = realPng([pngTextChunk('Comment', '<script>alert(document.domain)</script>')]);
    expect(compareDeclaredMime(png, 'image/png')).toMatchObject({ ok: true });
    expect(await detectPolyglot(png, 'image/png')).toBe('embedded_payload');
  });

  it('HTML / PHP appended to GIF and MP4', async () => {
    expect(await detectPolyglot(bytes(realGif(), '<?php system($_GET["c"]); ?>'), 'image/gif')).toBe('embedded_payload');
    expect(await detectPolyglot(bytes(realMp4(), '<html><body onload=alert(1)>'), 'video/mp4')).toBe('embedded_payload');
  });

  it('data after the PNG IEND chunk', async () => {
    expect(await detectPolyglot(bytes(realPng(), 'trailing bytes'), 'image/png')).toBe('trailing_data');
  });

  it('a PDF header hidden in the first KiB of an image', async () => {
    const gif = bytes(realGif().subarray(0, 13), '%PDF-1.4 1 0 obj', realGif().subarray(13));
    expect(await detectPolyglot(gif, 'image/gif')).toBe('embedded_pdf');
  });

  it.each([
    ['OpenAction JavaScript', realPdf('/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >> ')],
    ['hex-escaped /J#61vaScript name', realPdf('/OpenAction << /S /J#61vaScript /J#53 (app.alert\\(1\\)) >> ')],
    ['Launch action', realPdf('/OpenAction << /S /Launch /F (cmd.exe) >> ')],
    ['javascript: URI action', realPdf('/OpenAction << /S /URI /URI (javascript:alert\\(1\\)) >> ')],
    ['RichMedia annotation', realPdf('', ['<< /Type /Annot /Subtype /RichMedia >>'])],
    ['JavaScript hidden in a Flate object stream', pdfWithObjStm('<< /S /JavaScript /JS (app.alert\\(1\\)) >>')],
    ['name tree JavaScript', realPdf('/Names << /JavaScript 5 0 R >> ')],
  ])('PDF-with-JS: %s', async (_label, pdf) => {
    expect(compareDeclaredMime(pdf, 'application/pdf')).toMatchObject({ ok: true });
    expect(await pdfHasActiveContent(pdf)).toBe(true);
    expect(await detectPolyglot(pdf, 'application/pdf')).toBe('pdf_active_content');
  });

  it('does not mistake look-alike PDF names for actions', async () => {
    expect(await pdfHasActiveContent(realPdf('/JSONData 1 /JBIG2Globals 2 '))).toBe(false);
  });
});

function bytesChunk(noise: Uint8Array): Uint8Array {
  // Wrap noise in a private ancillary PNG chunk so the file stays well-formed.
  const type = new TextEncoder().encode('prVt');
  const len = noise.length;
  return bytes([(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff], type, noise, [0, 0, 0, 0]);
}
