/**
 * Marketplace routes — POST-GA5.
 *
 * Public discovery + install path for signed extensions.
 *
 *   GET  /api/v1/marketplace/extensions             list published extensions
 *   GET  /api/v1/marketplace/extensions/:slug       detail (signature included)
 *   POST /api/v1/marketplace/extensions/:slug/install
 *                                                   install into the active site
 *   POST /api/v1/marketplace/publish                publish an extension
 *
 * Signature verification:
 *   - Extensions ship with a detached signature (`signature`) over the
 *     SHA-256 of the bundle. Public keys live in the env var
 *     `MARKETPLACE_PUBLIC_KEYS` as a JSON map `{ keyId: pem }`.
 *   - On install, we recompute the bundle hash and verify the signature
 *     using WebCrypto (`subtle.verify`).
 */

import { extensions, extensionVotes, userSites, notifications, roles } from "@lumibase/database";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { PermissionService } from "../services/permission-service";
import { ExtensionVerifierService } from "../services/extension-verifier";

export const marketplaceRouter = new Hono<AppEnv>();

// ── helpers ────────────────────────────────────────────────────────────────

function permissionCtx(c: Context<AppEnv>) {
  const auth = c.get("auth");
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    userId: auth?.userId ?? null,
    siteId: c.get("siteId"),
    roleId: auth?.roleId ?? null,
    user: auth ? { id: auth.userId ?? null, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : null,
    ip: c.get("ip") ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null,
    headers,
    apiKey: auth?.apiKey ?? null,
  };
}

async function requireInstallPermission(c: Context<AppEnv>): Promise<Response | null> {
  const perm = await new PermissionService({
    db: c.get("db"),
    cache: c.get("runtime").cache,
    ctx: permissionCtx(c),
  }).canAccess("extensions", "install");

  if (perm) return null;
  return c.json(
    { errors: [{ code: "FORBIDDEN", message: 'Action "extensions:install" is not allowed.' }] },
    403,
  );
}

