/**
 * Member mail (epic #672): the one path newsletters and sequences send
 * through, so every message to a member gets the same guarantees:
 *
 *   - the site's suppression list is honoured (marketing mail, CAN-SPAM);
 *   - a per-member unsubscribe link is rendered into the body AND sent as
 *     `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
 *     (RFC 8058), so mailbox providers can offer one-click unsubscribe;
 *   - when the sender sits on a verified custom sending domain, the message
 *     is DKIM-signed with that domain's active key (N06);
 *   - opens/clicks are tracked only when the newsletter opted in.
 *
 * Link tokens are stateless HS256 JWTs signed with `JWT_SECRET`, each with
 * its own `sub` purpose, so an open-pixel token cannot be replayed as an
 * unsubscribe token. Unsubscribe tokens do not expire (links in old mail must
 * keep working); click tokens carry the destination URL, so the redirect is
 * not an open redirect — only URLs we signed can be followed.
 */

import { SignJWT, jwtVerify } from 'jose';
import type { Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import type { DeliveryResult } from '../notifications/types';
import type { EmailService } from '../../services/email/email-service';
import { renderTemplate, type TemplateVars } from '../../services/email/render';
import { SuppressionService } from '../email/suppression';
import { resolveDkimForSender } from './sending-domains';

const UNSUB_SUB = 'member_unsubscribe';
const OPEN_SUB = 'member_email_open';
const CLICK_SUB = 'member_email_click';

export interface UnsubscribeClaims {
  siteId: string;
  memberId: string;
  /** Newsletter to leave; absent = every newsletter + sequences. */
  newsletterId?: string;
}

export interface TrackClaims {
  siteId: string;
  sendId: string;
  memberId: string;
  /** Destination for click tokens. */
  url?: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signUnsubscribeToken(claims: UnsubscribeClaims, secret: string): Promise<string> {
  return new SignJWT({ siteId: claims.siteId, memberId: claims.memberId, ...(claims.newsletterId ? { newsletterId: claims.newsletterId } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(UNSUB_SUB)
    .setIssuedAt()
    .sign(key(secret));
}

export async function verifyUnsubscribeToken(token: string, secret: string): Promise<UnsubscribeClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { subject: UNSUB_SUB });
    if (typeof payload.siteId !== 'string' || typeof payload.memberId !== 'string') return null;
    return {
      siteId: payload.siteId,
      memberId: payload.memberId,
      ...(typeof payload.newsletterId === 'string' ? { newsletterId: payload.newsletterId } : {}),
    };
  } catch {
    return null;
  }
}

export async function signTrackToken(kind: 'open' | 'click', claims: TrackClaims, secret: string): Promise<string> {
  return new SignJWT({ siteId: claims.siteId, sendId: claims.sendId, memberId: claims.memberId, ...(claims.url ? { url: claims.url } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(kind === 'open' ? OPEN_SUB : CLICK_SUB)
    .setIssuedAt()
    .setExpirationTime('180d')
    .sign(key(secret));
}

export async function verifyTrackToken(kind: 'open' | 'click', token: string, secret: string): Promise<TrackClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { subject: kind === 'open' ? OPEN_SUB : CLICK_SUB });
    if (typeof payload.siteId !== 'string' || typeof payload.sendId !== 'string' || typeof payload.memberId !== 'string') {
      return null;
    }
    if (kind === 'click' && typeof payload.url !== 'string') return null;
    return {
      siteId: payload.siteId,
      sendId: payload.sendId,
      memberId: payload.memberId,
      ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
    };
  } catch {
    return null;
  }
}

export const MEMBER_EMAIL_PUBLIC_PREFIX = '/api/v1/portal/email';

export function unsubscribeUrl(linkBase: string, token: string): string {
  return `${linkBase.replace(/\/+$/, '')}${MEMBER_EMAIL_PUBLIC_PREFIX}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/** Only http(s) links are rewritten for click tracking; mailto:, tel:, anchors stay as-is. */
const HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi;

async function rewriteLinks(html: string, sign: (url: string) => Promise<string>): Promise<string> {
  const matches = [...html.matchAll(HREF_RE)];
  if (matches.length === 0) return html;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const url = m[3]!;
    out += html.slice(last, m.index) + `${m[1]}${m[2]}${await sign(url)}${m[2]}`;
    last = (m.index ?? 0) + m[0].length;
  }
  return out + html.slice(last);
}

export interface MemberMailerDeps {
  db: Database;
  siteId: string;
  emailService: EmailService | null;
  /** `JWT_SECRET` — signs unsubscribe / tracking links. */
  secret: string;
  /** Opens sealed DKIM keys; absent = never sign. */
  keys?: KeyProvider;
}

export interface MemberMessage {
  member: { id: string; email: string; name: string | null };
  subject: string;
  html: string;
  text?: string | null;
  from?: string | null;
  fromName?: string | null;
  replyTo?: string | null;
  /** Public CMS origin for links. */
  linkBase: string;
  /** Unsubscribe scope; absent = all member mail. */
  newsletterId?: string;
  tracking?: { sendId: string; opens: boolean; clicks: boolean };
  /** Extra template variables (e.g. `post.title`). */
  vars?: TemplateVars;
  layoutHtml?: string | null;
}

export type MemberSendOutcome =
  | { status: 'sent' }
  | { status: 'suppressed' }
  | { status: 'failed'; error: string; retryable: boolean }
  | { status: 'not_configured' };

function formatFrom(address: string, name: string | null | undefined): string {
  if (!name) return address;
  const safe = name.replace(/["\\\r\n]/g, '').slice(0, 100);
  return `"${safe}" <${address}>`;
}

export class MemberMailer {
  private readonly suppression: SuppressionService;

  constructor(private readonly deps: MemberMailerDeps) {
    this.suppression = new SuppressionService({ db: deps.db });
  }

  async send(msg: MemberMessage): Promise<MemberSendOutcome> {
    const svc = this.deps.emailService;
    if (!svc) return { status: 'not_configured' };
    if (await this.suppression.isSuppressed({ siteId: this.deps.siteId, email: msg.member.email })) {
      return { status: 'suppressed' };
    }

    const unsubToken = await signUnsubscribeToken(
      { siteId: this.deps.siteId, memberId: msg.member.id, ...(msg.newsletterId ? { newsletterId: msg.newsletterId } : {}) },
      this.deps.secret,
    );
    const unsubUrl = unsubscribeUrl(msg.linkBase, unsubToken);
    const vars: TemplateVars = {
      ...(msg.vars ?? {}),
      'member.name': msg.member.name ?? '',
      'member.email': msg.member.email,
      'member.first_name': (msg.member.name ?? '').split(/\s+/)[0] ?? '',
      unsubscribe_url: unsubUrl,
    };
    const rendered = renderTemplate(
      { subject: msg.subject, bodyHtml: msg.html, bodyText: msg.text ?? null },
      msg.layoutHtml ? { html: msg.layoutHtml } : null,
      vars,
    );

    let html = rendered.html;
    if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(msg.html) && !(msg.layoutHtml ?? '').includes('unsubscribe_url')) {
      html += `<p style="font-size:12px;color:#666"><a href="${unsubUrl}">Unsubscribe</a></p>`;
    }
    let text = rendered.text;
    if (!text.includes(unsubUrl)) text += `\n\nUnsubscribe: ${unsubUrl}`;

    const tracking = msg.tracking;
    if (tracking?.clicks) {
      html = await rewriteLinks(html, async (url) => {
        if (url === unsubUrl) return url;
        const t = await signTrackToken('click', { siteId: this.deps.siteId, sendId: tracking.sendId, memberId: msg.member.id, url }, this.deps.secret);
        return `${msg.linkBase.replace(/\/+$/, '')}${MEMBER_EMAIL_PUBLIC_PREFIX}/c?t=${encodeURIComponent(t)}`;
      });
    }
    if (tracking?.opens) {
      const t = await signTrackToken('open', { siteId: this.deps.siteId, sendId: tracking.sendId, memberId: msg.member.id }, this.deps.secret);
      html += `<img src="${msg.linkBase.replace(/\/+$/, '')}${MEMBER_EMAIL_PUBLIC_PREFIX}/o?t=${encodeURIComponent(t)}" width="1" height="1" alt="" style="display:none">`;
    }

    const fromAddress = msg.from ?? svc.defaultFrom;
    const dkim = msg.from && this.deps.keys ? await resolveDkimForSender(this.deps.db, this.deps.siteId, this.deps.keys, msg.from) : null;

    const result: DeliveryResult = await svc.send({
      to: [msg.member.email],
      from: formatFrom(fromAddress, msg.fromName),
      ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
      subject: rendered.subject,
      html,
      text,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      ...(dkim ? { dkim } : {}),
    });
    if (result.ok) return { status: 'sent' };
    return { status: 'failed', error: (result.error ?? 'send failed').slice(0, 500), retryable: result.retryable ?? true };
  }
}
