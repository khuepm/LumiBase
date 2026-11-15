import { previewTemplateOrigin } from '@lumibase/contracts';

/**
 * Pure helpers behind the live preview pane (epic #667, V02 #680). Kept free
 * of React so the origin rules and the split/keyboard maths are unit-tested
 * directly.
 */

/** Device-width presets for the preview frame. `null` = fill the pane. */
export const DEVICE_PRESETS = [
  { id: 'desktop', label: 'Desktop', width: null },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'mobile', label: 'Mobile', width: 390 },
] as const;
export type DevicePresetId = (typeof DEVICE_PRESETS)[number]['id'];

/** Editor share of the split, in percent. */
export const SPLIT_MIN = 25;
export const SPLIT_MAX = 75;
export const SPLIT_DEFAULT = 50;
export const SPLIT_STEP = 5;

/** Debounce for streaming field changes to the frame (AC: render < 1 s). */
export const PATCH_DEBOUNCE_MS = 150;
/** Debounce for the post-save reload. */
export const RELOAD_DEBOUNCE_MS = 300;
/** Re-mint this long before the token expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)));
}

/**
 * Keyboard handling for the `role="separator"` divider (WAI-ARIA window
 * splitter): arrows move by a step, Home/End jump to the bounds, Enter resets.
 * Returns the new value, or `null` when the key is not ours.
 */
export function splitFromKey(key: string, value: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampSplit(value - SPLIT_STEP);
    case 'ArrowRight':
    case 'ArrowUp':
      return clampSplit(value + SPLIT_STEP);
    case 'Home':
      return SPLIT_MIN;
    case 'End':
      return SPLIT_MAX;
    case 'Enter':
      return SPLIT_DEFAULT;
    default:
      return null;
  }
}

/** Split percentage for a pointer at `clientX` over a container. */
export function splitFromPointer(clientX: number, left: number, width: number): number {
  if (width <= 0) return SPLIT_DEFAULT;
  return clampSplit(((clientX - left) / width) * 100);
}

export type FrameDecision =
  | { readonly ok: true; readonly origin: string; readonly allowedOrigins: string[] }
  | { readonly ok: false; readonly reason: 'invalid_url' | 'not_allowed' | 'same_origin' };

/**
 * May the Studio frame `url`? The frame origin must be the collection
 * template's own origin or one of the site's `preview.allowedOrigins`, and it
 * must NOT be the Studio's origin: a same-origin frame with `allow-scripts
 * allow-same-origin` could remove its own sandbox (ADR-014).
 */
export function decideFrame(input: {
  url: string;
  template: string;
  allowedOrigins: readonly string[];
  studioOrigin: string;
}): FrameDecision {
  let origin: string;
  try {
    const parsed = new URL(input.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'invalid_url' };
    origin = parsed.origin;
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  const allowed = new Set(input.allowedOrigins.filter((o) => o && o !== '*'));
  const templateOrigin = previewTemplateOrigin(input.template);
  if (templateOrigin) allowed.add(templateOrigin);
  if (origin === input.studioOrigin) return { ok: false, reason: 'same_origin' };
  if (!allowed.has(origin)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, origin, allowedOrigins: [...allowed] };
}

/** Field names whose value changed between two drafts (top-level, JSON compare). */
export function changedFields(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (!prev || JSON.stringify(prev[key]) !== JSON.stringify(value)) out[key] = value;
  }
  return out;
}

/** The form field a frame `focus` targets: the top-level name of a field path. */
export function topLevelField(path: string): string {
  return path.split('.')[0] ?? path;
}
