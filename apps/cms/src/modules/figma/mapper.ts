/**
 * Figma frame → block template draft (#758). Pure: no I/O, so the preview
 * and the import show exactly the same result.
 *
 * Field mapping:
 * - If any layer in the frame is named `#field_name`, only those layers map
 *   (the designer chose the fields). Otherwise every visible text layer and
 *   every layer with an image fill maps.
 * - Text → `string` / `input` (single line, ≤ 80 characters) or `text` /
 *   `input-multiline`. The sample text becomes the field note.
 * - A text layer inside (or named) `button` / `cta` / `link` also gets a
 *   `<name>_url` field for the target.
 * - Image fill → `string` / `file`.
 * - Names become snake_case; reserved names get an `f_` prefix; duplicates
 *   get `_2`, `_3`…; at most {@link MAX_FIELDS} fields, the rest are listed in
 *   `warnings`.
 *
 * Tokens: solid colours (by use count), font families and sizes, corner
 * radii — the input of the theme mapping in `theme.ts`.
 */
import type { FigmaColor, FigmaNode, FigmaPaint } from './client';

export const MAX_FIELDS = 40;
const RESERVED = new Set(['id', 'status', 'sort', 'created_at', 'updated_at', 'created_by', 'updated_by', 'site_id', 'data', 'version']);
const LINK_LIKE = /\b(button|btn|cta|link)\b/i;

export interface DraftField {
  name: string;
  type: 'string' | 'text';
  interface: 'input' | 'input-multiline' | 'file';
  label: string;
  note: string | null;
  /** Figma layer the field came from. */
  source: { nodeId: string; layer: string };
}

export interface DesignTokens {
  colors: Array<{ hex: string; count: number; usage: Array<'fill' | 'text' | 'button' | 'frame'> }>;
  fonts: Array<{ family: string; sizes: number[] }>;
  radii: Array<{ value: number; count: number }>;
}

export interface BlockDraft {
  collection: string;
  label: string;
  fields: DraftField[];
  /** Mustache template for item labels in Studio (`{{field}}`). */
  displayTemplate: string | null;
  tokens: DesignTokens;
  warnings: string[];
}

export function snakeName(raw: string): string {
  const s = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  const named = s.length === 0 ? 'field' : /^[0-9]/.test(s) ? `f_${s}` : s;
  return RESERVED.has(named) ? `f_${named}` : named;
}

function humanLabel(name: string): string {
  const words = name.replace(/^f_/, '').split('_').filter(Boolean);
  return words.length ? words.map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ') : name;
}

const visible = (n: { visible?: boolean }) => n.visible !== false;
const solid = (p: FigmaPaint) => p.type === 'SOLID' && visible(p) && p.color;
const hasImageFill = (n: FigmaNode) => (n.fills ?? []).some((p) => p.type === 'IMAGE' && visible(p));

export function colorToHex(c: FigmaColor, opacity = 1): string {
  const ch = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const a = (c.a ?? 1) * opacity;
  return `#${ch(c.r)}${ch(c.g)}${ch(c.b)}${a < 0.999 ? ch(a) : ''}`;
}

interface Candidate {
  node: FigmaNode;
  kind: 'text' | 'image';
  explicit: string | null;
  linkLike: boolean;
}

