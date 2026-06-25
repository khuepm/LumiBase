import { describe, it, expect } from 'vitest';
import { vercelProvider } from '../providers/vercel';
import { netlifyProvider } from '../providers/netlify';

describe('inbound webhook verification (Req 7.2)', () => {
  it('rejects when no secret is configured', () => {
    expect(vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': 'abc' }, rawBody: '{}' }, '')).toBe(false);
    expect(netlifyProvider.verifyWebhook({ headers: { 'x-webhook-signature': 'abc' }, rawBody: '{}' }, '')).toBe(false);
  });

  it('rejects when the signature header is missing', () => {
    expect(vercelProvider.verifyWebhook({ headers: {}, rawBody: '{}' }, 'secret')).toBe(false);
    expect(netlifyProvider.verifyWebhook({ headers: {}, rawBody: '{}' }, 'secret')).toBe(false);
  });

  it('accepts a signed request with a configured secret', () => {
    expect(vercelProvider.verifyWebhook({ headers: { 'x-vercel-signature': 'abc' }, rawBody: '{}' }, 'secret')).toBe(true);
    expect(netlifyProvider.verifyWebhook({ headers: { 'x-webhook-signature': 'abc' }, rawBody: '{}' }, 'secret')).toBe(true);
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
