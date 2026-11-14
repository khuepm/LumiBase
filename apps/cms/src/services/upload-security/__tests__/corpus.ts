/**
 * Upload-security corpus (#740). Every fixture is GENERATED here — no binary
 * blobs are checked in. Legitimate files are real, decodable minimal files;
 * the attack corpus covers the classic polyglot / disguise families.
 */
import { deflateSync } from 'node:zlib';

const enc = new TextEncoder();

export function bytes(...parts: Array<Uint8Array | string | number[]>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u16le = (n: number) => [n & 0xff, (n >>> 8) & 0xff];

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typed = bytes(type, data);
  return bytes(u32be(data.length), typed, u32be(crc32(typed)));
}

/** A real, decodable 2x2 RGBA PNG; optional extra chunks before IEND. */
export function realPng(extraChunks: Uint8Array[] = []): Uint8Array<ArrayBuffer> {
  const ihdr = bytes(u32be(2), u32be(2), [8, 6, 0, 0, 0]);
  const raw = bytes([0, 255, 0, 0, 255, 0, 255, 0, 255], [0, 0, 0, 255, 255, 255, 255, 255, 255]);
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  );
}

export function pngTextChunk(keyword: string, text: string): Uint8Array<ArrayBuffer> {
  return pngChunk('tEXt', bytes(keyword, [0], text));
}

/** Minimal valid baseline JPEG (1x1, grey) — 125 bytes, encoded here as hex. */
export function realJpeg(): Uint8Array<ArrayBuffer> {
  const hex =
    'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbd3ffd9';
  return Uint8Array.from(hex.match(/../g)!.map((h) => Number.parseInt(h, 16)));
}

/** Real 1x1 GIF89a (43 bytes). */
export function realGif(): Uint8Array<ArrayBuffer> {
  return bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x21, 0xf9, 4, 1, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]);
}

/** Real 1x1 lossless WebP. */
export function realWebp(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'));
}

function box(type: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes(u32be(8 + payload.length), type, payload);
}

/** ISO-BMFF AVIF: `ftyp avif` + a `meta` box header (structure only). */
export function realAvif(): Uint8Array<ArrayBuffer> {
  return bytes(box('ftyp', bytes('avif', [0, 0, 0, 0], 'avifmif1miaf')), box('meta', new Uint8Array(24)));
}

/** ISO-BMFF MP4: `ftyp isom` + empty `moov` + small `mdat`. */
export function realMp4(): Uint8Array<ArrayBuffer> {
  return bytes(box('ftyp', bytes('isom', [0, 0, 2, 0], 'isomiso2avc1mp41')), box('moov', new Uint8Array(16)), box('mdat', new Uint8Array(64).fill(7)));
}

/** WebM: EBML header magic + DocType "webm". */
export function realWebm(): Uint8Array<ArrayBuffer> {
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], 'webm', new Uint8Array(32));
}

