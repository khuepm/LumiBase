---
version: 4
sourceLang: en
lastUpdated: 2026-11-19T07:46:47.417Z
contentHash: 5642f8ddba285cd1
codeVerified: 2026-11-19T07:46:47.417Z
codeVerifiedHash: 5642f8ddba285cd1
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
| `CLAMD_HOST` | clamd host for the native adapter (Docker only) |
| `CLAMD_PORT` | clamd port (default `3310`) |
| `MALWARE_SCAN_URL` | HTTP endpoint that accepts a multipart upload |
| `MALWARE_SCAN_TOKEN` | optional bearer token |
| `MALWARE_SCAN_FIELD` | multipart field name (default `file`) |

There are two adapters. When both are configured, clamd wins.

- **clamd (Docker).** The native ClamAV daemon is reached over TCP with
  `zINSTREAM`. The Docker runtime provides the socket client
  (`runtime.clamd`) when `CLAMD_HOST` is set, so business logic never imports
  `node:net`. `stream: OK` is clean, `stream: <signature> FOUND` is infected,
  and an `ERROR` reply or an unreachable daemon follows `scan.onError`.
- **HTTP (both runtimes).** Any REST scanner. The adapter parses the common
  ClamAV REST response shapes as well as a generic `{ infected, viruses }`.
  This is the adapter on Cloudflare, which has no clamd TCP: point it at any
  HTTPS scanning service.

Docker: `docker compose -f docker/docker-compose.yml --profile malware-scan up -d`
starts clamd (`clamav`) and a REST front (`clamav-rest`). Set either
`CLAMD_HOST=clamav` (native, preferred) or
`MALWARE_SCAN_URL=http://clamav-rest:3000/api/v1/scan` with
`MALWARE_SCAN_FIELD=FILES`.

**Pending-scan sweeper.** A scan that never finished leaves its file
`pending`, which is never served. This happens when the process dies
mid-scan, or when the scan saw the file replaced and dropped its stale
verdict. Every five minutes, a sweep re-scans files that have been `pending`
for more than ten minutes, at most 50 per pass, oldest first. It runs as a
leader-locked cron on Docker and from the five-minute Cron Trigger on
Workers. Each verdict is written under the file's version, so overlapping
passes settle a file once. Verdicts are audited on the file's site with
`sweep: true`. A site that has since switched scanning off is left alone:
its pending files stay unserved until an admin re-scans them or turns
scanning back on. The lookup uses the partial index `files_pending_scan_idx`.

## Captions and subtitles (#871)

A caption or subtitle track is a WebVTT file in the library, linked to a
video for one locale. The track stays an ordinary asset: its own folder
permissions, versions and replace in place, so fixing a typo in a subtitle
keeps every link. Upload it like any file. `text/vtt` (`.vtt`) is in the
upload catalogue but off by default, so enable it under
**Settings → Uploads**. The upload guard requires the `WEBVTT` signature, so
an HTML or SVG document cannot pass as captions.

- `GET /api/v1/files/:id/captions` lists the tracks of a video (files `read`).
  Each track carries what an HTML `<track>` element needs: `kind`, `locale`
  (`srclang`), `label`, `isDefault` and `src`, a version-pinned, immutable
  `GET /api/v1/files/<caption>/content?v=<n>` URL. A track whose caption file
  the caller cannot see is listed with `src: null`.
- `POST /api/v1/files/:id/captions` attaches a track (files `update` on the
  video), with body `{ captionFileId, locale, kind?, label?, isDefault? }`:
  - `kind` is `subtitles` (default), `captions`, `descriptions` or `chapters`;
  - the video must be `video/*` (`422 NOT_A_VIDEO`);
  - the track must be a `text/vtt` file the caller can see
    (`415 CAPTION_NOT_VTT`, `404 CAPTION_FILE_NOT_FOUND`);
  - the locale must be one of the site's locales
    (`422 LOCALE_NOT_ENABLED`);
  - there is one track per video, locale and kind (`409 CAPTION_EXISTS`).
- `PATCH /api/v1/files/:id/captions/:captionId` changes `captionFileId`,
  `locale`, `kind`, `label` or `isDefault`. There is at most one default per
  video and kind, so setting one clears the others.
- `DELETE /api/v1/files/:id/captions/:captionId` detaches the track. The
  WebVTT file stays in the library. Deleting either file removes the link.

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
  `lumibase_file_versions` and `lumibase_file_captions` all carry `site_id` and are in the RLS
  `site_isolation` list. Every repository query is filtered by `site_id`
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

- Resumable uploads (TUS, D04 #704) are not implemented. Large files still
  use the single signed `PUT`.
- Rich text does not embed images through the picker yet (R03). The picker
  API above is the integration point.
- Video transcoding (#871 part 1, PR #937) and the Studio caption editor and
  player are separate slices of #871.
