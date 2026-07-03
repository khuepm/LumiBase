// ─── Cosmic design helpers — category accents, planet icons, trust levels ────

export type Accent = "violet" | "blue" | "green" | "neutral";

interface AccentColors {
  /** Main accent color (planet mid-tone, badge dot). */
  accent: string;
  /** Deep planet edge color. */
  deep: string;
  /** Glow box-shadow for planet icons. */
  glow: string;
}

export const ACCENT_COLORS: Record<Accent, AccentColors> = {
  violet: {
    accent: "#7B61FF",
    deep: "#26204a",
    glow: "rgba(123,97,255,0.45)",
  },
  blue: {
    accent: "#18A0FB",
    deep: "#123a52",
    glow: "rgba(24,160,251,0.42)",
  },
  green: {
    accent: "#2EC47C",
    deep: "#12402c",
    glow: "rgba(46,196,124,0.4)",
  },
  neutral: {
    accent: "#8a8a92",
    deep: "#26262b",
    glow: "rgba(255,255,255,0.16)",
  },
};

/** Deterministic category → accent mapping. */
const CATEGORY_ACCENT: Record<string, Accent> = {
  automation: "violet",
  developer: "violet",
  forms: "violet",
  seo: "violet",
  ai: "blue",
  analytics: "blue",
  media: "blue",
  content: "green",
  localization: "green",
  integrations: "neutral",
  "e-commerce": "neutral",
};

const ACCENT_ORDER: Accent[] = ["violet", "blue", "green", "neutral"];

export function categoryAccent(category: string): Accent {
  const key = category.toLowerCase();
  const mapped = CATEGORY_ACCENT[key];
  if (mapped) return mapped;
  // Deterministic fallback: hash the category name onto the accent wheel.
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return ACCENT_ORDER[Math.abs(hash) % ACCENT_ORDER.length];
}

/** Radial planet gradient for extension icons. */
export function planetGradient(accent: Accent): string {
  const c = ACCENT_COLORS[accent];
  return `radial-gradient(circle at 32% 28%, #fff 0%, ${c.accent} 60%, ${c.deep} 100%)`;
}

/** Human label for a category slug. */
export function categoryLabel(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ")
    .replace("E Commerce", "E-Commerce");
}

/** Trust level required to run an extension, derived from its category. */
export function trustLevel(category: string): { level: string; note: string } {
  switch (category.toLowerCase()) {
    case "analytics":
      return { level: "L1 · Propose", note: "reads runs, writes nothing" };
    case "e-commerce":
      return { level: "L3 · Veto-window", note: "syncs after a veto window" };
    default:
      return { level: "L2 · Assisted", note: "installs skills, never publishes" };
  }
}

export function formatInstalls(n?: number): string {
  if (!n) return "New";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k installs`;
  return `${n} installs`;
}
