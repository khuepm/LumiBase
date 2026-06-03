# Access Manifest `lumibase.access@v1`

Schema file: [`docs/schemas/lumibase.access.v1.schema.json`](../../schemas/lumibase.access.v1.schema.json).

Mục tiêu:

- Export/import roles, policies, permission rows, bindings và API key metadata bằng stable keys.
- Không phụ thuộc DB ids.
- Không chứa plaintext API keys, static tokens, password hashes, backup codes, SCIM token material hoặc webhook secrets.
- Là contract cho `GET /api/v1/access/export`, `POST /api/v1/access/import?dryRun=true`, CLI `lumibase access export/import`.

## Root object

```json
{
  "schema": "lumibase.access@v1",
  "version": 1,
  "kind": "lumibase.access",
  "siteKey": "default",
  "exportedAt": "2026-06-03T00:00:00.000Z",
  "managedBy": "access-import",
  "roles": [],
  "policies": [],
  "bindings": {},
  "apiKeys": [],
  "extensions": [],
  "meta": {}
}
```

Required root fields:

- `schema`: fixed string `lumibase.access@v1`.
- `version`: fixed number `1`.
- `kind`: fixed string `lumibase.access`.
- `siteKey`: stable site key/slug.
- `roles`: role definitions.
- `policies`: policy definitions with embedded permission rows.
- `bindings`: role/user/API-key binding arrays.

## Stable keys

Stable keys use this pattern:

```txt
^[a-z][a-z0-9_:-]{1,127}$
```

Examples:

- `role:administrator`
- `policy:admin`
- `policy:posts_editor`
- `api:nextjs_frontend`

Import must map stable keys to DB ids inside a transaction.

## Roles

Role object:

```json
{
  "key": "editor",
  "systemKey": null,
  "name": "Editor",
  "description": "Can edit own drafts",
  "icon": "square-pen",
  "parentKeys": [],
  "adminAccess": false,
  "appAccess": false,
  "meta": {}
}
```

Notes:

- `adminAccess` and `appAccess` are deprecated compatibility fields. New manifests should express those flags on policies.
- `parentKeys` is stable-key based and does not contain DB ids.

## Policies and permissions

Policy object:

```json
{
  "key": "posts_editor",
  "name": "Posts editor",
  "adminAccess": false,
  "appAccess": true,
  "enforceTfa": true,
  "ipAllow": ["10.0.0.0/8"],
  "ipDeny": [],
  "validFrom": null,
  "validUntil": null,
  "rules": {},
  "permissions": [
    {
      "collection": "posts",
      "action": "read",
      "fields": ["title", "body", "status"],
      "permissions": { "status": { "_eq": "published" } },
      "validation": {},
      "presets": {}
    }
  ]
}
```

Permission rows are unique by:

```txt
policy.key + collection + action
```

Supported `action` values in v1:

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

The last five support system targets such as extension access and operational actions.

## Bindings

Bindings are top-level to keep role/policy definitions reusable.

```json
{
  "bindings": {
    "rolePolicies": [
      { "roleKey": "editor", "policyKey": "posts_editor", "priority": 100 }
    ],
    "userRoles": [],
    "userPolicies": [],
    "apiKeyRoles": [],
    "apiKeyPolicies": []
  }
}
```

User bindings use `userRef`:

```json
{ "userRef": { "externalId": "logto:abc" }, "roleKey": "editor" }
```

Production exports should omit user membership by default if it contains PII. Use SCIM or environment-specific seed for production membership.

## API key metadata

API key export contains metadata only:

```json
{
  "key": "nextjs_frontend",
  "name": "Next.js frontend",
  "prefix": "lumi_live_ab12",
  "expiresAt": null,
  "revoked": false,
  "meta": {}
}
```

Never export plaintext API key secrets or token hashes. Import may create disabled placeholders or require `--generate-secrets`.

## Extension access metadata

Extension access metadata supports the POST-GA7 extension access plan:

```json
{
  "key": "shopify_sync",
  "accessMode": "restricted",
  "apiKeyCallable": false,
  "serviceAccountPolicyKey": null,
  "meta": {}
}
```

Actual access is still modeled as permission rows over system targets such as `extensions`, `extension_modules`, `extension_endpoints`, and `extension_operations`.

## Import modes

| Mode | Behavior |
|---|---|
| `dry-run` | Parse, validate, diff, conflict-check, write nothing. |
| `merge` | Upsert keys in manifest; do not delete objects outside manifest. |
| `replace-managed` | Delete objects previously managed by access import but absent from manifest. |
| `replace-all` | Replace all access config in the site; only for new/env-cloned sites. |

## Required dry-run checks

Import dry-run must validate:

- schema/version/kind;
- duplicate stable keys;
- duplicate permission rows by `policyKey + collection + action`;
- missing referenced role/policy/API-key keys;
- conflict report for every target receiving multiple policies;
- sensitive/system collection grants against the system collection contract;
- no plaintext secrets.
