import { describe, it, expect } from 'vitest';
import { vercelProvider } from '../providers/vercel';
import { netlifyProvider } from '../providers/netlify';
import { hmacHex } from '../providers/http';

// Build a valid compact JWS (HS256) the way Netlify signs notifications.
async function signJws(secret: string, body: string): Promise<string> {
  const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(body);
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${payload}.${sigB64}`;
}

describe('inbound webhook verification (Req 7.2)', () => {
  const body = '{"type":"deployment.ready"}';

  it('rejects when no secret is configured', async () => {
    expect(await vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': 'abc' }, rawBody: body }, '')).toBe(false);
    expect(await netlifyProvider.verifyWebhook({ headers: { 'x-webhook-signature': 'abc' }, rawBody: body }, '')).toBe(false);
  });

  it('rejects when the signature header is missing', async () => {
    expect(await vercelProvider.verifyWebhook({ headers: {}, rawBody: body }, 'secret')).toBe(false);
    expect(await netlifyProvider.verifyWebhook({ headers: {}, rawBody: body }, 'secret')).toBe(false);
  });

  it('rejects a forged/invalid signature even with a configured secret', async () => {
    // The core vulnerability this guards: a bogus signature must NOT pass.
    expect(await vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': 'deadbeef' }, rawBody: body }, 'secret')).toBe(false);
    expect(await netlifyProvider.verifyWebhook({ headers: { 'x-webhook-signature': 'not.a.jws' }, rawBody: body }, 'secret')).toBe(false);
  });

  it('accepts a correctly signed request (Vercel HMAC-SHA1, Netlify JWS)', async () => {
    const vercelSig = await hmacHex('secret', body, 'SHA-1');
    expect(await vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': vercelSig }, rawBody: body }, 'secret')).toBe(true);

    const netlifyJws = await signJws('secret', body);
    expect(await netlifyProvider.verifyWebhook({ headers: { 'x-webhook-signature': netlifyJws }, rawBody: body }, 'secret')).toBe(true);
  });

  it('rejects when the body is tampered after signing', async () => {
    const sig = await hmacHex('secret', body, 'SHA-1');
    expect(await vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': sig }, rawBody: body + 'x' }, 'secret')).toBe(false);
  });
});

describe('inbound webhook parsing (Req 7.3)', () => {
  it('parses a Vercel deployment.ready event to a terminal ref', () => {
    const body = JSON.stringify({
      type: 'deployment.ready',
      payload: { deployment: { id: 'dpl_1', url: 'site.vercel.app' } },
    });
    const ref = vercelProvider.parseWebhook(body);
    expect(ref?.providerDeploymentId).toBe('dpl_1');
    expect(ref?.status).toBe('ready');
    expect(ref?.url).toBe('https://site.vercel.app');
    expect(ref?.completedAt).toBeInstanceOf(Date);
  });

  it('parses a Vercel deployment.error event', () => {
    const ref = vercelProvider.parseWebhook(
      JSON.stringify({ type: 'deployment.error', payload: { deployment: { id: 'dpl_2' } } }),
    );
    expect(ref?.status).toBe('error');
  });

  it('parses a Netlify deploy state payload', () => {
    const ref = netlifyProvider.parseWebhook(JSON.stringify({ id: 'deploy_9', state: 'ready', ssl_url: 'https://x.netlify.app' }));
    expect(ref?.providerDeploymentId).toBe('deploy_9');
    expect(ref?.status).toBe('ready');
  });

  it('returns null for unparseable bodies', () => {
    expect(vercelProvider.parseWebhook('not json')).toBeNull();
    expect(netlifyProvider.parseWebhook('{}')).toBeNull();
  });
});
