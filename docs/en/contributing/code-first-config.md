# Code-First Configuration

LumiBase can export a site's **schema configuration** — collections, fields,
relations, settings and webhooks — as a single declarative JSON manifest
(`lumibase.config@v1`). Commit the manifest to git, review changes in pull
requests, and apply it across environments for CI/CD and environment sync. This
mirrors Directus's schema snapshot/apply, built on LumiBase's multi-tenant,
runtime-abstracted core.

> **Scope.** The manifest covers *schema config only*. It deliberately excludes:
> content items (that's data), access control (use `/api/v1/access/*`), and any
> secret/credential (never serialized). A manifest is safe to commit — it carries
> no `id`, `siteId`, timestamps, or hashes.

## The manifest

A canonical, diff-friendly JSON document. Resources are keyed by stable,
human-meaningful keys (collection `name`, `collection.field`,
`manyCollection.manyField`) rather than generated ids, and arrays are sorted so
two exports of the same state are byte-identical.

```jsonc
{
  "version": "lumibase.config@v1",
  "collections": [{ "name": "articles", "label": "Articles", "versioning": true }],
  "fields": [{ "collection": "articles", "field": "title", "type": "string", "interface": "input" }],
  "relations": [{ "manyCollection": "articles", "manyField": "author", "oneCollection": "users", "onDelete": "set null" }],
  "webhooks": [],
  "settings": [{ "key": "login_security_policy", "value": { /* … */ } }],
  "managedScopes": ["articles"]   // optional — see replace-managed below
}
```

## CLI

```bash
# Export the live config to a file (commit this to git)
pnpm --filter @lumibase/cms config export --site <siteId> --out config.json

# Diff a manifest against the live instance — exit 1 if changes are pending
pnpm --filter @lumibase/cms config diff --site <siteId> config.json

# Apply a manifest
pnpm --filter @lumibase/cms config apply --site <siteId> config.json --mode merge
```

Environment: `LUMIBASE_API_URL` (default `http://localhost:1989`) and
`LUMIBASE_TOKEN` (an admin bearer token).

## Apply modes

| Mode | Creates / updates | Deletes |
|------|-------------------|---------|
| `merge` (default) | ✅ | ❌ never |
| `replace-managed` | ✅ | only resources inside `managedScopes` |
| `replace-all` | ✅ | anything absent from the manifest (full sync) |

**Destructive guard.** Dropping a collection or field that holds data, changing a
field's `type`, or widening a relation's `onDelete` to `cascade` is classified
`high` risk and is **blocked** unless you pass `--allow-destructive` (CLI) /
`?allowDestructive=true` (API). A dry-run always *shows* destructive changes so
you can review them in CI before allowing them.

**Atomicity.** An apply runs inside a single database transaction. If any step
fails, the whole manifest is rolled back — the instance is never left half-applied.

## Recommended CI/CD workflow

1. **Author** schema changes in a branch (via Studio or the API).
2. **Export** and commit the manifest:
   `config export --site $SITE --out config.json`.
3. **Gate the PR**: in CI, run `config diff --site $STAGING config.json`. A
   non-zero exit means the branch diverges from staging — surface the diff for
   review.
4. **Promote**: on merge, run
   `config apply --site $PROD config.json --mode replace-managed` (or
   `replace-all` for a fully-managed environment), adding `--allow-destructive`
   only when the reviewed diff intends deletions.

## Round-trip guarantee

Exporting a site and immediately re-importing it (`--mode replace-all --dry-run`)
yields an all-`unchanged`, clean diff. The manifest is a faithful, lossless
representation of the site's schema config — verified by a property test
(`config-serialize.test.ts`) and a DB-backed round-trip test
(`config-import.db.integration.test.ts`).

## Limitations (v1)

- `replace-managed` deletion is scoped by collection name via `managedScopes`
  (not per-field). For full sync, use `replace-all`.
- Webhook URLs are exported verbatim — do not commit a manifest whose webhook URL
  embeds a secret token; prefer header-based auth.
- The CLI talks to a running CMS over HTTP; there is no offline/in-process mode yet.
