/**
 * Upload content sniffing (#740, epic #674 S11).
 *
 * Classifies an upload by its magic bytes — never by the client-declared MIME
 * type or the filename — and compares the result against what the client
 * declared. Pure, synchronous and allocation-light so it runs before the
 * storage write on both runtimes (Workers + Node). No Node-only APIs.
 *
 * This is a structural check, not a malware scanner. The serving layer
 * (`./serve-policy.ts`) contains anything it misses.
 */

/** What the bytes actually are, as far as the sniffer can tell. */
export type SniffedKind =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'mp4'
  | 'webm'
  | 'pdf'
  | 'zip'
  | 'executable'
  | 'html'
  | 'svg'
  | 'xml'
  | 'php'
  | 'text'
  | 'unknown';

/** Kinds that must never be stored under a different declared type. */
export const DANGEROUS_KINDS: ReadonlySet<SniffedKind> = new Set(['executable', 'html', 'svg', 'php']);

/** Declared MIME → the one kind its bytes must sniff as. */
const EXPECTED_KIND: Readonly<Record<string, SniffedKind>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'image/svg+xml': 'svg',
};

/** Declared MIME types whose content is free-form text. */
const TEXT_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/csv']);

/** `ftyp` major/compatible brands that mark an AVIF still or sequence. */
const AVIF_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis']);
/** ISO-BMFF brands that are still images, never `video/mp4`. */
const STILL_IMAGE_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'mif1', 'msf1']);

// Openings that make a text payload an active document if a browser renders it.
const HTML_OPENINGS = [
  '<!doctype html',
  '<html',
  '<head',
  '<body',
  '<script',
  '<iframe',
  '<meta',
  '<link',
  '<style',
  '<object',
  '<embed',
  '<form',
  '<img',
  '<a ',
  '<div',
  '<table',
  '<title',
  '<base',
] as const;

/**
 * Classify bytes by signature. Binary signatures are checked first; markup is
 * recognised after skipping a UTF-8 BOM and leading whitespace.
 */
