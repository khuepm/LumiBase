/**
 * Secure-by-default templates (#731): no template carries a secret or a
 * default admin, and the scaffolder generates per-project values.
 *
 * The end-to-end proof — scaffold every template into a temp dir and run
 * `lumibase doctor --security` on it — lives next to the checker, in
 * `packages/cli/src/security/scaffold-acceptance.test.ts`.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_ENV_FILE,
  fillSecrets,
  generateAdminPassword,
  generateEncryptionKey,
  generateJwtSecret,
  writeLocalSecrets,
} from './secrets.js';

// Not imported from ./index.js: that module runs the CLI on import.
const TEMPLATES = ['nextjs', 'default', 'cloudflare'] as const;

const templatesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../templates');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('secret generators', () => {
  it('JWT secret: 64 base64url chars, unique', () => {
    const a = generateJwtSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(generateJwtSecret()).not.toBe(a);
  });

  it('encryption key: base64 of exactly 32 bytes (what the CMS validates)', () => {
    const key = generateEncryptionKey();
    expect(Buffer.from(key, 'base64').byteLength).toBe(32);
    expect(Buffer.from(key, 'base64').toString('base64')).toBe(key);
  });

  it('admin password meets the 12+ / four-class policy', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateAdminPassword();
      expect(p.length).toBeGreaterThanOrEqual(12);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('fills only empty generator keys and leaves everything else untouched', () => {
    const { text, generated } = fillSecrets('# c\nJWT_SECRET=\nENCRYPTION_KEY=kept\nPORT=8787\nLUMIBASE_ADMIN_PASSWORD=\n');
    expect(generated).toEqual(['JWT_SECRET', 'LUMIBASE_ADMIN_PASSWORD']);
    expect(text).toMatch(/^JWT_SECRET=[A-Za-z0-9_-]{64}$/m);
    expect(text).toMatch(/^ENCRYPTION_KEY=kept$/m);
    expect(text).toMatch(/^PORT=8787$/m);
    expect(text.startsWith('# c\n')).toBe(true);
  });
});

describe('writeLocalSecrets', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('never overwrites an existing local env file', () => {
    dir = mkdtempSync(join(tmpdir(), 'clb-'));
    writeFileSync(join(dir, '.env.example'), 'JWT_SECRET=\n');
    writeFileSync(join(dir, '.env'), 'JWT_SECRET=mine\n');
    const r = writeLocalSecrets(dir, 'default');
    expect(r.written).toBeNull();
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('JWT_SECRET=mine\n');
  });

  it('writes a 0600 file with generated values', () => {
    dir = mkdtempSync(join(tmpdir(), 'clb-'));
    writeFileSync(join(dir, '.env.example'), 'JWT_SECRET=\n');
    expect(writeLocalSecrets(dir, 'default')).toMatchObject({ written: '.env', generated: ['JWT_SECRET'] });
    expect(statSync(join(dir, '.env')).mode & 0o077).toBe(0);
  });
});

describe('templates ship no secrets and no default admin', () => {
  const WEAK = /dev_secret_key|change-me|Change-Me-N0w!|changeme/i;

  it.each(TEMPLATES)('%s: no file contains a known default secret', (template) => {
    for (const file of walk(join(templatesDir, template))) {
      if (file.endsWith('README.md.hbs')) continue; // prose may name what NOT to do
      const text = readFileSync(file, 'utf8');
      expect(WEAK.test(text), `${file} contains a known default secret`).toBe(false);
    }
  });

  it.each(TEMPLATES)('%s: every secret in the example file is empty', (template) => {
    const exampleName = LOCAL_ENV_FILE[template].example.replace(/^\./, '_');
    const text = readFileSync(join(templatesDir, template, exampleName), 'utf8');
    for (const m of text.matchAll(/^([A-Z0-9_]*(?:SECRET|PASSWORD|ENCRYPTION_KEY|_TOKEN))=(.*)$/gm)) {
      expect(m[2], `${m[1]} must be empty in the committed example`).toBe('');
    }
    expect(text).toMatch(/^JWT_SECRET=$/m);
    expect(text).toMatch(/^ENCRYPTION_KEY=$/m);
  });

  it.each(TEMPLATES)('%s: gitignores its local secrets file', (template) => {
    const gitignore = readFileSync(join(templatesDir, template, '_gitignore'), 'utf8');
    expect(gitignore.split('\n')).toContain(LOCAL_ENV_FILE[template].target);
  });

  it('cloudflare: wrangler.toml [vars] carries no secret', () => {
    const toml = readFileSync(join(templatesDir, 'cloudflare/wrangler.toml.hbs'), 'utf8');
    const vars = toml.split(/^\[vars\]$/m)[1] ?? '';
    expect(vars).not.toMatch(/^\s*[A-Z_]*(SECRET|PASSWORD|KEY|TOKEN)\s*=/m);
    expect(toml).not.toMatch(/ADMIN_EMAIL/);
  });

  it('default + cloudflare: ship CSP, exact-origin CORS and a fail-closed secret check', () => {
    for (const rel of ['default/src/server.ts.hbs', 'cloudflare/src/index.ts.hbs']) {
      const src = readFileSync(join(templatesDir, rel), 'utf8');
      expect(src).toMatch(/secureHeaders\(/);
      expect(src).toMatch(/contentSecurityPolicy/);
      expect(src).toMatch(/allowed(Origins)?\.includes\(origin\)/);
      expect(src).toMatch(/JWT_SECRET[\s\S]{0,80}length < 32/);
    }
    const server = readFileSync(join(templatesDir, 'default/src/server.ts.hbs'), 'utf8');
    expect(server).toMatch(/LUMIBASE_API_RATE_LIMIT/);
  });

  it('default: Postgres and Redis are published on loopback only', () => {
    const compose = readFileSync(join(templatesDir, 'default/docker-compose.yml'), 'utf8');
    for (const m of compose.matchAll(/^\s*-\s*"([^"]+)"/gm)) {
      expect(m[1]!.startsWith('127.0.0.1:'), `${m[1]} is published on all interfaces`).toBe(true);
    }
  });
});
