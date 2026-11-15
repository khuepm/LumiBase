/**
 * Embedded image metadata — extract EXIF / IPTC / XMP on upload and strip GPS
 * from public variants (#705).
 *
 * Pure byte parsing, no native dependency, so it runs the same on Cloudflare
 * Workers and Node. Every read is bounds-checked: a truncated or hostile file
 * yields less metadata, never an exception or an unbounded loop.
 *
 * Supported containers: JPEG (APP1 Exif, APP1 XMP, APP13 IPTC-IIM), PNG
 * (`eXIf`, `iTXt` XMP), WebP (`EXIF`, `XMP `), TIFF (the file is the IFD).
 *
 * GPS stripping rewrites in place and never changes the file's length or
 * structure: the GPS IFD is emptied (entry count 0, entries and their value
 * bytes zeroed) and GPS properties inside XMP packets are blanked with spaces.
 * Orientation, copyright and every other tag survive, so the image renders
 * exactly as before. PNG chunks get their CRC recomputed.
 */

export interface ExifSummary {
  make?: string;
  model?: string;
  lensModel?: string;
  software?: string;
  dateTimeOriginal?: string;
  orientation?: number;
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  focalLength?: number;
  artist?: string;
  copyright?: string;
  imageDescription?: string;
}

export interface GpsSummary {
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

export interface IptcSummary {
  objectName?: string;
  headline?: string;
  caption?: string;
  keywords?: string[];
  byline?: string[];
  credit?: string;
  source?: string;
  copyright?: string;
  city?: string;
  country?: string;
}

export interface XmpSummary {
  title?: string;
  description?: string;
  creator?: string[];
  subject?: string[];
  rights?: string;
  credit?: string;
  headline?: string;
  hasGps?: boolean;
}

/**
 * Normalised, searchable fields merged across the three sources. IPTC wins
 * over XMP wins over EXIF, matching the IPTC/MWG guidance that the
 * editorially-curated block is authoritative.
 */
export interface MetadataSummary {
  title?: string;
  description?: string;
  creator?: string;
  credit?: string;
  copyright?: string;
  keywords: string[];
}

export interface ExtractedMetadata {
  width?: number;
  height?: number;
  exif?: ExifSummary;
  gps?: GpsSummary;
  iptc?: IptcSummary;
  xmp?: XmpSummary;
  summary: MetadataSummary;
}

/** Upper bound on IFD entries read per directory (real files have < 100). */
const MAX_IFD_ENTRIES = 512;
/** Upper bound on container segments/chunks walked. */
const MAX_SEGMENTS = 4096;
/** Upper bound on string values copied out of a file. */
const MAX_STRING = 2000;
const MAX_LIST = 200;

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: false });