export function sniffContentKind(bytes: Uint8Array): SniffedKind {
  if (bytes.length === 0) return 'unknown';
  if (hasExecutableSignature(bytes)) return 'executable';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'webp';
  if (asciiAt(bytes, 4, 'ftyp')) {
    const brands = ftypBrands(bytes);
    if (brands.some((b) => AVIF_BRANDS.has(b))) return 'avif';
    if (brands.length > 0 && !STILL_IMAGE_BRANDS.has(brands[0]!)) return 'mp4';
    return 'unknown';
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (asciiAt(bytes, 0, '%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';

  const head = markupHead(bytes);
  if (head.startsWith('<?php') || head.startsWith('<?=')) return 'php';
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  if (head.startsWith('<!doctype svg')) return 'svg';
  if (HTML_OPENINGS.some((opening) => head.startsWith(opening))) return 'html';
  if (head.startsWith('<?xml')) return 'xml';
  if (looksLikeText(bytes)) return 'text';
  return 'unknown';
}

/** Result of comparing the sniffed kind with what the client declared. */
export type SniffVerdict =
  | { ok: true; kind: SniffedKind }
  | { ok: false; kind: SniffedKind; reason: 'empty' | 'executable' | 'content_mime_mismatch' | 'dangerous_disguised' };

/**
 * Compare the sniffed kind with the declared (normalised) MIME type.
 *
 *  - catalogued binary/SVG types: the bytes must sniff as exactly that type;
 *  - text types: the bytes must be text, not HTML/SVG/PHP dressed as text;
 *  - any other type an operator allowed via env: accepted unless the bytes are
 *    an executable or an active document (HTML/SVG/PHP) disguised as it.
 */
export function compareDeclaredMime(bytes: Uint8Array, mime: string | undefined): SniffVerdict {
  const kind = sniffContentKind(bytes);
  if (!mime || bytes.length === 0) return { ok: false, kind, reason: 'empty' };
  if (kind === 'executable') return { ok: false, kind, reason: 'executable' };

  const expected = EXPECTED_KIND[mime];
  if (expected) {
    return kind === expected ? { ok: true, kind } : { ok: false, kind, reason: 'content_mime_mismatch' };
  }
  if (TEXT_MIMES.has(mime)) {
    return kind === 'text' || kind === 'xml'
      ? { ok: true, kind }
      : { ok: false, kind, reason: DANGEROUS_KINDS.has(kind) ? 'dangerous_disguised' : 'content_mime_mismatch' };
  }
  // Operator-allowed, uncatalogued type: an explicitly declared HTML upload is
  // the operator's call (it is still served as a sandboxed download); anything
  // else must not be an active document in disguise.
  if (kind === 'html' && (mime === 'text/html' || mime === 'application/xhtml+xml')) return { ok: true, kind };
  if (DANGEROUS_KINDS.has(kind)) return { ok: false, kind, reason: 'dangerous_disguised' };
  return { ok: true, kind };
}

// ---------------------------------------------------------------------------
// Polyglot detection
// ---------------------------------------------------------------------------

/** Why an otherwise-valid file was refused as a polyglot. */
export type PolyglotReason =
  | 'embedded_payload' // markup / PHP / script opening inside opaque binary
  | 'appended_archive' // ZIP / JAR (GIFAR) central directory appended
  | 'embedded_pdf' // a PDF header inside the first KiB of a non-PDF
  | 'trailing_data' // bytes after the PNG IEND chunk
  | 'pdf_active_content'; // PDF JavaScript / launch / rich-media actions

/** Raster image types whose bytes are opaque binary — no markup should appear. */
export const RASTER_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const VIDEO_MIMES: ReadonlySet<string> = new Set(['video/mp4', 'video/webm']);

// Openings that turn a valid binary into a functional polyglot. None occur as
// literal ASCII in legitimate raster/video data at any meaningful probability
// (each is >= 5 bytes, matched case-insensitively).
const EMBEDDED_PAYLOAD_MARKERS = ['<?php', '<script', '<html', '<!doctype html', '<iframe', '<body', 'javascript:'] as const;

/** Case-insensitive scan of raw image bytes for an embedded active payload. */
export function imageHasEmbeddedActivePayload(bytes: Uint8Array): boolean {
  return EMBEDDED_PAYLOAD_MARKERS.some((marker) => bytesContainAsciiCI(bytes, marker));
}

/**
 * Detect a ZIP/JAR end-of-central-directory record in the tail of the file
 * whose central directory really exists — the structure a ZIP/JAR reader
 * (e.g. the Java runtime for a GIFAR) locates from the END of the file. Four
 * consistent structural fields make a chance match in compressed image data
 * vanishingly unlikely.
 */
export function hasAppendedZipArchive(bytes: Uint8Array): boolean {
  const minEocd = 22;
  if (bytes.length < minEocd + 46) return false;
  const lowest = Math.max(0, bytes.length - (minEocd + 0xffff));
  for (let i = bytes.length - minEocd; i >= lowest; i--) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b || bytes[i + 2] !== 0x05 || bytes[i + 3] !== 0x06) continue;
    const entries = u16le(bytes, i + 10);
    const cdSize = u32le(bytes, i + 12);
    const cdOffset = u32le(bytes, i + 16);
    if (entries === 0 || cdSize < 46 || cdSize > i) continue;
    // Self-extracting / appended archives store offsets relative to the start
    // of the archive, which sits somewhere before the central directory; accept
    // either an absolute offset or one relative to `i - cdSize`.
    const cdStart = i - cdSize;
    const candidates = [cdOffset, cdStart];
    if (candidates.some((at) => at >= 0 && at + 4 <= i && isCentralDirHeader(bytes, at))) return true;
  }
  return false;
}

/** A `%PDF-` header inside the first KiB (where PDF readers look for one). */
export function hasEmbeddedPdfHeader(bytes: Uint8Array): boolean {
  return bytesContainAsciiCI(bytes.subarray(0, Math.min(bytes.length, 1024 + 5)), '%pdf-');
}

/**
 * Bytes after a PNG's IEND chunk. Walks the chunk list; an unparseable chunk
 * list returns false (a decoder problem, not a polyglot signal).
 */
export function pngHasTrailingData(bytes: Uint8Array): boolean {
  let pos = 8;
  while (pos + 12 <= bytes.length) {
    const length = u32be(bytes, pos);
    const end = pos + 12 + length;
    if (end > bytes.length) return false;
    if (asciiAt(bytes, pos + 4, 'IEND')) return end < bytes.length;
    pos = end;
  }
  return false;
}

/** Budget for inflating PDF object streams while looking for hidden actions. */
const PDF_SCAN_LIMITS = { maxStreams: 256, maxBytesPerStream: 4 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 };

/**
 * Detect PDF features that execute or launch something when the document is
 * opened: `/JavaScript` / `/JS` actions, `/Launch`, `/RichMedia` (Flash), and
 * `javascript:` URI actions. Names are normalised for `#xx` hex escapes
 * (`/J#61vaScript`), and compressed object streams (`/Type /ObjStm`, where a
 * PDF 1.5+ writer can hide dictionaries) are inflated within a fixed budget
 * using the platform `DecompressionStream`.
 */
export async function pdfHasActiveContent(bytes: Uint8Array): Promise<boolean> {
  const raw = latin1(bytes);
  if (pdfTextHasActiveContent(raw)) return true;

  let streams = 0;
  let totalInflated = 0;
  const streamRe = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = streamRe.exec(raw)) !== null) {
    if (streams >= PDF_SCAN_LIMITS.maxStreams || totalInflated >= PDF_SCAN_LIMITS.maxTotalBytes) break;
    // `endstream` also contains `stream`; skip those occurrences.
    if (raw.slice(Math.max(0, match.index - 3), match.index) === 'end') continue;
    const dictStart = raw.lastIndexOf('obj', match.index);
    const dict = normalisePdfNames(raw.slice(dictStart < 0 ? Math.max(0, match.index - 1024) : dictStart, match.index));
    if (!/\/Type\s*\/ObjStm/.test(dict) || !/\/FlateDecode/.test(dict)) continue;
    const dataStart = match.index + match[0].length;
    let dataEnd = raw.indexOf('endstream', dataStart);
    if (dataEnd < 0) break;
    streamRe.lastIndex = dataEnd;
    // The EOL before `endstream` is not part of the stream data.
    while (dataEnd > dataStart && (raw[dataEnd - 1] === '\n' || raw[dataEnd - 1] === '\r')) dataEnd--;
    streams++;
    const inflated = await inflateBounded(bytes.subarray(dataStart, dataEnd), PDF_SCAN_LIMITS.maxBytesPerStream);
    if (!inflated) continue;
    totalInflated += inflated.length;
    if (pdfTextHasActiveContent(latin1(inflated))) return true;
  }
  return false;
}

