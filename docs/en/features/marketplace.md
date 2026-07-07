---
version: 1
lastUpdated: 2026-06-23T12:59:56.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: f47ac6b8c1d63092
mtEngine: claude
syncStatus: machine-translated
---

# Marketplace for Extensions

The LumiBase Marketplace lets you publish and install **digitally signed** extensions (signed bundles). A bundle is verified with SHA-256 + ed25519/RSA-PSS via WebCrypto before it is mounted.

## Tables

`extensions` (see `data-model.md` section 7) gained marketplace columns as of POST-GA5:

| Column | Purpose |
|--------|----------|
| `signature` | Detached signature (base64) over the bundle's SHA-256 |
| `signatureAlg` | Algorithm: `ed25519` or `rsa-pss-sha256` |
| `publisherKeyId` | The key ID used to sign — looked up in the registry |
| `publisher` | Organization/author name |
| `marketplaceSlug` | Slug used to build the public detail URL |
| `publishedAt` | Null when not yet published |
| `bundleSha256` | The bundle's SHA-256 hex, to verify integrity |
| `downloadCount` | Cumulative package downloads (bumped by `/download`) |
| `submissionStatus` | Community submission state: `pending` / `approved` / `rejected` (null = not a submission) |
| `submittedBy` | User who submitted the extension via the community flow |

`extension_votes` records marketplace upvotes — one row per `(userId, marketplaceSlug)`, enforced by a unique index so voting is idempotent. Votes are keyed by slug so they survive version bumps.

| Column | Purpose |
|--------|----------|
| `marketplaceSlug` | The listing being voted for |
| `userId` | The voter (FK → `users`, cascade delete) |
| `createdAt` | When the vote was cast |

## Public keys registry

Public keys are declared in the `MARKETPLACE_PUBLIC_KEYS` env var as a JSON map:

```json
{
  "lumibase-official-2025": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  "vendor-acme-2025-01":     "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
}
```

Loaded once at router init, not cached long-term (can be rotated via an env update + redeploy).

## API endpoints

```
GET    /api/v1/marketplace/extensions              List published extensions
GET    /api/v1/marketplace/extensions/:slug        Detail (with signature)
GET    /api/v1/marketplace/extensions/:slug/download   Download package (302 → bundle; ?redirect=0 → JSON)
POST   /api/v1/marketplace/extensions/:slug/install    Install into the current site
POST   /api/v1/marketplace/extensions/:slug/vote       Upvote (auth; idempotent)
DELETE /api/v1/marketplace/extensions/:slug/vote       Remove upvote (auth)
POST   /api/v1/marketplace/publish                 Publish an uploaded (signed) extension
POST   /api/v1/marketplace/submit                  Community-submit an extension for review (auth)
GET    /api/v1/marketplace/submissions?status=     List submissions for moderation (extensions:configure)
POST   /api/v1/marketplace/submissions/:id/review  Approve / reject a submission (extensions:configure)
```

Implementation: `apps/cms/src/routes/marketplace.ts`.

The catalog projection adds three derived fields on top of the stable public
fields: `verified` (true when the listing carries a signature + registered
publisher key + integrity hash — drives the "Verified" badge and the trusted
install path), `voteCount`, and `hasVoted` (for the authenticated caller).
`totalDownloads` now reflects `downloadCount`.

## Download

`GET /extensions/:slug/download` bumps `downloadCount` on the latest published
version and, by default, `302`-redirects to the signed `bundleUrl` so large
bundles never transit the Worker. Programmatic clients pass `?redirect=0` to get
the bundle metadata (URL, hash, signature, key id, new count) as JSON instead.

## Voting

Any authenticated user can upvote a listing. `POST …/vote` inserts a row with
`ON CONFLICT DO NOTHING` against the unique `(userId, marketplaceSlug)` index, so
repeat votes are no-ops; `DELETE …/vote` retracts it. Both return the fresh
`{ voteCount, hasVoted }`.

## Community submissions

`POST /submit` lets any authenticated user propose an extension for the public
catalog. It validates the payload (name, SemVer `version`, `type`, slug, bundle
URL, optional description/publisher/repo/capabilities), rejects a slug that is
already live in the catalog (`409 SLUG_TAKEN`), and creates a **global,
unpublished** row (`siteId = null`, `publishedAt = null`) with
`submissionStatus = 'pending'` and `submittedBy = <user>`. Because it is
unpublished, it never appears in the public catalog until a moderator approves
it (`/submissions/:id/review`) **and** a signed bundle is published via
`/publish`. Moderation endpoints require the `extensions:configure` permission.

