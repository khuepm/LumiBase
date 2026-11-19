/**
 * Design tokens → Studio theme overrides (#758). Studio's theme tokens are
 * HSL triples (`--primary: 240 5.9% 10%`) and a CSS length for `--radius`;
 * the result is valid input for `PATCH /api/v1/site` `themeOverrides` and for
 * the `applyThemeOverrides` agent skill.
 *
 * Heuristics, in order:
 * - `--primary`: the most used colour on a button / CTA / link layer, else the
 *   most used saturated colour; `--primary-foreground` is white or near-black,
 *   whichever contrasts more; `--ring` follows `--primary`.
 * - `--background`: the frame's own fill.
 * - `--foreground`: the most used text colour.
 * - `--radius`: the most used corner radius, in px.
 */
import type { DesignTokens } from './mapper';

export interface ThemeSuggestion {
  light: Record<string, string>;
  /** Which token each value came from, for the reviewer. */
  rationale: Record<string, string>;
}

export function hexToHslTriple(hex: string): string | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return `${r1(h)} ${r1(s * 100)}% ${r1(l * 100)}%`;
}

function saturation(triple: string): number {
  return Number(triple.split(/\s+/)[1]!.replace('%', ''));
}

function lightness(triple: string): number {
  return Number(triple.split(/\s+/)[2]!.replace('%', ''));
}

export function suggestTheme(tokens: DesignTokens): ThemeSuggestion {
  const light: Record<string, string> = {};
  const rationale: Record<string, string> = {};
  const opaque = tokens.colors.filter((c) => c.hex.length === 7);
  const triple = (hex: string) => hexToHslTriple(hex);

  const button = opaque.find((c) => c.usage.includes('button'));
  const saturated = opaque.find((c) => {
    const t = triple(c.hex);
    return t !== null && saturation(t) >= 20 && lightness(t) > 10 && lightness(t) < 90;
  });
  const primary = button ?? saturated;
  if (primary) {
    const t = triple(primary.hex)!;
    light['--primary'] = t;
    light['--ring'] = t;
    light['--primary-foreground'] = lightness(t) > 60 ? '240 5.9% 10%' : '0 0% 98%';
    rationale['--primary'] = `${primary.hex} (${button ? 'button / CTA layer' : 'most used saturated colour'})`;
  }
  const frame = opaque.find((c) => c.usage.includes('frame'));
  if (frame) {
    light['--background'] = triple(frame.hex)!;
    rationale['--background'] = `${frame.hex} (frame fill)`;
  }
  const text = opaque.find((c) => c.usage.includes('text'));
  if (text) {
    light['--foreground'] = triple(text.hex)!;
    rationale['--foreground'] = `${text.hex} (most used text colour)`;
  }
  const radius = tokens.radii[0];
  if (radius) {
    const px = Math.round(radius.value);
    if (px <= 999) {
      light['--radius'] = `${px}px`;
      rationale['--radius'] = `${radius.value}px corner radius (used ${radius.count}×)`;
    }
  }
  return { light, rationale };
}
