/**
 * Offline tripwire for template dependency drift.
 *
 * #450: the Cloudflare template declared `@cloudflare/workers-types@^4.0.0`
 * while the `wrangler@^4` next to it had moved its peer to `^5.<date>`. Every
 * `npm install` of a freshly scaffolded Cloudflare project died with ERESOLVE,
 * and no test in the repo could see it — the unit tests check argument parsing
 * and file emission, and a peer conflict only exists once something installs.
 *
 * `scripts/smoke-scaffold.mjs` is the check that actually installs, but it needs
 * the network and about a minute, so it cannot guard every commit. This test is
 * the cheap half: it pins the template's Workers Types major to the major the
 * repo's own Workers app uses. `apps/cms` is kept current by dependabot, so when
 * that moves to a new major this test fails and names the template that needs
 * bumping — instead of the failure surfacing months later in a stranger's
 * `npm install`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');

/**
 * Template manifests are Handlebars, but every placeholder sits inside a JSON
 * string (`"name": "{{projectName}}"`), so they parse as JSON as-is. If that
 * ever stops being true this throws, which is the correct outcome — a template
 * manifest that is not valid JSON cannot produce an installable project.
 */
function readTemplateManifest(template: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} {
  const path = join(pkgRoot, 'templates', template, 'package.json.hbs');
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof readTemplateManifest>;
}

/** Major version out of a caret/tilde/exact range. `^5.20260903.1` → 5. */
function majorOf(range: string): number {
  const match = /(\d+)\./.exec(range);
  if (!match) throw new Error(`cannot read a major version from range: ${range}`);
  return Number(match[1]);
}

describe('template manifests', () => {
  it.each(['default', 'cloudflare'])('%s parses as JSON and names the project', (template) => {
    const manifest = readTemplateManifest(template) as { name?: string };
    expect(manifest.name).toBe('{{projectName}}');
  });

  it('keeps the Cloudflare template on the same Workers Types major as apps/cms', () => {
    const template = readTemplateManifest('cloudflare');
    const templateRange = template.devDependencies?.['@cloudflare/workers-types'];
    expect(templateRange, 'cloudflare template must declare @cloudflare/workers-types').toBeTruthy();

    const cmsManifestPath = join(repoRoot, 'apps/cms/package.json');
    if (!existsSync(cmsManifestPath)) {
      // Published package: apps/cms is not shipped. Nothing to compare against,
      // and asserting a hardcoded major here would just rot.
      return;
    }
    const cms = JSON.parse(readFileSync(cmsManifestPath, 'utf8')) as {
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    const cmsRange =
      cms.devDependencies?.['@cloudflare/workers-types'] ??
      cms.dependencies?.['@cloudflare/workers-types'];
    expect(cmsRange, 'apps/cms must declare @cloudflare/workers-types').toBeTruthy();

    expect(
      majorOf(templateRange as string),
      `templates/cloudflare declares ${templateRange} but apps/cms is on ${cmsRange}. ` +
        'wrangler pins its Workers Types peer to a major; a template left behind fails ' +
        'npm install with ERESOLVE (#450). Bump the template.',
    ).toBe(majorOf(cmsRange as string));
  });

  it('declares wrangler for the Cloudflare template', () => {
    // The peer relationship that broke #450 only exists because wrangler is
    // here. If it ever leaves, the assertion above stops meaning anything.
    const template = readTemplateManifest('cloudflare');
    expect(template.devDependencies?.wrangler).toBeTruthy();
  });
});
