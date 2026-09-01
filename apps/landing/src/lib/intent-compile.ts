/**
 * intent-rule.v1 — a local, deterministic compiler + evaluator for the landing
 * page's intent composer.
 *
 * Why this exists at all, and why it is not an API call: the real compiler is
 * `POST /api/v1/agent/intents/compile` (LLM-backed, see
 * `apps/cms/src/services/intent-service.ts`), and `/api/v1/agent` is
 * control-plane, admin-only. A visitor on lumibase.dev has no route to it, and
 * the landing app is a static export with no server anyway. So the composer
 * compiles locally with a phrase matcher over the same six rule shapes, and
 * says so in the UI. The point is not to fake the API — it is to emit the
 * *actual* `intent-rule.v1` payload you would commit, and then show a
 * collection moving against it.
 *
 * Everything here mirrors the shipped semantics on purpose:
 *  - rule shapes: `ruleSchema` in `intent-service.ts`
 *  - default schedule `0 6 * * *`: `compile()` in `intent-service.ts`
 *  - evaluation: `evaluateItem()` in `drift-service.ts` — notably
 *    `field_constraint` measures **characters** (`value.length`), not words,
 *    which is why a "50–200 words" phrase compiles with a warning rather than
 *    silently pretending words are the unit.
 *  - fix attribution: `RULE_ROLE_ROUTING` in `reconciler-service.ts`
 */

// ---------------------------------------------------------------------------
// intent-rule.v1
// ---------------------------------------------------------------------------

export type IntentRule =
  | { type: "required_fields"; fields: string[] }
  | { type: "freshness"; maxAgeDays: number }
  | { type: "translations"; locales: string[]; fields?: string[] }
  | { type: "link_health"; fields?: string[] }
  | {
      type: "field_constraint";
      field: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    }
  | { type: "glossary_compliance"; glossary?: string; fields?: string[] };

export interface CompiledIntent {
  rules: IntentRule[];
  /** 5-field cron, same default as the service when timing is unstated. */
  schedule: string;
  /** Lossy conversions and misses, surfaced instead of swallowed. */
  warnings: string[];
}

/** The service default when a description says nothing about timing. */
export const DEFAULT_SCHEDULE = "0 6 * * *";

/**
 * Words are not a unit `field_constraint` has. Six characters per word is the
 * conversion the composer states out loud in a warning — a rough English/
 * Vietnamese average including the trailing space.
 */
export const CHARS_PER_WORD = 6;

// ---------------------------------------------------------------------------
// Compile: natural language → rules
// ---------------------------------------------------------------------------

const LOCALE_CODES = ["vi", "en", "ja", "ko", "fr", "de", "es", "zh", "th", "id"];