/** A real one-page PDF with a correct xref table. */
export function realPdf(extraCatalog = '', extraObjects: string[] = []): Uint8Array<ArrayBuffer> {
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${extraCatalog}>>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 35 >>\nstream\nBT /F1 12 Tf 20 100 Td (Hi) Tj ET\nendstream',
    ...extraObjects,
  ];
  let body = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((obj, idx) => {
    offsets.push(body.length);
    body += `${idx + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(body, (ch) => ch.charCodeAt(0));
}

/** PDF whose dictionaries live in a Flate-compressed object stream (PDF 1.5+). */
export function pdfWithObjStm(hiddenDict: string): Uint8Array<ArrayBuffer> {
  const inner = `5 0 ${hiddenDict}`;
  const compressed = new Uint8Array(deflateSync(enc.encode(inner)));
  const head = `6 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`;
  const base = realPdf();
  return bytes(base.subarray(0, base.length - 6), head, compressed, '\nendstream\nendobj\n%%EOF\n');
}

/** A ZIP/JAR with one stored entry, built from scratch. */
export function zipArchive(name = 'META-INF/MANIFEST.MF', content = 'Manifest-Version: 1.0\nMain-Class: Evil\n'): Uint8Array<ArrayBuffer> {
  const data = enc.encode(content);
  const fname = enc.encode(name);
  const crc = crc32(data);
  const local = bytes([0x50, 0x4b, 0x03, 0x04], u16le(10), u16le(0), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(data.length), u32le(data.length), u16le(fname.length), u16le(0), fname, data);
  const central = bytes([0x50, 0x4b, 0x01, 0x02], u16le(20), u16le(10), u16le(0), u16le(0), u16le(0), u16le(0), u32le(crc), u32le(data.length), u32le(data.length), u16le(fname.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0), u32le(0), fname);
  const eocd = bytes([0x50, 0x4b, 0x05, 0x06], u16le(0), u16le(0), u16le(1), u16le(1), u32le(central.length), u32le(local.length), u16le(0));
  return bytes(local, central, eocd);
}

/** Clean SVGs that must round-trip byte-identical. */
export const LEGIT_SVGS: Record<string, string> = {
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><path d="M12 2L2 22h20z" fill="currentColor"/></svg>',
  gradientAndUse:
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">\n  <defs>\n    <linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>\n    <symbol id="dot"><circle cx="5" cy="5" r="5"/></symbol>\n  </defs>\n  <rect width="100" height="100" fill="url(#g)"/>\n  <use xlink:href="#dot" x="10" y="10"/>\n  <use href="#dot" x="30" y="30"/>\n  <text x="10" y="90" style="font-family: sans-serif; fill: #333">Hello &amp; welcome</text>\n</svg>\n',
  inkscape:
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" width="10" height="10"><sodipodi:namedview id="nv" inkscape:zoom="1"/><metadata><rdf:RDF><dc:title>Logo</dc:title></rdf:RDF></metadata><!-- comment --><g inkscape:label="Layer 1" inkscape:groupmode="layer"><ellipse cx="5" cy="5" rx="4" ry="3"/></g></svg>',
  styledFilter:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:#0a0}.b{filter:url(#f)}</style><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle class="a b" cx="5" cy="5" r="3"/><image width="1" height="1" href="data:image/png;base64,iVBORw0KGgo="/></svg>',
  animated:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"><animate attributeName="opacity" values="0;1;0" dur="2s" repeatCount="indefinite"/></rect></svg>',
};

/** SVGs carrying ACTIVE content: must be rejected at upload. */
export const ACTIVE_SVGS: Record<string, string> = {
  script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  scriptCdata: '<svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[alert(1)]]></script><rect/></svg>',
  prefixedScript: '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>',
  onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>',
  onloadNoSpace: '<svg xmlns="http://www.w3.org/2000/svg"\nonload="alert(1)"/>',
  uppercaseHandler: '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK="alert(1)"/></svg>',
  javascriptHref: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><rect/></a></svg>',
  entityEncodedJs: '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6A;avascript&#x3A;alert(1)"><rect/></a></svg>',
  tabSplitJs: '<svg xmlns="http://www.w3.org/2000/svg"><a href="java&#9;script:alert(1)"><rect/></a></svg>',
  foreignObject: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject></svg>',
  xhtmlNamespace: '<svg xmlns="http://www.w3.org/2000/svg"><g><div xmlns="http://www.w3.org/1999/xhtml">x</div></g></svg>',
  setHref: '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="&#106;avascript:alert(1)"/><rect/></a></svg>',
  animateXlinkHref: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a><animate attributeName="xlink:href" values="https://ok;data:,x"/><rect/></a></svg>',
  xxe: '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>',
  billionLaughs: '<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>',
  xslStylesheet: '<?xml version="1.0"?><?xml-stylesheet type="text/xsl" href="evil.xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>',
  iframe: '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.example"/></svg>',
  embed: '<svg xmlns="http://www.w3.org/2000/svg"><embed src="evil.swf"/></svg>',
  cssExpression: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="width:expression(alert(1))"/></svg>',
  handlerElement: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://www.w3.org/2001/xml-events"><handler type="application/ecmascript">alert(1)</handler></svg>',
};

/** SVGs with only EXTERNAL references: accepted, but neutralised when served. */
export const EXTERNAL_SVGS: Record<string, string> = {
  trackingImage: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png" width="1" height="1"/><rect/></svg>',
  externalUse: '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/sprite.svg#x"/></svg>',
  cssImport: '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);</style><rect/></svg>',
  cssUrl: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/f.svg#p)"/></svg>',
  nestedSvgDataUrl: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>',
};
