---
version: 4
sourceLang: en
lastUpdated: 2026-11-20T06:00:17.786Z
contentHash: f9f1da0558c36442
codeVerified: 2026-11-20T06:00:17.786Z
codeVerifiedHash: f9f1da0558c36442
codeVerifiedClaims: 16
---

# Upload security: MIME sniffing, SVG sanitising and polyglots

> **Audience:** operators and integrators who accept files into LumiBase, and
> reviewers auditing the upload path.
>
> **TL;DR:** LumiBase never trusts the declared `Content-Type` or the filename.
> Every raw-byte upload is classified by its magic bytes, compared with what the
> client declared, scanned for a second hidden format (polyglot), and — for SVG —
> checked for script. On the way out, only passive images and video render
> inline; everything else is a sandboxed download. Legitimate files are stored
> and served byte-for-byte unchanged.

Context: the 2026 Strapi MIME-validation bypass (CVE-2026-22707) is the class of
bug this page closes. Tracking: issue #740, epic #674 (S11). Feature spec:
`.kiro/specs/upload-file-controls/`.

## Where the checks run

All checks live in the `withFileUploadPolicy` guard
(`apps/cms/src/middleware/file-upload-policy.ts`), mounted on the API chain in
`apps/cms/src/index.ts`, so they run **before** any route handler writes to
storage, on both runtimes (Cloudflare Workers and Docker/Node). The guarded
surfaces are:

| Surface | What it carries | Checks |
|---|---|---|
| `POST /api/v1/files` | file metadata (JSON) | public block, MIME allowlist, filename hygiene, extension ↔ MIME |
| `PUT /api/v1/files/upload/:key` | raw bytes, presigned (JWT) | MIME allowlist, filename, true size, sniffing, polyglot scan |
| `POST /api/v1/media/:key` | raw bytes (RBAC) | public block + everything above |
| `PUT /api/v1/files/:id/content` | raw bytes, in-place replace (RBAC `files:update`) | public block, MIME allowlist, `?filename=` hygiene, true size, sniffing, polyglot scan |

The presigned upload is **not** direct-to-storage: the bytes still stream
through the CMS receiver, so the guard sees the whole file before
`storage.put`. `POST /api/v1/files/presigned-url` additionally refuses to mint
an upload URL for an unsafe filename.

**Storage is per site (#993).** The bucket is shared by every tenant, so keys
carry their site: presigned keys are `sites/<siteId>/files/<ts>_<name>` (media
already used `sites/<siteId>/media/`). The upload token binds one key and one
site, the receiver refuses a key outside that site's namespace, and the guard
applies the issuing site's upload policy (the path has no tenant context of its
own). `POST /api/v1/files` refuses a `filenameDisk` outside the caller's site
with `400 FILENAME_DISK_OUT_OF_SCOPE` — before this, a member could register
another site's object key and read, replace or delete its bytes through
`/files/:id/content`. Records created earlier keep their keys.