/** Locale pairs/lists: "vi+en", "vi + en", "en/vi", "vi, en", "en ↔ vi". */
function matchLocales(text: string): string[] {
  const found: string[] = [];
  // Only count a code when it is a standalone token, so "end" or "vieux"
  // cannot masquerade as a locale.
  const tokens = text.toLowerCase().split(/[^a-z]+/);
  for (const token of tokens) {
    if (LOCALE_CODES.includes(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

/**
 * Adds a rule, merging rather than dropping when one of the same kind is
 * already present.
 *
 * `required_fields` has to merge its `fields`: "≥1 image · alt text" is two
 * matches of the same rule type, and keying on type alone silently threw the
 * second away — the sentence asked for alt text and the payload never mentioned
 * it. `field_constraint` keys on the field, so constraints on different fields
 * coexist.
 */
function pushUnique(rules: IntentRule[], rule: IntentRule) {
  const key = (r: IntentRule) =>
    r.type === "field_constraint" ? `${r.type}:${r.field}` : r.type;
  const existing = rules.find((r) => key(r) === key(rule));
  if (!existing) {
    rules.push(rule);
    return;
  }
  if (existing.type === "required_fields" && rule.type === "required_fields") {
    for (const field of rule.fields) {
      if (!existing.fields.includes(field)) existing.fields.push(field);
    }
  }
}

/**
 * The collection a sentence is talking about, if it names one of the presets.
 *
 * Without this, typing "articles need alt text" while the `products` chip is
 * active compiles an intent against `products` — the payload contradicts the
 * sentence that produced it. Falls back to the active chip when the sentence
 * names nothing.
 */
export function collectionFromText(text: string, fallback: string): string {
  const lower = text.toLowerCase();
  for (const name of PRESET_COLLECTIONS) {
    // Singular too: the presets themselves say "Every product" / "Every doc".
    const stem = name.replace(/s$/, "");
    if (new RegExp(`\\b${stem}s?\\b`).test(lower)) return name;
  }
  if (/\bdocumentation\b/.test(lower)) return "docs";
  return fallback;
}

/**
 * Compiles a plain-language sentence into intent-rule.v1. Deterministic and
 * dependency-free: the same sentence always yields the same rules, which is
 * what makes it safe to run in a marketing page with no backend.
 */
export function compileIntent(description: string, collection: string): CompiledIntent {
  const text = description.trim();
  const lower = text.toLowerCase();
  const rules: IntentRule[] = [];
  const warnings: string[] = [];

  // ── required_fields ────────────────────────────────────────────────
  if (/\b(image|photo|picture|thumbnail|ảnh)\b/.test(lower)) {
    pushUnique(rules, { type: "required_fields", fields: ["image"] });
  }
  if (/\balt\s*text\b/.test(lower)) {
    pushUnique(rules, { type: "required_fields", fields: ["image_alt"] });
  }
  if (/\b(price|pricing)\b/.test(lower)) {
    pushUnique(rules, { type: "required_fields", fields: ["price"] });
  }

  // ── field_constraint: word ranges (lossy → warn) ───────────────────
  const words = lower.match(/(\d+)\s*[–—-]\s*(\d+)\s*words?/);
  if (words) {
    const minWords = Number(words[1]);
    const maxWords = Number(words[2]);
    const minLength = minWords * CHARS_PER_WORD;
    const maxLength = maxWords * CHARS_PER_WORD;
    pushUnique(rules, { type: "field_constraint", field: "description", minLength, maxLength });
    warnings.push(
      `field_constraint counts characters, not words — ${minWords}–${maxWords} words ⇒ ${minLength}–${maxLength} chars.`,
    );
  }

  // ── field_constraint: explicit character ceilings ──────────────────
  const chars = lower.match(/(?:≤|<=|under|max(?:imum)?(?:\s+of)?|at most)\s*(\d+)\s*(?:chars?|characters)/);
  if (chars) {
    const field = /\bseo\b/.test(lower) ? "seo_title" : "title";
    pushUnique(rules, { type: "field_constraint", field, maxLength: Number(chars[1]) });
  }

  // ── translations ───────────────────────────────────────────────────
  const locales = matchLocales(text);
  if (locales.length >= 2 || /\b(translat|localis|localiz|parity)/.test(lower)) {
    pushUnique(rules, {
      type: "translations",
      locales: locales.length >= 2 ? locales : ["vi", "en"],
    });
  }

  // ── freshness ──────────────────────────────────────────────────────
  const days = lower.match(/(\d+)\s*(?:d\b|days?)/);
  const hours = lower.match(/(\d+)\s*(?:h\b|hours?)/);
  if (days) {
    pushUnique(rules, { type: "freshness", maxAgeDays: Math.max(1, Number(days[1])) });
  } else if (hours) {
    const h = Number(hours[1]);
    pushUnique(rules, { type: "freshness", maxAgeDays: Math.max(1, Math.round(h / 24)) });
    if (h < 24) {
      warnings.push(`freshness is day-granular — ${h}h floors to maxAgeDays 1.`);
    }
  }

  // ── link_health ────────────────────────────────────────────────────
  if (/\b(no|zero)\s+(broken|dead)\s+links?\b/.test(lower) || /\blink\s*health\b/.test(lower)) {
    pushUnique(rules, { type: "link_health" });
  }

  // ── glossary_compliance ────────────────────────────────────────────
  if (/\b(glossary|terminology|brand\s+terms|banned\s+words)\b/.test(lower)) {
    pushUnique(rules, { type: "glossary_compliance" });
  }

  // ── schedule ───────────────────────────────────────────────────────
  let schedule = DEFAULT_SCHEDULE;
  if (/\bhourly\b|\bevery\s+hour\b/.test(lower)) schedule = "0 * * * *";
  else if (/\bweekly\b|\bevery\s+week\b/.test(lower)) schedule = "0 6 * * 1";
  else if (/\bnightly\b|\bdaily\b|\bevery\s+day\b/.test(lower)) schedule = DEFAULT_SCHEDULE;

  // The service refuses to persist a ruleless intent (COMPILE_EMPTY). Rather
  // than showing an error state in a hero card, fall back to the collection's
  // preset and say that is what happened.
  if (rules.length === 0) {
    warnings.push("Nothing in that sentence matched intent-rule.v1 — showing the preset instead.");
    return { rules: presetFor(collection).rules, schedule, warnings };
  }

  return { rules, schedule, warnings };
}

// ---------------------------------------------------------------------------
// The presets the composer offers
// ---------------------------------------------------------------------------

export interface Preset {
  collection: string;
  /** The sentence typed into the field — plain language, not JSON. */
  sentence: string;
  rules: IntentRule[];
}

const PRESET_SENTENCES: Record<string, string> = {
  products: "Every product: ≥1 image · 50–200 words · vi+en",
  articles: "Every article: hero image · SEO title ≤ 60 chars · updated within 30 days",
  docs: "Every doc: en/vi parity · no dead links · glossary terms",
};

export const PRESET_COLLECTIONS = ["products", "articles", "docs"] as const;

export function presetFor(collection: string): Preset {
  const name = collection in PRESET_SENTENCES ? collection : "products";
  const sentence = PRESET_SENTENCES[name]!;
  return { collection: name, sentence, rules: presetRules(name) };
}

/**
 * Preset rules, hand-written rather than compiled, so `compileIntent`'s
 * empty-match fallback cannot recurse into itself.
 *
 * These are asserted in `intent-compile.test.ts` to equal what the matcher
 * produces for the preset sentence — a regression in the matcher shows up as a
 * failing test rather than as a preset that quietly stops matching its label.
 */
function presetRules(collection: string): IntentRule[] {
  switch (collection) {
    case "articles":
      return [
        { type: "required_fields", fields: ["image"] },
        { type: "field_constraint", field: "seo_title", maxLength: 60 },
        { type: "freshness", maxAgeDays: 30 },
      ];
    case "docs":
      return [
        { type: "translations", locales: ["en", "vi"] },
        { type: "link_health" },
        { type: "glossary_compliance" },
      ];
    default:
      return [
        { type: "required_fields", fields: ["image"] },
        {
          type: "field_constraint",
          field: "description",
          minLength: 50 * CHARS_PER_WORD,
          maxLength: 200 * CHARS_PER_WORD,
        },
        { type: "translations", locales: ["vi", "en"] },
      ];
  }
}

export function sentenceFor(collection: string): string {
  return presetFor(collection).sentence;
}

// ---------------------------------------------------------------------------
// The sampled collection the rules are evaluated against
// ---------------------------------------------------------------------------

export interface DemoItem {
  slug: string;
  /** Days since last update — feeds the freshness rule. */
  ageDays: number;
  data: Record<string, unknown>;
}

/**
 * Eight items per collection, each shaped to fail at most one rule type, so a
 * visitor adding or removing a constraint sees the violation count move for a
 * reason they can point at.
 */
const SAMPLES: Record<string, DemoItem[]> = {
  products: [
    {
      slug: "products/ao-thun-basic-cotton",
      ageDays: 3,
      data: {
        image: "r2://products/ao-thun.webp",
        image_alt: "Áo thun cotton trắng trên nền xám",
        title: "Áo thun basic cotton",
        seo_title: "Áo thun basic cotton — chuẩn form, cotton 100%",
        price: 249000,
        description: "x".repeat(412),
        translations: { vi: "Áo thun basic", en: "Basic cotton tee" },
        body: "See https://lumibase.dev for the size chart.",
      },
    },
    {
      slug: "products/ban-phim-co-k3",
      ageDays: 5,
      data: {
        image: "r2://products/k3.webp",
        image_alt: "Bàn phím cơ K3 nhìn từ trên",
        title: "Bàn phím cơ K3",
        seo_title: "Bàn phím cơ K3 — switch brown, layout 75%",
        price: 1890000,
        description: "x".repeat(190),
        translations: { vi: "Bàn phím cơ K3", en: "K3 mechanical keyboard" },
        body: "Specs at https://lumibase.dev/docs.",
      },
    },
    {
      slug: "products/tai-nghe-air-2",
      ageDays: 8,
      data: {
        image: "",
        image_alt: "",
        title: "Tai nghe Air 2",
        seo_title: "Tai nghe Air 2 — ANC, pin 30h",
        price: 990000,
        description: "x".repeat(340),
        translations: { vi: "Tai nghe Air 2", en: "Air 2 earbuds" },
        body: "Compare at https://lumibase.dev/pricing.",
      },
    },
    {
      slug: "products/chuot-khong-day-m1",
      ageDays: 11,
      data: {
        image: "r2://products/m1.webp",
        image_alt: "Chuột không dây M1",
        title: "Chuột không dây M1",
        seo_title: "Chuột không dây M1 — 4000 DPI, im lặng",
        price: 450000,
        description: "x".repeat(505),
        translations: { vi: "Chuột không dây M1" },
        body: "Driver: https://lumibase.dev/downloads.",
      },
    },
    {
      slug: "products/balo-laptop-15",
      ageDays: 6,
      data: {
        image: "r2://products/balo.webp",
        image_alt: "Balo laptop 15 inch màu than",
        title: "Balo laptop 15\"",
        seo_title: "Balo laptop 15 inch chống nước, ngăn chống sốc, bảo hành 24 tháng",
        price: 690000,
        description: "x".repeat(388),
        translations: { vi: "Balo laptop 15\"", en: "15\" laptop backpack" },
        body: "Care guide: https://lumibase.dev/docs/care.",
      },
    },
    {
      slug: "products/den-ban-led-x",
      ageDays: 74,
      data: {
        image: "r2://products/den-x.webp",
        image_alt: "Đèn bàn LED X đang bật",
        title: "Đèn bàn LED X",
        seo_title: "Đèn bàn LED X — 3 nhiệt màu, cảm ứng",
        price: 320000,
        description: "x".repeat(430),
        translations: { vi: "Đèn bàn LED X", en: "LED desk lamp X" },
        body: "Manual: https://lumibase.dev/docs/lamp.",
      },
    },
    {
      slug: "products/sac-nhanh-65w",
      ageDays: 4,
      data: {
        image: "r2://products/sac-65w.webp",
        image_alt: "Củ sạc nhanh 65W",
        title: "Sạc nhanh 65W",
        seo_title: "Sạc nhanh 65W GaN — 3 cổng, PD 3.0",
        price: 549000,
        description: "x".repeat(366),
        translations: { vi: "Sạc nhanh 65W", en: "65W fast charger" },
        body: "Compatibility list at https:// — updating.",
      },
    },
    {
      slug: "products/loa-bluetooth-mini",
      ageDays: 9,
      data: {
        image: "r2://products/loa-mini.webp",
        image_alt: "Loa bluetooth mini cầm tay",
        title: "Loa bluetooth mini",
        seo_title: "Loa bluetooth mini — 12h pin, chống nước IPX7",
        price: 399000,
        description: `A cutting-edge speaker. ${"x".repeat(330)}`,
        translations: { vi: "Loa bluetooth mini", en: "Mini bluetooth speaker" },
        body: "Pairing steps: https://lumibase.dev/docs/pairing.",
      },
    },
  ],
  articles: [
    {
      slug: "articles/edge-caching-explained",
      ageDays: 4,
      data: {
        image: "r2://articles/edge-cache.webp",
        image_alt: "Diagram of a cache at the edge",
        title: "Edge caching explained",
        seo_title: "Edge caching explained: ETags, tags and purge",
        description: "x".repeat(820),
        translations: { en: "Edge caching explained", vi: "Giải thích edge caching" },
        body: "Benchmarks: https://lumibase.dev/docs/perf.",
      },
    },
    {
      slug: "articles/multi-tenant-rls-deep-dive",
      ageDays: 9,
      data: {
        image: "r2://articles/rls.webp",
        image_alt: "Row level security policy sketch",
        title: "Multi-tenant RLS deep dive",
        seo_title:
          "A multi-tenant row level security deep dive: site_id scoping, policies and the pitfalls we hit",
        description: "x".repeat(1180),
        translations: { en: "Multi-tenant RLS", vi: "RLS đa tenant" },
        body: "Schema: https://lumibase.dev/docs/data-model.",
      },
    },
    {
      slug: "articles/shipping-on-workers",
      ageDays: 52,
      data: {
        image: "r2://articles/workers.webp",
        image_alt: "Workers deployment map",
        title: "Shipping on Workers",
        seo_title: "Shipping on Cloudflare Workers",
        description: "x".repeat(640),
        translations: { en: "Shipping on Workers", vi: "Triển khai trên Workers" },
        body: "Guide: https://lumibase.dev/docs/deployment.",
      },
    },
    {
      slug: "articles/hitl-in-practice",
      ageDays: 12,
      data: {
        image: "",
        image_alt: "",
        title: "HITL in practice",
        seo_title: "Human-in-the-loop in practice",
        description: "x".repeat(700),
        translations: { en: "HITL in practice", vi: "HITL trong thực tế" },
        body: "Policy: https://lumibase.dev/docs/ai-skills.",
      },
    },
    {
      slug: "articles/nanoid-vs-uuid",
      ageDays: 6,
      data: {
        image: "r2://articles/ids.webp",
        image_alt: "Identifier comparison table",
        title: "NanoID vs UUID",
        seo_title: "NanoID vs UUID for edge-distributed writes",
        description: "x".repeat(560),
        translations: { en: "NanoID vs UUID" },
        body: "ADR: https://lumibase.dev/docs/adr-001.",
      },
    },
    {
      slug: "articles/agents-that-publish",
      ageDays: 2,
      data: {
        image: "r2://articles/agents.webp",
        image_alt: "Agent run timeline",
        title: "Agents that publish",
        seo_title: "Agents that publish, safely",
        description: `A revolutionary approach. ${"x".repeat(500)}`,
        translations: { en: "Agents that publish", vi: "Agent tự xuất bản" },
        body: "Ledger: https://lumibase.dev/docs/trust-ledger.",
      },
    },
    {
      slug: "articles/cdc-to-clickhouse",
      ageDays: 7,
      data: {
        image: "r2://articles/cdc.webp",
        image_alt: "Change feed to warehouse",
        title: "CDC to ClickHouse",
        seo_title: "Streaming change data capture into ClickHouse",
        description: "x".repeat(910),
        translations: { en: "CDC to ClickHouse", vi: "CDC sang ClickHouse" },
        body: "Setup: https:// — link pending.",
      },
    },
    {
      slug: "articles/policy-dsl-tour",
      ageDays: 5,
      data: {
        image: "r2://articles/policy.webp",
        image_alt: "JSON policy document",
        title: "A tour of the policy DSL",
        seo_title: "A tour of the JSON policy DSL",
        description: "x".repeat(770),
        translations: { en: "Policy DSL tour", vi: "Tham quan policy DSL" },
        body: "Reference: https://lumibase.dev/docs/permissions.",
      },
    },
  ],
  docs: [
    {
      slug: "docs/en/api/hono-api-spec",
      ageDays: 3,
      data: {
        image: "r2://docs/api.webp",
        image_alt: "API surface overview",
        title: "Hono API spec",
        seo_title: "REST API reference",
        description: "x".repeat(980),
        translations: { en: "Hono API spec", vi: "Đặc tả API Hono" },
        body: "Endpoints move sometimes: https:// and https://.",
      },
    },
    {
      slug: "docs/vi/operations/upgrades",
      ageDays: 8,
      data: {
        image: "r2://docs/upgrade.webp",
        image_alt: "Upgrade path diagram",
        title: "Nâng cấp",
        seo_title: "Hướng dẫn nâng cấp",
        description: "x".repeat(720),
        translations: { vi: "Nâng cấp" },
        body: "Runbook: https://lumibase.dev/docs/upgrades.",
      },
    },
    {
      slug: "docs/en/ai-skills",
      ageDays: 6,
      data: {
        image: "r2://docs/skills.webp",
        image_alt: "Skill catalogue",
        title: "AI skills",
        seo_title: "AI skill catalogue and HITL gates",
        description: `A synergy of skills. ${"x".repeat(600)}`,
        translations: { en: "AI skills", vi: "Kỹ năng AI" },
        body: "Harness: https://lumibase.dev/docs/harness.",
      },
    },
    {
      slug: "docs/en/data-model",
      ageDays: 4,
      data: {
        image: "r2://docs/model.webp",
        image_alt: "Entity relationship diagram",
        title: "Data model",
        seo_title: "Data model reference",
        description: "x".repeat(1040),
        translations: { en: "Data model", vi: "Mô hình dữ liệu" },
        body: "Migrations: https://lumibase.dev/docs/migrations.",
      },
    },
    {
      slug: "docs/en/deployment/cloudflare",
      ageDays: 41,
      data: {
        image: "r2://docs/cf.webp",
        image_alt: "Cloudflare bindings map",
        title: "Deploy to Cloudflare",
        seo_title: "Deploying to Cloudflare Workers",
        description: "x".repeat(860),
        translations: { en: "Deploy to Cloudflare", vi: "Triển khai Cloudflare" },
        body: "Bindings: https://lumibase.dev/docs/bindings.",
      },
    },
    {
      slug: "docs/en/security/route-guards",
      ageDays: 5,
      data: {
        image: "",
        image_alt: "",
        title: "Route guards",
        seo_title: "Route guard reference",
        description: "x".repeat(690),
        translations: { en: "Route guards", vi: "Route guard" },
        body: "Planes: https://lumibase.dev/docs/planes.",
      },
    },
    {
      slug: "docs/en/sdk/quickstart",
      ageDays: 2,
      data: {
        image: "r2://docs/sdk.webp",
        image_alt: "SDK snippet",
        title: "SDK quickstart",
        seo_title: "SDK quickstart",
        description: "x".repeat(410),
        translations: { en: "SDK quickstart", vi: "Bắt đầu với SDK" },
        body: "Types: https://lumibase.dev/docs/sdk.",
      },
    },
    {
      slug: "docs/vi/tutorials/nextjs-quickstart",
      ageDays: 7,
      data: {
        image: "r2://docs/next.webp",
        image_alt: "Next.js page tree",
        title: "Next.js quickstart",
        seo_title: "Bắt đầu với Next.js",
        description: "x".repeat(880),
        translations: { vi: "Bắt đầu với Next.js", en: "Next.js quickstart" },
        body: "Repo: https://github.com/khuepm/lumibase.",
      },
    },
  ],
};

export function sampleFor(collection: string): DemoItem[] {
  return SAMPLES[collection] ?? SAMPLES.products!;
}

/** Terms the demo glossary forbids — the CMS reads these from tenant config. */
const FORBIDDEN_TERMS = ["cutting-edge", "synergy", "revolutionary"];

// ---------------------------------------------------------------------------
// Evaluate: rules × sampled items → violations
// ---------------------------------------------------------------------------

export interface Violation {
  slug: string;
  ruleType: IntentRule["type"];
  /** Why it fails, in the words the drift row would carry. */
  reason: string;
  /** What the reconciler would do, attributed to the routed agent role. */
  fix: string;
}

/** `RULE_ROLE_ROUTING` from `reconciler-service.ts`. */
const ROLE: Record<IntentRule["type"], string> = {
  required_fields: "writer",
  freshness: "writer",
  translations: "translator",
  link_health: "librarian",
  field_constraint: "writer",
  glossary_compliance: "taxonomist",
};

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Scheme-prefixed tokens, then `new URL()` — same cheap check as drift v1. */
function brokenLinks(value: string): number {
  const tokens = value.match(/[a-z][a-z0-9+.-]*:\/\/\S*/gi) ?? [];
  return tokens.filter((token) => {
    const trimmed = token.replace(/[.,;)]+$/, "");
    try {
      const url = new URL(trimmed);
      return url.hostname === "";
    } catch {
      return true;
    }
  }).length;
}

/**
 * One pass over the sample, first violation per (item, rule) only — the card
 * shows a list, not a report, and a single item spraying six lines would bury
 * the signal.
 */
export function evaluateIntent(rules: IntentRule[], items: DemoItem[]): Violation[] {
  const violations: Violation[] = [];

  for (const item of items) {
    for (const rule of rules) {
      const before = violations.length;

      switch (rule.type) {
        case "required_fields": {
          for (const field of rule.fields) {
            if (isEmpty(item.data[field])) {
              violations.push({
                slug: item.slug,
                ruleType: rule.type,
                reason: `${field} missing or empty`,
                fix: `${ROLE[rule.type]} filled ${field}`,
              });
              break;
            }
          }
          break;
        }
        case "freshness": {
          if (item.ageDays > rule.maxAgeDays) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `${item.ageDays}d stale, budget is ${rule.maxAgeDays}d`,
              fix: `${ROLE[rule.type]} refreshed and re-published`,
            });
          }
          break;
        }
        case "translations": {
          const field = rule.fields?.[0] ?? "translations";
          const value = item.data[field];
          const record =
            value && typeof value === "object" && !Array.isArray(value)
              ? (value as Record<string, unknown>)
              : {};
          const missing = rule.locales.filter((locale) => isEmpty(record[locale]));
          if (missing.length > 0) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `${missing.join(", ")} translation missing`,
              fix: `${ROLE[rule.type]} drafted ${missing.join(", ")}`,
            });
          }
          break;
        }
        case "link_health": {
          const fields = rule.fields ?? Object.keys(item.data);
          let broken = 0;
          for (const field of fields) {
            const value = item.data[field];
            if (typeof value === "string") broken += brokenLinks(value);
          }
          if (broken > 0) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `${broken} link${broken > 1 ? "s" : ""} not well-formed`,
              fix: `${ROLE[rule.type]} repointed ${broken} link${broken > 1 ? "s" : ""}`,
            });
          }
          break;
        }
        case "field_constraint": {
          const value = item.data[rule.field];
          if (typeof value !== "string") break;
          if (rule.minLength !== undefined && value.length < rule.minLength) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `${rule.field} ${value.length} chars, floor is ${rule.minLength}`,
              fix: `${ROLE[rule.type]} expanded ${rule.field}`,
            });
          } else if (rule.maxLength !== undefined && value.length > rule.maxLength) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `${rule.field} ${value.length} chars, ceiling is ${rule.maxLength}`,
              fix: `${ROLE[rule.type]} trimmed ${rule.field}`,
            });
          }
          break;
        }
        case "glossary_compliance": {
          const fields = rule.fields ?? Object.keys(item.data);
          let hit: string | undefined;
          for (const field of fields) {
            const value = item.data[field];
            if (typeof value !== "string") continue;
            hit = FORBIDDEN_TERMS.find((term) => value.toLowerCase().includes(term));
            if (hit) break;
          }
          if (hit) {
            violations.push({
              slug: item.slug,
              ruleType: rule.type,
              reason: `forbidden term "${hit}"`,
              fix: `${ROLE[rule.type]} replaced "${hit}"`,
            });
          }
          break;
        }
      }

      // One violation per item keeps the list readable; the count still moves
      // when rules are added because a different item starts failing.
      if (violations.length > before) break;
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The reconciliation beats, and what each one says
// ---------------------------------------------------------------------------

