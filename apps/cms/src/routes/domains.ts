import { siteDomains } from '@lumibase/database';
import {
  DomainCreateSchema,
  FREE_DOMAIN_SUFFIX,
  type DomainResource,
  type DomainVerificationRecord,
} from '@lumibase/shared/schemas';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  CloudflareSaaSClient,
  cloudflareSaaSConfig,
  isHostnameLive,
} from '../services/domains/cloudflare-saas';
import { deleteHostMapping, putHostMapping } from '../services/domains/host-cache';

/**
 * Custom domains & free `*.lumibase.dev` subdomains (Enterprise feature).
 *
 * - Free subdomains (`kind: 'subdomain'`) go `active` immediately and write the
 *   host→site KV mapping so the tenant middleware resolves them at the edge.
 * - Custom domains (`kind: 'custom'`) are provisioned through Cloudflare for
 *   SaaS: we create a Custom Hostname, surface the DNS records the operator must
 *   publish, and flip to `active` (writing the KV mapping) once `POST /:id/verify`
 *   sees both the hostname and its certificate live.
 *
 * When the platform isn't configured for SaaS (self-hosted / Docker), custom
 * domains are created in `pending_dns` with manual DNS instructions instead of
 * calling Cloudflare.
 */
export const domainsRouter = new Hono<AppEnv>();

type DomainRow = typeof siteDomains.$inferSelect;

/** Strip internal columns and shape the row for the API. */
function toResource(row: DomainRow): DomainResource {
  const verification = (row.verification ?? {}) as { records?: DomainVerificationRecord[] };
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind as DomainResource['kind'],
    isPrimary: row.isPrimary,
    status: row.status as DomainResource['status'],
    statusReason: row.statusReason ?? null,
    sslStatus: row.sslStatus ?? null,
    verification: { records: verification.records ?? [] },
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function freeSuffix(c: { env: AppEnv['Bindings'] }): string {
  return c.env.LUMIBASE_FREE_DOMAIN_SUFFIX ?? FREE_DOMAIN_SUFFIX;
}

domainsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const rows = await db.select().from(siteDomains).where(eq(siteDomains.siteId, siteId));
  return c.json({ data: rows.map(toResource) });
});

domainsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;

  const body = await c.req.json().catch(() => ({}));
  const parsed = DomainCreateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] },
      400,
    );
  }
  const input = parsed.data;

  // Resolve the final FQDN. Subdomain labels expand under the free suffix.
  const hostname =
    input.kind === 'subdomain' ? `${input.hostname}.${freeSuffix(c)}` : input.hostname;

  // Build the insert. Free subdomains are live immediately; custom domains
  // either provision via Cloudflare or fall back to manual DNS instructions.
  let status: DomainRow['status'] = 'active';
  let sslStatus: string | null = null;
  let cfHostnameId: string | null = null;
  let records: DomainVerificationRecord[] = [];
  let statusReason: string | null = null;

  if (input.kind === 'custom') {
    const cfg = cloudflareSaaSConfig(c.env);
    if (cfg) {
      try {
        const state = await new CloudflareSaaSClient(cfg).createCustomHostname(hostname);
        cfHostnameId = state.cfHostnameId;
        sslStatus = state.sslStatus;
        records = state.records;
        status = isHostnameLive(state) ? 'active' : 'verifying';
      } catch (err) {
        status = 'failed';
        statusReason = err instanceof Error ? err.message : 'Cloudflare provisioning failed.';
      }
    } else {
      // Self-hosted: hand the operator manual DNS instructions.
      status = 'pending_dns';
      records = [
        {
          type: 'CNAME',
          name: hostname,
          value: c.env.LUMIBASE_SAAS_FALLBACK ?? `cname.${freeSuffix(c)}`,
          purpose: 'Point your domain at this LumiBase instance.',
        },
      ];
    }
  }

  let row: DomainRow | undefined;
  try {
    [row] = await db
      .insert(siteDomains)
      .values({
        siteId,
        hostname,
        kind: input.kind,
        status,
        statusReason,
        sslStatus,
        cfHostnameId,
        verification: { records },
        verifiedAt: status === 'active' ? new Date() : null,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      return c.json(
        { errors: [{ code: 'DOMAIN_TAKEN', message: 'That domain is already in use.' }] },
        409,
      );
    }
    throw err;
  }
  if (!row) {
    return c.json({ errors: [{ code: 'INTERNAL', message: 'Insert failed.' }] }, 500);
  }

  if (row.status === 'active' && cache) {
    await putHostMapping(cache, row.hostname, siteId);
  }

  return c.json({ data: toResource(row) }, 201);
});

