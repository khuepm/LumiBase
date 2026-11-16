import { describe, expect, it } from 'vitest';
import { resolveSignupCopy, signupCardOverrides, normalizeLocale } from '@lumibase/contracts/members';
import { MailchannelsTransport, NodemailerTransport, pemToBase64Der, safeHeaders } from '../../../services/email/transport';
import { isStudioAccessPath } from '../../../middleware/studio-access';
import { isPortalPublicPath } from '../portal-paths';
import { composeFromItem, pickText, sanitizeEmailHtml } from '../newsletters';
import { dkimAligned, joinTxtData, splitTxtValue, generateDkimKeyPair, dkimRecordValue } from '../sending-domains';
import { signTrackToken, signUnsubscribeToken, verifyTrackToken, verifyUnsubscribeToken } from '../mailer';
import { parseSegmentFilter, segmentWhere } from '../segments';
import { SEQUENCE_TEMPLATES, sequenceInputSchema } from '../sequences';

describe('transport headers + DKIM', () => {
  it('drops reserved, malformed and CRLF-injecting headers', () => {
    expect(
      safeHeaders({
        'List-Unsubscribe': '<https://x/u>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        Bcc: 'evil@example.com',
        'X-Bad': 'a\r\nBcc: evil@example.com',
        'Bad Name': 'x',
      }),
    ).toEqual({ 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });

  it('MailChannels payload carries headers and per-personalization DKIM', async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const t = new MailchannelsTransport(fetchFn);
    const res = await t.send({
      from: 'news@mail.example.test',
      to: ['a@example.test'],
      subject: 's',
      html: '<p>x</p>',
      headers: { 'List-Unsubscribe': '<https://x/u>' },
      dkim: { domainName: 'mail.example.test', keySelector: 'lb1', privateKey: '-----BEGIN PRIVATE KEY-----\nQUJD\nREVG\n-----END PRIVATE KEY-----\n' },
    });
    expect(res.ok).toBe(true);
    expect(body.headers).toEqual({ 'List-Unsubscribe': '<https://x/u>' });
    const p = (body.personalizations as Array<Record<string, unknown>>)[0]!;
    expect(p).toMatchObject({ dkim_domain: 'mail.example.test', dkim_selector: 'lb1', dkim_private_key: 'QUJDREVG' });
  });

  it('nodemailer receives headers and dkim options', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const t = new NodemailerTransport('smtp://localhost');
    (t as unknown as { handle: unknown }).handle = { sendMail: async (o: Record<string, unknown>) => void calls.push(o) };
    await t.send({ from: 'a@x.test', to: ['b@x.test'], subject: 's', text: 't', headers: { 'List-Unsubscribe': '<u>' }, dkim: { domainName: 'x.test', keySelector: 's1', privateKey: 'k' } });
    expect(calls[0]).toMatchObject({ headers: { 'List-Unsubscribe': '<u>' }, dkim: { domainName: 'x.test', keySelector: 's1', privateKey: 'k' } });
  });

  it('pemToBase64Der strips armor and whitespace', () => {
    expect(pemToBase64Der('-----BEGIN PRIVATE KEY-----\nAB\nCD\n-----END PRIVATE KEY-----\n')).toBe('ABCD');
  });
});

describe('signup copy (N05)', () => {
  it('resolves override → site locale → site base → built-in default', () => {
    const site = { vi: { button: 'Nhận tin' }, pt: { heading: 'Assine' } };
    expect(resolveSignupCopy('vi', site).button).toBe('Nhận tin');
    expect(resolveSignupCopy('vi', site).placeholder).toBe('ban@example.com');
    expect(resolveSignupCopy('pt-BR', site).heading).toBe('Assine');
    expect(resolveSignupCopy('pt-BR', site).button).toBe('Subscribe');
    const overrides = signupCardOverrides({ button_label: { vi: 'Theo dõi', en: 'Follow' }, heading: 'Fixed' });
    expect(resolveSignupCopy('vi', site, overrides)).toMatchObject({ button: 'Theo dõi', heading: 'Fixed' });
    expect(resolveSignupCopy('en', site, overrides).button).toBe('Follow');
  });

  it('never throws on malformed locales or data', () => {
    expect(normalizeLocale('"><script>')).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
    expect(resolveSignupCopy('%%%', null, null).button).toBe('Subscribe');
    expect(signupCardOverrides({ heading: 42, button_label: ['x'] })).toEqual({});
  });
});

describe('routing guards', () => {
  it('portal public paths are exact', () => {
    expect(isPortalPublicPath('/api/v1/portal/magic-link')).toBe(true);
    expect(isPortalPublicPath('/api/v1/portal/magic-link/')).toBe(true);
    expect(isPortalPublicPath('/api/v1/portal/me')).toBe(false);
    expect(isPortalPublicPath('/api/v1/portal/magic-link/verify/x')).toBe(false);
    expect(isPortalPublicPath('/api/v1/portal/configs')).toBe(false);
  });

  it('members admin is on the Studio plane; the Portal is not', () => {
    expect(isStudioAccessPath('/api/v1/members')).toBe(true);
    expect(isStudioAccessPath('/api/v1/members/tiers')).toBe(true);
    expect(isStudioAccessPath('/api/v1/portal/me')).toBe(false);
  });
});