/**
 * The loop, in beats — `compiling` stands for the compile step the real API
 * does, the rest mirror the drift → goal → resolve lifecycle. Held here rather
 * than in the component so the copy and the arithmetic can be asserted without
 * a DOM.
 */
export const RUN_BEATS = [
  { phase: "compiling", ms: 420 },
  { phase: "evaluate", ms: 820 },
  { phase: "incident", ms: 2000 },
  { phase: "reconcile", ms: 1800 },
  { phase: "converged", ms: 0 },
] as const;

export type RunPhase = (typeof RUN_BEATS)[number]["phase"] | "idle";

export interface RunState {
  /** Uppercase status line. */
  status: string;
  /** Items in the sample that satisfy every rule at this beat. */
  converged: number;
  /** Amber: the SLO is currently violated. */
  alarm: boolean;
  /** Violations are being shown as fixes rather than as reasons. */
  fixed: boolean;
}

/**
 * Derives everything the card shows from the beat plus the evaluation result.
 * `evaluate`/`incident` report the pre-fix count — the same rule IntentStage
 * uses — so the bar visibly drops before it climbs back.
 */
export function describeRun(
  phase: RunPhase,
  run: { total: number; failing: number } | null,
): RunState {
  if (!run || phase === "idle") {
    return { status: "awaiting intent", converged: 0, alarm: false, fixed: false };
  }
  const { total, failing } = run;
  const fixed = phase === "reconcile" || phase === "converged";
  const converged = fixed ? total : total - failing;

  switch (phase) {
    case "compiling":
      // Nothing has been evaluated yet at this beat, so the bar must not
      // already report the drift the evaluator is about to find. It sits full
      // and drops on `evaluate` — the order the real loop runs in.
      return { status: "compiling → intent-rule.v1", converged: total, alarm: false, fixed };
    case "evaluate":
      return { status: `evaluating ${total} sampled items`, converged, alarm: false, fixed };
    case "incident":
      return {
        status: `slo violated · ${failing} of ${total}`,
        converged,
        alarm: failing > 0,
        fixed,
      };
    case "reconcile":
      return {
        status: `reconciling · ${failing} goal${failing === 1 ? "" : "s"}`,
        converged,
        alarm: false,
        fixed,
      };
    default:
      return { status: `converged · ${total} of ${total}`, converged, alarm: false, fixed };
  }
}

