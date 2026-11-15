/**
 * Hand-built image containers for the metadata tests. Small, deterministic
 * and documented byte-for-byte, so a failing assertion points at the parser,
 * not at a binary fixture nobody can read.
 */

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function be16(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function be32(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function le32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes (big-endian); inlined when <= 4 bytes. */
  value: Uint8Array;
}

function ascii(tag: number, s: string): Entry {
  const v = enc.encode(`${s}\0`);
  return { tag, type: 2, count: v.length, value: v };
}

function short(tag: number, n: number): Entry {
  return { tag, type: 3, count: 1, value: concat(be16(n), new Uint8Array(2)) };
}

function long(tag: number, n: number): Entry {
  return { tag, type: 4, count: 1, value: be32(n) };
}

function rationals(tag: number, values: Array<[number, number]>): Entry {
  return { tag, type: 5, count: values.length, value: concat(...values.flatMap(([a, b]) => [be32(a), be32(b)])) };
}

/** Serialise one IFD at `offset` (relative to the TIFF header). */
function ifd(entries: Entry[], offset: number): Uint8Array {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const dirSize = 2 + sorted.length * 12 + 4;
  let dataOffset = offset + dirSize;
  const dir: Uint8Array[] = [be16(sorted.length)];
  const data: Uint8Array[] = [];
  for (const e of sorted) {
    let valueField: Uint8Array;
    if (e.value.length <= 4) {
      valueField = concat(e.value, new Uint8Array(4 - e.value.length));
    } else {
      valueField = be32(dataOffset);
      data.push(e.value);
      dataOffset += e.value.length;
    }
    dir.push(be16(e.tag), be16(e.type), be32(e.count), valueField);
  }
  dir.push(be32(0));
  return concat(...dir, ...data);
}

export const GPS = { lat: [[37, 1], [46, 1], [3000, 100]] as Array<[number, number]>, lon: [[122, 1], [25, 1], [0, 1]] as Array<[number, number]> };

/** Big-endian TIFF block: IFD0 (Make, Orientation, Copyright, GPS pointer) + GPS IFD. */
export function tiffBlock(opts: { gps?: boolean } = {}): Uint8Array {
  const header = concat(enc.encode('MM'), be16(42), be32(8));
  const ifd0Entries: Entry[] = [
    ascii(0x010f, 'LumiCam'),
    short(0x0112, 6),
    ascii(0x8298, '(c) Exif Owner'),
  ];
  // Size IFD0 first with a placeholder pointer so the GPS IFD offset is known.
  if (opts.gps) ifd0Entries.push(long(0x8825, 0));
  const ifd0Probe = ifd(ifd0Entries, 8);
  const gpsOffset = 8 + ifd0Probe.length;
  if (opts.gps) ifd0Entries[ifd0Entries.length - 1] = long(0x8825, gpsOffset);
  const ifd0 = ifd(ifd0Entries, 8);
  if (!opts.gps) return concat(header, ifd0);
  const gpsIfd = ifd(
    [
      ascii(0x0001, 'N'),
      rationals(0x0002, GPS.lat),
      ascii(0x0003, 'W'),
      rationals(0x0004, GPS.lon),
    ],
    gpsOffset,
  );
  return concat(header, ifd0, gpsIfd);
}

function iptcDataset(dataset: number, value: string): Uint8Array {
  const v = enc.encode(value);
  return concat(new Uint8Array([0x1c, 2, dataset]), be16(v.length), v);
}

export function iptcBlock(): Uint8Array {
  const iim = concat(
    iptcDataset(105, 'Harbour at dawn'),
    iptcDataset(25, 'harbour'),
    iptcDataset(25, 'sunrise'),
    iptcDataset(110, 'Lumi Photo Agency'),
    iptcDataset(116, '(c) IPTC Owner'),
    iptcDataset(80, 'Jane Photographer'),
    iptcDataset(120, 'Boats leaving the harbour'),
  );
  const pad = iim.length % 2 ? new Uint8Array(1) : new Uint8Array(0);
  // 8BIM, id 0x0404, empty pascal name (0x00 + pad byte), size, data.
  return concat(enc.encode('8BIM'), be16(0x0404), new Uint8Array([0, 0]), be32(iim.length), iim, pad);
}

export const XMP_WITH_GPS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" photoshop:Credit="XMP Credit" exif:GPSLatitude="37,46.5N">
<dc:subject><rdf:Bag><rdf:li>boats</rdf:li><rdf:li>harbour</rdf:li></rdf:Bag></dc:subject>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) XMP &amp; Co</rdf:li></rdf:Alt></dc:rights>
<exif:GPSLongitude>122,25.0W</exif:GPSLongitude>
</rdf:Description></rdf:RDF></x:xmpmeta>`;

function segment(marker: number, payload: Uint8Array): Uint8Array {
  return concat(new Uint8Array([0xff, marker]), be16(payload.length + 2), payload);
}

export function buildJpeg(opts: { gps?: boolean; iptc?: boolean; xmp?: string } = {}): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  parts.push(segment(0xe1, concat(enc.encode('Exif\0\0'), tiffBlock({ gps: opts.gps }))));
  if (opts.xmp) parts.push(segment(0xe1, concat(enc.encode('http://ns.adobe.com/xap/1.0/\0'), enc.encode(opts.xmp))));
  if (opts.iptc) parts.push(segment(0xed, concat(enc.encode('Photoshop 3.0\0'), iptcBlock())));
  // SOF0: precision 8, height 480, width 640, 1 component.
  parts.push(segment(0xc0, concat(new Uint8Array([8]), be16(480), be16(640), new Uint8Array([1, 1, 0x11, 0]))));
  parts.push(segment(0xda, new Uint8Array([1, 1, 0, 0, 0x3f, 0])));
  parts.push(new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xd9]));
  return concat(...parts);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const td = concat(enc.encode(type), data);
  return concat(be32(data.length), td, be32(crc32(td)));
}

export function buildPng(opts: { gps?: boolean } = {}): Uint8Array {
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', concat(be32(320), be32(200), new Uint8Array([8, 2, 0, 0, 0]))),
    pngChunk('eXIf', tiffBlock({ gps: opts.gps })),
    pngChunk('iTXt', concat(enc.encode('XML:com.adobe.xmp\0\0\0\0\0'), enc.encode(XMP_WITH_GPS))),
    pngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    pngChunk('IEND', new Uint8Array(0)),
  );
}

/** Verify every PNG chunk CRC — a stripper that forgets to fix one corrupts the image. */
export function pngCrcsValid(b: Uint8Array): boolean {
  let o = 8;
  while (o + 12 <= b.length) {
    const len = (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
    const td = b.subarray(o + 4, o + 8 + len);
    const stored = ((b[o + 8 + len]! << 24) | (b[o + 9 + len]! << 16) | (b[o + 10 + len]! << 8) | b[o + 11 + len]!) >>> 0;
    if (crc32(td) !== stored) return false;
    o += 12 + len;
  }
  return true;
}

export function buildWebp(opts: { gps?: boolean } = {}): Uint8Array {
  const chunk = (fourcc: string, data: Uint8Array) =>
    concat(enc.encode(fourcc), le32(data.length), data, data.length % 2 ? new Uint8Array(1) : new Uint8Array(0));
  // VP8X: flags (EXIF|XMP), reserved, canvas 800x600 (minus one, 24-bit LE).
  const vp8x = new Uint8Array([0x0c, 0, 0, 0, 0x1f, 0x03, 0x00, 0x57, 0x02, 0x00]);
  const body = concat(
    enc.encode('WEBP'),
    chunk('VP8X', vp8x),
    chunk('EXIF', tiffBlock({ gps: opts.gps })),
    chunk('XMP ', enc.encode(XMP_WITH_GPS)),
  );
  return concat(enc.encode('RIFF'), le32(body.length), body);
}
