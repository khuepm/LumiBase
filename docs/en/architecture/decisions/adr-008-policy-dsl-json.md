---
version: 1
lastUpdated: 2026-07-05T10:56:37.235Z
sourceLang: en
contentHash: c8336d583f99789d
---

# ADR-008: JSON Policy DSL for Permissions

**Date:** 2024-02-15
**Status:** Accepted

## Context

LumiBase needs a permissions system that supports:

1. **Field-level access control** — a role may read `articles.title` but not `articles.secret_notes`
2. **Conditional rules** — a role may only read items where `status = 'published'` or `author = $currentUser.id`
3. **Config-as-Code** — permission rules should be exportable as JSON/YAML and importable into a new environment (GitOps)
4. **Evaluatable at the API layer** — not just in the DB via row-level security (RLS), because LumiBase serves dynamic collections with a generic item layer
5. **Auditable and human-readable** — security auditors need to review the rules without understanding source code

Options considered:
- **OPA/Rego** — powerful but complex, adds external dependency, not easily serializable to JSON config
- **Casbin** — general purpose but limited field-level support; not natively JSON policy
- **Attribute-Based Access Control (ABAC) in code** — flexible but not exportable/importable without custom serialization
- **Custom JSON DSL** — full control, serializable, can be stored in DB and exported

## Decision

Implement a **custom JSON Policy DSL** stored in the `policies` → `permissions` tables.

A permission rule shape:

```typescript
type PermissionRule = {
  collection: string           // "*" for any collection
  action: 'create' | 'read' | 'update' | 'delete' | '*'
  fields?: string[]           // undefined = all fields; ["id","title"] = specific fields
  conditions?: FilterQuery    // same filter operators as the API query params
}
```

Example policy granting content editors read access to published articles:

```json
{
  "name": "content-editor-read",
  "permissions": [
    {
      "collection": "articles",
      "action": "read",
      "fields": ["id", "title", "content", "status", "author"],
      "conditions": { "status": { "_eq": "published" } }
    }
  ]
}
```

The `PermissionService.evaluate(user, action, collection, item?)` method:
1. Loads the user's roles and their attached policies (cached with tag `perm:{siteId}:{roleId}`)
2. Finds matching permission rules for the `(action, collection)` pair
3. Merges field masks (union of all allowed fields across matching rules)
4. Evaluates conditions against the item data (for `read`/`update`/`delete` on specific items)

The `conditions` syntax is identical to the API filter syntax — reusing the same JSONata-based evaluator.

## Consequences

**Positive:**
- Fully serializable to JSON — export/import works natively with Config-as-Code
- Human-readable and auditable without code knowledge
- Field-level control is first-class, not an afterthought
- Condition syntax reuses the API filter syntax — one evaluator to maintain
- Policies stored in DB → manageable through Studio UI and API without redeploys

**Negative:**
- Custom DSL means custom bugs — the evaluator must be thoroughly tested (see `src/services/__tests__/permission-dsl.test.ts`)
- Complex permission logic (e.g., "allow update only if the item was created by the current user AND it's a weekday") requires careful DSL expressiveness design
- No built-in policy conflict resolution — overlapping rules are union-merged (most permissive wins), which may surprise admins expecting deny-overrides-allow semantics

**Neutral:**
- A `POST /api/v1/permissions/check` debug endpoint is provided for admins to test rule evaluation without going through the full request cycle