// ---------------------------------------------------------------------------
// Syntax tokens, for rendering the payload as something worth looking at
// ---------------------------------------------------------------------------

export type JsonTokenKind = "key" | "string" | "number" | "keyword" | "punct" | "plain";

export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

/**
 * Splits one line of JSON into coloured tokens.
 *
 * Small and local by design: the payload is generated by
 * `formatIntentPayload`, so the grammar it has to survive is exactly the
 * grammar we emit — no comments, no exotic escapes. A key is a string followed
 * by a colon, which is all the context a single line needs.
 */
export function tokenizeJsonLine(line: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let i = 0;

  const push = (text: string, kind: JsonTokenKind) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    // Merge runs of the same kind so the DOM stays small.
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };

  while (i < line.length) {
    const ch = line[i]!;

    if (ch === '"') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === '"') break;
        else j += 1;
      }
      const text = line.slice(i, Math.min(j + 1, line.length));
      const after = line.slice(j + 1);
      push(text, /^\s*:/.test(after) ? "key" : "string");
      i = j + 1;
      continue;
    }

    if (/[-\d]/.test(ch) && /^-?\d/.test(line.slice(i))) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(i))!;
      push(m[0], "number");
      i += m[0].length;
      continue;
    }

    const word = /^(?:true|false|null)\b/.exec(line.slice(i));
    if (word) {
      push(word[0], "keyword");
      i += word[0].length;
      continue;
    }

    push(ch, /[{}[\],:]/.test(ch) ? "punct" : "plain");
    i += 1;
  }

  return tokens;
}

