---
version: 2
lastUpdated: 2026-08-01T23:58:27.871Z
sourceLang: vi
translatedFrom: vi
sourceHash: 41f061bd96e9ea1a
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-08-01T23:58:27.871Z
codeVerifiedHash: 41f061bd96e9ea1a
codeVerifiedClaims: 2
---

# Publish npm packages

LumiBase keeps every package in source control at `private: true` until the project is ready to go public. The npm publish flow only un-privates packages in the release workflow's temporary copy; the manifests in the repository stay private so nothing can be published by accident while the project is still closed.

## Public package allowlist

There is no separate allowlist file. The `publish-npm-packages` job in
`.github/workflows/release.yml` scans `packages/*/package.json` and publishes only the
packages that do **not** have `private: true`. In other words, the `private` flag in a
package's own `package.json` *is* the allowlist:

- `packages/sdk` (`@lumibase/sdk`)
- `packages/extension-sdk` (`@lumibase/extension-sdk`)
- `packages/cli` (`lumibase` — the CLI, unscoped name)

To make another package public: drop `private: true` from that package's
`package.json`, and make sure it does not depend on an internal `workspace:*`
dependency that is not public yet.

## Version fixed from root

Public packages use a fixed version taken from the root `package.json`. Before publishing, the workflow runs `pnpm version:check`, and the publish script also verifies that the release tag `vX.Y.Z` matches the root version `X.Y.Z`.

## Triggering a release

npm publishing runs when a SemVer tag matching `v*.*.*` is pushed. For example:

```sh
git tag v0.4.3
git push origin v0.4.3
```

The workflow uses npm trusted publishing/OIDC via the `id-token: write` permission and `actions/setup-node` with the npm registry. Do not configure a long-lived npm token unless the npm registry does not support trusted publishing for that package.

## Provenance

The publish command enables `--provenance` so npm records a provenance statement where the registry supports it. If the registry does not support provenance/OIDC, treat the release as a registry misconfiguration rather than falling back to a long-lived token by default.

## Release notes

After a successful publish, the workflow creates or updates the GitHub Release for the tag and inserts an `npm packages published` section. That section must state exactly which packages and versions were published, for example:

```md
## npm packages published
- @lumibase/sdk@0.4.3 (packages/sdk)
- @lumibase/extension-sdk@0.4.3 (packages/extension-sdk)
```