**The env allowlist is held to the catalogue (#993).**
`FILE_UPLOAD_ALLOWED_MIME_TYPES` entries outside the upload type catalogue —
wildcards included — are dropped with a warning, as the admin API already did;
`FILE_UPLOAD_ALLOW_UNCATALOGUED_MIME=true` restores the old behaviour, and
`lumibase doctor --security` reports it.

The pure helpers are in `apps/cms/src/services/upload-security/`:

- `content-sniff.ts` — `sniffContentKind`, `compareDeclaredMime`, `detectPolyglot`
- `svg-sanitizer.ts` — `sanitizeSvg`
- `serve-policy.ts` — `contentDispositionFor`, `userContentHeaders`

None of them uses a DOM, `jsdom` or a Node-only API; PDF object streams are
inflated with the platform `DecompressionStream`.

## 1. Magic-byte sniffing vs declared type

`sniffContentKind` classifies the bytes; `compareDeclaredMime` compares that
with the declared (normalised) MIME type:

| Declared type | Bytes must sniff as |
|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif` | exactly that image format |
| `video/mp4`, `video/webm` | an ISO-BMFF (non-still-image brand) / EBML file |
| `application/pdf` | `%PDF-` at offset 0 |
| `image/svg+xml` | an SVG document with no active content (§3) |
| `text/plain`, `text/csv` | text — not HTML, SVG or PHP dressed as text |
| any other type an operator allowed via env | anything **except** an executable or an HTML/SVG/PHP document in disguise |

Executables (PE, ELF, Mach-O, Java class, `#!` scripts) are refused under every
declared type. A mismatch returns `415 UPLOAD_CONTENT_MISMATCH`.

## 2. Polyglot detection

A polyglot is a file that is valid as two formats at once: it passes the
magic-byte check as an image but is *also* a JAR, a PDF or an HTML page.
`detectPolyglot` runs after sniffing:

| Finding | Applies to | Error code |
|---|---|---|
| `<?php`, `<script`, `<html`, `<!doctype html`, `<iframe`, `<body`, `javascript:` anywhere in the bytes | raster images, video | `UPLOAD_EMBEDDED_PAYLOAD` |
| ZIP/JAR end-of-central-directory record with a real central directory in the file tail (GIFAR and friends) | raster images, video, PDF | `UPLOAD_EMBEDDED_PAYLOAD` |
| `%PDF-` header inside the first KiB | raster images, video | `UPLOAD_EMBEDDED_PAYLOAD` |
| bytes after the PNG `IEND` chunk | PNG | `UPLOAD_EMBEDDED_PAYLOAD` |
| `/JavaScript`, `/JS`, `/Launch`, `/RichMedia`, or a `javascript:` URI action — including `#xx`-escaped names and dictionaries hidden in Flate-compressed object streams | PDF | `UPLOAD_ACTIVE_PDF` |

PDF object-stream inflation is bounded (stream count, bytes per stream, total
bytes), so a decompression bomb cannot exhaust the isolate.

## 3. SVG sanitiser

`sanitizeSvg` is a small single-pass tokenizer with an element **allow-list**.
Each removal is classified:

- **active** — `<script>`, `<foreignObject>`, `<iframe>`/`<embed>`/`<object>`,
  `<handler>`, XHTML/MathML-namespace content, `on*` handlers,
  `javascript:`/`vbscript:`/`data:text/html` values (entity- and
  whitespace-obfuscated too), `<set>`/`<animate>` retargeting `href`, CSS
  `expression()`, any `<!DOCTYPE>`/`<!ENTITY>` (XXE, billion laughs), and
  processing instructions other than `<?xml ?>` (e.g. `<?xml-stylesheet?>`).
  An upload with any active content is **rejected**: `415 UPLOAD_UNSAFE_SVG`.
- **external** — `href`/`xlink:href`/`src` that are not `#fragment` or inline
  raster `data:image/...;base64`, CSS `@import` and off-document `url(...)`.
  These are accepted at upload and **stripped when served**.
- **unknown** — elements outside the allow-list; stripped when served.

Editor metadata (`sodipodi:`, `inkscape:`, `rdf:`, `dc:`, `cc:`) is kept. When
nothing is removed the input is returned unchanged, so a clean SVG is served
byte-identical. `GET /api/v1/media/:key` re-runs the sanitiser on every SVG it
serves (this also neutralises objects stored before the guard existed), and the
in-process image transform sanitises an SVG source before rasterising it.

## 4. Filename hygiene

`validateUploadFilename` (shared from `@lumibase/contracts/schemas`) refuses,
with `400 UPLOAD_UNSAFE_FILENAME`:

- control characters, including NUL (`photo.png%00.php`);
- bidirectional controls such as U+202E RIGHT-TO-LEFT OVERRIDE
  (`invoice<U+202E>gnp.exe` displays as `invoiceexe.png`);
- path separators and `..`;
- a trailing dot or space (`shell.php.`);
- a dangerous extension in **any** position (`shell.php.png`, `x.html.jpg`,
  `invoice.pdf.exe`) — see `DANGEROUS_FILENAME_EXTENSIONS`.

The last extension must still match the declared MIME type
(`415 UPLOAD_EXTENSION_MISMATCH`).

## 5. Serving policy

`GET /api/v1/media/:key` sets, for every stored object:

| Header | Value |
|---|---|
| `Content-Disposition` | `inline` only for PNG, JPEG, GIF, WebP, AVIF, MP4, WebM; `attachment` for everything else (SVG, PDF, HTML, text, unknown) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox` |

The filename in `Content-Disposition` is stripped of directory parts, quotes,
control and bidi characters, and non-ASCII names get an RFC 5987 `filename*`.
An object with no recorded type is served as `application/octet-stream`.

The global `withSecurityHeaders` middleware keeps a route's own CSP and adds
the baseline policy as a second header — browsers enforce both, so the result
is never weaker than either.

## Per-site controls

The checks sit on top of the existing per-site upload policy
(**Studio → Settings → Uploads**, `GET/PUT /api/v1/uploads/config`): the MIME
allowlist and size cap are applied first, unchanged. MP4 and WebM are now in the
catalogue but **off by default** — a site admin opts in, and the sniffing and
polyglot checks then apply to them like any other type.

## What this is not

- Not a malware/AV scanner by itself. Optional scanning (F2, #707) runs
  **after** the upload through a deployment-configured HTTP scanner (ClamAV
  sidecar on Docker); while a site has it on, files stay unserved until the
  scan says `clean`. See
  [Digital Asset Management](../features/digital-asset-management.md#malware-scanning-d07).
- Not a re-encoder. Re-encoding images to strip everything but pixels is the
  false-positive-free polyglot defence; it is still planned (task F1).
- Headers only protect bytes served **through the CMS**. If you expose a storage
  bucket publicly (R2 public bucket / S3 website), configure
  `Content-Disposition`, `nosniff` and a sandbox CSP on that bucket or CDN too,
  or serve user files from a separate, cookie-less domain.
- PDFs with form-calculation JavaScript are rejected along with malicious ones.
  Flatten such forms before upload.