function extensionKey(input: { key?: string | null; marketplaceSlug?: string | null; name: string }): string {
  return (input.key ?? input.marketplaceSlug ?? input.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((num) => parseInt(num, 10) || 0);
  const pb = b.split(".").map((num) => parseInt(num, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

type MarketplaceManifest = Record<string, unknown> & {
  name?: string;
  description?: string;
  readme?: string;
  category?: string;
  tags?: unknown;
  publisher?: string;
  marketplace?: Record<string, unknown>;
  repositoryUrl?: string;
  documentationUrl?: string;
  license?: string;
  licenseType?: string;
};

type ExtensionRow = typeof extensions.$inferSelect;

const DEFAULT_PAGE = 1;
const DEFAULT_PER_PAGE = 12;
const MAX_PER_PAGE = 50;

function asManifest(input: unknown): MarketplaceManifest {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as MarketplaceManifest;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function catalogValue(manifest: MarketplaceManifest, key: string): unknown {
  return manifest.marketplace?.[key] ?? manifest[key];
}

function latestPublishedRows(rows: ExtensionRow[]): ExtensionRow[] {
  const bySlug = new Map<string, ExtensionRow>();

  for (const row of rows) {
    const slug = row.marketplaceSlug ?? row.key ?? row.name;
    const current = bySlug.get(slug);
    if (!current || compareSemver(row.version, current.version) > 0) {
      bySlug.set(slug, row);
    }
  }

  return [...bySlug.values()];
}

interface CatalogProjectionOpts {
  /** Total upvotes for the listing (across versions). */
  voteCount?: number;
  /** Whether the requesting user has already upvoted. */
  hasVoted?: boolean;
}

function toCatalogExtension(row: ExtensionRow, opts: CatalogProjectionOpts = {}) {
  const manifest = asManifest(row.manifest);
  const slug = row.marketplaceSlug ?? row.key ?? extensionKey(row);
  const category = asString(catalogValue(manifest, "category")) ?? row.type;
  const tags = asTags(catalogValue(manifest, "tags"));
  const publisherName =
    asString(catalogValue(manifest, "publisherName")) ??
    asString(manifest.publisher) ??
    row.publisher ??
    "Unknown publisher";
  const description =
    asString(catalogValue(manifest, "description")) ??
    `${row.name} extension for LumiBase.`;

  return {
    id: row.id,
    slug,
    marketplaceSlug: slug,
    name: asString(catalogValue(manifest, "name")) ?? row.name,
    description,
    readme: asString(catalogValue(manifest, "readme")) ?? description,
    category,
    tags,
    publisherName,
    publisher: publisherName,
    latestVersion: row.version,
    version: row.version,
    type: row.type,
    totalDownloads: row.downloadCount ?? 0,
    voteCount: opts.voteCount ?? 0,
    hasVoted: opts.hasVoted ?? false,
    /**
     * Trusted source signal driving the "verified" badge. Prefer the persisted
     * `verifiedAt` (set only after a real crypto check at publish/install) or
     * the server-derived `isOfficial`; fall back to the presence of signature
     * fields for legacy rows published before verification was recorded.
     */
    verified: Boolean(
      row.verifiedAt ||
        row.isOfficial ||
        (row.signature && row.publisherKeyId && row.bundleSha256),
    ),
    rating: null,
    ratingCount: null,
    versions: [
      {
        id: row.id,
        version: row.version,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        sha256: row.bundleSha256,
      },
    ],
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.publishedAt?.toISOString() ?? null,
    repositoryUrl: asString(catalogValue(manifest, "repositoryUrl")),
    documentationUrl: asString(catalogValue(manifest, "documentationUrl")),
    licenseType:
      asString(catalogValue(manifest, "licenseType")) ??
      asString(catalogValue(manifest, "license")),
    manifest: row.manifest,
    bundleUrl: row.bundleUrl,
    bundleSha256: row.bundleSha256,
    signature: row.signature,
    signatureAlg: row.signatureAlg,
    publisherKeyId: row.publisherKeyId,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  const integer = Math.floor(parsed);
  return max ? Math.min(integer, max) : integer;
}

/**
 * Load raw vote rows for the given slugs. Aggregated in JS (consistent with the
 * catalog which already materialises rows in memory) so callers can derive both
 * per-slug counts and the caller's own vote state from a single query.
 */
async function loadVotes(
  db: AppEnv["Variables"]["db"],
  slugs: string[],
): Promise<Array<{ marketplaceSlug: string; userId: string }>> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select()
    .from(extensionVotes)
    .where(inArray(extensionVotes.marketplaceSlug, slugs));
  return rows.map((r) => ({ marketplaceSlug: r.marketplaceSlug, userId: r.userId }));
}

function tallyVotes(
  votes: Array<{ marketplaceSlug: string; userId: string }>,
  userId: string | null,
): { counts: Map<string, number>; voted: Set<string> } {
  const counts = new Map<string, number>();
  const voted = new Set<string>();
  for (const v of votes) {
    counts.set(v.marketplaceSlug, (counts.get(v.marketplaceSlug) ?? 0) + 1);
    if (userId && v.userId === userId) voted.add(v.marketplaceSlug);
  }
  return { counts, voted };
}

function currentUserId(c: Context<AppEnv>): string | null {
  return c.get("auth")?.userId ?? null;
}

// ── routes ─────────────────────────────────────────────────────────────────

marketplaceRouter.get("/extensions", async (c) => {
  const db = c.get("db");
  const q = c.req.query("q")?.trim().toLowerCase() ?? "";
  const category = c.req.query("category")?.trim().toLowerCase() ?? "";
  const tagQuery = c.req.query("tags") ?? "";
  const tags = tagQuery
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const sort = c.req.query("sort") ?? "latest";
  const page = parsePositiveInt(c.req.query("page"), DEFAULT_PAGE);
  const perPage = parsePositiveInt(c.req.query("perPage"), DEFAULT_PER_PAGE, MAX_PER_PAGE);

  const rows = await db
    .select()
    .from(extensions)
    .where(and(isNull(extensions.siteId), isNotNull(extensions.publishedAt)));

  let catalog = latestPublishedRows(rows).map((row) => toCatalogExtension(row));

  if (q) {
    catalog = catalog.filter((ext) => {
      const haystack = [
        ext.name,
        ext.description,
        ext.publisherName,
        ext.slug,
        ext.category,
        ...ext.tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  if (category) {
    catalog = catalog.filter((ext) => ext.category.toLowerCase() === category);
  }

  if (tags.length > 0) {
    catalog = catalog.filter((ext) =>
      tags.some((tag) => ext.tags.map((t) => t.toLowerCase()).includes(tag)),
    );
  }

  if (sort === "name") {
    catalog.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // `popular` falls back to latest until download metrics exist.
    catalog.sort((a, b) => {
      const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  const total = catalog.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const pageItems = catalog.slice(start, start + perPage);

  // Attach vote metrics only for the current page's listings.
  const votes = await loadVotes(db, pageItems.map((ext) => ext.slug));
  const { counts, voted } = tallyVotes(votes, currentUserId(c));
  const data = pageItems.map((ext) => ({
    ...ext,
    voteCount: counts.get(ext.slug) ?? 0,
    hasVoted: voted.has(ext.slug),
  }));

  return c.json({
    data,
    total,
    page,
    perPage,
    totalPages,
  });
});

marketplaceRouter.get("/extensions/:slug", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");
  const rows = await db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.marketplaceSlug, slug),
        isNull(extensions.siteId),
        isNotNull(extensions.publishedAt),
      ),
    );
  const [row] = latestPublishedRows(rows);
  if (!row)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Extension not found" }] },
      404,
    );

  const votes = await loadVotes(db, [slug]);
  const { counts, voted } = tallyVotes(votes, currentUserId(c));

  return c.json({
    data: toCatalogExtension(row, {
      voteCount: counts.get(slug) ?? 0,
      hasVoted: voted.has(slug),
    }),
  });
});

// ── package download ─────────────────────────────────────────────────────────
// Public "Download package" action. Bumps the download counter and hands back
// the signed bundle location so the client can save it without installing.
marketplaceRouter.get("/extensions/:slug/download", async (c) => {
  const db = c.get("db");
  const slug = c.req.param("slug");

  const rows = await db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.marketplaceSlug, slug),
        isNull(extensions.siteId),
        isNotNull(extensions.publishedAt),
      ),
    );
  const [row] = latestPublishedRows(rows);
  if (!row)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Extension not found" }] },
      404,
    );

  await db
    .update(extensions)
    .set({ downloadCount: (row.downloadCount ?? 0) + 1 })
    .where(eq(extensions.id, row.id));

  // A redirect keeps large bundles off the Worker; `?redirect=0` returns JSON
  // for programmatic clients that want the metadata (hash/signature) too.
  if (c.req.query("redirect") === "0") {
    return c.json({
      data: {
        slug,
        version: row.version,
        bundleUrl: row.bundleUrl,
        bundleSha256: row.bundleSha256,
        signature: row.signature,
        signatureAlg: row.signatureAlg,
        publisherKeyId: row.publisherKeyId,
        downloadCount: (row.downloadCount ?? 0) + 1,
      },
    });
  }
  return c.redirect(row.bundleUrl, 302);
});

// ── voting ────────────────────────────────────────────────────────────────────
async function slugIsPublished(
  db: AppEnv["Variables"]["db"],
  slug: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.marketplaceSlug, slug),
        isNull(extensions.siteId),
        isNotNull(extensions.publishedAt),
      ),
    );
  return rows.length > 0;
}

