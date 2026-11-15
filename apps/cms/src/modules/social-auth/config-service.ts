/**
 * Per-site social login provider configuration (#736).
 *
 * Public values are columns; the client secret (Google, GitHub) and the Apple
 * `.p8` signing key are sealed with the KeyProvider (`sealSecret`, AES-GCM,
 * AAD = site + provider + field — the same vault the TOTP seeds use) and are
 * write-only through the API: reads report `hasClientSecret` /
 * `hasApplePrivateKey`, never the value.
 */

import { and, eq } from 'drizzle-orm';
import { importPKCS8 } from 'jose';
import { z } from 'zod';
import { socialAuthProviders, type Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { openSecret, sealSecret } from '../../services/crypto/sealed-secret';
import { SocialAuthError } from './errors';
import { SOCIAL_PROVIDERS, type ProviderRuntimeConfig, type SocialProvider } from './providers';
import { validateRedirectUri } from './redirect';

type Row = typeof socialAuthProviders.$inferSelect;

export interface ProviderConfigView {
  provider: SocialProvider;
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  appleTeamId: string | null;
  appleKeyId: string | null;
  hasApplePrivateKey: boolean;
  allowedRedirectUris: string[];
  updatedAt: string | null;
}

export const providerConfigInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    clientId: z.string().trim().min(1).max(512),
    /** Write-only. Omit (or send empty) to keep the stored secret. */
    clientSecret: z.string().max(4096).optional(),
    appleTeamId: z.string().trim().max(64).optional(),
    appleKeyId: z.string().trim().max(64).optional(),
    /** Write-only PKCS#8 PEM of the `.p8` key. Omit to keep the stored key. */
    applePrivateKey: z.string().max(8192).optional(),
    allowedRedirectUris: z.array(z.string()).max(20).default([]),
  })
  .strict();

export type ProviderConfigInput = z.infer<typeof providerConfigInputSchema>;

const secretAad = (siteId: string, provider: SocialProvider, field: 'client-secret' | 'apple-key') =>
  `social-provider|${siteId}|${provider}|${field}`;

