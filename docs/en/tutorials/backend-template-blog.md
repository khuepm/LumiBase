---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T09:00:27.434Z
contentHash: 4a73874cf7ffed05
codeVerified: 2026-11-19T09:00:27.434Z
codeVerifiedHash: 4a73874cf7ffed05
codeVerifiedClaims: 12
---

# Create a blog backend from a template

In this tutorial you create a complete blog backend in one site from the
official `wordpress-alike` template. You do it three ways: with the REST API,
with an agent over MCP, and in Studio. Then you add your own content to it.
Reference: [Backend templates](../features/backend-templates.md).

You need a site admin token (`$TOKEN`), the site to install into (`$SITE`) and
the CMS origin (`$CMS`).

## What a template is, and what it is not

- **A content model, not a deployment.** A template creates collections,
  fields and relations, and optionally some demo content, in the site you
  name. It does not create a frontend, a server, a database or a project.
- **Logical collections, not physical tables.** Collections are rows in the
  site's schema tables, and every item is a row of `lumibase_items` whose
  values live in a JSONB column (`storageModes: ["jsonb"]`). Installing a
  template creates **no** physical table per collection. Two sites can
  install the same template, and they stay independent.
- **No automatic public access.** Installing creates no role, policy,
  permission or user. The new collections are not readable by the public
  Delivery API until you grant access, like any collection you create by hand.
- **Not WordPress.** `wordpress-alike` borrows familiar WordPress concepts
  (posts, pages, categories, tags, comments). There is no PHP, no WordPress
  REST API compatibility, and no plugins or themes. Its authors are content
  profiles, not login accounts.

## 1. Find the template

```bash
curl -s "$CMS/api/v1/backend-templates/official" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE"
```

The response lists `wordpress-alike` with version `1.0.0`.

## 2. Preview the install (plan)

A plan resolves the exact revision, checks compatibility and name conflicts,
and lists what will be created. It writes no schema and no content. The target
site is always explicit, and it must be the site of the request.

```bash
curl -s -X POST "$CMS/api/v1/backend-templates/plans" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{
    "template": { "source": "official", "slug": "wordpress-alike", "version": "1.0.0" },
    "targetSiteId": "'"$SITE"'"
  }'
```

`data.report.counts` shows 8 collections and `seedRecords: 0`: without a seed
pack only the schema is created. To include the synthetic demo content, add
`"seedMode": "pack", "seedPack": "demo"`. If the site already has a `posts`
collection, the plan returns `409 NAME_CONFLICT`. Add a prefix with
`"namespace": { "prefix": "blog_" }` to install next to it.

A plan expires after 15 minutes.

## 3. Install

```bash
curl -s -X POST "$CMS/api/v1/backend-templates/installations" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "planId": "<data.id from step 2>", "idempotencyKey": "blog-1" }'
```

Everything commits in one transaction, or nothing does. Sending the same
request again returns the same installation (`meta.replayed: true`), so a
retry is safe. Read it later with
`GET /api/v1/backend-templates/installations/<id>`.

## 4. The same with an agent (MCP)

On `POST /api/v1/mcp` (with the site's `contentOs.mcp` flag on), an agent
calls `planBackendTemplate` with the same input as step 2. If the user did not
say which site, the tool answers `MISSING_INPUT` and the agent must ask. The
agent then calls `instantiateBackendTemplate` with the `planId` and the
returned `binding`:

```json
{ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": { "name": "instantiateBackendTemplate",
              "arguments": { "planId": "<planId>", "expect": { "...": "the binding, unchanged" } } } }
```

The result is `pending_approval`. A human approves it in Studio (Mission
Control → Inbox), or with `POST /api/v1/agent/approvals/<approvalId>/decide`
and `{ "decision": "approved" }`. If anything about the plan changed since,
the approval writes nothing (`BINDING_MISMATCH`). The agent then reads the
result with `getBackendTemplateInstallation` and `{ "installationId": "<planId>" }`.

## 5. The same in Studio

Open **Data model → Backend templates** and pick **WordPress alike** and
revision **1.0.0**. Choose the target site; there is no default. Leave the
demo content off. Press **Preview**, check the counts and the collection
list, then press **Install**. Changing any choice after the preview disables
**Install** until you preview again.

## 6. Add your own content

The installed collections are ordinary collections. Use the item API, Studio
or the MCP item tools with the site's normal permissions:

```bash
curl -s -X POST "$CMS/api/v1/items/authors" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "data": { "name": "Ana", "slug": "ana" } }'
```

A post without its required `title` is refused, and `status` must be one of
`draft`, `published` or `private`. Nothing has to be reseeded, and editing the
content never changes the template.

## Make your own template

Capture collections of a site as a draft with
`POST /api/v1/backend-templates/capture`, or import a JSON document with
`POST /api/v1/backend-templates`. Publish it with
`POST /api/v1/backend-templates/<id>/publish`, which creates an immutable
revision. Then plan and install it as above, with
`"template": { "source": "site", "slug": "<slug>", "version": "<version>" }`.