function clean(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  // eslint-disable-next-line no-control-regex
  const out = value.replace(/\u0000+$/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
  return out.length > 0 ? out.slice(0, MAX_STRING) : undefined;
}

function u16(b: Uint8Array, o: number, le: boolean): number {
  return le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!;
}

function u32(b: Uint8Array, o: number, le: boolean): number {
  return le
    ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000
    : b[o]! * 0x1000000 + ((b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!);
}

function i32(b: Uint8Array, o: number, le: boolean): number {
  const v = u32(b, o, le);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

function startsWith(b: Uint8Array, o: number, ascii: string): boolean {
  if (o + ascii.length > b.length) return false;
  for (let i = 0; i < ascii.length; i++) if (b[o + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// TIFF / EXIF
// ---------------------------------------------------------------------------

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Absolute offset (within the whole buffer) of the value bytes. */
  valueAt: number;
  byteLength: number;
  /** Absolute offset of the 12-byte directory entry. */
  entryAt: number;
}

interface TiffView {
  b: Uint8Array;
  base: number;
  end: number;
  le: boolean;
}

function openTiff(b: Uint8Array, base: number, end: number): TiffView | null {
  if (end - base < 8) return null;
  const le = b[base] === 0x49 && b[base + 1] === 0x49;
  const be = b[base] === 0x4d && b[base + 1] === 0x4d;
  if (!le && !be) return null;
  if (u16(b, base + 2, le) !== 42) return null;
  return { b, base, end, le };
}

function readIfd(t: TiffView, relOffset: number): { entries: IfdEntry[]; countAt: number } | null {
  const at = t.base + relOffset;
  if (relOffset < 8 || at + 2 > t.end) return null;
  const n = u16(t.b, at, t.le);
  if (n > MAX_IFD_ENTRIES || at + 2 + n * 12 > t.end) return null;
  const entries: IfdEntry[] = [];
  for (let i = 0; i < n; i++) {
    const e = at + 2 + i * 12;
    const tag = u16(t.b, e, t.le);
    const type = u16(t.b, e + 2, t.le);
    const count = u32(t.b, e + 4, t.le);
    const size = TYPE_SIZE[type];
    if (!size) continue;
    const byteLength = size * count;
    if (!Number.isFinite(byteLength) || byteLength > t.end - t.base) continue;
    const valueAt = byteLength <= 4 ? e + 8 : t.base + u32(t.b, e + 8, t.le);
    if (valueAt < t.base || valueAt + byteLength > t.end) continue;
    entries.push({ tag, type, count, valueAt, byteLength, entryAt: e });
  }
  return { entries, countAt: at };
}

function tiffFirstIfd(t: TiffView): number {
  return u32(t.b, t.base + 4, t.le);
}

function entryString(t: TiffView, e: IfdEntry): string | undefined {
  if (e.type !== 2 && e.type !== 7 && e.type !== 1) return undefined;
  return clean(utf8.decode(t.b.subarray(e.valueAt, e.valueAt + Math.min(e.byteLength, MAX_STRING * 4))));
}

function entryNumbers(t: TiffView, e: IfdEntry, max = 8): number[] {
  const out: number[] = [];
  const n = Math.min(e.count, max);
  for (let i = 0; i < n; i++) {
    switch (e.type) {
      case 1:
      case 7:
        out.push(t.b[e.valueAt + i]!);
        break;
      case 3:
        out.push(u16(t.b, e.valueAt + i * 2, t.le));
        break;
      case 4:
        out.push(u32(t.b, e.valueAt + i * 4, t.le));
        break;
      case 9:
        out.push(i32(t.b, e.valueAt + i * 4, t.le));
        break;
      case 5: {
        const num = u32(t.b, e.valueAt + i * 8, t.le);
        const den = u32(t.b, e.valueAt + i * 8 + 4, t.le);
        out.push(den === 0 ? 0 : num / den);
        break;
      }
      case 10: {
        const num = i32(t.b, e.valueAt + i * 8, t.le);
        const den = i32(t.b, e.valueAt + i * 8 + 4, t.le);
        out.push(den === 0 ? 0 : num / den);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

const TAG = {
  imageDescription: 0x010e,
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  software: 0x0131,
  artist: 0x013b,
  copyright: 0x8298,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  focalLength: 0x920a,
  pixelX: 0xa002,
  pixelY: 0xa003,
  lensModel: 0xa434,
  imageWidth: 0x0100,
  imageLength: 0x0101,
} as const;

function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function parseExif(t: TiffView): { exif?: ExifSummary; gps?: GpsSummary; width?: number; height?: number } {
  const ifd0 = readIfd(t, tiffFirstIfd(t));
  if (!ifd0) return {};
  const exif: ExifSummary = {};
  let width: number | undefined;
  let height: number | undefined;
  let exifPtr: number | undefined;
  let gpsPtr: number | undefined;
  for (const e of ifd0.entries) {
    switch (e.tag) {
      case TAG.imageDescription: exif.imageDescription = entryString(t, e); break;
      case TAG.make: exif.make = entryString(t, e); break;
      case TAG.model: exif.model = entryString(t, e); break;
      case TAG.software: exif.software = entryString(t, e); break;
      case TAG.artist: exif.artist = entryString(t, e); break;
      case TAG.copyright: exif.copyright = entryString(t, e); break;
      case TAG.orientation: exif.orientation = entryNumbers(t, e, 1)[0]; break;
      case TAG.imageWidth: width = entryNumbers(t, e, 1)[0]; break;
      case TAG.imageLength: height = entryNumbers(t, e, 1)[0]; break;
      case TAG.exifIfd: exifPtr = entryNumbers(t, e, 1)[0]; break;
      case TAG.gpsIfd: gpsPtr = entryNumbers(t, e, 1)[0]; break;
      default: break;
    }
  }
  if (exifPtr) {
    const sub = readIfd(t, exifPtr);
    for (const e of sub?.entries ?? []) {
      switch (e.tag) {
        case TAG.exposureTime: exif.exposureTime = round(entryNumbers(t, e, 1)[0] ?? 0); break;
        case TAG.fNumber: exif.fNumber = round(entryNumbers(t, e, 1)[0] ?? 0, 2); break;
        case TAG.iso: exif.iso = entryNumbers(t, e, 1)[0]; break;
        case TAG.focalLength: exif.focalLength = round(entryNumbers(t, e, 1)[0] ?? 0, 2); break;
        case TAG.dateTimeOriginal: exif.dateTimeOriginal = entryString(t, e); break;
        case TAG.lensModel: exif.lensModel = entryString(t, e); break;
        case TAG.pixelX: width = width ?? entryNumbers(t, e, 1)[0]; break;
        case TAG.pixelY: height = height ?? entryNumbers(t, e, 1)[0]; break;
        default: break;
      }
    }
  }
  let gps: GpsSummary | undefined;
  if (gpsPtr) {
    const g = readIfd(t, gpsPtr);
    if (g && g.entries.length > 0) {
      const by = new Map(g.entries.map((e) => [e.tag, e]));
      const ref = (tag: number) => {
        const e = by.get(tag);
        return e ? entryString(t, e) ?? String.fromCharCode(t.b[e.valueAt] ?? 0) : undefined;
      };
      const dms = (tag: number) => {
        const e = by.get(tag);
        if (!e) return undefined;
        const [d = 0, m = 0, s = 0] = entryNumbers(t, e, 3);
        return d + m / 60 + s / 3600;
      };
      gps = {};
      const lat = dms(0x0002);
      const lon = dms(0x0004);
      if (lat !== undefined) gps.latitude = round(ref(0x0001)?.startsWith('S') ? -lat : lat);
      if (lon !== undefined) gps.longitude = round(ref(0x0003)?.startsWith('W') ? -lon : lon);
      const altEntry = by.get(0x0006);
      if (altEntry) {
        const alt = entryNumbers(t, altEntry, 1)[0] ?? 0;
        const below = by.get(0x0005) ? t.b[by.get(0x0005)!.valueAt] === 1 : false;
        gps.altitude = round(below ? -alt : alt, 2);
      }
    }
  }
  const cleaned = Object.fromEntries(Object.entries(exif).filter(([, v]) => v !== undefined)) as ExifSummary;
  return {
    exif: Object.keys(cleaned).length > 0 ? cleaned : undefined,
    gps,
    width,
    height,
  };
}

/** Empty the GPS IFD of a TIFF block in place. Returns whether anything changed. */
function neutralizeTiffGps(t: TiffView): boolean {
  const ifd0 = readIfd(t, tiffFirstIfd(t));
  const ptrEntry = ifd0?.entries.find((e) => e.tag === TAG.gpsIfd);
  if (!ptrEntry) return false;
  const gpsPtr = entryNumbers(t, ptrEntry, 1)[0];
  if (!gpsPtr) return false;
  const g = readIfd(t, gpsPtr);
  if (!g) return false;
  const n = u16(t.b, g.countAt, t.le);
  if (n === 0) return false;
  for (const e of g.entries) {
    if (e.byteLength > 4) t.b.fill(0, e.valueAt, e.valueAt + e.byteLength);
  }
  t.b.fill(0, g.countAt + 2, g.countAt + 2 + n * 12);
  t.b[g.countAt] = 0;
  t.b[g.countAt + 1] = 0;
  return true;
}

// ---------------------------------------------------------------------------
// IPTC-IIM (Photoshop APP13 resource 0x0404)
// ---------------------------------------------------------------------------

function parseIptc(b: Uint8Array, start: number, end: number): IptcSummary | undefined {
  const out: IptcSummary = {};
  const push = (key: 'keywords' | 'byline', v: string | undefined) => {
    if (!v) return;
    const list = (out[key] ??= []);
    if (list.length < MAX_LIST) list.push(v);
  };
  let o = start;
  let guard = 0;
  while (o + 5 <= end && guard++ < MAX_SEGMENTS * 4) {
    if (b[o] !== 0x1c) {
      o++;
      continue;
    }
    const record = b[o + 1]!;
    const dataset = b[o + 2]!;
    let len = u16(b, o + 3, false);
    let dataAt = o + 5;
    if (len & 0x8000) {
      // Extended dataset: the low bits give the length-of-length.
      const lenOfLen = len & 0x7fff;
      if (lenOfLen > 4 || dataAt + lenOfLen > end) break;
      len = 0;
      for (let i = 0; i < lenOfLen; i++) len = len * 256 + b[dataAt + i]!;
      dataAt += lenOfLen;
    }
    if (dataAt + len > end) break;
    if (record === 2) {
      const v = clean(utf8.decode(b.subarray(dataAt, dataAt + Math.min(len, MAX_STRING * 4))));
      switch (dataset) {
        case 5: out.objectName = v; break;
        case 25: push('keywords', v); break;
        case 80: push('byline', v); break;
        case 90: out.city = v; break;
        case 101: out.country = v; break;
        case 105: out.headline = v; break;
        case 110: out.credit = v; break;
        case 115: out.source = v; break;
        case 116: out.copyright = v; break;
        case 120: out.caption = v; break;
        default: break;
      }
    }
    o = dataAt + len;
  }
  const cleaned = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as IptcSummary;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function parsePhotoshopResources(b: Uint8Array, start: number, end: number): IptcSummary | undefined {
  let o = start;
  let guard = 0;
  while (o + 12 <= end && guard++ < MAX_SEGMENTS) {
    if (!startsWith(b, o, '8BIM')) break;
    const id = u16(b, o + 4, false);
    const nameLen = b[o + 6]!;
    // Pascal string padded to an even total length (length byte included).
    let p = o + 6 + 1 + nameLen;
    if ((1 + nameLen) % 2 === 1) p++;
    if (p + 4 > end) break;
    const size = u32(b, p, false);
    const dataAt = p + 4;
    if (dataAt + size > end) break;
    if (id === 0x0404) return parseIptc(b, dataAt, dataAt + size);
    o = dataAt + size + (size % 2);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&amp;/g, '&');
}

function xmpList(xml: string, prop: string): string[] {
  const block = new RegExp(`<${prop}(?:\\s[^>]*)?>([\\s\\S]*?)</${prop}>`, 'i').exec(xml);
  if (block) {
    const items = [...block[1]!.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/gi)]
      .map((m) => clean(decodeEntities(m[1]!.replace(/<[^>]+>/g, ''))))
      .filter((v): v is string => !!v);
    if (items.length > 0) return items.slice(0, MAX_LIST);
    const text = clean(decodeEntities(block[1]!.replace(/<[^>]+>/g, '')));
    if (text) return [text];
  }
  const attr = new RegExp(`\\s${prop}="([^"]*)"`, 'i').exec(xml);
  const v = attr ? clean(decodeEntities(attr[1]!)) : undefined;
  return v ? [v] : [];
}

export function parseXmp(xml: string): XmpSummary | undefined {
  const out: XmpSummary = {};
  const one = (prop: string) => xmpList(xml, prop)[0];
  out.title = one('dc:title');
  out.description = one('dc:description');
  const creator = xmpList(xml, 'dc:creator');
  if (creator.length) out.creator = creator;
  const subject = xmpList(xml, 'dc:subject');
  if (subject.length) out.subject = subject;
  out.rights = one('dc:rights');
  out.credit = one('photoshop:Credit');
  out.headline = one('photoshop:Headline');
  if (/exif:GPS(?:Latitude|Longitude)/i.test(xml)) out.hasGps = true;
  const cleaned = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as XmpSummary;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/** Byte ranges of every `<x:xmpmeta …>…</x:xmpmeta>` packet in a buffer. */
function xmpPacketRanges(b: Uint8Array, start = 0, end = b.length): Array<[number, number]> {
  const text = latin1.decode(b.subarray(start, end));
  const ranges: Array<[number, number]> = [];
  const re = /<x:xmpmeta[\s>][\s\S]*?<\/x:xmpmeta>/g;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 64) ranges.push([start + m.index, start + m.index + m[0].length]);
  return ranges;
}

/**
 * Blank GPS properties inside XMP packets with spaces (same byte length).
 * Works on the latin1 view, which maps 1:1 onto bytes, so offsets line up;
 * every property name it touches is ASCII.
 */
function blankXmpGps(b: Uint8Array, start = 0, end = b.length): boolean {
  let changed = false;
  for (const [s, e] of xmpPacketRanges(b, start, end)) {
    const text = latin1.decode(b.subarray(s, e));
    const patterns = [
      /\sexif:GPS[A-Za-z]*="[^"]*"/g,
      /<exif:GPS([A-Za-z]*)(?:\s[^>]*)?>[\s\S]*?<\/exif:GPS\1>/g,
      /<exif:GPS[A-Za-z]*(?:\s[^>]*)?\/>/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        b.fill(0x20, s + m.index, s + m.index + m[0].length);
        changed = true;
      }
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

type Format = 'jpeg' | 'png' | 'webp' | 'tiff';

export function detectImageFormat(b: Uint8Array): Format | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (startsWith(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (startsWith(b, 0, 'RIFF') && startsWith(b, 8, 'WEBP')) return 'webp';
  if (startsWith(b, 0, 'II*\0') || startsWith(b, 0, 'MM\0*')) return 'tiff';
  return null;
}

interface Collected {
  tiffs: Array<[number, number]>;
  xmp: string[];
  iptc?: IptcSummary;
  width?: number;
  height?: number;
}

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

function walkJpeg(b: Uint8Array, out: Collected): void {
  let o = 2;
  let guard = 0;
  while (o + 4 <= b.length && guard++ < MAX_SEGMENTS) {
    if (b[o] !== 0xff) break;
    const marker = b[o + 1]!;
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
    if (marker >= 0xd0 && marker <= 0xd7) {
      o += 2;
      continue;
    }
    const len = u16(b, o + 2, false);
    const start = o + 4;
    const end = o + 2 + len;
    if (len < 2 || end > b.length) break;
    if (marker === 0xe1 && startsWith(b, start, EXIF_HEADER)) {
      out.tiffs.push([start + EXIF_HEADER.length, end]);
    } else if (marker === 0xe1 && startsWith(b, start, XMP_HEADER)) {
      out.xmp.push(utf8.decode(b.subarray(start + XMP_HEADER.length, end)));
    } else if (marker === 0xed && startsWith(b, start, 'Photoshop 3.0\0')) {
      out.iptc = parsePhotoshopResources(b, start + 14, end) ?? out.iptc;
    } else if (
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc &&
      end - start >= 5
    ) {
      out.height = u16(b, start + 1, false);
      out.width = u16(b, start + 3, false);
    }
    o = end;
  }
}

interface PngChunk {
  type: string;
  dataAt: number;
  length: number;
}

function pngChunks(b: Uint8Array): PngChunk[] {
  const chunks: PngChunk[] = [];
  let o = 8;
  let guard = 0;
  while (o + 12 <= b.length && guard++ < MAX_SEGMENTS) {
    const length = u32(b, o, false);
    const type = latin1.decode(b.subarray(o + 4, o + 8));
    if (o + 12 + length > b.length) break;
    chunks.push({ type, dataAt: o + 8, length });
    if (type === 'IEND') break;
    o += 12 + length;
  }
  return chunks;
}

function walkPng(b: Uint8Array, out: Collected): void {
  for (const c of pngChunks(b)) {
    if (c.type === 'IHDR' && c.length >= 8) {
      out.width = u32(b, c.dataAt, false);
      out.height = u32(b, c.dataAt + 4, false);
    } else if (c.type === 'eXIf') {
      out.tiffs.push([c.dataAt, c.dataAt + c.length]);
    } else if (c.type === 'iTXt' && startsWith(b, c.dataAt, 'XML:com.adobe.xmp\0')) {
      // keyword\0 compressionFlag compressionMethod language\0 translated\0 text
      let p = c.dataAt + 18;
      const compressed = b[p] === 1;
      p += 2;
      const end = c.dataAt + c.length;
      for (let skip = 0; skip < 2; skip++) {
        while (p < end && b[p] !== 0) p++;
        p++;
      }
      if (!compressed && p < end) out.xmp.push(utf8.decode(b.subarray(p, end)));
    }
  }
}

interface RiffChunk {
  fourcc: string;
  dataAt: number;
  length: number;
}

function riffChunks(b: Uint8Array): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let o = 12;
  let guard = 0;
  while (o + 8 <= b.length && guard++ < MAX_SEGMENTS) {
    const fourcc = latin1.decode(b.subarray(o, o + 4));
    const length = u32(b, o + 4, true);
    if (o + 8 + length > b.length) break;
    chunks.push({ fourcc, dataAt: o + 8, length });
    o += 8 + length + (length % 2);
  }
  return chunks;
}

function walkWebp(b: Uint8Array, out: Collected): void {
  for (const c of riffChunks(b)) {
    if (c.fourcc === 'VP8X' && c.length >= 10) {
      out.width = 1 + (b[c.dataAt + 4]! | (b[c.dataAt + 5]! << 8) | (b[c.dataAt + 6]! << 16));
      out.height = 1 + (b[c.dataAt + 7]! | (b[c.dataAt + 8]! << 8) | (b[c.dataAt + 9]! << 16));
    } else if (c.fourcc === 'VP8 ' && c.length >= 10 && out.width === undefined) {
      out.width = u16(b, c.dataAt + 6, true) & 0x3fff;
      out.height = u16(b, c.dataAt + 8, true) & 0x3fff;
    } else if (c.fourcc === 'VP8L' && c.length >= 5 && out.width === undefined) {
      const bits = u32(b, c.dataAt + 1, true);
      out.width = (bits & 0x3fff) + 1;
      out.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (c.fourcc === 'EXIF') {
      // Some writers keep the JPEG-style "Exif\0\0" prefix.
      const skip = startsWith(b, c.dataAt, EXIF_HEADER) ? EXIF_HEADER.length : 0;
      out.tiffs.push([c.dataAt + skip, c.dataAt + c.length]);
    } else if (c.fourcc === 'XMP ') {
      out.xmp.push(utf8.decode(b.subarray(c.dataAt, c.dataAt + c.length)));
    }
  }
}

function collect(b: Uint8Array, format: Format): Collected {
  const out: Collected = { tiffs: [], xmp: [] };
  switch (format) {
    case 'jpeg': walkJpeg(b, out); break;
    case 'png': walkPng(b, out); break;
    case 'webp': walkWebp(b, out); break;
    case 'tiff': {
      out.tiffs.push([0, b.length]);
      const x = xmpPacketRanges(b)[0];
      if (x) out.xmp.push(utf8.decode(b.subarray(x[0], x[1])));
      break;
    }
  }
  return out;
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((v) => v !== undefined && v !== null && (typeof v !== 'string' || v.length > 0));
}

function summarize(m: Omit<ExtractedMetadata, 'summary'>): MetadataSummary {
  const keywords = new Set<string>();
  for (const k of [...(m.iptc?.keywords ?? []), ...(m.xmp?.subject ?? [])]) {
    if (keywords.size < MAX_LIST) keywords.add(k);
  }
  const summary: MetadataSummary = { keywords: [...keywords] };
  const set = <K extends keyof MetadataSummary>(k: K, v: MetadataSummary[K] | undefined) => {
    if (v !== undefined) summary[k] = v;
  };
  set('title', firstDefined(m.iptc?.headline, m.iptc?.objectName, m.xmp?.title, m.xmp?.headline));
  set('description', firstDefined(m.iptc?.caption, m.xmp?.description, m.exif?.imageDescription));
  set('creator', firstDefined(m.iptc?.byline?.[0], m.xmp?.creator?.[0], m.exif?.artist));
  set('credit', firstDefined(m.iptc?.credit, m.xmp?.credit));
  set('copyright', firstDefined(m.iptc?.copyright, m.xmp?.rights, m.exif?.copyright));
  return summary;
}

/**
 * Extract embedded metadata. Returns `null` for anything that is not a
 * supported image container; never throws on malformed input.
 */
export function extractMediaMetadata(bytes: Uint8Array): ExtractedMetadata | null {
  const format = detectImageFormat(bytes);
  if (!format) return null;
  try {
    const c = collect(bytes, format);
    const result: Omit<ExtractedMetadata, 'summary'> = {};
    for (const [s, e] of c.tiffs) {
      const t = openTiff(bytes, s, e);
      if (!t) continue;
      const parsed = parseExif(t);
      if (parsed.exif) result.exif = { ...result.exif, ...parsed.exif };
      if (parsed.gps) result.gps = parsed.gps;
      if (format === 'tiff') {
        c.width ??= parsed.width;
        c.height ??= parsed.height;
      }
    }
    if (c.iptc) result.iptc = c.iptc;
    for (const xml of c.xmp) {
      const x = parseXmp(xml);
      if (x) result.xmp = { ...result.xmp, ...x };
    }
    if (c.width) result.width = c.width;
    if (c.height) result.height = c.height;
    return { ...result, summary: summarize(result) };
  } catch {
    return null;
  }
}

/** Whether the bytes carry any GPS position (EXIF GPS IFD or XMP GPS properties). */
export function hasGpsMetadata(bytes: Uint8Array): boolean {
  const m = extractMediaMetadata(bytes);
  return !!(m?.gps && Object.keys(m.gps).length > 0) || m?.xmp?.hasGps === true;
}

// --- PNG CRC-32 ------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function crc32(b: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ b[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU32be(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/**
 * Return a copy of `bytes` with every GPS position removed, or the input
 * itself (same reference) when there was nothing to strip or the format is
 * not one this module understands. Length and structure are preserved.
 */
export function stripGpsMetadata(bytes: Uint8Array): Uint8Array {
  const format = detectImageFormat(bytes);
  if (!format) return bytes;
  const out = new Uint8Array(bytes);
  let changed = false;
  try {
    if (format === 'png') {
      for (const c of pngChunks(out)) {
        let chunkChanged = false;
        if (c.type === 'eXIf') {
          const t = openTiff(out, c.dataAt, c.dataAt + c.length);
          if (t && neutralizeTiffGps(t)) chunkChanged = true;
        } else if (c.type === 'iTXt' && blankXmpGps(out, c.dataAt, c.dataAt + c.length)) {
          chunkChanged = true;
        }
        if (chunkChanged) {
          // CRC covers the chunk type + data.
          writeU32be(out, c.dataAt + c.length, crc32(out, c.dataAt - 4, c.dataAt + c.length));
          changed = true;
        }
      }
    } else {
      const c = collect(out, format);
      for (const [s, e] of c.tiffs) {
        const t = openTiff(out, s, e);
        if (t && neutralizeTiffGps(t)) changed = true;
      }
      if (blankXmpGps(out)) changed = true;
    }
  } catch {
    return bytes;
  }
  return changed ? out : bytes;
}

/**
 * Flatten the searchable fields into one lowercase string, stored on the file
 * row so the media library can match keywords, credit and copyright with a
 * single `ILIKE` without knowing the JSON shape.
 */
export function metadataSearchText(m: ExtractedMetadata | null | undefined): string {
  if (!m) return '';
  const s = m.summary;
  return [s.title, s.description, s.creator, s.credit, s.copyright, ...s.keywords]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' ')
    .toLowerCase()
    .slice(0, 8000);
}
