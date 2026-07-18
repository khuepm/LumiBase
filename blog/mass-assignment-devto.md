---
title: "The Hotel Upgrade Hack: Mass Assignment Vulnerabilities in APIs"
description: "How one extra JSON field can hand attackers admin privileges — and three concrete layers that stop it cold."
tags: [security, javascript, webdev, typescript]
published: false
cover_image: ""
---

## The hotel check-in trick

Imagine you walk up to a hotel front desk, pick up the paper check-in form, and fill it in normally: your name, check-in date, number of guests, room type: Standard. But before you slide it back across the counter, you quietly pencil in one more line — *room type: Presidential Suite*. The receptionist types every field into the system without a second glance. You just upgraded yourself for free.

That is Mass Assignment. And developers reproduce this exact vulnerability in API code every single day, usually without realising it.

## What is Mass Assignment?

Mass Assignment happens when a server takes user-supplied data and binds it directly to an internal model, without filtering which fields the user is actually allowed to set.

In a Rails-flavoured example it looks like this:

```ruby
# Dangerous — creates a user from whatever the client sends
User.create(params)
```

In Node.js / TypeScript land it is just as easy to write:

```typescript
// Dangerous
const user = await db.insert(users).values(req.body);

// Also dangerous
Object.assign(existingUser, req.body);
```

Now suppose your `users` table has columns like `email`, `name`, `passwordHash`, `isAdmin`, and `role`. A normal user submitting a sign-up form sends:

```json
{ "email": "attacker@example.com", "name": "Attacker", "password": "hunter2" }
```

An attacker submitting the same endpoint sends:

```json
{ "email": "attacker@example.com", "name": "Attacker", "password": "hunter2", "isAdmin": true, "role": "superuser" }
```

If the server binds `req.body` directly, both requests succeed. The attacker now has an admin account. No password cracking, no token theft, no exploiting a cryptographic weakness — just one extra JSON key.

## The GitHub 2012 incident

In March 2012, security researcher Egor Homakov exploited a Mass Assignment vulnerability in GitHub and added himself as a member of the `rails/rails` organisation — the official GitHub repository for Ruby on Rails — without any invitation or admin approval. He did this by injecting `organization_id` (and related fields) into a form POST that was meant only for updating his own profile.

GitHub suspended his account initially, then reinstated it and acknowledged the bug. The vulnerability was OWASP-known at the time; it simply hadn't been plugged.

The incident was a watershed moment for the Rails community. Mass Assignment had been called out before, but this was the first time it was demonstrated publicly against a flagship open-source project with millions of followers. Rails subsequently introduced `strong_parameters` to force developers to whitelist fields explicitly.

## Why Mass Assignment is particularly dangerous

**Privilege escalation.** The most direct impact: an attacker sets `isAdmin: true`, `role: "admin"`, `subscriptionTier: "enterprise"`. No brute force needed.

**Data corruption.** If `createdAt`, `updatedAt`, or audit fields can be overwritten, you lose tamper-evident logging. Compliance audits break down. Forensics become unreliable.

**Multi-tenancy bypass.** This is the one that keeps me up at night. In a multi-tenant system every domain record carries a `siteId`. If an attacker can inject `siteId` into a create or update payload, they can write data into another tenant's namespace, or re-parent their own records to escape rate limits and quotas scoped to their tenant.

**Subtle escalation paths.** Sometimes the dangerous field isn't `isAdmin`. It's `planId`, `ownerId`, `verifiedAt`, `emailVerified`, or `stripeCustomerId`. Attackers probe every field in a response body and try to send each one back in the next write request. Any field that sticks is a potential attack surface.

## Where Lumibase is exposed

Lumibase is a Content OS — a headless CMS that accepts writes from multiple surfaces simultaneously: the Studio editor UI, AI skill output piped through the agent harness, incoming webhooks from external platforms, and third-party extension callbacks. Every one of those surfaces eventually calls the same Hono route handlers and lands in the same service layer.

The schema for a content item looks roughly like this (simplified):

```typescript
// packages/database/src/schema/items.ts
export const items = pgTable('items', {
  id: text('id').primaryKey(),
  siteId: text('site_id').notNull(),           // tenant boundary
  collectionId: text('collection_id').notNull(),
  data: jsonb('data').notNull(),
  status: text('status').notNull().default('draft'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  publishedAt: timestamp('published_at'),
});
```

If a route handler did something naive like this:

```typescript
// apps/cms/src/routes/items.ts — BAD example, do not do this
app.post('/items', async (c) => {
  const body = await c.req.json();
  const item = await itemService.create({ ...body, siteId: c.get('tenant').siteId });
  return c.json({ data: item });
});
```

An attacker could include `createdBy`, `publishedAt`, or `status: "published"` in the body, skipping the review workflow entirely. Worse, if the spread order were reversed, they could overwrite `siteId` itself.

## Fix layer 1: Zod strips unknown keys at the boundary

The first and most important line of defence is to never let raw `req.body` touch business logic. Parse every incoming request through a Zod schema, and let Zod strip fields the schema doesn't declare.