describe('newsletter compose', () => {
  it('strips active content', () => {
    const out = sanitizeEmailHtml('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="//e"></iframe>');
    expect(out).not.toMatch(/script|onclick|javascript:|iframe/i);
    expect(out).toContain('<p>Hi</p>');
  });

  it('keeps safe formatting and links, drops unsafe URLs and attributes', () => {
    const out = sanitizeEmailHtml('<h2 class="t">T</h2><p>a <a href="https://x.test/a?b=1&amp;c=2" onclick="x">link</a> &amp; <strong>b</strong></p><img src="javascript:alert(1)" alt="i"><img src="https://x.test/i.png">1 < 2');
    expect(out).toBe('<h2 class="t">T</h2><p>a <a href="https://x.test/a?b=1&amp;c=2">link</a> &amp; <strong>b</strong></p><img alt="i" /><img src="https://x.test/i.png" />1 &lt; 2');
  });

  it('is not bypassed by nested or spliced payloads', () => {
    for (const payload of [
      '<scr<script></script>ipt>alert(1)</script>',
      '<<script>script>alert(1)<</script>/script>',
      '<p oonclick=x()nclick="alert(1)">x</p>',
      '<ifr<iframe></iframe>ame src=//e></iframe>',
      '<SCRIPT >alert(1)</SCRIPT >',
    ]) {
      const out = sanitizeEmailHtml(payload);
      expect(out).not.toMatch(/<\s*\/?\s*(script|iframe)/i);
      expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });

  it('composes from strings, translatable maps and rich text documents', () => {
    expect(pickText({ en: 'Hello', vi: 'Xin chào' }, 'vi')).toBe('Xin chào');
    const plain = composeFromItem({ id: 'p1', data: { title: 'T <b>', content: 'one\n\ntwo' } }, { subjectField: 'title', bodyField: 'content' });
    expect(plain.html).toContain('<h1>T &lt;b&gt;</h1>');
    expect(plain.html).toContain('<p>one</p><p>two</p>');
    const doc = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '<x>' }] }] };
    const rich = composeFromItem({ id: 'p2', data: { title: 'R', content: doc } }, { subjectField: 'title', bodyField: 'content' });
    expect(rich.html).toContain('&lt;x&gt;');
    expect(() => composeFromItem({ id: 'p3', data: {} }, { subjectField: 'title', bodyField: 'content' })).toThrow();
  });
});

describe('sending domain helpers (N06)', () => {
  it('splits 2048-bit DKIM values into ≤255-byte strings and joins them back', async () => {
    const { publicKey, privateKeyPem } = await generateDkimKeyPair();
    expect(privateKeyPem).toContain('BEGIN PRIVATE KEY');
    const value = dkimRecordValue(publicKey);
    expect(value.length).toBeGreaterThan(255);
    const split = splitTxtValue(value);
    for (const chunk of split.match(/"([^"]*)"/g)!) expect(chunk.length - 2).toBeLessThanOrEqual(255);
    expect(joinTxtData(split)).toBe(value);
  });

  it('checks DMARC alignment by mode', () => {
    expect(dkimAligned('example.test', 'example.test', 'strict')).toBe(true);
    expect(dkimAligned('news.example.test', 'example.test', 'strict')).toBe(false);
    expect(dkimAligned('news.example.test', 'example.test', 'relaxed')).toBe(true);
    expect(dkimAligned('other.test', 'example.test', 'relaxed')).toBe(false);
  });
});

describe('link tokens', () => {
  it('are purpose-bound', async () => {
    const unsub = await signUnsubscribeToken({ siteId: 's', memberId: 'm' }, 'secret');
    const open = await signTrackToken('open', { siteId: 's', sendId: 'x', memberId: 'm' }, 'secret');
    expect(await verifyUnsubscribeToken(unsub, 'secret')).toEqual({ siteId: 's', memberId: 'm' });
    expect(await verifyUnsubscribeToken(open, 'secret')).toBeNull();
    expect(await verifyTrackToken('click', open, 'secret')).toBeNull();
    expect(await verifyTrackToken('open', open, 'other')).toBeNull();
  });
});

describe('segments + sequences schemas', () => {
  it('compiles an empty filter to the site condition only', () => {
    expect(segmentWhere('site_x', parseSegmentFilter({}))).toBeTruthy();
  });

  it('ships valid templates', () => {
    for (const t of SEQUENCE_TEMPLATES) {
      expect(sequenceInputSchema.safeParse({ ...t.sequence, status: 'draft' }).success).toBe(true);
    }
    expect(SEQUENCE_TEMPLATES.map((t) => t.key)).toEqual(['welcome', 'onboarding', 'win-back']);
  });
});
