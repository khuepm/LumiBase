---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:40.851Z
contentHash: d879ebbc6005e4ba
codeVerified: 2026-11-14T01:59:40.851Z
codeVerifiedHash: d879ebbc6005e4ba
codeVerifiedClaims: 2
---

# Security Advisories

LumiBase publishes every confirmed vulnerability in a released version as a
**GitHub Security Advisory (GHSA)** in its own repository. This page says where
to find them, how to subscribe, and which machine-readable sources to poll. How
reports become advisories is in the
[vulnerability disclosure policy](./vulnerability-disclosure.md).

## Where advisories are published

| Source | What it holds |
|--------|---------------|
| <https://github.com/khuepm/lumibase/security/advisories> | The canonical list: every published LumiBase advisory, with affected and patched versions, CVSS vector, CWE, CVE ID and credits. |
| `CHANGELOG.md`, `### Security` under each release | One line per fix, linking the advisory. Also lists hardening that needed no advisory. |
| GitHub Release notes for the fixed tag | The same lines, attached to the release built by `.github/workflows/release.yml`. |
| [GitHub Advisory Database](https://github.com/advisories) | Advisories for the npm packages (`lumibase`, `create-lumibase`, `@lumibase/sdk`, `@lumibase/contracts`, `@lumibase/mcp-server`, `@lumibase/extension-sdk`), after GitHub reviews them. This is what Dependabot alerts and `npm audit` read. |
| [cve.org](https://www.cve.org/) and the NVD | The CVE record, for advisories that received a CVE ID. |

The CMS server, its Docker image (`ghcr.io/khuepm/lumibase-cms`), Studio and the
desktop/mobile shell are not npm packages, so their advisories appear in the
repository list and on cve.org but do not raise Dependabot alerts. Operators of
those components should watch the repository as described below.

## Subscribing

- **Watch the repository:** on GitHub, **Watch** → **Custom** → tick
  **Security alerts**, or **Releases** for every release. Security fixes always
  ship in a release.
- **Dependabot:** projects that depend on the npm packages get alerts and update
  pull requests automatically once an advisory is in the GitHub Advisory Database.
- **Polling:** use the API endpoints below from your own monitoring.

## Machine-readable feed

There is no separate feed file in this repository; the GitHub API is the feed,
so it can never disagree with the published advisories.

All published advisories for the repository, newest first (no authentication
needed for published advisories):

```bash
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/khuepm/lumibase/security-advisories?state=published&sort=published&direction=desc"
```

Each entry carries `ghsa_id`, `cve_id`, `summary`, `severity`, `cvss`, `cwes`,
`vulnerabilities` (package, vulnerable and patched version ranges),
`published_at` and `html_url`.

Reviewed advisories for one npm package, from the global GitHub Advisory
Database:

```bash
curl -s -H "Accept: application/vnd.github+json" \
  "https://api.github.com/advisories?ecosystem=npm&affects=@lumibase/sdk"
```

The same npm advisories are mirrored to [OSV](https://osv.dev/), so OSV-based
scanners pick them up:

```bash
curl -s -d '{"package":{"ecosystem":"npm","name":"@lumibase/sdk"}}' \
  "https://api.osv.dev/v1/query"
```

## Published advisories

| Advisory | CVE | Severity | Affected | Patched | Published |
|----------|-----|----------|----------|---------|-----------|
| _None yet._ | — | — | — | — | — |

Maintainers add a row here in the same pull request that publishes the advisory
(see [runbook §9](./advisory-runbook.md#9-after-publication)). The GitHub list
above is authoritative if the two ever differ.

## Reading an advisory

Each advisory follows the [advisory template](./advisory-template.md): a summary,
affected and patched versions, severity with the CVSS vector, impact, the fix,
workarounds for operators who cannot upgrade at once, and credits. Upgrade to the
patched version listed for your major; the
[supported versions](./vulnerability-disclosure.md#2-supported-versions) table
says which majors still receive fixes.
