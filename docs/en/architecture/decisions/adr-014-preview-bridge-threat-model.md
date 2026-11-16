---
version: 1
lastUpdated: 2026-11-15T19:48:28.721Z
sourceLang: en
contentHash: 32f370d0d5d7af2b
codeVerified: 2026-11-15T19:48:28.721Z
codeVerifiedHash: 32f370d0d5d7af2b
codeVerifiedClaims: 8
---

# ADR-014: Live preview bridge — preview tokens, framing and postMessage threat model

**Date:** 2026-11-15
**Status:** Accepted

## Context

Epic #667 adds live preview and visual editing: the Studio item editor frames
the site's own frontend, streams unsaved field values into it, and lets an
editor click an element on the page to jump to its field. That needs three
things LumiBase did not have:

1. a credential that lets a **public** frontend read **draft** content for a
   short time;
2. a Studio page that frames a **third-party origin**;
3. a two-way `postMessage` channel between two origins.

Two published competitor vulnerabilities set the bar:

- **Sanity #12794** — a preview secret written to the wrong dataset in a
  multi-workspace Studio, so one workspace's secret worked on another. In
  LumiBase terms: a preview credential minted for site A must never read
  site B.
- **Builder.io #4501** (CWE-346) — the visual editor accepted `postMessage`
  from any origin and acted on it, giving cross-origin code execution.

TinaCMS #7134 (an overlay that re-hydrated the page on every keystroke and hit
a 1 MB payload cap) and Sanity #12806 (Safari's cross-origin iframe sandboxing)
are the reliability failure modes to design against.

### Assets

| Asset | Why it matters |
|---|---|
| Draft content | Unpublished, may be embargoed. |
| Preview token | Reads draft content without a Studio session. |
| Studio session (bearer token in the Studio origin) | Full editor/admin power. |
| The editor's attention | A click in the frame moves focus in the Studio. |

### Attackers

| Attacker | Capability |
|---|---|
| A1 — holder of a leaked preview URL | Has the token string. |
| A2 — another tenant's admin | Valid credentials on site B, wants site A's drafts. |
| A3 — a malicious or compromised page | Can frame the frontend or be framed; can `postMessage` anything. |
| A4 — a compromised frontend | Runs inside the Studio's preview frame. |
| A5 — a hostile collection template | A `meta.previewUrl` such as `javascript:…`. |

## Decision

### 1. Preview tokens are site-scoped twice, revocable and short-lived (V01)

- A token is an HS256 JWT whose key is derived **per site**:
  `HMAC-SHA256(JWT_SECRET, "lumibase:preview:v1|" + siteId)`. The audience is
  `lumibase-preview:<siteId>`. A token for site A fails **signature**
  verification on site B before any database read (A2).
- Every minted token has a row in `lumibase_preview_secrets` (`site_id`,
  SHA-256 of the token, target, `created_by`, `expires_at`, `revoked_at`). The
  public read requires a valid signature **and** a live row on the requesting
  site, so a token is revocable on its own and all of a site's tokens can be
  rotated at once (`POST /api/v1/preview/tokens/revoke-all`). The plaintext is
  returned once, on mint; it is never stored or logged.
- Lifetime defaults to 900 s, capped at 3600 s (`preview.ttlSeconds`).
- Reads run with the **creator's** permissions, re-evaluated on every read:
  a token never reads more than the editor who minted it can read now, and
  dies when that editor loses access (A1).
- Every failure — malformed, wrong site, expired, revoked, creator lost
  access — answers the same `401` body, so the endpoint is not an oracle.
  Failures with a valid signature are audited (`preview.token_rejected`);
  mints, reads, revocations and rotations are audited too.
- Responses are `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`,
  `Referrer-Policy: no-referrer`. The token is accepted in the
  `x-lumibase-preview` header (preferred) or `?__preview=`.
- Minting is limited to user principals (no API keys) and rate-limited per
  user (30/min).

### 2. Framing is allowlisted on both sides (V02, V05)

