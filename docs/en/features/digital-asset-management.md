---
version: 3
sourceLang: en
lastUpdated: 2026-11-18T04:54:08.544Z
contentHash: 8a8197eaaf330d9e
codeVerified: 2026-11-18T04:54:08.544Z
codeVerifiedHash: 8a8197eaaf330d9e
codeVerifiedClaims: 36
---

# Digital Asset Management

The files module (`/api/v1/files`, **Studio → Files & Media**) is a digital
asset library: folders you can rearrange, bulk upload, replace-in-place with
undo, duplicate detection, "where used" with a safe delete, embedded metadata
(EXIF / IPTC / XMP) that is searchable, optional GPS stripping, optional
malware scanning, and one media picker shared by fields and extensions.

Tracking: epic #670 (D01–D08). Code: `apps/cms/src/routes/files.ts`,
`apps/cms/src/services/files/`, `apps/cms/src/modules/malware-scan/`,
`apps/studio/src/modules/files/`.

## Folders and folder permissions (D01)

- `GET /api/v1/files/folders/tree` returns the nested tree. Every node has an
  id `path` (`/root/child/`), a `namePath` (`Marketing/2026`) and its `depth`.
- `PATCH /api/v1/files/folders/:id` renames (`name`) and/or moves (`parent`) a
  folder. A move into the folder itself or one of its sub-folders is refused
  with `409 FOLDER_CYCLE`.
- `DELETE /api/v1/files/folders/:id` deletes only an **empty** folder.
  Otherwise it answers `409 FOLDER_NOT_EMPTY` with the counts.
- Moving or renaming a file (`PATCH /api/v1/files/:id` with `folder` or
  `filenameDownload`) never changes its id or storage key. URLs and references
  keep working, so no redirect map is needed.
- In Studio, drag files (or a selection) onto a folder in the sidebar to move
  them, and drag a folder onto another folder to re-parent it.

**Folder-scoped access.** Site admins have full access. Other members need a
policy permission on the `files` collection (`read`, `create`, `update`,
`delete`). The permission's rule is evaluated against each file, using these
fields:

