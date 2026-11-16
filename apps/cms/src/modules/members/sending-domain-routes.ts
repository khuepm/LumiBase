/**
 * Custom sending domains (`/api/v1/email/sending-domains/*`, epic #672 N06).
 * Attached to the email module router, so it inherits `requireSiteAdmin()`.
 *
 *   GET    /             list with DNS records + deliverability status
 *   POST   /             add a domain (generates a 2048-bit DKIM key)
 *   GET    /:id          one domain
 *   POST   /:id/check    look up SPF / DKIM / DMARC now
 *   POST   /:id/rotate   start a DKIM rotation (new selector published next to the old)
 *   DELETE /:id          remove
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../env';
import { EmailService } from '../../services/email/email-service';
import { AuditLogger } from '../audit/logger';
import { MemberError, memberErrorResponse } from './errors';
import {
  DohResolver,
  checkSendingDomain,
  createSendingDomain,
  deleteSendingDomain,
  getSendingDomain,
  listSendingDomains,
  sendingDomainInputSchema,
  startRotation,
  toDomainView,
  transportProvider,
  type DnsResolver,
} from './sending-domains';

/** Test seam: swap the DoH resolver. */
let resolverOverride: DnsResolver | null = null;
export function setSendingDomainResolver(resolver: DnsResolver | null): void {
  resolverOverride = resolver;
}

export const sendingDomainsRouter = new Hono<AppEnv>();

/** A path parameter; the wrapper below erases Hono's path typing. */
function param(c: Context<AppEnv>, name: string): string {
  return c.req.param(name) ?? '';
}

function h(fn: (c: Context<AppEnv>) => Promise<Response>) {
  return async (c: Context<AppEnv>) => {
    try {
      return await fn(c);
    } catch (err) {
      return memberErrorResponse(c, err);
    }
  };
}

function provider(c: Context<AppEnv>) {
  return transportProvider(EmailService.fromEnv(c.env)?.transportKind);
}

function keys(c: Context<AppEnv>) {
  const k = c.get('runtime')?.keys;
  if (!k) throw new MemberError('KEYS_NOT_CONFIGURED', 503, 'No key provider is configured to seal DKIM keys.');
  return k;
}

function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>) {
  return new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event,
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

sendingDomainsRouter.get(
  '/',
  h(async (c) => {
    const rows = await listSendingDomains(c.get('db'), c.get('siteId'));
    const p = provider(c);
    return c.json({ data: rows.map((r) => toDomainView(r, p)) });
  }),
);

sendingDomainsRouter.post(
  '/',
  h(async (c) => {
    const { domain } = sendingDomainInputSchema.parse(await c.req.json().catch(() => ({})));
    const row = await createSendingDomain(c.get('db'), c.get('siteId'), keys(c), domain);
    await audit(c, 'sending_domain_added', { domainId: row.id, domain: row.domain, selector: row.dkimSelector });
    return c.json({ data: toDomainView(row, provider(c)) }, 201);
  }),
);

sendingDomainsRouter.get(
  '/:id',
  h(async (c) => c.json({ data: toDomainView(await getSendingDomain(c.get('db'), c.get('siteId'), param(c, 'id')), provider(c)) })),
);

sendingDomainsRouter.post(
  '/:id/check',
  h(async (c) => {
    const row = await checkSendingDomain(c.get('db'), c.get('siteId'), param(c, 'id'), resolverOverride ?? new DohResolver(), provider(c));
    return c.json({ data: toDomainView(row, provider(c)) });
  }),
);

sendingDomainsRouter.post(
  '/:id/rotate',
  h(async (c) => {
    const row = await startRotation(c.get('db'), c.get('siteId'), param(c, 'id'), keys(c));
    await audit(c, 'sending_domain_rotation_started', { domainId: row.id, nextSelector: row.nextSelector });
    return c.json({ data: toDomainView(row, provider(c)) });
  }),
);

sendingDomainsRouter.delete(
  '/:id',
  h(async (c) => {
    await deleteSendingDomain(c.get('db'), c.get('siteId'), param(c, 'id'));
    await audit(c, 'sending_domain_removed', { domainId: param(c, 'id') });
    return c.json({ data: null });
  }),
);