function pdfTextHasActiveContent(text: string): boolean {
  const normalised = normalisePdfNames(text);
  return (
    /\/(?:JavaScript|JS|Launch|RichMedia)(?![A-Za-z0-9])/.test(normalised) ||
    /\/URI\s*\(\s*javascript:/i.test(normalised)
  );
}

/** Decode `#xx` hex escapes inside PDF names (`/J#61vaScript` → `/JavaScript`). */
function normalisePdfNames(text: string): string {
  return text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * zlib-inflate at most `limit` bytes. Whatever inflated before a stream error
 * (e.g. trailing junk after the deflate end, which real PDFs carry) is still
 * returned; null only when nothing inflated at all.
 */
async function inflateBounded(data: Uint8Array, limit: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch {
    // Keep the partial output collected so far.
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Run every polyglot check that applies to the declared type. Returns the
 * first reason found, or null when the file is clean. Only runs after
 * `compareDeclaredMime` accepted the bytes.
 */
export async function detectPolyglot(bytes: Uint8Array, mime: string): Promise<PolyglotReason | null> {
  const opaqueBinary = RASTER_IMAGE_MIMES.has(mime) || VIDEO_MIMES.has(mime);
  if (opaqueBinary && imageHasEmbeddedActivePayload(bytes)) return 'embedded_payload';
  if ((opaqueBinary || mime === 'application/pdf') && hasAppendedZipArchive(bytes)) return 'appended_archive';
  if (opaqueBinary && hasEmbeddedPdfHeader(bytes)) return 'embedded_pdf';
  if (mime === 'image/png' && pngHasTrailingData(bytes)) return 'trailing_data';
  if (mime === 'application/pdf' && (await pdfHasActiveContent(bytes))) return 'pdf_active_content';
  return null;
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

export function hasExecutableSignature(bytes: Uint8Array): boolean {
  return (
    asciiAt(bytes, 0, 'MZ') || // PE / DOS
    startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O fat / Java class
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O
    asciiAt(bytes, 0, '#!') // shebang script
  );
}

function ftypBrands(bytes: Uint8Array): string[] {
  const boxSize = u32be(bytes, 0);
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16, 256);
  const brands: string[] = [];
  if (bytes.length < 12) return brands;
  brands.push(ascii(bytes, 8, 4));
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(bytes, at, 4));
  return brands;
}

function markupHead(bytes: Uint8Array): string {
  let start = 0;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) start = 3;
  let text = '';
  const limit = Math.min(bytes.length, start + 1024);
  for (let i = start; i < limit; i++) text += String.fromCharCode(bytes[i]!);
  return text.trimStart().toLowerCase();
}

export function looksLikeText(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i]!;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

function isCentralDirHeader(bytes: Uint8Array, at: number): boolean {
  return bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 0x01 && bytes[at + 3] === 0x02;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

export function asciiAt(bytes: Uint8Array, offset: number, signature: string): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u32le(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24)) >>> 0;
}

function u32be(bytes: Uint8Array, at: number): number {
  return (((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)) >>> 0;
}

function latin1(bytes: Uint8Array): string {
  // `latin1` is a WHATWG encoding label (windows-1252) on Workers and Node;
  // every byte maps to one UTF-16 unit, so offsets line up with `bytes`.
  return new TextDecoder('latin1').decode(bytes);
}

/**
 * Case-insensitive search for a lowercase ASCII needle in raw bytes, compared
 * byte-by-byte (no full-buffer string allocation).
 */
export function bytesContainAsciiCI(bytes: Uint8Array, needle: string): boolean {
  const n = needle.length;
  if (n === 0 || bytes.length < n) return false;
  const first = needle.charCodeAt(0);
  const firstUpper = toUpperAsciiCode(first);
  for (let i = 0; i <= bytes.length - n; i++) {
    const b = bytes[i]!;
    if (b !== first && b !== firstUpper) continue;
    let matched = true;
    for (let j = 1; j < n; j++) {
      const nc = needle.charCodeAt(j);
      const bc = bytes[i + j]!;
      if (bc !== nc && bc !== toUpperAsciiCode(nc)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function toUpperAsciiCode(code: number): number {
  return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}