- **Studio side.** The Studio frames a URL only if its origin is the
  collection template's own origin or is listed in the site's
  `preview.allowedOrigins` (exact `scheme://host[:port]`, no wildcards). It
  refuses a URL on the Studio's own origin: a same-origin frame with
  `allow-scripts allow-same-origin` could remove its own sandbox (A4).
- The frame is `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`,
  `referrerpolicy="no-referrer"`, `allow=""` (no powerful features). There is
  no `allow-top-navigation`, so the frame cannot navigate the Studio.
- The Studio HTML served by the CMS carries `frame-src` (default
  `https: http://localhost:* http://127.0.0.1:*`, tightened with
  `LUMIBASE_STUDIO_FRAME_SRC`). The baseline still has `frame-ancestors 'none'`
  for the Studio itself, and no CSP anywhere allows `unsafe-eval`.
- **Frontend side.** The frontend must send
  `Content-Security-Policy: frame-ancestors 'self' <studio origin>` so that only
  the Studio can frame it (A3 framing the frontend to drive it is then blocked
  by the browser, and by §3 regardless).
- `meta.previewUrl` is validated on write (CMS) and before use (Studio): an
  absolute `http(s)` URL with only the known placeholders; every value is
  `encodeURIComponent`-ed (A5).

### 3. The bridge accepts data, never code (V03, V05)

Both directions pass one shared gate (`@lumibase/visual-editing/protocol`), in
this order:

1. `event.origin` is on an **exact** allowlist — never `*`, never `null`;
2. `event.source` is the expected window (the iframe's `contentWindow` in the
   Studio; `window.parent` in the frontend);
3. the JSON payload is at most 64 KiB;
4. the payload matches a **strict** Zod schema for that direction (unknown
   keys, wrong channel/version and malformed identifiers are rejected).

Anything that fails is dropped and reported (`onReject`, default
`console.warn`). Outbound messages always name the target origin. After the
handshake the frontend locks onto the one Studio origin that greeted it.

Nothing in a message is evaluated, used as a URL to navigate to, or inserted
as HTML: field values are applied with `textContent` or handed to the
application as data. Patches are field-level, coalesced once per animation
frame, capped at 50 fields per message, and an over-full backlog collapses into
a single reload (backpressure instead of unbounded growth).

The overlay is inert unless the page is framed and in preview mode, and ships
≤ 15 kB gzip (enforced in CI).

## Consequences

- A leaked preview URL is bounded by TTL, revocation, the creator's current
  permissions and `noindex`/`no-store`; a site admin can kill every token with
  one rotation.
- Rotating `JWT_SECRET` invalidates every preview token of every site (the
  site keys derive from it); that is intended.
- Operators who serve the frontend from an origin other than the template's
  must add it to `preview.allowedOrigins`; operators who want framing narrower
  than "any https origin" set `LUMIBASE_STUDIO_FRAME_SRC`.
- The token rides in the URL the Studio opens (the frontend needs it). The
  reference frontend moves it into an `httpOnly` cookie on the first request
  and redirects, so it does not stay in the page URL, HTML or bundle.
- Browser coverage: the cross-origin bridge e2e
  (`packages/visual-editing/e2e/bridge.e2e.mjs`) runs Chromium and WebKit;
  an engine that is not installed is reported as skipped, not passed.

## Security review checklist

Changes to the preview surface must keep every item below true (also listed
in `.kiro/steering/definition-of-done.md`):

- [ ] Preview queries run on `scopedDbFor(c, siteId)` with the site from the
      URL; the token never chooses the site.
- [ ] One `401` body for every token failure; no new distinguishable error.
- [ ] No `postMessage(…, '*')`; every inbound handler calls `acceptPreviewMessage`.
- [ ] No message value reaches `innerHTML`, `eval`, `Function`, `location` or `src`.
- [ ] No `unsafe-eval` in any CSP; Studio keeps `frame-ancestors 'none'`.
- [ ] The overlay bundle stays ≤ 15 kB gzip.
