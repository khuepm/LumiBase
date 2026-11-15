/**
 * Astro and SvelteKit starters (#744, epic #675 H04).
 *
 * The install + typecheck + build half of the acceptance runs in CI through
 * `scripts/smoke-scaffold.mjs` (it needs the network). This file is the
 * offline half that runs on every commit: the template registry, the files a
 * scaffold emits, and the two properties the starters' security story rests
 * on — no credential reaches the browser, and draft preview fails closed.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_TEMPLATES, TEMPLATES, TEMPLATE_INFO, isTemplate } from './templates.js';
import { helpText } from './utils/help.js';
import { parseArgs } from './utils/args.js';
import { scaffold } from './scaffold.js';
import { resolveContentConfig as resolveAstroConfig, safeSlug } from '../templates/astro/src/lib/config.js';
import {
  previewAvailable,
  resolveContentConfig as resolveKitConfig,
} from '../templates/sveltekit/src/lib/server/config.js';
import {
  MIN_SECRET_LENGTH,
  PREVIEW_TTL_SECONDS,
  constantTimeEqual,
  issuePreviewCookie,
  safeRedirectPath,
  secretMatches,
  verifyPreviewCookie,
} from '../templates/sveltekit/src/lib/server/preview.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');
const templatesDir = join(pkgRoot, 'templates');
const read = (template: string, rel: string) => readFileSync(join(templatesDir, template, rel), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const SITE_TEMPLATES = ['astro', 'sveltekit'] as const;

describe('template registry', () => {
  it('has exactly one directory per registered template', () => {
    const dirs = readdirSync(templatesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual([...TEMPLATES].sort());
  });

  it('accepts astro and sveltekit and rejects anything else', () => {
    expect(isTemplate('astro')).toBe(true);
    expect(isTemplate('sveltekit')).toBe(true);
    expect(isTemplate('svelte')).toBe(false);
    expect(isTemplate(true)).toBe(false);
    expect(CONTENT_TEMPLATES).toEqual(expect.arrayContaining(['astro', 'sveltekit']));
  });

  it('keeps nextjs as the preselected (first) choice', () => {
    expect(TEMPLATES[0]).toBe('nextjs');
  });

  it('lists every template in --help', () => {
    const help = helpText();
    for (const name of TEMPLATES) {
      expect(help).toContain(name);
      expect(help).toContain(TEMPLATE_INFO[name].title);
    }
  });

  it('parses -h and --help without eating the project name', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    const r = parseArgs(['--help', 'my-site']);
    expect(r.help).toBe(true);
    expect(r._).toEqual(['my-site']);
  });

  it('smoke-tests and builds every template in CI', () => {
    const smoke = readFileSync(join(pkgRoot, 'scripts/smoke-scaffold.mjs'), 'utf8');
    const list = /const TEMPLATES = \[([^\]]+)\]/.exec(smoke)?.[1] ?? '';
    for (const name of TEMPLATES) expect(list).toContain(`'${name}'`);
    expect(smoke).toMatch(/astro: 'dist\/index\.html'/);
    expect(smoke).toMatch(/sveltekit: '\.svelte-kit\/cloudflare\/_worker\.js'/);
  });
});

describe.each(SITE_TEMPLATES)('%s template — manifest', (template) => {
  const manifest = JSON.parse(read(template, 'package.json.hbs')) as {
    name: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  it('names the project and pins the client to the scaffolder version', () => {
    expect(manifest.name).toBe('{{projectName}}');
    // A range would let npm pick the `latest` dist-tag instead of this release (B95).
    expect(manifest.dependencies['lumibase']).toBe('{{lumibaseVersion}}');
    expect(manifest.devDependencies['lumibase']).toBeUndefined();
  });

  it('pins every other dependency to a concrete version range', () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      if (name === 'lumibase') continue;
      expect(range, `${name} must be pinned`).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });

  it('has the scripts the CI smoke and the docs rely on', () => {
    for (const script of ['dev', 'build', 'typecheck', 'types', 'types:check', 'deploy']) {
      expect(manifest.scripts[script], `missing script: ${script}`).toBeTruthy();
    }
    expect(manifest.scripts['deploy']).toMatch(/^wrangler pages deploy/);
    expect(manifest.devDependencies['wrangler']).toBeTruthy();
  });
});

describe('astro template — static export', () => {
  it('builds static output', () => {
    expect(read('astro', 'astro.config.mjs')).toMatch(/output:\s*'static'/);
    expect(read('astro', 'package.json.hbs')).toMatch(/"build":\s*"astro build"/);
    expect(read('astro', 'wrangler.jsonc.hbs')).toMatch(/"pages_build_output_dir":\s*"dist"/);
  });

  it('declares every LumiBase variable server-only, and the credentials secret', () => {
    const config = read('astro', 'astro.config.mjs');
    const fields = [...config.matchAll(/(LUMIBASE_[A-Z_]+):\s*envField\.\w+\(\{([^}]*)\}/g)];
    expect(fields.map((m) => m[1]).sort()).toEqual([
      'LUMIBASE_PREVIEW',
      'LUMIBASE_PREVIEW_TOKEN',
      'LUMIBASE_PUBLISHABLE_KEY',
      'LUMIBASE_SITE_ID',
      'LUMIBASE_URL',
    ]);
    for (const [, name, body] of fields) {
      expect(body, `${name} must be server-only`).toMatch(/context:\s*'server'/);
      if (/KEY|TOKEN/.test(name as string)) expect(body, `${name} must be secret`).toMatch(/access:\s*'secret'/);
    }
  });

  it('fetches content at build time through the SDK', () => {
    const lib = read('astro', 'src/lib/lumibase.ts');
    expect(lib).toMatch(/from 'astro:env\/server'/);
    expect(lib).toMatch(/createLumiClient<Schema>/);
    expect(lib).toMatch(/readItems\('posts'/);
    expect(lib).toMatch(/from '\.\.\/lumibase-types'/);
    expect(read('astro', 'src/pages/posts/[slug].astro')).toMatch(/getStaticPaths/);
  });
});

describe('astro template — which credential a build uses', () => {
  const base = { url: 'https://cms.example.com/', siteId: 's1', publishableKey: 'lbk_pub_abc' };

  it('builds the setup page when the CMS is not configured', () => {
    expect(resolveAstroConfig({})).toEqual({
      configured: false,
      missing: ['LUMIBASE_URL', 'LUMIBASE_PUBLISHABLE_KEY'],
    });
    expect(resolveAstroConfig({ url: '  ', publishableKey: 'lbk_pub_x' })).toMatchObject({ configured: false });
  });

  it('reads published content with the publishable key', () => {
    expect(resolveAstroConfig(base)).toEqual({
      configured: true,
      config: { url: 'https://cms.example.com', siteId: 's1', token: 'lbk_pub_abc', preview: false },
    });
    expect(resolveAstroConfig({ ...base, siteId: '' })).toMatchObject({ config: { siteId: '__default__' } });
  });

  it('refuses a secret token where the publishable key belongs', () => {
    expect(() => resolveAstroConfig({ ...base, publishableKey: 'lbk_secret' })).toThrow(/publishable key/);
  });

  it('fails a preview build closed', () => {
    expect(() => resolveAstroConfig({ ...base, preview: true })).toThrow(/LUMIBASE_PREVIEW_TOKEN is empty/);
    expect(() => resolveAstroConfig({ ...base, preview: true, previewToken: 'lbk_pub_abc' })).toThrow(
      /publishable key/,
    );
    expect(resolveAstroConfig({ ...base, preview: true, previewToken: 'lbk_preview' })).toMatchObject({
      config: { token: 'lbk_preview', preview: true },
    });
  });

  it('routes only URL-safe slugs', () => {
    expect(safeSlug('hello-world_2')).toBe('hello-world_2');
    for (const bad of ['', '../etc', 'a/b', '-lead', 'x'.repeat(129), 7, null, 'sp ace']) {
      expect(safeSlug(bad)).toBeNull();
    }
  });
});

describe('sveltekit template — server loads on Cloudflare Pages', () => {
  it('uses adapter-cloudflare with the Pages output directory', () => {
    expect(read('sveltekit', 'vite.config.ts')).toMatch(/adapter:\s*adapter\(\)/);
    expect(read('sveltekit', 'vite.config.ts')).toMatch(/@sveltejs\/adapter-cloudflare/);
    expect(read('sveltekit', 'wrangler.jsonc.hbs')).toMatch(
      /"pages_build_output_dir":\s*"\.svelte-kit\/cloudflare"/,
    );
  });

  it('reads the private env only from server-only modules', () => {
    const src = join(templatesDir, 'sveltekit/src');
    const serverOnly = /(^|\/)(lib\/server\/.*|hooks\.server\.ts|\+server\.ts|\+(page|layout)\.server\.ts|env\.ts)$/;
    for (const file of walk(src)) {
      const rel = relative(src, file).split('\\').join('/');
      const text = readFileSync(file, 'utf8');
      if (/['"](\$app\/env\/private|#lib\/server\/[^'"]*)['"]/.test(text)) {
        expect(rel, `${rel} imports server-only code but is not a server module`).toMatch(serverOnly);
      }
      expect(text, `${rel} must not use a PUBLIC_ variable`).not.toMatch(/PUBLIC_LUMIBASE/);
    }
  });

  it('declares no public or static env variable', () => {
    const env = read('sveltekit', 'src/env.ts');
    expect(env).toMatch(/defineEnvVars/);
    expect(env).not.toMatch(/public:\s*true/);
    expect(env).not.toMatch(/static:\s*true/);
  });

  it('never caches a preview response in a shared cache', () => {
    expect(read('sveltekit', 'src/lib/server/lumibase.ts')).toMatch(/preview \? 'private, no-store'/);
  });
});

describe('sveltekit template — which credential a request uses', () => {
  const env = {
    LUMIBASE_URL: 'https://cms.example.com',
    LUMIBASE_SITE_ID: 's1',
    LUMIBASE_PUBLISHABLE_KEY: 'lbk_pub_abc',
    LUMIBASE_PREVIEW_SECRET: 's'.repeat(MIN_SECRET_LENGTH),
    LUMIBASE_PREVIEW_TOKEN: 'lbk_preview',
  };

  it('uses the preview token only for a preview request on a fully configured site', () => {
    expect(resolveKitConfig(env, false)).toMatchObject({ config: { token: 'lbk_pub_abc', preview: false } });
    expect(resolveKitConfig(env, true)).toMatchObject({ config: { token: 'lbk_preview', preview: true } });
  });

  it('falls back to the publishable key when preview is not fully configured', () => {
    for (const broken of [
      { ...env, LUMIBASE_PREVIEW_SECRET: undefined },
      { ...env, LUMIBASE_PREVIEW_SECRET: 'short' },
      { ...env, LUMIBASE_PREVIEW_TOKEN: '' },
      { ...env, LUMIBASE_PREVIEW_TOKEN: 'lbk_pub_abc' },
    ]) {
      expect(previewAvailable(broken)).toBe(false);
      expect(resolveKitConfig(broken, true)).toMatchObject({ config: { token: 'lbk_pub_abc', preview: false } });
    }
    expect(previewAvailable(env)).toBe(true);
  });

  it('refuses a secret token in the publishable slot and reports missing settings', () => {
    expect(() => resolveKitConfig({ ...env, LUMIBASE_PUBLISHABLE_KEY: 'lbk_secret' }, false)).toThrow(
      /publishable key/,
    );
    expect(resolveKitConfig({}, true)).toEqual({
      configured: false,
      missing: ['LUMIBASE_URL', 'LUMIBASE_PUBLISHABLE_KEY'],
    });
  });
});

describe('sveltekit template — the preview cookie', () => {
  const secret = 'k'.repeat(MIN_SECRET_LENGTH);
  const now = Date.UTC(2026, 10, 15, 12, 0, 0);

  it('round-trips a cookie it issued, until it expires', async () => {
    const cookie = await issuePreviewCookie(secret, now);
    expect(await verifyPreviewCookie(secret, cookie, now)).toBe(true);
    expect(await verifyPreviewCookie(secret, cookie, now + (PREVIEW_TTL_SECONDS - 1) * 1000)).toBe(true);
    expect(await verifyPreviewCookie(secret, cookie, now + PREVIEW_TTL_SECONDS * 1000)).toBe(false);
  });

  it('rejects a cookie signed with another secret (rotation revokes sessions)', async () => {
    const cookie = await issuePreviewCookie(secret, now);
    expect(await verifyPreviewCookie('z'.repeat(MIN_SECRET_LENGTH), cookie, now)).toBe(false);
  });

  it('rejects forged, tampered and malformed cookies', async () => {
    const cookie = await issuePreviewCookie(secret, now);
    const [exp, sig] = cookie.split('.') as [string, string];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    const forged = [
      '1',
      'true',
      `${exp}.${flipped}`,
      `${Number(exp) + 60}.${sig}`,
      `${exp}.${sig}x`,
      `${exp}`,
      '',
      // Far-future expiry with a well-formed signature slot: refused before the HMAC check.
      `9999999999.${sig}`,
    ];
    for (const value of forged) {
      expect(await verifyPreviewCookie(secret, value, now), `accepted: ${value}`).toBe(false);
    }
    expect(await verifyPreviewCookie(secret, undefined, now)).toBe(false);
  });

  it('treats a short or missing secret as preview disabled', async () => {
    const cookie = await issuePreviewCookie('short', now);
    expect(await verifyPreviewCookie('short', cookie, now)).toBe(false);
    expect(await verifyPreviewCookie(undefined, cookie, now)).toBe(false);
  });

  it('matches the preview secret exactly', async () => {
    expect(await secretMatches(secret, secret)).toBe(true);
    expect(await secretMatches(`${secret}x`, secret)).toBe(false);
    expect(await secretMatches(secret.slice(1), secret)).toBe(false);
    expect(await secretMatches('', secret)).toBe(false);
    expect(await secretMatches(null, secret)).toBe(false);
    expect(await secretMatches('short', 'short')).toBe(false);
  });

  it('compares without depending on where strings differ', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('only redirects to same-origin paths', () => {
    expect(safeRedirectPath('/posts/hello?x=1')).toBe('/posts/hello?x=1');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example', 'posts', '/\nx']) {
      expect(safeRedirectPath(bad)).toBe('/');
    }
  });
});

describe.each(SITE_TEMPLATES)('%s template — no secrets committed', (template) => {
  const envExample = read(template, '_env.example');

  it('ships every credential empty in .env.example', () => {
    const credentials = [...envExample.matchAll(/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*)=(.*)$/gm)];
    expect(credentials.length).toBeGreaterThanOrEqual(3);
    for (const [, name, value] of credentials) {
      expect(value, `${name} must be empty in .env.example`).toBe('');
    }
  });

  it('has no browser-exposed LumiBase variable', () => {
    expect(envExample).not.toMatch(/^(PUBLIC_|VITE_)/m);
  });

  it('git-ignores the real env files', () => {
    const ignore = read(template, '_gitignore');
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
    if (template === 'sveltekit') expect(ignore).toMatch(/^\.dev\.vars$/m);
  });

  it('keeps the CLI token out of the committed config', () => {
    expect(read(template, 'lumibase.config.json')).not.toMatch(/token/i);
  });

  it('marks the visual editing hook point without inventing an API', () => {
    const file =
      template === 'astro' ? 'src/components/VisualEditing.astro' : 'src/lib/components/VisualEditing.svelte';
    const hook = read(template, file);
    expect(hook).toMatch(/#681/);
    expect(hook).not.toMatch(/<script/);
    expect(hook).not.toMatch(/@lumibase\/visual-editing['"]/);
  });
});

describe('scaffold() emits runnable astro and sveltekit projects', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumibase-site-templates-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each(SITE_TEMPLATES)('%s', async (template) => {
    const targetDir = join(root, template);
    await scaffold({
      projectName: `demo-${template}`,
      targetDir,
      template,
      packageManager: 'npm',
      installDeps: false,
      initializeGit: false,
    });

    expect(existsSync(join(targetDir, '.env.example'))).toBe(true);
    expect(existsSync(join(targetDir, '.gitignore'))).toBe(true);
    expect(existsSync(join(targetDir, '_env.example'))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe(`demo-${template}`);
    expect(manifest.dependencies['lumibase']).toMatch(/^\d+\.\d+\.\d+/);

    expect(readFileSync(join(targetDir, 'wrangler.jsonc'), 'utf8')).toContain(`"name": "demo-${template}"`);

    const readme = readFileSync(join(targetDir, 'README.md'), 'utf8');
    expect(readme.startsWith(`# demo-${template}\n`)).toBe(true);
    expect(readme).not.toMatch(/\{\{\s*(projectName|lumibaseVersion)/);
    if (template === 'astro') {
      // GitHub Actions expressions survive Handlebars rendering intact.
      expect(readme).toContain('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    }
  });
});

describe('CI builds the starters and deploys only with secrets', () => {
  const ciPath = join(repoRoot, '.github/workflows/ci.yml');

  it.skipIf(!existsSync(ciPath))('guards the Pages deploy step on the Cloudflare secrets', () => {
    const ci = readFileSync(ciPath, 'utf8');
    const job = ci.slice(ci.indexOf('scaffold-smoke:'));
    expect(job).toMatch(/--workdir/);
    expect(job).toMatch(/wrangler pages deploy|npm run deploy/);
    expect(job).toMatch(/can_deploy == 'true'/);
    // Secrets are read through env and compared, never spliced into a script.
    expect(job).toMatch(/HAS_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN != '' \}\}/);
    expect(job).toMatch(/::notice::Skipping the Astro starter Pages deploy/);
  });
});
