/**
 * #731 acceptance: a fresh scaffold of every create-lumibase template passes
 * `lumibase doctor --security` with zero critical findings.
 *
 * This runs the real scaffolder (`packages/create-lumibase/src/scaffold.ts`,
 * the function `npm create lumibase` calls) into a temp directory and then the
 * real CLI command against it — no fixtures, so a template edit that
 * reintroduces a fixed secret, a default admin or `*` CORS fails here.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scaffold } from '../../../create-lumibase/src/scaffold.js';
import { doctorCommand } from '../commands/doctor.js';
import { parseArgs } from '../utils/args.js';
import type { SecurityReport } from './checks.js';

const TEMPLATES = ['nextjs', 'default', 'cloudflare'] as const;
type Template = (typeof TEMPLATES)[number];

const root = mkdtempSync(join(tmpdir(), 'lb-731-'));
const dirOf = (t: Template) => join(root, `fresh-${t}`);

async function securityReport(cwd: string, extra: string[] = []): Promise<{ code: number; report: SecurityReport }> {
  const out: string[] = [];
  const code = await doctorCommand(parseArgs(['doctor', '--security', '--json', ...extra]), {
    cwd,
    env: {},
    write: (line) => out.push(line),
  });
  return { code, report: JSON.parse(out.join('\n')) as SecurityReport };
}

beforeAll(async () => {
  // The spinner writes to stdout; keep test output readable.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const template of TEMPLATES) {
    await scaffold({
      projectName: `fresh-${template}`,
      targetDir: dirOf(template),
      template,
      packageManager: 'npm',
      installDeps: false,
      initializeGit: false,
    });
  }
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fresh scaffold passes doctor --security (#731)', () => {
  it.each(TEMPLATES)('%s: zero critical findings, exit 0', async (template) => {
    const { code, report } = await securityReport(dirOf(template));
    expect(report.findings.filter((f) => f.severity === 'critical')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(code).toBe(0);
    expect(report.sources.length).toBeGreaterThan(0);
  });

  it.each(TEMPLATES)('%s: writes generated secrets to a gitignored 0600 file', (template) => {
    const target = template === 'cloudflare' ? '.dev.vars' : '.env';
    const path = join(dirOf(template), target);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(join(dirOf(template), '.gitignore'), 'utf8')).toMatch(new RegExp(`^${target.replace('.', '\\.')}$`, 'm'));
    expect(readFileSync(path, 'utf8')).toMatch(/^JWT_SECRET=\S{32,}$/m);
  });

  it('nextjs: compose resolves the CMS secrets from .env, not from the committed file', async () => {
    const compose = readFileSync(join(dirOf('nextjs'), 'docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/JWT_SECRET: \$\{JWT_SECRET:\?/);
    expect(compose).toMatch(/ENCRYPTION_KEY: \$\{ENCRYPTION_KEY:\?/);
    expect(compose).not.toMatch(/dev_secret_key/);
    const env = readFileSync(join(dirOf('nextjs'), '.env'), 'utf8');
    expect(env).toMatch(/^ENCRYPTION_KEY=[A-Za-z0-9+/]{43}=$/m);
    expect(env).toMatch(/^LUMIBASE_ADMIN_PASSWORD=\S{12,}$/m);
  });

  it('two scaffolds never share a secret', async () => {
    const again = join(root, 'again-nextjs');
    await scaffold({
      projectName: 'again-nextjs',
      targetDir: again,
      template: 'nextjs',
      packageManager: 'npm',
      installDeps: false,
      initializeGit: false,
    });
    const pick = (dir: string, key: string) =>
      new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(join(dir, '.env'), 'utf8'))?.[1];
    for (const key of ['JWT_SECRET', 'ENCRYPTION_KEY', 'LUMIBASE_ADMIN_PASSWORD']) {
      expect(pick(again, key)).toBeTruthy();
      expect(pick(again, key)).not.toBe(pick(dirOf('nextjs'), key));
    }
  });

  it('the production checklist still lists what a local stack cannot satisfy', async () => {
    // Development defaults are not production-ready, and the doctor says so:
    // a local Postgres has no TLS, and the default dev origin is http.
    const { code, report } = await securityReport(dirOf('nextjs'), ['--production']);
    expect(report.mode).toBe('production');
    expect(code).toBe(1);
    expect(report.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining(['database-tls', 'cors-insecure-origin', 'setup-token-off']),
    );
    // …but none of it is a secret problem: those were generated.
    expect(report.findings.map((f) => f.id)).not.toEqual(
      expect.arrayContaining(['jwt-secret-weak', 'jwt-secret-short', 'encryption-key-weak', 'admin-password-default']),
    );
  });
});
