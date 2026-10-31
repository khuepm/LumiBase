/**
 * Redaction of secret-bearing fields in site settings values.
 *
 * Shared by every read surface that returns settings: the REST read API
 * (`routes/settings.ts`, B2) and the `listSettings` agent skill (#579). The
 * skill used to return raw values, so a governed MCP client or the Copilot got
 * secrets such as `media.signedTransform.secret` that REST redacts, and on the
 * MCP path the tool result lands in an external model's context.
 *
 * Server-side consumers that need the real value read it directly from the DB
 * (e.g. `media.ts` `loadSignedTransformPolicy`), so no read surface ever needs
 * to return a secret, to anyone.
 */
const SECRET_TOKENS = ['secret', 'token', 'password', 'passwd', 'apikey', 'privatekey', 'accesskey', 'credential', 'passphrase'];

export const REDACTED = '[redacted]';

export function isSecretSettingField(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_TOKENS.some((t) => norm.includes(t));
}

export function redactSettingSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSettingSecrets);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretSettingField(k) ? REDACTED : redactSettingSecrets(v);
    }
    return out;
  }
  return value;
}

export function redactSettingRow<T extends { value: unknown }>(row: T): T {
  return { ...row, value: redactSettingSecrets(row.value) };
}
