// Pure helpers for scripts/visual-snapshots.mjs, kept separate so the
// `guards` vitest project can test them without a browser.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const THEMES = /** @type {const} */ (['light', 'dark']);

/** Stories (not docs pages) from a built Storybook's index.json, sorted by id. */
export function storiesFromIndex(index) {
  return Object.values(index.entries ?? {})
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id)
    .sort();
}

/** One PNG file name per story × theme. */
export function snapshotName(storyId, theme) {
  return `${storyId}--${theme}.png`;
}

/** `iframe.html` URL rendering one story in one theme, without the manager UI. */
export function storyUrl(base, storyId, theme) {
  const url = new URL('iframe.html', base.endsWith('/') ? base : `${base}/`);
  url.searchParams.set('id', storyId);
  url.searchParams.set('viewMode', 'story');
  url.searchParams.set('globals', `theme:${theme}`);
  return url.toString();
}

/**
 * Compare two snapshot directories. A story counts as changed when more than
 * `maxDiffRatio` of its pixels differ (anti-aliasing noise is ignored by
 * pixelmatch's `threshold`). Diff images are written to `outDir`.
 *
 * @returns {{ changed: Array<{ name: string, ratio: number }>, added: string[], removed: string[], unchanged: number }}
 */
export function compareDirs(baseDir, headDir, outDir, { threshold = 0.1, maxDiffRatio = 0.001 } = {}) {
  const list = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : []);
  const base = new Set(list(baseDir));
  const head = list(headDir);
  const result = { changed: [], added: [], removed: [...base].filter((f) => !head.includes(f)), unchanged: 0 };
  mkdirSync(outDir, { recursive: true });
  for (const name of head) {
    if (!base.has(name)) {
      result.added.push(name);
      continue;
    }
    const a = PNG.sync.read(readFileSync(path.join(baseDir, name)));
    const b = PNG.sync.read(readFileSync(path.join(headDir, name)));
    if (a.width !== b.width || a.height !== b.height) {
      result.changed.push({ name, ratio: 1 });
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
    const ratio = pixels / (a.width * a.height);
    if (ratio > maxDiffRatio) {
      result.changed.push({ name, ratio });
      writeFileSync(path.join(outDir, name), PNG.sync.write(diff));
    } else {
      result.unchanged += 1;
    }
  }
  return result;
}

/** Markdown summary for $GITHUB_STEP_SUMMARY. */
export function summaryMarkdown(result) {
  const lines = ['## Storybook visual check', ''];
  lines.push(
    `Unchanged: ${result.unchanged} · Changed: ${result.changed.length} · Added: ${result.added.length} · Removed: ${result.removed.length}`,
  );
  if (result.changed.length > 0) {
    lines.push('', '| Snapshot | Pixels changed |', '| --- | --- |');
    for (const { name, ratio } of result.changed) lines.push(`| \`${name}\` | ${(ratio * 100).toFixed(2)}% |`);
    lines.push('', 'Diff images, plus the base and head screenshots, are in the `storybook-visual-diff` artifact.');
  }
  return `${lines.join('\n')}\n`;
}