marketplaceRouter.post("/extensions/:slug/vote", async (c) => {
  const userId = currentUserId(c);
  if (!userId)
    return c.json(
      { errors: [{ code: "UNAUTHORIZED", message: "Sign in to vote." }] },
      401,
    );

  const db = c.get("db");
  const slug = c.req.param("slug");

  if (!(await slugIsPublished(db, slug)))
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Extension not found" }] },
      404,
    );

  // Idempotent: the unique (user, slug) index absorbs repeat votes.
  await db
    .insert(extensionVotes)
    .values({ id: nanoid(), marketplaceSlug: slug, userId })
    .onConflictDoNothing();

  const votes = await loadVotes(db, [slug]);
  const { counts } = tallyVotes(votes, userId);
  return c.json({ data: { slug, voteCount: counts.get(slug) ?? 0, hasVoted: true } });
});

marketplaceRouter.delete("/extensions/:slug/vote", async (c) => {
  const userId = currentUserId(c);
  if (!userId)
    return c.json(
      { errors: [{ code: "UNAUTHORIZED", message: "Sign in to vote." }] },
      401,
    );

  const db = c.get("db");
  const slug = c.req.param("slug");

  await db
    .delete(extensionVotes)
    .where(
      and(
        eq(extensionVotes.marketplaceSlug, slug),
        eq(extensionVotes.userId, userId),
      ),
    );

  const votes = await loadVotes(db, [slug]);
  const { counts } = tallyVotes(votes, userId);
  return c.json({ data: { slug, voteCount: counts.get(slug) ?? 0, hasVoted: false } });
});

