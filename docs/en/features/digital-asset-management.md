---
version: 3
sourceLang: en
lastUpdated: 2026-11-18T05:19:32.427Z
contentHash: 9921b44328a9e837
codeVerified: 2026-11-18T05:19:32.427Z
codeVerifiedHash: 9921b44328a9e837
codeVerifiedClaims: 46
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

## Video pipeline (#871)

Videos cannot be transcoded in a Worker, so the CMS hands them to an
external **video provider** behind a port
(`apps/cms/src/modules/video/provider.ts`). Two adapters ship:
**Cloudflare Stream** and **Mux**. Both speak plain HTTP, so the pipeline
runs the same on Workers and Docker. Business logic never names a provider.

Off by default. When a site enables `video.enabled` and the deployment has a
provider, every new or replaced `video/*` file gets a row in
`lumibase_video_assets` and moves through these states:

| State | Meaning |
|---|---|
| `uploaded` | queued; waits for the malware scan (#707) to mark the file servable |
| `processing` | submitted; the provider is building the renditions, HLS manifest and poster |
| `ready` | playable; duration and dimensions are copied onto the file (`duration` in seconds, `width`, `height`) |
| `failed` | the provider rejected it, five submissions failed, or it took longer than 24 hours |

1. **Submit.** After the upload response (`waitUntil` on Workers, a detached
   task on Node), the CMS sends the provider a short-lived signed URL,
   `GET /api/v1/video/source/<token>`. The token names the site, file and
   version and expires after six hours, and its key is derived from
   `JWT_SECRET`. The provider pulls the original from it. A file that is
   still being scanned is submitted once the scan comes back clean.
2. **Webhook.** The provider calls `POST /api/v1/video/webhook/<provider>`.
   The signature is checked against the deployment's webhook secret, with a
   five-minute replay window. The site, file and version come from the
   passthrough the CMS attached at submit time. An event for an older version
   or another asset is ignored.
3. **Sweep.** Every five minutes (Docker leader-locked cron, Workers
   five-minute trigger), `video-sweep`:
   - submits queued rows, including retryable failures (up to five attempts);
   - polls processing rows whose webhook never came;
   - re-queues a submit interrupted mid-flight;
   - fails anything processing for more than 24 hours.

A replace re-queues the file and deletes the previous provider asset.
Deleting the file deletes its provider asset too.

**Endpoints.**

- `GET /api/v1/files/:id/video` returns the state (`meta.enabled`,
  `meta.providerConfigured`).
- `POST /api/v1/files/:id/video/retry` (files `update`) re-submits a failed or
  queued video.
- `GET /api/v1/files/:id/video/playback` returns `{ hls, poster, expiresAt }`
  for a ready video. With `video.signedPlayback` (the default) both URLs are
  signed by the provider and expire after `video.playbackTtlSeconds`: the same
  short-lived-URL model as signed transforms. The response is
  `Cache-Control: private, no-store`. It answers `409 VIDEO_NOT_READY` until
  the current version is ready.

The provider is a **deployment** setting:

| Variable | Meaning |
|---|---|
| `VIDEO_PROVIDER` | `cloudflare-stream` or `mux`; unset = no transcoding |
| `LUMIBASE_PUBLIC_URL` | public origin the provider pulls sources from; the sweep cannot submit without it |
| `CF_STREAM_ACCOUNT_ID`, `CF_STREAM_API_TOKEN` | Stream API access |
| `CF_STREAM_WEBHOOK_SECRET` | secret returned when the account webhook was registered |
| `CF_STREAM_CUSTOMER_DOMAIN` | playback host, e.g. `customer-<code>.cloudflarestream.com` |
| `MUX_TOKEN_ID`, `MUX_TOKEN_SECRET` | Mux API access token |
| `MUX_WEBHOOK_SECRET` | Mux webhook signing secret |
| `MUX_SIGNING_KEY_ID`, `MUX_SIGNING_KEY_PRIVATE` | signing key for signed playback (the base64 key Mux hands out, or a PEM) |

Point the provider's webhook at
`<LUMIBASE_PUBLIC_URL>/api/v1/video/webhook/cloudflare-stream` or
`…/webhook/mux`.

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
| `video.enabled` | `false` | video pipeline |
| `video.signedPlayback` | `true` | provider-signed, expiring playback URLs |
| `video.playbackTtlSeconds` | `3600` | playback URL lifetime (60–86400) |

## Multi-tenancy

- **Isolated per site:** `lumibase_files`, `lumibase_folders`,
  `lumibase_file_versions` and `lumibase_video_assets` all carry `site_id` and are in the RLS
  `site_isolation` list. Every repository query is filtered by `site_id`
  (`DrizzleFileRepository`). Archived binaries live under `sites/<site>/…`.
  Cache tags (`file:<site>:<id>`) and the `files.dam` setting are per site.
  Duplicate lookups and "where used" only search the caller's site.
- **Shared across the deployment:** the scanner endpoint (`MALWARE_SCAN_*`)
  and the video provider account (`VIDEO_PROVIDER`, `CF_STREAM_*`, `MUX_*`).
  They are operator-controlled service identities, not tenant data, and a
  tenant can only switch scanning or video on for its own site. Provider
  webhooks carry the site in a signed passthrough; the webhook and source
  routes query only that site's rows.
- **How it is verified:** `apps/cms/src/routes/__tests__/files-dam.test.ts`
  runs two sites side by side. Site A cannot read, replace or delete site B's
  file (404, nothing written), and duplicate lookups never return the other
  site's file with the same hash.

## Not done yet

- Resumable uploads (TUS, D04 #704) are not implemented. Large files still
  use the single signed `PUT`.
- Rich text does not embed images through the picker yet (R03). The picker
  API above is the integration point.
- Video captions/subtitles as locale-tied related assets, and the Studio
  player, processing status and retry button, are the next slices of #871.
