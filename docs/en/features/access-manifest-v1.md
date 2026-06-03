# Access Manifest `lumibase.access@v1`

Schema file: [`docs/schemas/lumibase.access.v1.schema.json`](../../schemas/lumibase.access.v1.schema.json).

This is the contract for access config import/export:

- roles;
- policies;
- permission rows;
- role/user/API-key bindings;
- API key metadata;
- extension access metadata.

It uses stable keys instead of DB ids and must never contain plaintext API keys, static tokens, password hashes, backup codes, SCIM token material, or webhook secrets.

## Root object

Required root fields are `schema`, `version`, `kind`, `siteKey`, `roles`, `policies`, and `bindings`.

```json
{
  "schema": "lumibase.access@v1",
  "version": 1,
  "kind": "lumibase.access",
  "siteKey": "default",
  "roles": [],
  "policies": [],
  "bindings": {},
  "apiKeys": [],
  "extensions": []
}
```

## Stable keys

Stable keys match:

```txt
^[a-z][a-z0-9_:-]{1,127}$
```

Import maps keys to DB ids inside a transaction.

## Policies

Policies own their permission rows. Permission rows are unique by:

```txt
policy.key + collection + action
```

Supported v1 actions:

```txt
create
read
update
delete
share
read_decrypted
execute
configure
install
enable
grant_capability
```

The operational actions are for system targets such as extension access.

## Bindings

Bindings are top-level:

- `rolePolicies`
- `userRoles`
- `userPolicies`
- `apiKeyRoles`
- `apiKeyPolicies`

Production exports should omit user membership by default if it contains PII.

## API keys

API key export is metadata-only. Never export plaintext secrets or token hashes. Import may create disabled placeholders or require `--generate-secrets`.

## Extension access

Extension access metadata is optional in v1. Effective access still comes from permission rows over `extensions`, `extension_modules`, `extension_endpoints`, and `extension_operations`.

## Import modes

| Mode | Behavior |
|---|---|
| `dry-run` | Parse, validate, diff, conflict-check, write nothing. |
| `merge` | Upsert manifest keys; do not delete objects outside manifest. |
| `replace-managed` | Delete objects managed by access import but absent from manifest. |
| `replace-all` | Replace all site access config; only for new/cloned environments. |
