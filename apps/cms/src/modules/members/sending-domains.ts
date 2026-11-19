/**
 * Custom sending domains (#722, epic #672 N06): DNS wizard, 2048-bit DKIM
 * with zero-downtime rotation, SPF and DMARC (alignment) checks.
 *
 * Records the operator publishes (all TXT):
 *   - SPF   `<domain>`                     `v=spf1 … include:relay.mailchannels.net ~all`
 *   - DKIM  `<selector>._domainkey.<domain>` `v=DKIM1; k=rsa; p=<2048-bit key>`
 *   - DMARC `_dmarc.<domain>`              `v=DMARC1; p=…`
 *
 * A 2048-bit key does not fit one 255-byte TXT string; the wizard hands out
 * the value pre-split into quoted chunks (`"…" "…"`) because several DNS UIs
 * get the split wrong.
 *
 * Rotation never breaks verification of mail in flight:
 *   1. `startRotation` generates the next key under a NEW selector and asks
 *      the operator to publish it next to the current one;
 *   2. once a check sees the next record AND it has been visible for longer
 *      than {@link DNS_PROPAGATION_GRACE_MS} (past typical TTLs), signing
 *      switches to it;
 *   3. the old selector stays published (and listed) for
 *      {@link PREVIOUS_KEY_RETENTION_MS} so queued or retried mail signed
 *      with it still verifies; after that the wizard says it may be removed.
 * Rotation is due {@link ROTATION_INTERVAL_MS} after activation; the members
 * tick starts it and completes switches.
 *
 * DMARC is checked for alignment, not just presence: we sign with `d=<domain>`,
 * and every newsletter sender on that domain must align with it under the
 * record's `adkim` mode (strict = exact domain, relaxed = same domain or a
 * subdomain of it).
 *
 * Private keys are sealed with the KeyProvider; the AAD binds the ciphertext
 * to site + domain + selector so it cannot be replayed on another row.
 */

import { z } from 'zod';
import { and, eq, isNotNull, lt, or } from 'drizzle-orm';
import { newsletters, sendingDomains, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { openSecret, sealSecret } from '../../services/crypto/sealed-secret';
import type { DkimSigningKey } from '../../services/email/transport';
import { MemberError, isUniqueViolation } from './errors';

export const DKIM_KEY_BITS = 2048;
export const DNS_PROPAGATION_GRACE_MS = 60 * 60 * 1000; // 1h past first sighting
export const PREVIOUS_KEY_RETENTION_MS = 7 * 86_400_000; // keep the old selector 7 days
export const ROTATION_INTERVAL_MS = 180 * 86_400_000; // rotate every ~6 months
const TXT_CHUNK = 255;
const MAILCHANNELS_SPF = 'include:relay.mailchannels.net';

const DOMAIN_RE = /^(?=.{4,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

export const sendingDomainInputSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN_RE, 'must be a domain name like news.example.com'),
});

// ── DNS ───────────────────────────────────────────────────────────────────

/** Resolve TXT records: one string per record (chunks joined), `[]` when none. */
export interface DnsResolver {
  resolveTxt(name: string): Promise<string[]>;
}

/**
 * DNS-over-HTTPS resolver (JSON API). Works on both runtimes because it only
 * needs `fetch` — no `node:dns` in business logic.
 */