```typescript
// packages/shared/src/schemas/items.ts
import { z } from 'zod';

export const createItemSchema = z.object({
  collectionId: z.string().min(1),
  data: z.record(z.unknown()),
  status: z.enum(['draft', 'review']).default('draft'),
  // Notice: no siteId, no createdBy, no publishedAt, no id
});

export type CreateItemInput = z.infer<typeof createItemSchema>;
```

By default, `z.object()` strips unknown keys when it parses (`.parse()` drops them; `.strict()` would throw instead). Either way the poisoned fields never make it through.

```typescript
// apps/cms/src/routes/items.ts
import { createItemSchema } from '@lumibase/shared/schemas/items';

app.post('/items', async (c) => {
  const raw = await c.req.json();

  // parse() drops any key not declared in createItemSchema
  const input = createItemSchema.parse(raw);
  // input is now typed as CreateItemInput — no isAdmin, no siteId, no createdBy

  const item = await itemService.createItem(c.get('tenant').siteId, c.get('user').id, input);
  return c.json({ data: item });
});
```

`siteId` and `createdBy` are injected from the verified middleware context — not from the request body. The client never gets to supply them.

## Fix layer 2: Typed DTOs in the service layer

Zod at the boundary is excellent, but defence in depth means the service layer should also be structurally incapable of accepting unsafe inputs. The pattern is to define a strict DTO type and have every service function accept only that type.

```typescript
// apps/cms/src/services/item-service.ts
import type { CreateItemInput } from '@lumibase/shared/schemas/items';
import { nanoid } from 'nanoid';
import { items } from '@lumibase/database/schema';

export class ItemService {
  async createItem(
    siteId: string,
    createdBy: string,
    dto: CreateItemInput,          // only the fields Zod already validated
  ) {
    const now = new Date();
    const record = {
      id: nanoid(),
      siteId,                      // from verified tenant context, not dto
      createdBy,                   // from verified auth context, not dto
      collectionId: dto.collectionId,
      data: dto.data,
      status: dto.status,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,           // only set by publish workflow, never by create
    };

    const [inserted] = await this.db.insert(items).values(record).returning();
    return inserted;
  }
}
```

The function signature makes the contract machine-checkable: TypeScript will refuse to compile if you accidentally pass something that has `isAdmin` or `siteId` on it and try to spread it into `record`. The type system becomes an automatic audit.

## Fix layer 3: Readonly fields — never let user-supplied data touch system fields

Some fields should be immutable after creation, or only writable by internal system processes. The cleanest way to express this in a Drizzle + TypeScript stack is to never include those columns in any user-facing DTO and to always set them programmatically.

```typescript
// Readonly fields checklist for every entity:
// id           → nanoid() at creation, never updatable
// siteId       → from tenant middleware, never from body
// createdBy    → from auth middleware, never from body
// createdAt    → DB default, never from body
// updatedAt    → set by service on every write, never from body
// publishedAt  → set only by the publish workflow, never by generic update
// auditFields  → written only by the audit module
```

For updates, define a separate schema that only allows the fields that genuinely should change:

```typescript
export const updateItemSchema = z.object({
  data: z.record(z.unknown()).optional(),
  status: z.enum(['draft', 'review']).optional(),
  // collectionId is also omitted — you can't move items between collections via a plain update
});

export type UpdateItemInput = z.infer<typeof updateItemSchema>;
```

Attempting to pass `{ siteId: "other-tenant", publishedAt: "2020-01-01" }` to an endpoint that parses through `updateItemSchema` will silently drop both fields before the service ever sees them.

## Whitelist, never blacklist

The instinct when you first learn about Mass Assignment is to write a blacklist:

```typescript
// Tempting but wrong
const { isAdmin, role, siteId, createdBy, ...safeBody } = req.body;
await db.insert(users).values(safeBody);
```

This breaks the moment you add a new sensitive column and forget to add it to the destructuring. You are playing catch-up with your own schema.

The whitelist approach flips the default: only explicitly declared fields pass through. Adding a new sensitive column to your database has zero impact on the attack surface because it was never in the allowlist to begin with.

One extra field in a JSON body should not hand someone a Presidential Suite. Or admin access. Or a ticket into another tenant's data. The framework's convenience — `req.body`, `Object.assign`, spread operators — is exactly what makes this vulnerability so pervasive. Comfortable patterns are the ones that hide the worst assumptions.

## Wrapping up

Three layers working together: Zod parses and strips at the HTTP boundary, typed DTOs constrain what the service can receive, and system fields are never in the DTO at all. Each layer catches what the previous one might miss. Any one of them alone is useful; all three together make Mass Assignment effectively impossible to sneak through.

I'm building [Lumibase](https://lumibase.dev) — a Content OS designed for AI agents operating at the edge. Security is structural from day one: multi-tenant isolation, typed service contracts, and strict schema validation at every entry point — whether the write comes from a human editor, an AI skill, a webhook, or an extension. If that sounds interesting, come take a look at [lumibase.dev](https://lumibase.dev) 🌱