marketplaceRouter.get("/updates", async (c) => {
  const siteId = c.get("siteId");
  const db = c.get("db");

  const installedList = await db
    .select()
    .from(extensions)
    .where(and(eq(extensions.siteId, siteId)));

  const updates: Array<{
    installedId: string;
    name: string;
    currentVersion: string;
    latestVersion: string;
    bundleUrl: string;
    bundleSha256: string | null;
  }> = [];

  for (const installed of installedList) {
    const query = installed.marketplaceSlug
      ? eq(extensions.marketplaceSlug, installed.marketplaceSlug)
      : eq(extensions.name, installed.name);

    const globals = await db
      .select()
      .from(extensions)
      .where(
        and(query, isNull(extensions.siteId), isNotNull(extensions.publishedAt)),
      );

    let latestGlobal = null;
    for (const g of globals) {
      if (compareSemver(g.version, installed.version) > 0) {
        if (!latestGlobal || compareSemver(g.version, latestGlobal.version) > 0) {
          latestGlobal = g;
        }
      }
    }

    if (latestGlobal) {
      updates.push({
        installedId: installed.id,
        name: installed.name,
        currentVersion: installed.version,
        latestVersion: latestGlobal.version,
        bundleUrl: latestGlobal.bundleUrl,
        bundleSha256: latestGlobal.bundleSha256,
      });
    }
  }

  return c.json({ data: updates });
});

marketplaceRouter.post("/extensions/:slug/install", async (c) => {
  const denied = await requireInstallPermission(c);
  if (denied) return denied;

  const siteId = c.get("siteId");
  const db = c.get("db");
  const slug = c.req.param("slug");

  const [source] = await db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.marketplaceSlug, slug),
        isNull(extensions.siteId),
        isNotNull(extensions.publishedAt),
      ),
    );
  if (!source)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Not found" }] },
      404,
    );

  // Verify the bundle signature (mandatory + fail-closed for official
  // `lumibase-*`; policy-driven for third-party). The verifier fetches the
  // bundle (SSRF-guarded), re-hashes it, resolves the publisher key (DB over
  // env), and derives the official flag server-side.
  const verifier = new ExtensionVerifierService(db, c.env);
  const verdict = await verifier.verifyByMetadata(source.name, {
    bundleUrl: source.bundleUrl,
    bundleSha256: source.bundleSha256,
    signature: source.signature,
    publisherKeyId: source.publisherKeyId,
    signatureAlg: source.signatureAlg,
  });

  const requireSignature =
    ExtensionVerifierService.isReservedName(source.name) ||
    (c.env.LUMIBASE_EXT_SIGNATURE_POLICY ?? "require") !== "warn";

  if (requireSignature && !verdict.ok) {
    return c.json(
      { errors: [{ code: "SIGNATURE_INVALID", message: `Signature check failed: ${verdict.reason}` }] },
      400,
    );
  }
  // A reserved `lumibase-*` name that verifies but is NOT signed by an official
  // key must never be installed as official (namespace squat protection).
  if (ExtensionVerifierService.isReservedName(source.name) && !verdict.isOfficial) {
    return c.json(
      { errors: [{ code: "RESERVED_NAMESPACE", message: "lumibase-* requires an official signature" }] },
      400,
    );
  }

  // Clone the marketplace row into the site's installation row.
  const installed = await db
    .insert(extensions)
    .values({
      siteId,
      key: extensionKey(source),
      name: source.name,
      version: source.version,
      type: source.type,
      enabled: source.enabledByDefault,
      enabledByDefault: source.enabledByDefault,
      autoInstall: source.autoInstall,
      isOfficial: verdict.isOfficial,
      verifiedAt: verdict.ok ? new Date() : null,
      bundleUrl: source.bundleUrl,
      manifest: source.manifest,
      capabilities: [],
      bundleSha256: source.bundleSha256,
      signature: source.signature,
      signatureAlg: source.signatureAlg,
      publisherKeyId: source.publisherKeyId,
      publisher: source.publisher,
      marketplaceSlug: source.marketplaceSlug,
    })
    .returning();

  return c.json({ data: installed[0] }, 201);
});