export class DohResolver implements DnsResolver {
  constructor(
    private readonly endpoint = 'https://cloudflare-dns.com/dns-query',
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async resolveTxt(name: string): Promise<string[]> {
    const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=TXT`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await this.fetchFn(url, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`dns ${res.status}`);
      const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
      return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => joinTxtData(a.data));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** `"abc" "def"` → `abcdef`; an unquoted value is returned as-is. */
export function joinTxtData(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, '$1'));
  return parts.length > 0 ? parts.join('') : data;
}

/** Split a TXT value into ≤255-byte quoted strings for DNS UIs. */
export function splitTxtValue(value: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += TXT_CHUNK) chunks.push(value.slice(i, i + TXT_CHUNK));
  return chunks.map((c) => `"${c}"`).join(' ');
}

// ── Keys ──────────────────────────────────────────────────────────────────

function toBase64(buf: ArrayBuffer): string {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function pem(label: string, b64: string): string {
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export async function generateDkimKeyPair(): Promise<{ publicKey: string; privateKeyPem: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: DKIM_KEY_BITS, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return { publicKey: toBase64(spki), privateKeyPem: pem('PRIVATE KEY', toBase64(pkcs8)) };
}

export function newSelector(now: Date): string {
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const rand = crypto.getRandomValues(new Uint8Array(3));
  return `lb${ym}${[...rand].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function keyAad(siteId: string, domain: string, selector: string): string {
  return `sending-domain:${siteId}:${domain}:${selector}`;
}

export function dkimRecordValue(publicKey: string): string {
  return `v=DKIM1; k=rsa; p=${publicKey}`;
}

// ── Views ─────────────────────────────────────────────────────────────────

type DomainRow = typeof sendingDomains.$inferSelect;

export interface DnsRecordView {
  purpose: 'spf' | 'dkim' | 'dkim_next' | 'dkim_previous' | 'dmarc';
  type: 'TXT';
  host: string;
  value: string;
  /** Value pre-split into ≤255-byte quoted strings. */
  valueChunks: string;
  status: 'ok' | 'missing' | 'mismatch' | 'unchecked' | 'removable';
  note?: string;
}

export interface DomainChecks {
  spf?: 'ok' | 'missing' | 'mismatch';
  dkim?: 'ok' | 'missing' | 'mismatch';
  nextDkim?: 'ok' | 'missing' | 'mismatch';
  nextFirstSeenAt?: string;
  dmarc?: 'ok' | 'missing' | 'invalid';
  dmarcPolicy?: string | null;
  dmarcAlignment?: 'strict' | 'relaxed';
  dmarcAligned?: boolean;
  misalignedSenders?: string[];
  problems?: string[];
  checkedAt?: string;
  error?: string;
}

export interface SendingDomainView {
  id: string;
  domain: string;
  status: string;
  dkimSelector: string;
  rotation: { state: 'idle' | 'publishing_next' | 'retiring_previous'; nextSelector: string | null; previousSelector: string | null; previousRetireAfter: Date | null; rotateAfter: Date | null };
  checks: DomainChecks;
  records: DnsRecordView[];
  lastCheckedAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

function checksOf(row: DomainRow): DomainChecks {
  return (row.checks ?? {}) as DomainChecks;
}

export function toDomainView(row: DomainRow, provider: 'smtp' | 'mailchannels' | null, now: Date = new Date()): SendingDomainView {
  const checks = checksOf(row);
  const spfValue = provider === 'mailchannels' ? `v=spf1 a mx ${MAILCHANNELS_SPF} ~all` : 'v=spf1 a mx include:<your SMTP provider> ~all';
  const rec = (purpose: DnsRecordView['purpose'], host: string, value: string, status: DnsRecordView['status'], note?: string): DnsRecordView => ({
    purpose,
    type: 'TXT',
    host,
    value,
    valueChunks: splitTxtValue(value),
    status,
    ...(note ? { note } : {}),
  });
  const records: DnsRecordView[] = [
    rec('spf', row.domain, spfValue, checks.spf ?? 'unchecked', 'Merge into your existing SPF record; a domain may have only one.'),
    rec('dkim', `${row.dkimSelector}._domainkey.${row.domain}`, dkimRecordValue(row.dkimPublicKey), checks.dkim ?? 'unchecked'),
    rec(
      'dmarc',
      `_dmarc.${row.domain}`,
      'v=DMARC1; p=none; adkim=r; aspf=r',
      checks.dmarc === 'ok' ? 'ok' : checks.dmarc === 'invalid' ? 'mismatch' : checks.dmarc ?? 'unchecked',
      'Start with p=none, then tighten to quarantine/reject once reports look clean.',
    ),
  ];
  if (row.nextSelector && row.nextPublicKey) {
    records.push(
      rec('dkim_next', `${row.nextSelector}._domainkey.${row.domain}`, dkimRecordValue(row.nextPublicKey), checks.nextDkim ?? 'unchecked', 'Publish next to the current key; signing switches once it has propagated.'),
    );
  }
  if (row.previousSelector && row.previousPublicKey) {
    const retired = !!row.previousRetireAfter && row.previousRetireAfter.getTime() <= now.getTime();
    records.push(
      rec(
        'dkim_previous',
        `${row.previousSelector}._domainkey.${row.domain}`,
        dkimRecordValue(row.previousPublicKey),
        retired ? 'removable' : 'ok',
        retired ? 'No longer used; you may delete this record.' : 'Keep published until mail signed with it has been delivered.',
      ),
    );
  }
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    dkimSelector: row.dkimSelector,
    rotation: {
      state: row.nextSelector ? 'publishing_next' : row.previousSelector ? 'retiring_previous' : 'idle',
      nextSelector: row.nextSelector,
      previousSelector: row.previousSelector,
      previousRetireAfter: row.previousRetireAfter,
      rotateAfter: row.rotateAfter,
    },
    checks,
    records,
    lastCheckedAt: row.lastCheckedAt,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function listSendingDomains(db: Database, siteId: string): Promise<DomainRow[]> {
  return db.select().from(sendingDomains).where(eq(sendingDomains.siteId, siteId)).orderBy(sendingDomains.domain);
}

export async function getSendingDomain(db: Database, siteId: string, id: string): Promise<DomainRow> {
  const [row] = await db
    .select()
    .from(sendingDomains)
    .where(and(eq(sendingDomains.siteId, siteId), eq(sendingDomains.id, id)))
    .limit(1);
  if (!row) throw new MemberError('NOT_FOUND', 404, 'Sending domain not found.');
  return row;
}

export async function createSendingDomain(
  db: Database,
  siteId: string,
  keys: KeyProvider,
  domain: string,
  now: Date = new Date(),
): Promise<DomainRow> {
  const selector = newSelector(now);
  const { publicKey, privateKeyPem } = await generateDkimKeyPair();
  const sealed = await sealSecret(keys, keyAad(siteId, domain, selector), privateKeyPem);
  try {
    const [row] = await db
      .insert(sendingDomains)
      .values({ siteId, domain, dkimSelector: selector, dkimPublicKey: publicKey, dkimPrivateKeySealed: sealed.ciphertext })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw new MemberError('DOMAIN_EXISTS', 409, 'This domain is already set up for the site.');
    throw err;
  }
}

export async function deleteSendingDomain(db: Database, siteId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(sendingDomains)
    .where(and(eq(sendingDomains.siteId, siteId), eq(sendingDomains.id, id)))
    .returning({ id: sendingDomains.id });
  if (deleted.length === 0) throw new MemberError('NOT_FOUND', 404, 'Sending domain not found.');
}

// ── Checks ────────────────────────────────────────────────────────────────

function parseTags(record: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    tags.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return tags;
}

function dkimMatches(records: string[], publicKey: string): 'ok' | 'missing' | 'mismatch' {
  const dkim = records.filter((r) => /^\s*v\s*=\s*DKIM1/i.test(r) || /\bp\s*=/.test(r));
  if (dkim.length === 0) return 'missing';
  return dkim.some((r) => (parseTags(r).get('p') ?? '').replace(/\s+/g, '') === publicKey) ? 'ok' : 'mismatch';
}

/** Whether `from` (an address domain) aligns with `d=` under the DMARC mode. */
export function dkimAligned(fromDomain: string, signingDomain: string, mode: 'strict' | 'relaxed'): boolean {
  const f = fromDomain.toLowerCase();
  const d = signingDomain.toLowerCase();
  if (f === d) return true;
  // Relaxed: same organizational domain. Approximated as "one is a subdomain
  // of the other" — enough for the senders this module allows (the sending
  // domain itself or its subdomains); no public-suffix list in the bundle.
  return mode === 'relaxed' && (f.endsWith(`.${d}`) || d.endsWith(`.${f}`));
}

function addressDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

export async function checkSendingDomain(
  db: Database,
  siteId: string,
  id: string,
  resolver: DnsResolver,
  provider: 'smtp' | 'mailchannels' | null,
  now: Date = new Date(),
): Promise<DomainRow> {
  const row = await getSendingDomain(db, siteId, id);
  const prev = checksOf(row);
  const checks: DomainChecks = { checkedAt: now.toISOString(), problems: [] };
  try {
    const [rootTxt, dkimTxt, dmarcTxt, nextTxt] = await Promise.all([
      resolver.resolveTxt(row.domain),
      resolver.resolveTxt(`${row.dkimSelector}._domainkey.${row.domain}`),
      resolver.resolveTxt(`_dmarc.${row.domain}`),
      row.nextSelector ? resolver.resolveTxt(`${row.nextSelector}._domainkey.${row.domain}`) : Promise.resolve([]),
    ]);

    const spf = rootTxt.filter((r) => /^\s*v=spf1\b/i.test(r));
    if (spf.length === 0) checks.spf = 'missing';
    else if (spf.length > 1) {
      checks.spf = 'mismatch';
      checks.problems!.push('More than one SPF record; receivers treat that as a permanent error.');
    } else if (provider === 'mailchannels' && !spf[0]!.includes(MAILCHANNELS_SPF)) {
      checks.spf = 'mismatch';
      checks.problems!.push(`SPF does not include ${MAILCHANNELS_SPF}.`);
    } else checks.spf = 'ok';

    checks.dkim = dkimMatches(dkimTxt, row.dkimPublicKey);
    if (checks.dkim !== 'ok') checks.problems!.push(`DKIM record for selector ${row.dkimSelector} is ${checks.dkim}.`);

    if (row.nextSelector && row.nextPublicKey) {
      checks.nextDkim = dkimMatches(nextTxt, row.nextPublicKey);
      checks.nextFirstSeenAt = checks.nextDkim === 'ok' ? prev.nextFirstSeenAt ?? now.toISOString() : undefined;
    }

    const dmarc = dmarcTxt.filter((r) => /^\s*v\s*=\s*DMARC1/i.test(r));
    if (dmarc.length === 0) {
      checks.dmarc = 'missing';
      checks.problems!.push('No DMARC record; Gmail and Yahoo require one for bulk senders.');
    } else if (dmarc.length > 1) {
      checks.dmarc = 'invalid';
      checks.problems!.push('More than one DMARC record.');
    } else {
      const tags = parseTags(dmarc[0]!);
      const policy = tags.get('p') ?? null;
      checks.dmarcPolicy = policy;
      checks.dmarc = policy && ['none', 'quarantine', 'reject'].includes(policy.toLowerCase()) ? 'ok' : 'invalid';
      if (checks.dmarc === 'invalid') checks.problems!.push('DMARC record has no valid p= policy.');
      checks.dmarcAlignment = (tags.get('adkim') ?? 'r').toLowerCase() === 's' ? 'strict' : 'relaxed';
    }

    // Alignment: every newsletter sender that would be signed with this
    // domain must align with d=<domain> under the record's adkim mode.
    const mode = checks.dmarcAlignment ?? 'relaxed';
    const senders = await db
      .select({ senderEmail: newsletters.senderEmail })
      .from(newsletters)
      .where(and(eq(newsletters.siteId, siteId), isNotNull(newsletters.senderEmail)));
    const relevant = senders
      .map((s) => s.senderEmail!)
      .filter((addr) => {
        const d = addressDomain(addr);
        return !!d && (d === row.domain || d.endsWith(`.${row.domain}`));
      });
    checks.misalignedSenders = relevant.filter((addr) => !dkimAligned(addressDomain(addr)!, row.domain, mode));
    checks.dmarcAligned = checks.dmarc === 'ok' && checks.dkim === 'ok' && checks.misalignedSenders.length === 0;
    if (checks.misalignedSenders.length > 0) {
      checks.problems!.push(`Senders not aligned under adkim=${mode === 'strict' ? 's' : 'r'}: ${checks.misalignedSenders.join(', ')}.`);
    }
  } catch (err) {
    checks.error = err instanceof Error ? err.message.slice(0, 200) : 'dns lookup failed';
    checks.problems!.push('DNS lookup failed; try again shortly.');
  }

  // Verified = signing key published + SPF present. DMARC problems are
  // reported but do not block sending (p=none is a valid starting point).
  const verified = checks.dkim === 'ok' && checks.spf === 'ok';
  const status = checks.error ? row.status : verified ? 'verified' : row.status === 'verified' ? 'failed' : 'pending';
  const [updated] = await db
    .update(sendingDomains)
    .set({
      checks,
      status,
      lastCheckedAt: now,
      updatedAt: now,
      ...(verified && !row.verifiedAt ? { verifiedAt: now, rotateAfter: row.rotateAfter ?? new Date(now.getTime() + ROTATION_INTERVAL_MS) } : {}),
    })
    .where(and(eq(sendingDomains.siteId, siteId), eq(sendingDomains.id, id)))
    .returning();
  return updated!;
}

// ── Rotation ──────────────────────────────────────────────────────────────

export async function startRotation(db: Database, siteId: string, id: string, keys: KeyProvider, now: Date = new Date()): Promise<DomainRow> {
  const row = await getSendingDomain(db, siteId, id);
  if (row.nextSelector) throw new MemberError('ROTATION_IN_PROGRESS', 409, 'A rotation is already waiting for its DNS record.');
  let selector = newSelector(now);
  while (selector === row.dkimSelector || selector === row.previousSelector) selector = newSelector(now);
  const { publicKey, privateKeyPem } = await generateDkimKeyPair();
  const sealed = await sealSecret(keys, keyAad(siteId, row.domain, selector), privateKeyPem);
  const checks = { ...checksOf(row), nextDkim: undefined, nextFirstSeenAt: undefined };
  const [updated] = await db
    .update(sendingDomains)
    .set({ nextSelector: selector, nextPublicKey: publicKey, nextPrivateKeySealed: sealed.ciphertext, checks, updatedAt: now })
    .where(and(eq(sendingDomains.siteId, siteId), eq(sendingDomains.id, id), eq(sendingDomains.dkimSelector, row.dkimSelector)))
    .returning();
  if (!updated) throw new MemberError('CONFLICT', 409, 'The domain changed while rotating; retry.');
  return updated;
}

/**
 * Switch signing to the next key once its record has been visible for
 * longer than the propagation grace. Conditional on the current selector, so
 * two ticks cannot both switch. Returns null when not ready.
 */
export async function completeRotationIfReady(db: Database, row: DomainRow, now: Date = new Date()): Promise<DomainRow | null> {
  const checks = checksOf(row);
  if (!row.nextSelector || !row.nextPublicKey || !row.nextPrivateKeySealed) return null;
  if (checks.nextDkim !== 'ok' || !checks.nextFirstSeenAt) return null;
  if (now.getTime() - Date.parse(checks.nextFirstSeenAt) < DNS_PROPAGATION_GRACE_MS) return null;
  const [updated] = await db
    .update(sendingDomains)
    .set({
      previousSelector: row.dkimSelector,
      previousPublicKey: row.dkimPublicKey,
      previousRetireAfter: new Date(now.getTime() + PREVIOUS_KEY_RETENTION_MS),
      dkimSelector: row.nextSelector,
      dkimPublicKey: row.nextPublicKey,
      dkimPrivateKeySealed: row.nextPrivateKeySealed,
      nextSelector: null,
      nextPublicKey: null,
      nextPrivateKeySealed: null,
      rotateAfter: new Date(now.getTime() + ROTATION_INTERVAL_MS),
      checks: { ...checks, dkim: 'ok', nextDkim: undefined, nextFirstSeenAt: undefined },
      updatedAt: now,
    })
    .where(and(eq(sendingDomains.siteId, row.siteId), eq(sendingDomains.id, row.id), eq(sendingDomains.dkimSelector, row.dkimSelector)))
    .returning();
  return updated ?? null;
}

/**
 * Tick work across sites (system connection): re-check domains with a
 * rotation pending, finish switches, start rotations that are due, and drop
 * retired previous keys from the row once their retention passed.
 */
export async function runSendingDomainTick(
  db: Database,
  keys: KeyProvider | undefined,
  resolver: DnsResolver,
  provider: 'smtp' | 'mailchannels' | null,
  now: Date = new Date(),
): Promise<{ checked: number; rotated: number; started: number }> {
  let checked = 0;
  let rotated = 0;
  let started = 0;
  const due = await db
    .select()
    .from(sendingDomains)
    .where(
      or(
        isNotNull(sendingDomains.nextSelector),
        and(eq(sendingDomains.status, 'verified'), lt(sendingDomains.rotateAfter, now)),
        lt(sendingDomains.previousRetireAfter, new Date(now.getTime() - PREVIOUS_KEY_RETENTION_MS)),
      ),
    )
    .limit(50);
  for (const row of due) {
    if (row.nextSelector) {
      const fresh = await checkSendingDomain(db, row.siteId, row.id, resolver, provider, now);
      checked += 1;
      if (await completeRotationIfReady(db, fresh, now)) rotated += 1;
    } else if (row.status === 'verified' && row.rotateAfter && row.rotateAfter < now && keys) {
      await startRotation(db, row.siteId, row.id, keys, now).catch(() => undefined);
      started += 1;
    } else if (row.previousRetireAfter && row.previousRetireAfter.getTime() < now.getTime() - PREVIOUS_KEY_RETENTION_MS) {
      // Two retention periods on: forget the old public key entirely.
      await db
        .update(sendingDomains)
        .set({ previousSelector: null, previousPublicKey: null, previousRetireAfter: null, updatedAt: now })
        .where(and(eq(sendingDomains.siteId, row.siteId), eq(sendingDomains.id, row.id)));
    }
  }
  return { checked, rotated, started };
}

// ── Signing ───────────────────────────────────────────────────────────────

/** Verified sending domain covering `fromAddress` (exact or parent domain). */
export async function findDomainForSender(db: Database, siteId: string, fromAddress: string): Promise<DomainRow | null> {
  const d = addressDomain(fromAddress);
  if (!d) return null;
  const rows = await db.select().from(sendingDomains).where(eq(sendingDomains.siteId, siteId));
  const matches = rows.filter((r) => d === r.domain || d.endsWith(`.${r.domain}`));
  // Longest (most specific) domain wins.
  matches.sort((a, b) => b.domain.length - a.domain.length);
  return matches[0] ?? null;
}

export async function resolveDkimForSender(
  db: Database,
  siteId: string,
  keys: KeyProvider,
  fromAddress: string,
): Promise<DkimSigningKey | null> {
  const row = await findDomainForSender(db, siteId, fromAddress);
  if (!row || row.status !== 'verified') return null;
  const privateKey = await openSecret(keys, keyAad(siteId, row.domain, row.dkimSelector), row.dkimPrivateKeySealed);
  return { domainName: row.domain, keySelector: row.dkimSelector, privateKey };
}

export function transportProvider(kind: string | null | undefined): 'smtp' | 'mailchannels' | null {
  return kind === 'smtp' || kind === 'mailchannels' ? kind : null;
}