function walk(node: FigmaNode, linkAncestor: boolean, out: Candidate[], tokens: Map<string, { count: number; usage: Set<string> }>, fonts: Map<string, Set<number>>, radii: Map<number, number>, isRoot: boolean) {
  if (!visible(node)) return;
  const explicit = node.name.trim().startsWith('#') ? node.name.trim().slice(1) : null;
  const linkLike = linkAncestor || LINK_LIKE.test(node.name);
  for (const p of node.fills ?? []) {
    if (!solid(p)) continue;
    const hex = colorToHex(p.color!, p.opacity ?? 1);
    const entry = tokens.get(hex) ?? { count: 0, usage: new Set<string>() };
    entry.count++;
    entry.usage.add(isRoot ? 'frame' : node.type === 'TEXT' ? 'text' : linkLike ? 'button' : 'fill');
    tokens.set(hex, entry);
  }
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) radii.set(node.cornerRadius, (radii.get(node.cornerRadius) ?? 0) + 1);
  if (node.type === 'TEXT') {
    const fam = node.style?.fontFamily;
    if (fam) {
      const sizes = fonts.get(fam) ?? new Set<number>();
      if (typeof node.style?.fontSize === 'number') sizes.add(node.style.fontSize);
      fonts.set(fam, sizes);
    }
    out.push({ node, kind: 'text', explicit, linkLike });
  } else if (!isRoot && hasImageFill(node)) {
    out.push({ node, kind: 'image', explicit, linkLike });
  } else if (!isRoot && explicit && !node.children?.length) {
    out.push({ node, kind: 'text', explicit, linkLike });
  }
  for (const child of node.children ?? []) walk(child, linkLike, out, tokens, fonts, radii, false);
}

export function mapFrame(frame: FigmaNode, opts: { collection?: string; label?: string } = {}): BlockDraft {
  const candidates: Candidate[] = [];
  const colors = new Map<string, { count: number; usage: Set<string> }>();
  const fonts = new Map<string, Set<number>>();
  const radii = new Map<number, number>();
  walk(frame, false, candidates, colors, fonts, radii, true);

  const anyExplicit = candidates.some((c) => c.explicit !== null);
  const chosen = anyExplicit ? candidates.filter((c) => c.explicit !== null) : candidates;
  const warnings: string[] = [];
  const used = new Set<string>();
  const unique = (base: string) => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base.slice(0, 56)}_${i}`;
    used.add(name);
    return name;
  };
  const fields: DraftField[] = [];
  for (const c of chosen) {
    if (fields.length >= MAX_FIELDS) {
      warnings.push(`Skipped layer "${c.node.name}": more than ${MAX_FIELDS} fields.`);
      continue;
    }
    const base = snakeName(c.explicit ?? c.node.name);
    const source = { nodeId: c.node.id, layer: c.node.name };
    if (c.kind === 'image') {
      const name = unique(base === 'field' ? 'image' : base);
      fields.push({ name, type: 'string', interface: 'file', label: humanLabel(name), note: 'Image from the Figma frame.', source });
      continue;
    }
    const sample = (c.node.characters ?? '').trim();
    const multiline = sample.length > 80 || sample.includes('\n');
    const name = unique(base);
    fields.push({
      name,
      type: multiline ? 'text' : 'string',
      interface: multiline ? 'input-multiline' : 'input',
      label: humanLabel(name),
      note: sample ? `Figma sample: ${sample.slice(0, 200)}` : null,
      source,
    });
    if (c.linkLike && fields.length < MAX_FIELDS) {
      const urlName = unique(`${name.slice(0, 56)}_url`);
      fields.push({ name: urlName, type: 'string', interface: 'input', label: `${humanLabel(name)} link`, note: 'Link target for the button.', source });
    }
  }
  if (fields.length === 0) warnings.push('No text or image layers found; the block has no fields.');

  const collection = opts.collection ?? `block_${snakeName(frame.name).replace(/^f_/, '')}`.slice(0, 63);
  const firstText = fields.find((f) => f.interface === 'input') ?? fields.find((f) => f.interface === 'input-multiline');
  return {
    collection,
    label: opts.label ?? frame.name.trim().slice(0, 120),
    fields,
    displayTemplate: firstText ? `{{${firstText.name}}}` : null,
    tokens: {
      colors: [...colors.entries()]
        .map(([hex, v]) => ({ hex, count: v.count, usage: [...v.usage].sort() as DesignTokens['colors'][number]['usage'] }))
        .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
        .slice(0, 24),
      fonts: [...fonts.entries()].map(([family, sizes]) => ({ family, sizes: [...sizes].sort((a, b) => a - b) })),
      radii: [...radii.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value - b.value),
    },
    warnings,
  };
}