const publishSchema = z.object({
  extensionId: z.string(),
  marketplaceSlug: z.string().regex(/^[a-z0-9-]+$/),
  publisher: z.string().min(1),
  signature: z.string().min(1),
  signatureAlg: z.enum(["ed25519", "rsa-pss-sha256"]).default("ed25519"),
  publisherKeyId: z.string().min(1),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

marketplaceRouter.post("/publish", async (c) => {
  // Publishing writes the SHARED global catalog (siteId null) that every tenant
  // reads, so it is a moderator action — gate it like /submissions/review.
  // Without this, any authenticated user with a site membership could publish
  // or overwrite arbitrary global listings and spoof the "verified" badge.
  const denied = await requireConfigurePermission(c);
  if (denied) return denied;

  const db = c.get("db");
  const parsed = publishSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({
          code: "VALIDATION",
          message: i.message,
        })),
      },
      400,
    );
  }

  // Load the target global row first: we need its stored bundle + submission
  // state to verify against before trusting any client-supplied signature.
  const [target] = await db
    .select()
    .from(extensions)
    .where(
      and(eq(extensions.id, parsed.data.extensionId), isNull(extensions.siteId)),
    );

  if (!target)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Extension not found" }] },
      404,
    );

  // A community submission must clear moderation before it can go live — a
  // moderator cannot publish a `pending`/`rejected` row and skip review.
  // Direct-publish official rows have `submissionStatus` null and are exempt.
  if (target.submissionStatus && target.submissionStatus !== "approved") {
    return c.json(
      {
        errors: [
          {
            code: "NOT_APPROVED",
            message: "Submission must be approved before it can be published.",
          },
        ],
      },
      409,
    );
  }

  // Verify the supplied signature against the STORED bundle before persisting
  // it (server-derives `isOfficial`; never trusts a client claim). Mirrors the
  // install-time gate: reserved `lumibase-*` must be signed by an official key.
  const verifier = new ExtensionVerifierService(db, c.env);
  const verdict = await verifier.verifyByMetadata(target.name, {
    bundleUrl: target.bundleUrl,
    bundleSha256: parsed.data.bundleSha256,
    signature: parsed.data.signature,
    publisherKeyId: parsed.data.publisherKeyId,
    signatureAlg: parsed.data.signatureAlg,
  });

  const requireSignature =
    ExtensionVerifierService.isReservedName(target.name) ||
    (c.env.LUMIBASE_EXT_SIGNATURE_POLICY ?? "require") !== "warn";

  if (requireSignature && !verdict.ok) {
    return c.json(
      {
        errors: [
          {
            code: "SIGNATURE_INVALID",
            message: `Signature check failed: ${verdict.reason}`,
          },
        ],
      },
      400,
    );
  }
  if (ExtensionVerifierService.isReservedName(target.name) && !verdict.isOfficial) {
    return c.json(
      {
        errors: [
          {
            code: "RESERVED_NAMESPACE",
            message: "lumibase-* requires an official signature",
          },
        ],
      },
      400,
    );
  }

  const updated = await db
    .update(extensions)
    .set({
      key: parsed.data.marketplaceSlug,
      marketplaceSlug: parsed.data.marketplaceSlug,
      publisher: parsed.data.publisher,
      signature: parsed.data.signature,
      signatureAlg: parsed.data.signatureAlg,
      publisherKeyId: parsed.data.publisherKeyId,
      bundleSha256: parsed.data.bundleSha256,
      // Server-derived trust signals — drive the "verified" badge, never the
      // client's word.
      isOfficial: verdict.isOfficial,
      verifiedAt: verdict.ok ? new Date() : null,
      publishedAt: new Date(),
    })
    .where(
      and(eq(extensions.id, parsed.data.extensionId), isNull(extensions.siteId)),
    )
    .returning();

  if (updated.length === 0)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Extension not found" }] },
      404,
    );

  const source = updated[0]!;

  const query = source.marketplaceSlug
    ? eq(extensions.marketplaceSlug, source.marketplaceSlug)
    : eq(extensions.name, source.name);

  const installedOutdated = await db
    .select()
    .from(extensions)
    .where(and(query, isNotNull(extensions.siteId)));

  const outdatedExtensions = installedOutdated.filter(
    (installed) => compareSemver(source.version, installed.version) > 0
  );

  if (outdatedExtensions.length > 0) {
    const siteIds = Array.from(new Set(outdatedExtensions.map(e => e.siteId!)));

    // Fetch all admins for all affected sites in a single query
    const admins = await db
      .select({ userId: userSites.userId, siteId: userSites.siteId })
      .from(userSites)
      .innerJoin(
        roles,
        and(
          eq(roles.id, userSites.roleId),
          eq(roles.adminAccess, true),
        ),
      )
      .where(inArray(userSites.siteId, siteIds));

    // Group admins by siteId for fast lookup
    const adminsBySite = new Map<string, string[]>();
    for (const admin of admins) {
      const list = adminsBySite.get(admin.siteId!) || [];
      list.push(admin.userId);
      adminsBySite.set(admin.siteId!, list);
    }

    // Prepare notifications for all admins
    const pendingNotifications = [];
    for (const installed of outdatedExtensions) {
      const siteAdmins = adminsBySite.get(installed.siteId!) || [];
      for (const adminUserId of siteAdmins) {
        pendingNotifications.push({
          siteId: installed.siteId!,
          recipient: adminUserId,
          subject: "Extension Update Available",
          message: `A new version ${source.version} of extension '${installed.name}' is available. You are currently running ${installed.version}.`,
          status: "unread",
          pushed: false,
        });
      }
    }

    // Insert all notifications in a single batch query
    if (pendingNotifications.length > 0) {
      await db.insert(notifications).values(pendingNotifications);
    }
  }

  return c.json({ data: source });
});

