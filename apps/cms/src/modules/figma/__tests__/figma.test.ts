/**
 * Figma import (#758): URL parsing, the REST client against fixture JSON,
 * frame → block mapping (heuristic and explicit `#field` naming), design
 * tokens, and the token → Studio theme mapping.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ThemeOverridesSchema } from '@lumibase/contracts/schemas';
import { FigmaClient, FigmaError, parseFigmaUrl } from '../client';
import { MAX_FIELDS, mapFrame, snakeName } from '../mapper';
import { hexToHslTriple, suggestTheme } from '../theme';
import { EXPLICIT_FRAME, HERO_FRAME, nodesResponse } from './fixtures';

describe('parseFigmaUrl', () => {
  it('accepts design / file / proto links and converts the node id', () => {
    expect(parseFigmaUrl('https://www.figma.com/design/AbCdEf123456/Landing?node-id=12-34&t=x')).toEqual({ fileKey: 'AbCdEf123456', nodeId: '12:34' });
    expect(parseFigmaUrl('https://figma.com/file/AbCdEf123456/x?node-id=1:2')).toEqual({ fileKey: 'AbCdEf123456', nodeId: '1:2' });
  });

  it('refuses other hosts, missing node ids and garbage', () => {
    for (const bad of ['https://evil.example/design/AbCdEf123456?node-id=1-2', 'https://www.figma.com/design/AbCdEf123456/x', 'not a url', 'https://www.figma.com/community/file/1']) {
      expect(() => parseFigmaUrl(bad)).toThrow(FigmaError);
    }
  });
});

describe('FigmaClient', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('reads one node with the X-Figma-Token header', async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const client = new FigmaClient({
      token: 'figd_secret_token',
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return ok(nodesResponse(HERO_FRAME));
      },
    });
    expect((await client.getNode('AbCdEf123456', '12:34')).name).toBe('Hero Card');
    expect(calls[0]!.url).toBe('https://api.figma.com/v1/files/AbCdEf123456/nodes?ids=12%3A34');
    expect(calls[0]!.headers.get('x-figma-token')).toBe('figd_secret_token');
  });

  it('maps Figma errors to stable codes', async () => {
    const withStatus = (status: number, body: unknown = {}) => new FigmaClient({ token: 't', fetch: async () => ok(body, status) });
    await expect(withStatus(403).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_TOKEN_REJECTED', status: 422 });
    await expect(withStatus(404).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_NOT_FOUND' });
    await expect(withStatus(429).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_RATE_LIMITED', status: 429 });
    await expect(withStatus(500).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_UNAVAILABLE', status: 502 });
    await expect(withStatus(200, { nodes: { '1:1': null } }).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_NOT_FOUND' });
    const text = { ...HERO_FRAME.children![1]!, id: '1:1' };
    await expect(withStatus(200, nodesResponse(text)).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_NOT_A_FRAME' });
    await expect(new FigmaClient({ token: 't', fetch: async () => { throw new Error('offline'); } }).getNode('k', '1:1')).rejects.toMatchObject({ code: 'FIGMA_UNAVAILABLE' });
  });
});

describe('mapFrame', () => {
  it('maps text and image layers into block fields with a display template', () => {
    const draft = mapFrame(HERO_FRAME);
    expect(draft.collection).toBe('block_hero_card');
    expect(draft.label).toBe('Hero Card');
    expect(draft.fields.map((f) => [f.name, f.type, f.interface])).toEqual([
      ['background', 'string', 'file'],
      ['title', 'string', 'input'],
      ['body_copy', 'text', 'input-multiline'],
      ['label', 'string', 'input'],
      ['label_url', 'string', 'input'],
    ]);
    expect(draft.fields.find((f) => f.name === 'title')).toMatchObject({ label: 'Title', note: 'Figma sample: Ship content faster', source: { nodeId: '12:36' } });
    expect(draft.displayTemplate).toBe('{{title}}');
    expect(draft.warnings).toEqual([]);
  });

  it('collects colours by use, fonts and radii', () => {
    const { tokens } = mapFrame(HERO_FRAME);
    expect(tokens.colors.find((c) => c.hex === '#4f46e5')).toMatchObject({ usage: ['button'] });
    expect(tokens.colors.find((c) => c.hex === '#0f172a')).toMatchObject({ count: 2, usage: ['text'] });
    expect(tokens.colors.find((c) => c.hex === '#ffffff')!.usage).toEqual(['frame', 'text']);
    expect(tokens.fonts).toEqual([{ family: 'Inter', sizes: [16, 40] }]);
    expect(tokens.radii).toEqual([{ value: 12, count: 2 }]);
  });

  it('maps only `#field` layers when the designer named any', () => {
    const draft = mapFrame(EXPLICIT_FRAME, { collection: 'quote_block', label: 'Quote' });
    expect(draft.collection).toBe('quote_block');
    expect(draft.fields.map((f) => [f.name, f.interface])).toEqual([
      ['quote', 'input'],
      ['author', 'input'],
      ['avatar', 'file'],
    ]);
  });

  it('dedupes, escapes reserved names and caps the field count', () => {
    const many = {
      id: '1:1',
      name: 'Grid',
      type: 'FRAME',
      children: Array.from({ length: MAX_FIELDS + 5 }, (_, i) => ({ id: `1:${i + 2}`, name: i === 0 ? 'id' : 'Item', type: 'TEXT', characters: 'x' })),
    };
    const draft = mapFrame(many);
    expect(draft.fields).toHaveLength(MAX_FIELDS);
    expect(draft.fields.slice(0, 3).map((f) => f.name)).toEqual(['f_id', 'item', 'item_2']);
    expect(draft.warnings).toHaveLength(5);
    expect(mapFrame({ id: '1:1', name: 'Empty', type: 'FRAME', children: [] }).warnings[0]).toMatch(/no fields/);
  });

  it('property: every generated field name is a valid, unique schema name', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 30 }), { minLength: 1, maxLength: 30 }), (names) => {
        const frame = { id: '1:1', name: 'F', type: 'FRAME', children: names.map((n, i) => ({ id: `2:${i}`, name: n, type: 'TEXT', characters: 'x' })) };
        const fields = mapFrame(frame).fields.map((f) => f.name);
        expect(new Set(fields).size).toBe(fields.length);
        for (const n of fields) expect(n).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      }),
    );
    expect(snakeName('Tiêu đề chính')).toBe('tieu_de_chinh');
    expect(snakeName('CTA Button')).toBe('cta_button');
  });
});

describe('suggestTheme', () => {
  it('maps button colour to --primary, frame fill to --background, text to --foreground, radius', () => {
    const theme = suggestTheme(mapFrame(HERO_FRAME).tokens);
    expect(theme.light).toEqual({
      '--primary': '243.4 75.4% 58.6%',
      '--ring': '243.4 75.4% 58.6%',
      '--primary-foreground': '0 0% 98%',
      '--background': '0 0% 100%',
      '--foreground': '222.2 47.4% 11.2%',
      '--radius': '12px',
    });
    expect(theme.rationale['--primary']).toMatch(/#4f46e5 \(button/);
    // The result is accepted as Studio theme overrides as-is.
    expect(ThemeOverridesSchema.safeParse({ light: theme.light }).success).toBe(true);
  });

  it('converts hex to HSL triples, and suggests nothing without tokens', () => {
    expect(hexToHslTriple('#000000')).toBe('0 0% 0%');
    expect(hexToHslTriple('#ff0000')).toBe('0 100% 50%');
    expect(hexToHslTriple('nope')).toBeNull();
    expect(suggestTheme({ colors: [], fonts: [], radii: [] }).light).toEqual({});
  });
});