## Verification flow

On `POST /install`:

1. Fetch the bundle from `bundleUrl` (R2/S3/external).
2. Recompute SHA-256 → compare against `bundleSha256`.
3. Look up `publisherKeyId` in `MARKETPLACE_PUBLIC_KEYS`.
4. Verify `signature` via `crypto.subtle.verify(algorithm, key, signatureBytes, sha256Bytes)`.
5. On failure → reject the install, do not mount.
6. On success → write the extension to the DB for the current `siteId` with `enabled: false` by default; the admin enables it manually.

## Publish flow

`POST /publish` requires:

- An uploaded bundle (URL in R2/S3).
- The exact SHA-256 hex.
- A signature + `publisherKeyId`.
- A unique slug + `publisher` info.

Only an admin (capability `marketplace:publish`) is allowed.

## Roadmap

- [x] Studio UI marketplace browser (browse + 1-click install).
- [x] Versioning + auto-update notifications.
- [x] Public marketplace site (apps/marketplace) backed by the real catalog API.
- [x] Revenue sharing for commercial extensions: launch is **Free-first**; checkout/payout work is tracked as a separate commercial backlog.

## Public marketplace launch

`apps/marketplace` is a Next.js static export deployed to Cloudflare Pages. It reads catalog data from CMS through:

```
GET /api/v1/marketplace/extensions?q=&category=&tags=&page=&perPage=&sort=
GET /api/v1/marketplace/extensions/:slug
```

The public catalog response is projected from `extensions.manifest.marketplace` first, then falls back to the existing `extensions` row. Stable public fields include `slug`, `name`, `description`, `readme`, `category`, `tags`, `publisherName`, `latestVersion`, `publishedAt`, `updatedAt`, `licenseType`, `repositoryUrl`, and `documentationUrl`. Existing fields (`marketplaceSlug`, `publisher`, `version`, `type`) remain for Studio compatibility.

Launch checklist:

- Set `NEXT_PUBLIC_USE_REAL_API=true`.
- Set `NEXT_PUBLIC_CMS_API_URL` to the production CMS URL.
- Build with `pnpm marketplace:build`.
- Deploy with `pnpm marketplace:deploy` or Cloudflare Pages using `apps/marketplace/out`.
- Smoke test `/`, `/extensions/`, `/categories/seo/`, and `/extensions/<slug>/`.
- Seed listing metadata in `manifest.marketplace` if production rows are missing description/category/tags/license/link data.

## Revenue sharing status

The launch marketplace is free-first. LumiBase does not process paid extension checkout, license entitlement, payout, refund, or tax handling in this phase.

Commercial extensions backlog:

- Pricing fields for extension listings.
- Publisher accounts and payout profile.
- Default percentage-based platform commission.
- License entitlement for paid extension installs.
- Checkout provider integration.
- Revenue ledger, payout lifecycle, and refund lifecycle.

## Versioning & Auto-update

### 1. Versioning Model
To support multiple versions of an extension in the system:
* **Identity:** `marketplaceSlug` represents the unique identity of an extension on the Marketplace (e.g. `custom-analytics`).
* **Version (SemVer):** The `version` column follows Semantic Versioning (e.g. `1.0.0`, `1.1.0`).
* **Global Extensions (Marketplace Registry):** Rows with `siteId IS NULL` store the versions published to the Marketplace. One extension can have multiple global rows representing different versions. The latest version is the one with the highest SemVer that has `publishedAt IS NOT NULL`.
* **Installed Extensions (Tenant):** On install, the specific version is copied into the tenant's site (`siteId = activeSiteId`). At any given time a site has at most one active version of that extension.

### 2. Update Check Flow
The system provides an API to check for available updates for the extensions installed on a site:

```
GET /api/v1/marketplace/updates
```

**Algorithm:**
1. Get the list of extensions installed on the current site from the `extensions` table (rows with `siteId = activeSiteId`).
2. For each installed extension, query the `extensions` table for global rows (`siteId IS NULL`) with the same `marketplaceSlug`.
3. Filter the published global versions (`publishedAt IS NOT NULL`) whose version number is greater than the current version.
4. Return the list of extensions that have a newer update, including the new `version`, `bundleUrl`, and `manifest`.

### 3. Auto-update Notifications
* **Trigger:** When `POST /api/v1/marketplace/publish` successfully publishes a new extension version.
* **Dispatcher:** The system scans all sites that have that extension installed at an older version.
* **Notification channel:** Sends a security notification of type `marketplace.extension.update_available` to the inbox of the site's administrators (inbox notification) and triggers a notification webhook.
