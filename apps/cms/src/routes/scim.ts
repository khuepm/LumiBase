/**
 * SCIM 2.0 provisioning routes — POST-GA4.
 *
 * Subset of RFC 7644 sufficient for Okta / Azure AD / Logto provisioning:
 *
 *   GET    /scim/v2/Users          — list users (with filtering)
 *   GET    /scim/v2/Users/:id      — get user
 *   POST   /scim/v2/Users          — create user
 *   PUT    /scim/v2/Users/:id      — replace user
 *   PATCH  /scim/v2/Users/:id      — partial update
 *   DELETE /scim/v2/Users/:id      — soft delete (active = false)
 *   GET    /scim/v2/Groups         — list groups (mapped to LumiBase teams)
 *   POST   /scim/v2/Groups         — create group
 *   GET    /scim/v2/ServiceProviderConfig
 *   GET    /scim/v2/Schemas
 *   GET    /scim/v2/ResourceTypes
 *
 * Auth: this router expects a separate `Authorization: Bearer <token>` set
 * outside the normal Logto JWT pipeline. The expected token is read from
 * `c.env.SCIM_TOKEN`. For local dev, set `SCIM_TOKEN=dev-scim` in wrangler.toml.
 */

import { teams, teamMembers, userSites, users, scimTokens, activity } from "@lumibase/database";
import { and, eq, ilike, or, isNull, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { emailLookup, isEmailIdentityConflict } from "../modules/email-identity/service";
import { formatSafeError } from '@lumibase/contracts/utils';
import { containsPattern } from "../services/like-pattern";

export const scimRouter = new Hono<AppEnv>();

const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST_RESPONSE = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** RFC 7644 §3.3 / §3.12: the userName is already taken (#794). */
function scimUniqueness(c: Context<AppEnv>) {
  return c.json(
    { schemas: [SCIM_ERROR], status: "409", scimType: "uniqueness", detail: "userName is already in use" },
    409,
  );
}

// ── auth middleware ────────────────────────────────────────────────────────

async function sha256(text: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

scimRouter.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      {
        schemas: [SCIM_ERROR],
        status: "401",
        detail: "Missing or invalid Authorization header",
      },
      401,
    );
  }

  const bearer = auth.slice(7);
  const tokenHash = await sha256(bearer);
  const db = c.get("db");

  // Query database for this token
  const [token] = await db
    .select()
    .from(scimTokens)
    .where(and(eq(scimTokens.tokenHash, tokenHash), isNull(scimTokens.revokedAt)))
    .limit(1);

  if (!token) {
    return c.json(
      {
        schemas: [SCIM_ERROR],
        status: "401",
        detail: "Unauthorized SCIM client",
      },
      401,
    );
  }

  // Check expiration
  if (token.expiresAt && token.expiresAt < new Date()) {
    return c.json(
      {
        schemas: [SCIM_ERROR],
        status: "401",
        detail: "SCIM token has expired",
      },
      401,
    );
  }

  // Update lastUsedAt
  try {
    await db.update(scimTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(scimTokens.id, token.id));
  } catch (err) {
    console.error("Failed to update SCIM lastUsedAt", formatSafeError(err));
  }

  // Set siteId context to the token's siteId to enforce multi-tenant isolation
  c.set("siteId", token.siteId);
  c.set("scimToken" as any, token);

  await next();

  // Log SCIM write actions if the request succeeded
  if (c.res.status >= 200 && c.res.status < 300) {
    const method = c.req.method.toUpperCase();
    const path = c.req.path;
    let action = "";

    if (path.endsWith("/Users") && method === "POST") {
      action = "scim.user.create";
    } else if (path.includes("/Users/") && method === "PUT") {
      action = "scim.user.update";
    } else if (path.includes("/Users/") && method === "PATCH") {
      action = "scim.user.patch";
    } else if (path.includes("/Users/") && method === "DELETE") {
      action = "scim.user.delete";
    } else if (path.endsWith("/Groups") && method === "POST") {
      action = "scim.group.create";
    } else if (path.includes("/Groups/") && method === "PUT") {
      action = "scim.group.update";
    } else if (path.includes("/Groups/") && method === "PATCH") {
      action = "scim.group.patch";
    } else if (path.includes("/Groups/") && method === "DELETE") {
      action = "scim.group.delete";
    }

    if (action) {
      try {
        await db.insert(activity).values({
          siteId: token.siteId,
          action,
          userId: "scim",
          collection: "scim",
          itemId: path.split("/").pop() || null,
          payload: {
            method,
            path,
            tokenLabel: token.label,
          },
        });
      } catch (err) {
        console.error("Failed to log SCIM activity", formatSafeError(err));
      }
    }
  }
});

// ── helpers ────────────────────────────────────────────────────────────────

interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: { givenName?: string | null; familyName?: string | null };
  emails: Array<{ value: string; primary: boolean }>;
  active: boolean;
  meta: { resourceType: "User"; created?: string; lastModified?: string };
}


