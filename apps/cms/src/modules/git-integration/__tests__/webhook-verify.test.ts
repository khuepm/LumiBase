import { describe, it, expect } from 'vitest';
import { hmacSha256Hex } from '../../notifications/webhook-channel';
import { constantTimeEqualStr } from '../webhook/constant-time';
import {
  extractRepoFullName,
  isWebhookProvider,
  verifyWebhookSignature,
} from '../webhook/verify';

const SECRET = 'whsec_test_secret';

describe('constantTimeEqualStr', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqualStr('abc', 'abc')).toBe(true);
  });
  it('returns false for different content or length', () => {
    expect(constantTimeEqualStr('abc', 'abd')).toBe(false);
    expect(constantTimeEqualStr('abc', 'abcd')).toBe(false);
    expect(constantTimeEqualStr('', 'a')).toBe(false);
  });
});

describe('verifyWebhookSignature — github', () => {
  it('accepts a correct HMAC-SHA256 signature', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const sig = `sha256=${await hmacSha256Hex(SECRET, body)}`;
    const res = await verifyWebhookSignature('github', {
      rawBody: body,
      secret: SECRET,
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
      },
    });
    expect(res.valid).toBe(true);
    expect(res.event).toBe('pull_request');
    expect(res.deliveryId).toBe('delivery-1');
  });

  it('rejects a tampered body', async () => {
    const sig = `sha256=${await hmacSha256Hex(SECRET, 'original')}`;
    const res = await verifyWebhookSignature('github', {
      rawBody: 'tampered',
      secret: SECRET,
      headers: { 'x-hub-signature-256': sig },
    });
    expect(res.valid).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const body = 'payload';
    const sig = `sha256=${await hmacSha256Hex('other', body)}`;
    const res = await verifyWebhookSignature('github', {
      rawBody: body,
      secret: SECRET,
      headers: { 'x-hub-signature-256': sig },
    });
    expect(res.valid).toBe(false);
  });
});

describe('verifyWebhookSignature — gitlab', () => {
  it('accepts a matching token', async () => {
    const res = await verifyWebhookSignature('gitlab', {
      rawBody: '{}',
      secret: SECRET,
      headers: {
        'x-gitlab-token': SECRET,
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-event-uuid': 'uuid-1',
      },
    });
    expect(res.valid).toBe(true);
    expect(res.event).toBe('Merge Request Hook');
    expect(res.deliveryId).toBe('uuid-1');
  });

  it('rejects a wrong token', async () => {
    const res = await verifyWebhookSignature('gitlab', {
      rawBody: '{}',
      secret: SECRET,
      headers: { 'x-gitlab-token': 'nope' },
    });
    expect(res.valid).toBe(false);
  });
});

describe('extractRepoFullName / isWebhookProvider', () => {
  it('extracts the repo from github + gitlab payloads', () => {
    expect(
      extractRepoFullName('github', { repository: { full_name: 'a/b' } }),
    ).toBe('a/b');
    expect(
      extractRepoFullName('gitlab', {
        project: { path_with_namespace: 'g/s/p' },
      }),
    ).toBe('g/s/p');
    expect(extractRepoFullName('github', {})).toBeNull();
  });
  it('guards the provider union', () => {
    expect(isWebhookProvider('github')).toBe(true);
    expect(isWebhookProvider('gitlab')).toBe(true);
    expect(isWebhookProvider('bitbucket')).toBe(false);
  });
});