// ── community submissions ─────────────────────────────────────────────────────
// Any authenticated user can propose an extension for the catalog. The listing
// lands in `submission_status = 'pending'` and unpublished (`publishedAt` null),
// so it never appears in the public catalog until a moderator approves and a
// signed bundle is published via /publish.

async function requireConfigurePermission(
  c: Context<AppEnv>,
): Promise<Response | null> {
  const perm = await new PermissionService({
    db: c.get("db"),
    cache: c.get("runtime").cache,
    ctx: permissionCtx(c),
  }).canAccess("extensions", "configure");

  if (perm) return null;
  return c.json(
    {
      errors: [
        {
          code: "FORBIDDEN",
          message: 'Action "extensions:configure" is not allowed.',
        },
      ],
    },
    403,
  );
}

const submitSchema = z.object({
  name: z.string().min(1).max(120),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+([-.+][0-9A-Za-z-.]+)?$/, "Expected SemVer version"),
  type: z.enum([
    "hook",
    "endpoint",
    "operation",
    "interface",
    "display",
    "layout",
    "panel",
    "module",
  ]),
  marketplaceSlug: z.string().regex(/^[a-z0-9-]+$/),
  bundleUrl: z.string().url(),
  bundleSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  description: z.string().max(2000).optional(),
  publisher: z.string().min(1).max(120).optional(),
  repositoryUrl: z.string().url().optional(),
  capabilities: z.array(z.string()).max(100).optional(),
});

