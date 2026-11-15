import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compareDirs, snapshotName, storiesFromIndex, storyUrl, summaryMarkdown } from '../scripts/visual-lib.mjs';

function png(dir: string, name: string, paint: (x: number, y: number) => [number, number, number]) {
  const image = new PNG({ width: 20, height: 20 });
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4;
      const [r, g, b] = paint(x, y);
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  writeFileSync(path.join(dir, name), PNG.sync.write(image));
}

const white = (): [number, number, number] => [255, 255, 255];

describe('visual regression helpers', () => {
  it('lists stories only (docs pages are not screenshotted), sorted', () => {
    const index = {
      entries: {
        'b--two': { id: 'b--two', type: 'story' },
        'a--docs': { id: 'a--docs', type: 'docs' },
        'a--one': { id: 'a--one', type: 'story' },
      },
    };
    expect(storiesFromIndex(index)).toEqual(['a--one', 'b--two']);
  });

  it('builds a story iframe URL pinned to a theme', () => {
    const url = new URL(storyUrl('http://127.0.0.1:9/', 'ui-cn--override-wins', 'dark'));
    expect(url.pathname).toBe('/iframe.html');
    expect(url.searchParams.get('id')).toBe('ui-cn--override-wins');
    expect(url.searchParams.get('globals')).toBe('theme:dark');
    expect(snapshotName('ui-cn--override-wins', 'dark')).toBe('ui-cn--override-wins--dark.png');
  });

  it('flags changed, added and removed snapshots and writes a diff image', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sb-visual-'));
    const base = path.join(root, 'base');
    const head = path.join(root, 'head');
    const out = path.join(root, 'out');
    for (const dir of [base, head]) mkdirSync(dir, { recursive: true });
    png(base, 'same.png', white);
    png(head, 'same.png', white);
    png(base, 'changed.png', white);
    png(head, 'changed.png', (x) => (x < 10 ? [0, 0, 0] : [255, 255, 255]));
    png(base, 'gone.png', white);
    png(head, 'new.png', white);

    const result = compareDirs(base, head, out);
    expect(result.unchanged).toBe(1);
    expect(result.changed.map((c) => c.name)).toEqual(['changed.png']);
    expect(result.changed[0]?.ratio).toBeCloseTo(0.5);
    expect(result.added).toEqual(['new.png']);
    expect(result.removed).toEqual(['gone.png']);
    expect(readdirSync(out)).toEqual(['changed.png']);
    expect(summaryMarkdown(result)).toContain('| `changed.png` | 50.00% |');
  });
});
