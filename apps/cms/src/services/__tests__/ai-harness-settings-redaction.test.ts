import { describe, expect, it, vi } from 'vitest';
import { AISecureHarness } from '../ai-harness';

/**
 * `listSettings` returns setting values with the same redaction as
 * `GET /api/v1/settings` (#579). Before, the skill returned raw rows, so a
 * governed MCP client got `media.signedTransform.secret` in a tool result that
 * then sat in an external model's context, while REST redacted it for everyone.
 */
describe('listSettings skill redaction (#579)', () => {
  it('redacts secret-bearing fields and keeps the rest', async () => {
    const configService = {
      listSettings: vi.fn(async () => [
        {
          key: 'media.signedTransform',
          scope: 'site',
          value: { enabled: true, secret: 'CANARY-579-SECRET', nested: { apiKey: 'CANARY-579-KEY', ttl: 60 } },
        },
        { key: 'locales', scope: 'site', value: { default: 'en' } },
      ]),
    };
    const harness = new AISecureHarness({ db: {} as never, siteId: 'site_1', configService: configService as never });
    const result = await harness.runSkill('listSettings', {});
    expect(result.success).toBe(true);
    const text = JSON.stringify(result.success ? result.data : null);
    expect(text).not.toContain('CANARY-579');
    expect(result.success && result.data).toEqual({
      settings: [
        {
          key: 'media.signedTransform',
          scope: 'site',
          value: { enabled: true, secret: '[redacted]', nested: { apiKey: '[redacted]', ttl: 60 } },
        },
        { key: 'locales', scope: 'site', value: { default: 'en' } },
      ],
    });
  });
});
