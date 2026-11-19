---
version: 5
lastUpdated: 2026-11-19T08:07:58.988Z
sourceLang: en
contentHash: 5a037c6c803734f1
codeVerified: 2026-11-19T08:07:58.988Z
codeVerifiedHash: 5a037c6c803734f1
codeVerifiedClaims: 44
---

# Release Flags

Release flags let a feature be merged to `main` and deployed while it stays
**dark**: the code ships, but nothing runs until LumiBase releases it with a
signed manifest, or an operator forces it on. Once released, a site admin can
choose whether their site uses it.

This is the first part of [#869](https://github.com/khuepm/LumiBase/issues/869).
The in-app **Upgrade** button described there is not implemented yet.

## How a flag is decided

Every flag is declared once, in `apps/cms/src/modules/release-flags/registry.ts`,
with a stage, an owner issue and a removal date. Its state is computed in two
layers.

**1. Release gate (whole deployment).** The first source that has a value wins:

| Order | Source | Set by |
|---|---|---|
| 1 | `LUMIBASE_RELEASE_FLAGS` | The operator (env). The kill switch. |
| 2 | The accepted signed manifest | LumiBase |
| 3 | The flag's stage | The code: `ga` is released, `dark` and `beta` are not |

**2. Site choice.** Only for released flags declared `siteToggle`: the value
the site admin chose, otherwise the flag's `siteDefault`.

A site can never turn on a feature the release gate keeps off. The resolver is
`apps/cms/src/modules/release-flags/resolver.ts`.

## Releasing a feature (LumiBase side)

A manifest lists the flags to release and is signed with Ed25519. Use
`scripts/release-flags/manifest.mjs`:

```bash
# once: create the key pair; keep the private key out of the repository
node scripts/release-flags/manifest.mjs keygen --out ./keys --key-id lumibase-release-v1

# each release: sign the full set of flags you want released
node scripts/release-flags/manifest.mjs sign \
  --key ./keys/lumibase-release-v1.private.pem --key-id lumibase-release-v1 \
  --flags content-environments=on --out manifest.json
```

A manifest replaces the previous one as a whole. Include every flag you want
released, not only the one that changed. `sign` refuses a manifest with no
flags, because it would withdraw every released feature; pass `--allow-empty`
if that is what you mean.

An instance accepts a manifest only when all of these hold:

- the key id is in `LUMIBASE_RELEASE_PUBLIC_KEYS` and the signature is valid;
- `issuedAt` is not more than 5 minutes in the future;
- `notAfter`, when present, has not passed;
- `audience` is `"*"` or contains `LUMIBASE_INSTANCE_ID`;
- `issuedAt` is later than the manifest already accepted. Sending the same
  manifest again is a no-op.

The last rule stops an old manifest from being replayed to roll flags back. To
turn a feature off, sign a newer manifest with the flag set to `off`.

## Delivering the manifest to an instance

There are two channels. Both go through the same verification.

- **Push.** The bootstrap admin sends the envelope to
  `PUT /api/v1/release-flags/manifest`. This works without outbound network
  access.
- **Pull (opt-in).** Set `LUMIBASE_RELEASE_MANIFEST_URL` to an `https://` URL
  that serves the envelope. The instance fetches it in the background, at most
  every `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` seconds (default 300, minimum 60).
  The bootstrap admin can trigger a fetch with
  `POST /api/v1/release-flags/manifest/pull`.

  The pull does not wait for traffic: the instance also pulls once at start
  and from a one-minute schedule (`node-cron` in the Docker worker process,
  the Cron Trigger `scheduled` handler on Workers). A scheduled pull runs only
  when `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` has passed since the last attempt
  by any replica, so several replicas still pull about once per interval.

If a fetch fails or a manifest is rejected, the instance keeps the manifest it
already accepted. Losing contact with LumiBase never turns a released feature
off. The pull does not follow redirects.

Every accepted or rejected manifest, from either channel, is written to the
audit log at instance scope (no site), as `release_flags.manifest_accepted` or
`release_flags.manifest_rejected`.

**Revoking a key.** A stored manifest counts only while the key that signed it
is still in `LUMIBASE_RELEASE_PUBLIC_KEYS` with the same PEM. Removing a key, for
example after a leak, withdraws every manifest it signed: flags fall back to
their stage default until a manifest signed by a trusted key arrives.

## Operating the release channel (LumiBase side)

This is how LumiBase runs the issuing side. Self-hosted operators only need the
public key and, if they opt in, the pull URL.

**Key custody.** The release private key exists in two places only: the
`LUMIBASE_RELEASE_SIGNING_KEY` secret of the GitHub environment
`release-manifest`, and an offline backup held by the maintainers. It is never
committed, never written to a CI log or disk, and never stored on an instance —
instances hold public keys only. The environment requires reviewer approval
and only allows the `main` branch, so a manifest is issued by one person and
approved by another.

**Issuing.** Run the **Release manifest** workflow
(`.github/workflows/release-manifest.yml`, manual dispatch) with a channel and
the full list of released flags. It shows the manifest currently published on
that channel, signs a new one with `manifest.mjs sign --key-env` (the key is
read from the environment, not a file), verifies it with `manifest.mjs verify`
against the published public keys and the channel's audience, uploads it to
`<bucket>/flags/<channel>.json`, and keeps the envelope as a run artifact. It
needs these settings on the `release-manifest` environment:

| Name | Kind | Value |
|---|---|---|
| `LUMIBASE_RELEASE_SIGNING_KEY` | secret | Ed25519 private key (PEM) |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | secret | R2 write access to the manifest bucket |
| `LUMIBASE_RELEASE_KEY_ID` | variable | Key id of the signing key, e.g. `lumibase-release-v1` |
| `LUMIBASE_RELEASE_PUBLIC_KEYS` | variable | The same JSON instances use |
| `LUMIBASE_RELEASE_MANIFEST_BUCKET` | variable | R2 bucket that serves the manifests |
| `LUMIBASE_RELEASE_MANIFEST_BASE_URL` | variable | Public `https://` URL of that bucket |

**Audiences.** Each LumiBase-operated environment has its own channel and
instance id, set in `apps/cms/wrangler.toml`: `lumibase-staging`,
`lumibase-production`, `lumibase-demo`, `lumibase-dev`. A manifest issued for
one of them carries that id as its `audience`, so it cannot be replayed on
another environment. Point each environment's `LUMIBASE_RELEASE_MANIFEST_URL`
at `<base>/flags/<instance id>.json`. The `public` channel is signed with
audience `"*"` for self-hosted instances that opted in to the pull.

**Rotating the key.**

1. `manifest.mjs keygen --key-id lumibase-release-v2` on an offline machine.
2. Add the new public key next to the old one in `LUMIBASE_RELEASE_PUBLIC_KEYS`
   everywhere (instances and the workflow variable) and deploy. Both keys are
   now trusted.
3. Replace `LUMIBASE_RELEASE_SIGNING_KEY` and `LUMIBASE_RELEASE_KEY_ID` with the
   new key and issue a new manifest on every channel.
4. After every instance reports the new manifest (`acceptedIssuedAt` in
   `/health`), remove the old public key everywhere. Manifests it signed stop
   counting from then on.
5. For a leaked key, skip the overlap: remove the old key first (flags fall
   back to their stage defaults) and issue with the new one.

**Monitoring.** With observability access (`/metrics` credentials),
`GET /health` adds `releaseManifest`: `pull` (`not-configured`, `pending`, `ok`
or `failing`), `lastAttemptAt`, `lastSuccessAt`, `acceptedIssuedAt`,
`consecutiveFailures` and `lastError`. The history is shared by every replica
through the runtime cache. A failing pull never degrades the health status,
because the accepted manifest stays in force. `/metrics` exposes
`lumibase_release_manifest_pulls_total{outcome}`,
`lumibase_release_manifest_consecutive_failures` and
`lumibase_release_manifest_last_success_timestamp_seconds`.

## Configuration

| Variable | Purpose |
|---|---|
| `LUMIBASE_RELEASE_PUBLIC_KEYS` | JSON `{ "keyId": "<PEM>" }` of trusted signing keys. Several keys allow rotation. Without it, every manifest is refused. |
| `LUMIBASE_RELEASE_FLAGS` | Operator override, e.g. `content-environments=on,other=off`. Unknown keys are ignored and logged. |
| `LUMIBASE_RELEASE_MANIFEST_URL` | Opt-in pull URL. Plain `http` is allowed only for loopback. |
| `LUMIBASE_RELEASE_MANIFEST_REFRESH_S` | Pull interval in seconds. |
| `LUMIBASE_INSTANCE_ID` | This deployment's id, matched against a manifest's `audience`. |

## API

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/v1/release-flags` | Any member | Members get `{ key, enabled }` for released flags only, so unreleased keys stay hidden; site admins get every flag with stage, source, owner and removal date. |
| `PUT /api/v1/release-flags/site` | Site admin | `{ "flags": { "<key>": true \| false \| null } }`. `null` clears the choice. |
| `GET /api/v1/release-flags/manifest` | Bootstrap admin | Accepted manifest (with `trusted`: whether its key is still trusted), trusted key ids, last pull result. |
| `PUT /api/v1/release-flags/manifest` | Bootstrap admin | Submit a signed envelope. |
| `POST /api/v1/release-flags/manifest/pull` | Bootstrap admin | Fetch from the configured URL now. |

The manifest endpoints refuse API keys. A rejected manifest answers
`MANIFEST_REJECTED` with a `reason`: `422` for a bad signature, unknown key,
expired, not yet valid, wrong audience or malformed payload; `409` for `STALE`
(older than the accepted one) or when no trusted key is configured.

## Studio

**Settings → System → Release flags** lists the flags for the active site.

- Site admins see every declared flag: description, stage, whether this
  deployment released it and why (the operator, the LumiBase manifest or the
  stage default), whether it is on for this site and why (follows the release,
  chosen for this site, or site default), owner and removal date.
- A released flag declared `siteToggle` has a switch for the site, and a
  **Use default** button clears the site's choice (`null`). The switch is
  disabled with an explanation while the deployment has not released the flag.
- Members see only the released flags and whether each is on, read-only.
- Managing the signed manifest stays an API for the bootstrap admin; Studio
  has no page for it.

Other Studio screens hide the UI of a feature whose flag is off with
`useReleaseFlag(key)` or `<ReleaseFlagGate flag="…">` from
`apps/studio/src/lib/release-flags.tsx`. The list is read once per session and
site; a read error keeps the feature hidden. Hiding is a convenience — the
server still answers `404` on a gated route.

## Gating code (developers)

```ts
import { requireReleaseFlag, isReleaseFlagEnabled } from '../modules/release-flags';

// A whole route: answers 404 NOT_FOUND, like an unknown route, while off.
router.post('/environments', requireReleaseFlag('content-environments'), handler);

// A branch inside a handler.
if (await isReleaseFlagEnabled(c, 'content-environments')) { /* ... */ }
```

Keys are typed: a key that is not declared in the registry does not compile.
The states are evaluated once per request and kept on the request context.

Rules for a new flag:

1. Declare it in `registry.ts` with `stage: 'dark'`, an `owner` issue and a
   `removeBy` date. A test fails once `removeBy` has passed.
2. **A flag gates code, not schema.** Migrations run whether the flag is on or
   off, so every migration behind a flag must be additive and safe while the
   feature is off.
3. When the feature is generally available, delete the flag and its checks.

## Limits

- **Not a security or licensing boundary on self-hosted instances.** The code
  and the repository are open, and the operator can set
  `LUMIBASE_RELEASE_FLAGS`. Use flags to stage releases, not to restrict paid
  features.
- **The pull channel contacts a LumiBase server.** It is off unless
  `LUMIBASE_RELEASE_MANIFEST_URL` is set.
- **Propagation is not instant across replicas.** The replica that accepts a
  manifest uses it immediately; other replicas read it within 30 seconds. A site
  choice made through the API is visible on the next request; one written
  through the generic settings endpoint can take up to 60 seconds.

## Multi-tenancy

| Resource | Scope | Why |
|---|---|---|
| Accepted manifest (`lumibase_release_manifests`, one row) | Deployment-wide | It records what the deployment released. It holds no tenant data. |
| `LUMIBASE_RELEASE_FLAGS`, trusted keys, pull URL | Deployment-wide | Operator configuration. |
| Site choices (`lumibase_settings`, key `release.flags`) | Per site | Under the existing `site_isolation` RLS policy. |
| Cache entry `release-flags:site:{siteId}` | Per site | The key contains the site id. |

Verified by `apps/cms/src/modules/release-flags/__tests__/release-flags.db.integration.test.ts`
and `routes.db.integration.test.ts` in the same folder: a choice on one site does
not change another site, and a gated route opens only on the site that chose it.