/** The payload, line by line, ready to render. */
export function tokenizePayload(payload: string): JsonToken[][] {
  return payload.split("\n").map(tokenizeJsonLine);
}

// ---------------------------------------------------------------------------
// Render: the payload you would actually commit
// ---------------------------------------------------------------------------

/**
 * The `POST /api/v1/agent/intents` body, printed with one rule per line so it
 * stays readable in a card-sized code block.
 *
 * `rules` is printed before `schedule`/`autonomyCap` because the block only
 * shows a few lines before it scrolls, and the rules are the part the visitor
 * just authored. `budget` is omitted on purpose — the server prefaults it
 * (10 goals/cycle, 60 writes/min, $1).
 */
export function formatIntentPayload(collection: string, compiled: CompiledIntent): string {
  const rules = compiled.rules.map(
    (rule, i) => `    ${JSON.stringify(rule)}${i < compiled.rules.length - 1 ? "," : ""}`,
  );
  return [
    "{",
    `  "name": ${JSON.stringify(`${collection} slo`)},`,
    `  "collection": ${JSON.stringify(collection)},`,
    '  "rules": [',
    ...rules,
    "  ],",
    `  "schedule": ${JSON.stringify(compiled.schedule)},`,
    '  "autonomyCap": 2',
    "}",
  ].join("\n");
}
