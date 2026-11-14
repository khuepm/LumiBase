/**
 * Per-project secrets, generated at scaffold time (#731).
 *
 * Templates used to ship fixed values — `JWT_SECRET=change-me-in-production`,
 * `dev_secret_key`, an admin password printed in the README — and every
 * project generated from them shared those values until someone remembered
 * to change them. A shared JWT secret is a shared admin credential: anyone who
 * knows it can sign a token the CMS accepts.
 *
 * So the committed `.env.example` (or `.dev.vars.example`) lists the keys with
 * EMPTY values, and the scaffolder writes the gitignored local file with fresh
 * CSPRNG values. Nothing secret is ever in a template, and a project that
 * skips this step fails loudly (`${JWT_SECRET:?…}` in compose, `requireEnv` in
 * the scripts) instead of running on a known value.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Template } from './index.js';

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HS256 signing secret: 48 random bytes → 64 base64url chars. */
export function generateJwtSecret(): string {
  return base64url(randomBytes(48));
}

/** AES-256-GCM key in the exact form the CMS validates: base64 of 32 bytes. */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * First-admin password that satisfies the starter's policy (12+ chars with
 * upper, lower, digit and symbol). The random body carries the entropy
 * (144 bits); the fixed suffix only guarantees every character class.
 */
export function generateAdminPassword(): string {
  return `${base64url(randomBytes(18))}#Lb7`;
}

/** Where each template's local, gitignored secrets live, and what it copies. */
export const LOCAL_ENV_FILE: Record<Template, { example: string; target: string }> = {
  default: { example: '.env.example', target: '.env' },
  nextjs: { example: '.env.example', target: '.env' },
  cloudflare: { example: '.dev.vars.example', target: '.dev.vars' },
};

/** Generators keyed by variable name. Only keys present (and empty) in the example are filled. */
const GENERATORS: Record<string, () => string> = {
  JWT_SECRET: generateJwtSecret,
  ENCRYPTION_KEY: generateEncryptionKey,
  LUMIBASE_ADMIN_PASSWORD: generateAdminPassword,
};

/** Fill every `KEY=` line whose key has a generator. Other lines pass through untouched. */
export function fillSecrets(exampleText: string): { text: string; generated: string[] } {
  const generated: string[] = [];
  const text = exampleText
    .split('\n')
    .map((line) => {
      const m = /^([A-Z][A-Z0-9_]*)=\s*$/.exec(line);
      const gen = m ? GENERATORS[m[1]!] : undefined;
      if (!m || !gen) return line;
      generated.push(m[1]!);
      return `${m[1]}=${gen()}`;
    })
    .join('\n');
  return { text, generated };
}

export interface LocalSecretsResult {
  /** File written, relative to the project, or `null` when one already existed. */
  written: string | null;
  target: string;
  generated: string[];
}

/**
 * Write the local secrets file next to the example. An existing file is left
 * alone: regenerating ENCRYPTION_KEY under a database that already holds
 * ciphertext would make that data unreadable.
 */
export function writeLocalSecrets(targetDir: string, template: Template): LocalSecretsResult {
  const { example, target } = LOCAL_ENV_FILE[template];
  const targetPath = join(targetDir, target);
  if (existsSync(targetPath)) return { written: null, target, generated: [] };
  const { text, generated } = fillSecrets(readFileSync(join(targetDir, example), 'utf8'));
  writeFileSync(targetPath, text, { encoding: 'utf8', mode: 0o600 });
  return { written: target, target, generated };
}
