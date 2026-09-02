---
version: 4
lastUpdated: 2026-09-02T19:04:59.918Z
sourceLang: vi
translatedFrom: vi
sourceHash: e4938939b037622d
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-02T19:04:59.918Z
codeVerifiedHash: e4938939b037622d
codeVerifiedClaims: 2
---

# Publish npm packages

LumiBase keeps package sources in the monorepo; the npm publish job only pushes packages that do **not** have `private: true`. In other words, the `private` flag in a package's own `package.json` *is* the allowlist.

## Public package allowlist

There is no separate allowlist file. The `publish-npm-packages` job in
`.github/workflows/release.yml` scans `packages/*/package.json` and publishes only the
packages that do **not** have `private: true`:

- `packages/create-lumibase` (`create-lumibase`)
- `packages/sdk` (`@lumibase/sdk`)
- `packages/extension-sdk` (`@lumibase/extension-sdk`)
- `packages/mcp-server` (`@lumibase/mcp-server`)
- `packages/cli` (`lumibase` — unscoped name; the CLI plus a library entry that re-exports `@lumibase/sdk`, which must therefore be published first or in the same run)
- `packages/contracts` (`@lumibase/contracts`)

To make another package public: drop `private: true` from that package's
`package.json`, add `publishConfig.access: public` plus a `build` script that emits
`dist/`, and make sure it does not depend on an internal `workspace:*`
dependency that is not public yet.

Every public package should ship a `README.md`, `homepage`, `bugs`, and `keywords` —
the npm page is the discovery funnel; an empty manifest suppresses installs.

## Version fixed from root

Public packages use a fixed version taken from the root `package.json`. Before publishing, the workflow runs `pnpm version:check`, and the publish script also verifies that the release tag `vX.Y.Z` matches the root version `X.Y.Z`.

## Triggering a release

npm publishing runs when a SemVer tag matching `v*.*.*` is pushed. For example:

```sh
git tag v0.4.3
git push origin v0.4.3
```

The workflow uses npm trusted publishing/OIDC via the `id-token: write` permission and `actions/setup-node` with the npm registry. The job also supports `NPM_TOKEN` when `PUBLISH_NPM_PACKAGES` is enabled. Do not configure a long-lived npm token unless the npm registry does not support trusted publishing for that package.

## Provenance

The publish command enables `--provenance` so npm records a provenance statement where the registry supports it. If the registry does not support provenance/OIDC, treat the release as a registry misconfiguration rather than falling back to a long-lived token by default.

## Release notes

After a successful publish, the workflow creates or updates the GitHub Release for the tag and inserts an `npm packages published` section. That section must state exactly which packages and versions were published, for example:

```md
## npm packages published
- create-lumibase@0.24.1 (packages/create-lumibase)
- @lumibase/sdk@0.24.1 (packages/sdk)
- @lumibase/extension-sdk@0.24.1 (packages/extension-sdk)
- @lumibase/mcp-server@0.24.1 (packages/mcp-server)
- @lumibase/contracts@0.24.1 (packages/contracts)
```
