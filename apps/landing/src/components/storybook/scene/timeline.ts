/**
 * The story's choreography as plain numbers.
 *
 * Nothing here touches WebGL or the DOM, so the same functions drive the scene
 * and can be unit-tested. Everything is keyed by a *chapter coordinate* `c`:
 * `c === 2` means chapter 2 is centred in the viewport, `c === 2.5` means the
 * reader is halfway between chapters 2 and 3.
 */

export const CHAPTERS = [
  "prologue",
  "intent",
  "trust",
  "studio",
  "mcp",
  "provenance",
  "epilogue",
] as const;

export type ChapterName = (typeof CHAPTERS)[number];
export type Layout = "desktop" | "mobile";

export const LAST_CHAPTER = CHAPTERS.length - 1;
export const TRUST_CHAPTER = CHAPTERS.indexOf("trust");
export const TRUST_LEVELS = 5;

/**
 * A place on screen. `x`/`y` run -1..1 across the viewport (y up). `s` is a
 * radius as a fraction of half the viewport height, so sizes hold their
 * proportion to the page at any aspect ratio.
 */
export interface Anchor {
  x: number;
  y: number;
  s: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smoothstep = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * How far along the hand-off between two chapters we are, 0..1.
 *
 * The first and last `HOLD` of every gap are flat: while a chapter is roughly
 * centred nothing moves, so the copy can be read against a still scene, and
 * the travel happens in the stretch where no chapter is centred anyway.
 */
const HOLD = 0.22;
export function handoff(fraction: number): number {
  return smoothstep((fraction - HOLD) / (1 - 2 * HOLD));
}

/** Sample one value per chapter at chapter coordinate `c`. */
export function sampleTrack(keys: readonly number[], c: number): number {
  const last = keys.length - 1;
  if (last < 0) return 0;
  const clamped = Math.min(last, Math.max(0, c));
  const i = Math.min(last - 1, Math.floor(clamped));
  if (last === 0) return keys[0]!;
  return lerp(keys[i]!, keys[i + 1]!, handoff(clamped - i));
}

/**
 * 1 while chapter `index` is on stage, easing to 0 as its neighbours take over.
 * `reach` widens the plateau: at 0.5 a prop is fully present for the whole
 * time its chapter is the nearest one.
 */
export function presence(c: number, index: number, reach = 0.5): number {
  const distance = Math.abs(c - index);
  return 1 - smoothstep((distance - reach * 0.6) / (reach * 0.8));
}

/**
 * Progress *through* a chapter, 0 as it arrives and 1 as it leaves — for props
 * that play out while their chapter is on screen.
 */
export function within(c: number, index: number): number {
  return clamp01(c - index + 0.5);
}

/**
 * Chapter coordinate from where each chapter's centre sits on the page.
 * `centers` must be ascending document offsets; `viewportCenter` is the
 * document offset currently in the middle of the screen.
 */
export function chapterFromScroll(centers: readonly number[], viewportCenter: number): number {
  const last = centers.length - 1;
  if (last < 0) return 0;
  if (viewportCenter <= centers[0]!) return 0;
  if (viewportCenter >= centers[last]!) return last;
  for (let i = 0; i < last; i++) {
    const a = centers[i]!;
    const b = centers[i + 1]!;
    if (viewportCenter <= b) return b === a ? i : i + (viewportCenter - a) / (b - a);
  }
  return last;
}

// ── Staging ──────────────────────────────────────────────────────────────

const LUMI: Record<Layout, readonly Anchor[]> = {
  // Copy sits on the left on desktop, so Lumi keeps to the right until the
  // finale, where both share the centre line.
  desktop: [
    { x: 0.47, y: 0.16, s: 0.27 },
    { x: 0.52, y: 0.1, s: 0.21 },
    { x: 0.5, y: 0, s: 0.14 }, // overridden by the trust staircase
    { x: 0.8, y: 0.62, s: 0.115 },
    { x: 0.5, y: 0.02, s: 0.19 },
    { x: 0.74, y: 0.5, s: 0.15 },
    { x: 0, y: -0.24, s: 0.23 },
  ],
  // On a phone the scene takes the top of the screen and the copy the bottom —
  // except at ground level, where the lamp needs the hill and the copy goes up.
  mobile: [
    { x: 0, y: -0.36, s: 0.13 },
    { x: 0.16, y: 0.56, s: 0.115 },
    { x: 0, y: 0.6, s: 0.085 },
    { x: 0.5, y: 0.68, s: 0.085 },
    { x: 0, y: 0.56, s: 0.105 },
    { x: 0.42, y: 0.7, s: 0.085 },
    { x: 0, y: -0.36, s: 0.13 },
  ],
};

export function lumiAnchor(layout: Layout, c: number): Anchor {
  const keys = LUMI[layout];
  return {
    x: sampleTrack(keys.map((k) => k.x), c),
    y: sampleTrack(keys.map((k) => k.y), c),
    s: sampleTrack(keys.map((k) => k.s), c),
  };
}

/** Where step `level` (0..4) of the trust staircase stands. */
export function trustStep(layout: Layout, level: number): Anchor {
  return layout === "desktop"
    ? { x: 0.2 + 0.15 * level, y: -0.56 + 0.2 * level, s: 0.075 }
    : { x: -0.66 + 0.33 * level, y: 0.42 + 0.055 * level, s: 0.05 };
}

/** Lumi perched on a trust step: centred above it, clear of the star. */
export function lumiOnStep(layout: Layout, level: number): Anchor {
  const step = trustStep(layout, level);
  const s = LUMI[layout][TRUST_CHAPTER]!.s;
  return { x: step.x, y: step.y + step.s * 0.9 + s * 1.25, s };
}

/**
 * How far the camera has risen off the ground, 0 (standing on the hill) to 1
 * (up among the stars). The story leaves the ground after the prologue and
 * comes back down for the epilogue.
 */
export function altitude(c: number): number {
  const up = smoothstep((c - 0.22) / 0.7);
  const down = smoothstep((c - (LAST_CHAPTER - 0.92)) / 0.7);
  return up * (1 - down);
}
