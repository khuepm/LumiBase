import { z } from 'zod';

/**
 * Page layout v1 — the composer's output format (epic #667, V06 #684).
 *
 * It is still plain `lumibase_pages.layoutConfig` JSON, read unchanged by
 * `GET /api/v1/deliver/page/:site_id/:slug`: delivery only looks at
 * `sections[].{id, component, styleConfig, data, source}`. Everything the
 * composer adds lives inside those keys, so delivery needs no change:
 *
 *   - `component`              a registered page block (a collection with
 *                              `meta.pageBlock: true`); `data` holds that
 *                              block's field values and is validated against
 *                              its fields, including nested `blocks` fields;
 *   - `styleConfig.region`     the region (slot) the section renders in;
 *   - `styleConfig.locales`    if set, the section is visible only in these
 *                              locales (the frontend filters, see
 *                              {@link selectPageSections});
 *   - `source`                 optional data binding, published items only.
 *
 * `version: 1` marks a layout written by the composer; only those are
 * validated strictly on write. Older free-form layouts keep working as-is.
 */

export const PAGE_LAYOUT_VERSION = 1;
export const PAGE_LAYOUT_MAX_SECTIONS = 200;
export const PAGE_LAYOUT_MAX_REGIONS = 12;
export const PAGE_LAYOUT_DEFAULT_REGION = 'main';
/** Max items a section source may request (delivery clamps to 50 as well). */
export const PAGE_SOURCE_MAX_LIMIT = 50;

const ident = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'Must be a lowercase identifier.');
const regionKey = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Region keys are lowercase, ≤ 32 characters.');
const localeTag = z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/, 'Invalid locale tag.');

export const PageRegionSchema = z
  .object({
    key: regionKey,
    label: z.string().min(1).max(80).optional(),
  })
  .strict();
export type PageRegion = z.infer<typeof PageRegionSchema>;

export const PageSectionSourceSchema = z
  .object({
    collection: ident,
    limit: z.number().int().min(1).max(PAGE_SOURCE_MAX_LIMIT).optional(),
    /** `field` or `-field` (descending). */
    orderBy: z
      .string()
      .regex(/^-?[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'orderBy is a field name, optionally prefixed with "-".')
      .optional(),
    /**
     * Composer layouts read published items only. Delivery is public: a
     * `draft` source would publish drafts to anyone who knows the slug.
     */
    status: z.literal('published').optional(),
    seo: z.union([z.boolean(), z.object({ jsonLdType: z.string().min(1).max(64) }).strict()]).optional(),
  })
  .strict();
export type PageSectionSource = z.infer<typeof PageSectionSourceSchema>;

export const PageSectionStyleSchema = z
  .looseObject({
    region: regionKey.optional(),
    locales: z.array(localeTag).min(1).max(50).optional(),
  });

export const PageSectionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Section ids are 1–64 characters of A–Z a–z 0–9 _ -.'),
    component: ident,
    data: z.record(z.string(), z.unknown()).default({}),
    styleConfig: PageSectionStyleSchema.default({}),
    source: PageSectionSourceSchema.optional(),
  })
  .strict();
export type PageSection = z.infer<typeof PageSectionSchema>;

export const PageLayoutSchema = z
  .object({
    version: z.literal(PAGE_LAYOUT_VERSION),
    regions: z.array(PageRegionSchema).min(1).max(PAGE_LAYOUT_MAX_REGIONS).optional(),
    sections: z.array(PageSectionSchema).max(PAGE_LAYOUT_MAX_SECTIONS),
  })
  .strict()
  .superRefine((layout, ctx) => {
    const regions = new Set((layout.regions ?? [{ key: PAGE_LAYOUT_DEFAULT_REGION }]).map((r) => r.key));
    if (layout.regions && regions.size !== layout.regions.length) {
      ctx.addIssue({ code: 'custom', path: ['regions'], message: 'Region keys must be unique.' });
    }
    const ids = new Set<string>();
    layout.sections.forEach((section, index) => {
      if (ids.has(section.id)) {
        ctx.addIssue({ code: 'custom', path: ['sections', index, 'id'], message: `Duplicate section id "${section.id}".` });
      }
      ids.add(section.id);
      const region = section.styleConfig.region ?? PAGE_LAYOUT_DEFAULT_REGION;
      if (!regions.has(region)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', index, 'styleConfig', 'region'],
          message: `Unknown region "${region}".`,
        });
      }
    });
  });
export type PageLayout = z.infer<typeof PageLayoutSchema>;

/** True when a stored `layoutConfig` was written by the composer (v1). */
export function isComposerLayout(layoutConfig: unknown): boolean {
  return (
    typeof layoutConfig === 'object' &&
    layoutConfig !== null &&
    (layoutConfig as { version?: unknown }).version === PAGE_LAYOUT_VERSION
  );
}

/** The minimal section shape delivery returns (`sections[]` of the page payload). */
export interface DeliveredSection {
  id: string;
  component: string;
  styleConfig?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/**
 * Frontend helper: the sections of one region visible in one locale, in
 * order. Works on the delivery payload (`GET /deliver/page/...` → `sections`)
 * as well as on a stored layout. A section without `styleConfig.region` is in
 * `main`; one without `styleConfig.locales` is visible in every locale.
 */
export function selectPageSections<T extends DeliveredSection>(
  sections: readonly T[],
  opts: { region?: string; locale?: string | null } = {},
): T[] {
  const region = opts.region ?? PAGE_LAYOUT_DEFAULT_REGION;
  return sections.filter((section) => {
    const style = section.styleConfig ?? {};
    const sectionRegion = typeof style.region === 'string' ? style.region : PAGE_LAYOUT_DEFAULT_REGION;
    if (sectionRegion !== region) return false;
    const locales = Array.isArray(style.locales) ? style.locales.filter((l): l is string => typeof l === 'string') : null;
    if (!locales || locales.length === 0 || !opts.locale) return true;
    return locales.includes(opts.locale);
  });
}