marketplaceRouter.post("/submit", async (c) => {
  const userId = currentUserId(c);
  if (!userId)
    return c.json(
      { errors: [{ code: "UNAUTHORIZED", message: "Sign in to submit." }] },
      401,
    );

  const db = c.get("db");
  const parsed = submitSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({
          code: "VALIDATION",
          message: `${i.path.join(".") || "(root)"}: ${i.message}`,
        })),
      },
      400,
    );
  }
  const input = parsed.data;

  // Reserved namespace: community `/submit` is unsigned, so it must never claim
  // a `lumibase-*` name/slug. Official extensions ship via signed `/publish`.
  if (
    ExtensionVerifierService.isReservedName(input.name) ||
    ExtensionVerifierService.isReservedName(input.marketplaceSlug)
  ) {
    return c.json(
      {
        errors: [
          {
            code: "RESERVED_NAMESPACE",
            message: 'The "lumibase-" namespace is reserved for official extensions.',
          },
        ],
      },
      400,
    );
  }

  // Guard the namespace: a slug already live in the public catalog can only be
  // updated by its publisher through /publish, not re-claimed via /submit.
  const existingPublished = await db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.marketplaceSlug, input.marketplaceSlug),
        isNull(extensions.siteId),
        isNotNull(extensions.publishedAt),
      ),
    );
  if (existingPublished.length > 0)
    return c.json(
      {
        errors: [
          {
            code: "SLUG_TAKEN",
            message: `Slug "${input.marketplaceSlug}" is already published.`,
          },
        ],
      },
      409,
    );

  const manifest: MarketplaceManifest = {
    name: input.name,
    marketplace: {
      description: input.description,
      publisherName: input.publisher,
      repositoryUrl: input.repositoryUrl,
    },
  };

  const submitted = await db
    .insert(extensions)
    .values({
      siteId: null,
      key: input.marketplaceSlug,
      name: input.name,
      version: input.version,
      type: input.type,
      enabled: false,
      bundleUrl: input.bundleUrl,
      manifest,
      capabilities: input.capabilities ?? [],
      bundleSha256: input.bundleSha256 ?? null,
      publisher: input.publisher ?? null,
      marketplaceSlug: input.marketplaceSlug,
      publishedAt: null,
      submissionStatus: "pending",
      submittedBy: userId,
    })
    .returning();

  return c.json({ data: submitted[0] }, 201);
});

// List submissions for moderation (defaults to pending).
marketplaceRouter.get("/submissions", async (c) => {
  const denied = await requireConfigurePermission(c);
  if (denied) return denied;

  const db = c.get("db");
  const status = c.req.query("status") ?? "pending";

  const rows = await db
    .select()
    .from(extensions)
    .where(
      and(isNull(extensions.siteId), eq(extensions.submissionStatus, status)),
    );

  return c.json({ data: rows });
});

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
});

// Moderate a submission. Approving marks it reviewed; publishing to the public
// catalog still requires a signed bundle via /publish.
marketplaceRouter.post("/submissions/:id/review", async (c) => {
  const denied = await requireConfigurePermission(c);
  if (denied) return denied;

  const db = c.get("db");
  const id = c.req.param("id");
  const parsed = reviewSchema.safeParse(await c.req.json());
  if (!parsed.success)
    return c.json(
      {
        errors: parsed.error.issues.map((i) => ({
          code: "VALIDATION",
          message: i.message,
        })),
      },
      400,
    );

  const nextStatus = parsed.data.action === "approve" ? "approved" : "rejected";

  const updated = await db
    .update(extensions)
    .set({ submissionStatus: nextStatus })
    .where(
      and(
        eq(extensions.id, id),
        isNull(extensions.siteId),
        isNotNull(extensions.submissionStatus),
      ),
    )
    .returning();

  if (updated.length === 0)
    return c.json(
      { errors: [{ code: "NOT_FOUND", message: "Submission not found" }] },
      404,
    );

  return c.json({ data: updated[0] });
});