function siteUserIds(siteId: string) {
  return (db: AppEnv["Variables"]["db"]) =>
    db.select({ id: userSites.userId }).from(userSites).where(eq(userSites.siteId, siteId));
}

async function getSiteUser(db: AppEnv["Variables"]["db"], siteId: string, id: string) {
  const [row] = await db
    .select({
      id: users.id,
      externalId: users.externalId,
      passwordHash: users.passwordHash,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatar: users.avatar,
      status: users.status,
      preferences: users.preferences,
      tfa: users.tfa,
      lastSeenAt: users.lastSeenAt,
      isBootstrap: users.isBootstrap,
      lockedUntil: users.lockedUntil,
      failedCount: users.failedCount,
      failedCountWindowStart: users.failedCountWindowStart,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .innerJoin(userSites, eq(users.id, userSites.userId))
    .where(and(eq(userSites.siteId, siteId), eq(users.id, id)))
    .limit(1);

  return row;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toScimUser(u: any): ScimUser {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    externalId: u.externalId,
    userName: u.email,
    name: { givenName: u.firstName, familyName: u.lastName },
    emails: [{ value: u.email, primary: true }],
    active: u.status === "active",
    meta: {
      resourceType: "User",
      created: u.createdAt?.toISOString?.() ?? undefined,
      lastModified: u.updatedAt?.toISOString?.() ?? undefined,
    },
  };
}

function parseFilter(filter: string): { field?: string; value?: string } {
  // Accept simple filters: `userName eq "alice@example.com"`
  const match = filter.match(/^(\w+)\s+eq\s+"([^"]+)"$/);
  if (!match) return {};
  return { field: match[1], value: match[2] };
}

// ── service provider config ───────────────────────────────────────────────

scimRouter.get("/ServiceProviderConfig", (c) =>
  c.json({
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://docs.lumibase.dev/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        name: "Bearer",
        description: "OAuth Bearer Token",
        type: "oauthbearertoken",
      },
    ],
  }),
);

scimRouter.get("/Schemas", (c) =>
  c.json({
    schemas: [SCIM_LIST_RESPONSE],
    totalResults: 2,
    Resources: [{ id: SCIM_USER_SCHEMA }, { id: SCIM_GROUP_SCHEMA }],
  }),
);

scimRouter.get("/ResourceTypes", (c) =>
  c.json({
    schemas: [SCIM_LIST_RESPONSE],
    totalResults: 2,
    Resources: [
      {
        id: "User",
        name: "User",
        endpoint: "/Users",
        schema: SCIM_USER_SCHEMA,
      },
      {
        id: "Group",
        name: "Group",
        endpoint: "/Groups",
        schema: SCIM_GROUP_SCHEMA,
      },
    ],
  }),
);

// ── /Users ─────────────────────────────────────────────────────────────────

scimRouter.get("/Users", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const filter = c.req.query("filter");

  let rows;
  const selectSiteUsers = () =>
    db
      .select({
        id: users.id,
        externalId: users.externalId,
        passwordHash: users.passwordHash,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        avatar: users.avatar,
        status: users.status,
        preferences: users.preferences,
        tfa: users.tfa,
        lastSeenAt: users.lastSeenAt,
        isBootstrap: users.isBootstrap,
        lockedUntil: users.lockedUntil,
        failedCount: users.failedCount,
        failedCountWindowStart: users.failedCountWindowStart,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .innerJoin(userSites, eq(users.id, userSites.userId));

  if (filter) {
    const parsed = parseFilter(filter);
    if (parsed.field === "userName" && parsed.value) {
      // RFC 7643 §4.1.1: userName is caseExact=false. Identity-aware (#794):
      // under `root` mode an alias finds the account it resolves to.
      const { where } = await emailLookup(db, parsed.value);
      rows = await selectSiteUsers().where(and(eq(userSites.siteId, siteId), where));
    } else if (parsed.field === "externalId" && parsed.value) {
      rows = await selectSiteUsers().where(and(eq(userSites.siteId, siteId), eq(users.externalId, parsed.value)));
    } else {
      rows = await selectSiteUsers().where(
        and(eq(userSites.siteId, siteId), or(ilike(users.email, containsPattern(parsed.value ?? "")))),
      );
    }
  } else {
    rows = await selectSiteUsers().where(eq(userSites.siteId, siteId)).limit(200);
  }

  return c.json({
    schemas: [SCIM_LIST_RESPONSE],
    totalResults: rows.length,
    startIndex: 1,
    itemsPerPage: rows.length,
    Resources: rows.map(toScimUser),
  });
});

scimRouter.get("/Users/:id", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const id = c.req.param("id");
  const row = await getSiteUser(db, siteId, id);
  if (!row) {
    return c.json(
      { schemas: [SCIM_ERROR], status: "404", detail: "User not found" },
      404,
    );
  }
  return c.json(toScimUser(row));
});