/** Poll Cloudflare and advance the domain's status; write KV when it goes live. */
domainsRouter.post('/:id/verify', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const id = c.req.param('id');

  const row = await loadDomain(db, siteId, id);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);

  if (row.kind === 'subdomain') {
    // Free subdomains are always live; just (re)write the KV mapping.
    if (cache) await putHostMapping(cache, row.hostname, siteId);
    return c.json({ data: toResource(row) });
  }

  const cfg = cloudflareSaaSConfig(c.env);
  if (!cfg || !row.cfHostnameId) {
    return c.json({ data: toResource(row) });
  }

  const set: Partial<DomainRow> = { updatedAt: new Date() };
  try {
    const state = await new CloudflareSaaSClient(cfg).getCustomHostname(row.cfHostnameId);
    set.sslStatus = state.sslStatus;
    set.verification = { records: state.records };
    if (isHostnameLive(state)) {
      set.status = 'active';
      set.statusReason = null;
      set.verifiedAt = row.verifiedAt ?? new Date();
    } else {
      set.status = 'verifying';
    }
  } catch (err) {
    set.status = 'failed';
    set.statusReason = err instanceof Error ? err.message : 'Verification failed.';
  }

  const [updated] = await db
    .update(siteDomains)
    .set(set)
    .where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)))
    .returning();

  if (updated?.status === 'active' && cache) {
    await putHostMapping(cache, updated.hostname, siteId);
  }

  return c.json({ data: toResource(updated ?? row) });
});

/** Promote a domain to the site's canonical (primary) hostname. */
domainsRouter.post('/:id/primary', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');

  const row = await loadDomain(db, siteId, id);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);
  if (row.status !== 'active') {
    return c.json(
      { errors: [{ code: 'NOT_ACTIVE', message: 'Only an active domain can be primary.' }] },
      409,
    );
  }

  // Single primary per site: clear the rest, then set this one.
  await db
    .update(siteDomains)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(eq(siteDomains.siteId, siteId));
  const [updated] = await db
    .update(siteDomains)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)))
    .returning();

  return c.json({ data: toResource(updated ?? row) });
});

domainsRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const cache = c.get('runtime')?.cache;
  const id = c.req.param('id');

  const row = await loadDomain(db, siteId, id);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Domain not found.' }] }, 404);

  // Best-effort de-provision on Cloudflare; don't block deletion on its failure.
  if (row.kind === 'custom' && row.cfHostnameId) {
    const cfg = cloudflareSaaSConfig(c.env);
    if (cfg) {
      try {
        await new CloudflareSaaSClient(cfg).deleteCustomHostname(row.cfHostnameId);
      } catch {
        /* ignore — row removal + KV cleanup below is what matters for routing */
      }
    }
  }

  await db.delete(siteDomains).where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)));
  if (cache) await deleteHostMapping(cache, row.hostname);

  return c.body(null, 204);
});

function loadDomain(
  db: AppEnv['Variables']['db'],
  siteId: string,
  id: string,
): Promise<DomainRow | undefined> {
  return db
    .select()
    .from(siteDomains)
    .where(and(eq(siteDomains.id, id), eq(siteDomains.siteId, siteId)))
    .limit(1)
    .then((rows) => rows[0]);
}

/** Detect a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (e: unknown): boolean =>
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === '23505';
  if (hasCode(err)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return hasCode(cause);
}