| Field | Value |
|---|---|
| `folder` | folder id, or `null` at the root |
| `folder_path` | `/a/b/c/` (the folder's id chain), or `/` at the root |
| `uploaded_by` | uploader user id |
| `mime` | MIME type |
| `id` | file id |

```json
{ "folder_path": { "_starts_with": "/<folderId>/" } }
```

That rule grants a whole subtree. The trailing slash makes `/ab/` never match
`/a/`. Files outside the rule answer `404` (not `403`), and moving a file
out of the granted subtree is refused. Folder management and the DAM
settings stay site-admin only. A principal without any `files` grant is
refused exactly as before.

## Bulk upload (D02)

Drop many files (or pick them) anywhere on the library page. The queue
uploads **three at a time** and shows progress per file. Network and server
errors are retried twice with backoff. A file the upload guard rejects
(4xx) fails at once and is reported on its own row with the reason. The
whole batch lands in the folder that was open when you dropped it. The
panel offers **Retry failed** and **Clear finished**. Progress updates are
coalesced, so 100 files do not freeze the UI.

After the upload, select files and use **Edit metadata** to set alt text,
caption, credit and tags in one go. The API call is
`POST /api/v1/files/bulk { ids, folder?, metadata? }`. Files the caller may
not touch are listed in `meta.skipped`, and the rest are applied.

## Replace in place (D03)

```
PUT /api/v1/files/:id/content?filename=new-name.jpg
Content-Type: image/jpeg
If-Match: "v3"            # optional — 409 VERSION_CONFLICT when stale
<raw bytes>
```

- The id, **storage key**, folder and every reference stay the same, and
  `version` goes up by one. The Studio `file` field stores the storage key,
  so the key is deliberately kept.
- The previous bytes are copied to `sites/<site>/file-versions/<id>/v<n>` and
  recorded in `lumibase_file_versions` for `versionRetentionDays` (default
  30). `GET /api/v1/files/:id/versions` lists them, and
  `POST /api/v1/files/:id/versions/:versionId/restore` brings one back.
  A restore is itself a replace, so history is never rewritten. Expired
  versions are pruned with their objects.
- After a replace, the edge copies of the file are purged (cache tag
  `file:<site>:<id>`). Every collection whose items reference the file has its
  cache tag invalidated and its ISR revalidation targets notified. Pages that
  embed the file invalidate the deliver tag. Image transforms are computed on
  request from the current bytes and keyed by its version, so they regenerate
  lazily.
- The replace body passes the same upload guard as every other upload surface
  (size, MIME allowlist, magic bytes, polyglot scan). See
  [upload security](../security/upload-security.md).

**Delivery by id.** `GET /api/v1/files/:id/content` serves the current bytes,
using the same `files:read` permission. The default response is revalidating
(`max-age=300, must-revalidate`). A URL pinned with `?v=<version>` is
`immutable` for a year: a replace bumps the version, so a pinned URL can
never serve stale bytes. Responses carry `ETag`, `Cache-Tag` and
`X-Lumi-File-Version`.

## Duplicates, where used, and safe delete (D06)

- On registration (`POST /api/v1/files`) the CMS reads the stored object back
  (objects up to 64 MiB), records its SHA-256 in `content_hash`, and returns
  same-content files in `meta.duplicates`. Studio hashes each file in the
  browser **before** uploading it (`GET /api/v1/files/duplicates?hash=`). On
  a match the queue pauses that file and asks: **Skip** or **Upload anyway**.
- `GET /api/v1/files/:id/usage` lists the items (collection, id, status and
  the top-level fields) and pages that contain the file id or storage key.
- `DELETE /api/v1/files/:id` on a referenced file answers
  `409 FILE_IN_USE`, with the references in `errors[0].details.usage`. The
  site's `deletePolicy` decides what happens next. `confirm` (the default)
  deletes when the request is repeated with `?confirm=true`. `block` never
  deletes a referenced file. A delete removes the row, the stored object and
  every archived version.

References are found by a literal substring match on the JSON. This can
over-report (a text field that merely mentions the key) but never misses a
verbatim reference, which is the safe bias in front of a delete.

## Embedded metadata (D05)

EXIF (camera, lens, exposure, orientation, artist, copyright), GPS, IPTC-IIM
(headline, caption, keywords, by-line, credit, source, copyright, city,
country) and XMP (`dc:title`, `dc:description`, `dc:creator`, `dc:subject`,
`dc:rights`, `photoshop:Credit`) are extracted from JPEG, PNG, WebP and TIFF
on registration and on every replace. The results go to
`files.metadata.embedded`. A merged `summary` (IPTC wins over XMP, which wins
over EXIF) and a lowercase `searchText` feed the library search:
`GET /api/v1/files?search=sunrise` matches IPTC keywords, credit and copyright.
Editorial keys you set yourself (`alt`, `caption`, `tags`, …) are never
overwritten. The parser is pure TypeScript with bounded reads, so it runs on
both runtimes.

**Strip GPS on public delivery.** With `stripGpsOnPublic: true`, the bytes
served by `GET /api/v1/files/:id/content` have their GPS removed. The GPS IFD
is emptied and the XMP `exif:GPS*` properties are blanked. The file keeps its
length and structure, and orientation and copyright survive. The stored
original is untouched, so editors still see the position in the details
panel. Image transforms already drop GPS: Sharp strips metadata by default,
and Cloudflare Image Resizing keeps only copyright by default.

## Media picker (D08)

One picker serves the media library, the built-in `file` / `files` fields
("Choose from library") and UI extensions:

```ts
import { getStudioHost } from '@lumibase/extension-sdk';

const assets = await getStudioHost()?.openMediaPicker({
  multiple: true,
  max: 5,
  initiallySelected: ['<fileId or storage key>'],
  allowedMimeTypes: ['image/*'],
  folder: '<folderId>',        // scope; includeSubfolders defaults to true
});
// → PickedAsset[] | null (cancelled)
```

Filtering is server-side. `GET /api/v1/files` takes `folder` (`root` for
files outside any folder), `subfolders=true`, `search`, `mime`
(comma-separated, exact or `type/*`), `ids`, `limit` (≤ 1000) and `offset`.
It returns `meta.total`. Inside Studio code, use the `useMediaPicker()` hook.

## Malware scanning (D07)

Off by default. When a site enables `scan.enabled`, every new or replaced
binary starts as `scanStatus: pending`. A background scan (`waitUntil` on
Workers, a detached task on Node) sends the bytes to the deployment's scanner
and records `clean`, `infected` or `error`. `GET /api/v1/files/:id/content`
serves only `skipped` and `clean` files. Anything else answers
`423 FILE_SCAN_PENDING` / `423 FILE_QUARANTINED`. Verdicts are written to the
audit log (`file_quarantined`, `file_scan_clean`, `file_scan_error`).
`scan.onError` decides the outcome when the scanner is down. The default,
`quarantine`, fails closed; `allow` marks the file clean. A site admin can
re-run a scan with `POST /api/v1/files/:id/scan`.

The scanner is a **deployment** setting, never a tenant one:

| Variable | Meaning |
|---|---|
| `MALWARE_SCAN_URL` | HTTP endpoint that accepts a multipart upload |
| `MALWARE_SCAN_TOKEN` | optional bearer token |
| `MALWARE_SCAN_FIELD` | multipart field name (default `file`) |

Docker: `docker compose -f docker/docker-compose.yml --profile malware-scan up -d`
starts a ClamAV REST sidecar. Set `MALWARE_SCAN_URL=http://clamav-rest:3000/api/v1/scan`
and `MALWARE_SCAN_FIELD=FILES`. On Cloudflare, point it at any HTTPS
scanning service. The adapter parses the common ClamAV REST response
shapes as well as a generic `{ infected, viruses }`.

## Resumable uploads (TUS, D04)

Large files can be uploaded with the [TUS 1.0](https://tus.io/protocols/resumable-upload)
protocol (core, `creation`, `termination`, `expiration`) at
`/api/v1/files/tus`. A dropped connection or a page reload no longer
restarts the upload from zero: the client asks the server how many bytes
it holds (`HEAD`) and continues from there. Any TUS client works; the
Studio media library switches to it automatically for files of 32 MiB and
more (`apps/studio/src/modules/files/tus-client.ts`, 16 MiB chunks, the
upload URL kept in `localStorage` so a reload resumes).

1. `POST /api/v1/files/tus` with `Upload-Length` and `Upload-Metadata`
   (`filename`, `filetype`, optional `folder`, `alt`). The upload guard checks
   the declaration exactly like a direct upload: public roles are refused,
   the size cap, MIME allowlist, filename hygiene and extension ↔ MIME
   apply. `files:create` and the folder placement rule are checked too.
   The answer is `201` with `Location` and `Upload-Expires`.
2. `PATCH <Location>` with `Upload-Offset` and an
   `application/offset+octet-stream` body. A chunk is committed **all or
   nothing**: if storage fails the answer is `503` and the offset does not
   move. A wrong offset answers `409 OFFSET_MISMATCH` with the stored
   offset. The first chunk is sniffed against the declared type.
3. The chunk that reaches `Upload-Length` completes the upload. Permission
   and placement are **checked again** (a revoked user's upload is
   discarded), the assembled file gets the polyglot scan, the file row is
   created, metadata is extracted and the malware scan is scheduled exactly
   as for a direct upload. The response carries `X-Lumi-File-Id`.
4. `DELETE <Location>` terminates an upload and drops its stored parts.

**How it runs on both runtimes.** Bytes go straight into a multipart upload
on R2 (Workers) or S3/MinIO (Docker) through the runtime's `MultipartStorage`
port (`packages/runtime/src/interfaces/storage.ts`), so no runtime holds the
whole file in memory. Multipart parts must be the same size, so the server
cuts the stream into 8 MiB parts and keeps the remainder in a small tail
object until the next chunk arrives. Progress lives in the
`lumibase_upload_sessions` table. Each `PATCH` takes a short lease with a
conditional update, so two concurrent writers cannot both append; a lease
left by a crashed request expires after five minutes.

**Ownership and expiry.** Only the creator (or a site admin) can see or write
an upload; anyone else gets `404`. An upload expires 24 hours after its last
committed chunk (`410` afterwards). An hourly sweep, `upload-expiry`, aborts
expired multipart uploads and deletes their tail objects (Docker leader-locked
cron and the Workers hourly cron).

## Settings

`GET /api/v1/files/settings` returns the settings, and
`PUT /api/v1/files/settings` updates them (site admin, partial). They are
stored in `settings` under the key `files.dam`:

| Key | Default | |
|---|---|---|
| `deletePolicy` | `confirm` | `confirm` or `block` for referenced files |
| `versionRetentionDays` | `30` | `0` keeps no history |
| `stripGpsOnPublic` | `false` | strip GPS from delivered bytes |
| `extractMetadata` | `true` | EXIF/IPTC/XMP extraction |
| `scan.enabled` | `false` | malware scanning |
| `scan.onError` | `quarantine` | `quarantine` or `allow` |

## Multi-tenancy

- **Isolated per site:** `lumibase_files`, `lumibase_folders`,
  `lumibase_file_versions` and `lumibase_upload_sessions` all carry `site_id`
  and are in the RLS `site_isolation` list. Every repository query is filtered by `site_id`
  (`DrizzleFileRepository`). Archived binaries live under `sites/<site>/…`.
  Cache tags (`file:<site>:<id>`) and the `files.dam` setting are per site.
  Duplicate lookups and "where used" only search the caller's site.
- **Shared across the deployment:** the scanner endpoint (`MALWARE_SCAN_*`).
  It is an operator-controlled service identity, not tenant data, and a
  tenant can only switch scanning on for its own site.
- **How it is verified:** `apps/cms/src/routes/__tests__/files-dam.test.ts`
  runs two sites side by side. Site A cannot read, replace or delete site B's
  file (404, nothing written), and duplicate lookups never return the other
  site's file with the same hash.

## Not done yet

- TUS `Upload-Defer-Length` (size unknown at creation) answers `501`, and the
  `concatenation` extension is not offered.
- Rich text does not embed images through the picker yet (R03). The picker
  API above is the integration point.