scimRouter.post("/Users", async (c) => {
  const db = c.get("db");
  const body = (await c.req.json()) as Partial<ScimUser> & {
    password?: string;
  };

  if (!body.userName) {
    return c.json(
      { schemas: [SCIM_ERROR], status: "400", detail: "userName required" },
      400,
    );
  }

  const siteId = c.get("siteId");
  const userName = body.userName;
  // Account + membership commit together (#794): an address that is taken —
  // exactly, as an alias under `root` mode, or as an alias of an existing
  // member of a `strict` site — answers RFC 7644 §3.3 409 `uniqueness`
  // instead of a 500 or an orphan account.
  let created: (typeof users.$inferSelect) | undefined;
  try {
    created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({
          externalId: body.externalId ?? userName,
          email: userName,
          firstName: body.name?.givenName ?? null,
          lastName: body.name?.familyName ?? null,
          status: body.active === false ? "suspended" : "active",
        })
        .returning();
      if (row) {
        await tx
          .insert(userSites)
          .values({ userId: row.id, siteId })
          .onConflictDoNothing({ target: [userSites.userId, userSites.siteId] });
      }
      return row;
    });
  } catch (err) {
    if (isEmailIdentityConflict(err)) return scimUniqueness(c);
    throw err;
  }

  return c.json(toScimUser(created), 201);
});

scimRouter.put("/Users/:id", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const id = c.req.param("id");
  const body = (await c.req.json()) as Partial<ScimUser>;

  let updated: Array<typeof users.$inferSelect>;
  try {
    updated = await db
      .update(users)
      .set({
        email: body.userName ?? undefined,
        firstName: body.name?.givenName ?? null,
        lastName: body.name?.familyName ?? null,
        status: body.active === false ? "suspended" : "active",
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, id), inArray(users.id, siteUserIds(siteId)(db))))
      .returning();
  } catch (err) {
    // A new userName that another account (or strict-site member) already owns.
    if (isEmailIdentityConflict(err)) return scimUniqueness(c);
    throw err;
  }

  if (updated.length === 0) {
    return c.json(
      { schemas: [SCIM_ERROR], status: "404", detail: "User not found" },
      404,
    );
  }
  return c.json(toScimUser(updated[0]));
});

scimRouter.patch("/Users/:id", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const id = c.req.param("id");
  const body = (await c.req.json()) as {
    Operations?: Array<{ op: string; path?: string; value?: unknown }>;
  };

  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const op of body.Operations ?? []) {
    if (op.op.toLowerCase() === "replace") {
      if (op.path === "active")
        set["status"] = op.value ? "active" : "suspended";
      else if (op.path === "name.givenName") set["firstName"] = op.value;
      else if (op.path === "name.familyName") set["lastName"] = op.value;
      else if (op.path === "userName") set["email"] = op.value;
    }
  }

  let updated: Array<typeof users.$inferSelect>;
  try {
    updated = await db
      .update(users)
      .set(set)
      .where(and(eq(users.id, id), inArray(users.id, siteUserIds(siteId)(db))))
      .returning();
  } catch (err) {
    if (isEmailIdentityConflict(err)) return scimUniqueness(c);
    throw err;
  }
  if (updated.length === 0) {
    return c.json(
      { schemas: [SCIM_ERROR], status: "404", detail: "User not found" },
      404,
    );
  }
  return c.json(toScimUser(updated[0]));
});

scimRouter.delete("/Users/:id", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const id = c.req.param("id");
  const updated = await db
    .update(users)
    .set({ status: "suspended", updatedAt: new Date() })
    .where(and(eq(users.id, id), inArray(users.id, siteUserIds(siteId)(db))))
    .returning({ id: users.id });
  if (updated.length === 0) {
    return c.json(
      { schemas: [SCIM_ERROR], status: "404", detail: "User not found" },
      404,
    );
  }
  return c.body(null, 204);
});

// ── /Groups (mapped to LumiBase teams) ────────────────────────────────────

scimRouter.get("/Groups", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");
  const rows = await db.select().from(teams).where(eq(teams.siteId, siteId)).limit(200);

  return c.json({
    schemas: [SCIM_LIST_RESPONSE],
    totalResults: rows.length,
    startIndex: 1,
    itemsPerPage: rows.length,
    Resources: rows.map((t) => ({
      schemas: [SCIM_GROUP_SCHEMA],
      id: t.id,
      displayName: t.name,
      meta: { resourceType: "Group" },
    })),
  });
});

scimRouter.post("/Groups", async (c) => {
  const db = c.get("db");
  const siteId = c.get("siteId");

  const body = (await c.req.json()) as {
    displayName: string;
    members?: Array<{ value: string }>;
  };
  const inserted = await db
    .insert(teams)
    .values({ siteId, name: body.displayName })
    .returning();

  if (body.members?.length) {
    for (const m of body.members) {
      await db
        .insert(teamMembers)
        .values({ teamId: inserted[0]!.id, userId: m.value })
        .onConflictDoNothing();
      await db
        .insert(userSites)
        .values({ userId: m.value, siteId })
        .onConflictDoNothing();
    }
  }

  return c.json(
    {
      schemas: [SCIM_GROUP_SCHEMA],
      id: inserted[0]!.id,
      displayName: inserted[0]!.name,
      meta: { resourceType: "Group" },
    },
    201,
  );
});