function toView(provider: SocialProvider, row: Row | undefined): ProviderConfigView {
  return {
    provider,
    configured: !!row,
    enabled: row?.enabled ?? false,
    clientId: row?.clientId ?? null,
    hasClientSecret: !!row?.clientSecretCiphertext,
    appleTeamId: row?.appleTeamId ?? null,
    appleKeyId: row?.appleKeyId ?? null,
    hasApplePrivateKey: !!row?.applePrivateKeyCiphertext,
    allowedRedirectUris: Array.isArray(row?.allowedRedirectUris) ? row.allowedRedirectUris : [],
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

async function seal(keys: KeyProvider, aad: string, value: string): Promise<string> {
  try {
    return (await sealSecret(keys, aad, value)).ciphertext;
  } catch (err) {
    if (err instanceof Error && /no encryption key configured/i.test(err.message)) {
      throw new SocialAuthError(
        'ENCRYPTION_NOT_CONFIGURED',
        503,
        'Storing a provider secret requires ENCRYPTION_KEY to be configured on this deployment.',
      );
    }
    throw err;
  }
}

export class SocialProviderConfigService {
  constructor(
    private readonly db: Database,
    private readonly keys: KeyProvider,
    private readonly siteId: string,
  ) {}

  private async rows(): Promise<Row[]> {
    return this.db.select().from(socialAuthProviders).where(eq(socialAuthProviders.siteId, this.siteId));
  }

  private async row(provider: SocialProvider): Promise<Row | undefined> {
    const [row] = await this.db
      .select()
      .from(socialAuthProviders)
      .where(and(eq(socialAuthProviders.siteId, this.siteId), eq(socialAuthProviders.provider, provider)))
      .limit(1);
    return row;
  }

  async list(): Promise<ProviderConfigView[]> {
    const rows = await this.rows();
    return SOCIAL_PROVIDERS.map((p) => toView(p, rows.find((r) => r.provider === p)));
  }

  /** Providers a visitor may use right now (public; names only). */
  async enabledProviders(): Promise<SocialProvider[]> {
    const rows = await this.rows();
    return SOCIAL_PROVIDERS.filter((p) => rows.some((r) => r.provider === p && r.enabled));
  }

  async upsert(provider: SocialProvider, raw: unknown): Promise<{ view: ProviderConfigView; changed: string[] }> {
    const parsed = providerConfigInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SocialAuthError('VALIDATION', 400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    const input = parsed.data;
    const redirects: string[] = [];
    for (const entry of input.allowedRedirectUris) {
      const v = validateRedirectUri(entry);
      if (!v.ok) throw new SocialAuthError('INVALID_REDIRECT_URI', 400, `Redirect URI "${entry}" ${v.reason}.`);
      if (!redirects.includes(v.uri)) redirects.push(v.uri);
    }

    const existing = await this.row(provider);
    const changed: string[] = ['clientId', 'allowedRedirectUris'];
    let clientSecretCiphertext = existing?.clientSecretCiphertext ?? null;
    let applePrivateKeyCiphertext = existing?.applePrivateKeyCiphertext ?? null;

    if (provider !== 'apple' && input.clientSecret?.trim()) {
      clientSecretCiphertext = await seal(this.keys, secretAad(this.siteId, provider, 'client-secret'), input.clientSecret.trim());
      changed.push('clientSecret');
    }
    if (provider === 'apple' && input.applePrivateKey?.trim()) {
      const pem = input.applePrivateKey.trim();
      try {
        await importPKCS8(pem, 'ES256');
      } catch {
        throw new SocialAuthError('INVALID_APPLE_KEY', 400, 'applePrivateKey must be the PKCS#8 PEM content of the .p8 key file.');
      }
      applePrivateKeyCiphertext = await seal(this.keys, secretAad(this.siteId, provider, 'apple-key'), pem);
      changed.push('applePrivateKey');
    }

    const appleTeamId = provider === 'apple' ? input.appleTeamId || existing?.appleTeamId || null : null;
    const appleKeyId = provider === 'apple' ? input.appleKeyId || existing?.appleKeyId || null : null;
    const enabled = input.enabled ?? existing?.enabled ?? false;

    if (enabled) {
      const missing: string[] = [];
      if (provider === 'apple') {
        if (!appleTeamId) missing.push('appleTeamId');
        if (!appleKeyId) missing.push('appleKeyId');
        if (!applePrivateKeyCiphertext) missing.push('applePrivateKey');
      } else if (!clientSecretCiphertext) {
        missing.push('clientSecret');
      }
      if (redirects.length === 0) missing.push('allowedRedirectUris');
      if (missing.length) {
        throw new SocialAuthError('PROVIDER_INCOMPLETE', 400, `Cannot enable ${provider}: missing ${missing.join(', ')}.`);
      }
    }
    if (enabled !== (existing?.enabled ?? false)) changed.push('enabled');

    const values = {
      enabled,
      clientId: input.clientId,
      clientSecretCiphertext: provider === 'apple' ? null : clientSecretCiphertext,
      appleTeamId,
      appleKeyId,
      applePrivateKeyCiphertext: provider === 'apple' ? applePrivateKeyCiphertext : null,
      allowedRedirectUris: redirects,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(socialAuthProviders)
      .values({ siteId: this.siteId, provider, ...values })
      .onConflictDoUpdate({ target: [socialAuthProviders.siteId, socialAuthProviders.provider], set: values })
      .returning();
    return { view: toView(provider, row), changed };
  }

  async remove(provider: SocialProvider): Promise<boolean> {
    const removed = await this.db
      .delete(socialAuthProviders)
      .where(and(eq(socialAuthProviders.siteId, this.siteId), eq(socialAuthProviders.provider, provider)))
      .returning({ id: socialAuthProviders.id });
    return removed.length > 0;
  }

  /**
   * Decrypted configuration for an ENABLED provider, plus its redirect
   * allow-list. Null when the provider is not set up or switched off.
   */
  async runtime(provider: SocialProvider): Promise<{ config: ProviderRuntimeConfig; allowedRedirectUris: string[] } | null> {
    const row = await this.row(provider);
    if (!row?.enabled) return null;
    const allowedRedirectUris = Array.isArray(row.allowedRedirectUris) ? row.allowedRedirectUris : [];
    try {
      if (provider === 'apple') {
        if (!row.appleTeamId || !row.appleKeyId || !row.applePrivateKeyCiphertext) return null;
        const privateKeyPem = await openSecret(this.keys, secretAad(this.siteId, provider, 'apple-key'), row.applePrivateKeyCiphertext);
        return {
          config: { provider, clientId: row.clientId, apple: { teamId: row.appleTeamId, keyId: row.appleKeyId, privateKeyPem } },
          allowedRedirectUris,
        };
      }
      if (!row.clientSecretCiphertext) return null;
      const clientSecret = await openSecret(this.keys, secretAad(this.siteId, provider, 'client-secret'), row.clientSecretCiphertext);
      return { config: { provider, clientId: row.clientId, clientSecret }, allowedRedirectUris };
    } catch {
      // Key rotated away / tampered row: fail closed, but say why.
      throw new SocialAuthError(
        'SOCIAL_PROVIDER_KEY_UNAVAILABLE',
        503,
        `The stored ${provider} secret cannot be decrypted; re-enter it in the provider settings.`,
      );
    }
  }
}
