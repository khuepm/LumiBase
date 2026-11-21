import {
  PAGE_LAYOUT_DEFAULT_REGION,
  PAGE_LAYOUT_MAX_REGIONS,
  PAGE_LAYOUT_VERSION,
  type PageLayout,
  type PageRegion,
  type PageSection,
} from '@lumibase/contracts';
import { newBlockId } from '@/modules/content/interfaces/blocks';

/**
 * Pure state helpers for the page composer (epic #667, V06 #684). The
 * composer edits a v1 layout (see `@lumibase/contracts` `PageLayoutSchema`);
 * everything here is a plain function of the layout so it is unit-tested
 * directly and the component stays thin.
 */

export type ComposerLayout = PageLayout;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function regionOf(section: PageSection): string {
  const region = section.styleConfig?.region;
  return typeof region === 'string' ? region : PAGE_LAYOUT_DEFAULT_REGION;
}

/** Keys a v1 layout and a v1 section may carry (`PageLayoutSchema` is strict). */
const LAYOUT_KEYS = new Set(['version', 'regions', 'sections']);
const SECTION_KEYS = new Set(['id', 'component', 'data', 'styleConfig', 'source']);

/**
 * Turn whatever is stored in `layoutConfig` into an editable v1 layout.
 *
 * A v1 layout is taken as-is. An older free-form layout keeps each section's
 * `id`, `component`, `data`, `styleConfig` and `source`, but the v1 schema is
 * strict, so any other top-level key (`theme`, `seo`, …) or section key cannot
 * be saved. Those are listed in `dropped` (as `theme`, `sections.2.analyticsKey`)
 * so the UI can say what the first save removes. `converted` tells the UI.
 */
export function toComposerLayout(stored: unknown): {
  layout: ComposerLayout;
  converted: boolean;
  dropped: string[];
} {
  const raw = isRecord(stored) ? stored : {};
  const dropped: string[] = Object.keys(raw).filter((key) => !LAYOUT_KEYS.has(key));
  if (Array.isArray(raw.sections)) {
    raw.sections.forEach((s, index) => {
      if (!isRecord(s)) return;
      for (const key of Object.keys(s)) if (!SECTION_KEYS.has(key)) dropped.push(`sections.${index}.${key}`);
    });
  }
  const regions: PageRegion[] = Array.isArray(raw.regions)
    ? raw.regions
        .filter(isRecord)
        .filter((r) => typeof r.key === 'string')
        .map((r) => ({ key: r.key as string, ...(typeof r.label === 'string' ? { label: r.label } : {}) }))
    : [];
  const sections: PageSection[] = Array.isArray(raw.sections)
    ? raw.sections.filter(isRecord).map((s) => ({
        id: typeof s.id === 'string' && s.id ? s.id : newBlockId(),
        component: typeof s.component === 'string' ? s.component : '',
        data: isRecord(s.data) ? s.data : {},
        styleConfig: isRecord(s.styleConfig) ? (s.styleConfig as PageSection['styleConfig']) : {},
        ...(isRecord(s.source) ? { source: s.source as PageSection['source'] } : {}),
      }))
    : [];
  const keys = new Set(regions.map((r) => r.key));
  if (!keys.has(PAGE_LAYOUT_DEFAULT_REGION)) regions.unshift({ key: PAGE_LAYOUT_DEFAULT_REGION });
  // Sections pointing at a region nobody declared get one, so they stay visible.
  for (const s of sections) {
    const region = regionOf(s);
    if (!regions.some((r) => r.key === region)) regions.push({ key: region });
  }
  const converted = raw.version !== PAGE_LAYOUT_VERSION && (sections.length > 0 || dropped.length > 0);
  return {
    layout: { version: PAGE_LAYOUT_VERSION, regions, sections },
    converted,
    dropped: converted ? dropped : [],
  };
}

export function sectionsIn(layout: ComposerLayout, region: string): PageSection[] {
  return layout.sections.filter((s) => regionOf(s) === region);
}

function withRegion(section: PageSection, region: string): PageSection {
  const styleConfig = { ...section.styleConfig };
  if (region === PAGE_LAYOUT_DEFAULT_REGION) delete styleConfig.region;
  else styleConfig.region = region;
  return { ...section, styleConfig };
}

/**
 * Add a block at the end of a region. Returns the new layout and section id.
 * A region the layout does not declare falls back to the default one, so a
 * stale target (a region removed meanwhile) never yields an invisible section.
 */
export function addSection(layout: ComposerLayout, component: string, region: string): { layout: ComposerLayout; id: string } {
  const id = newBlockId();
  const declared = (layout.regions ?? [{ key: PAGE_LAYOUT_DEFAULT_REGION }]).some((r) => r.key === region);
  const section = withRegion({ id, component, data: {}, styleConfig: {} }, declared ? region : PAGE_LAYOUT_DEFAULT_REGION);
  return { layout: { ...layout, sections: [...layout.sections, section] }, id };
}

export function removeSection(layout: ComposerLayout, id: string): ComposerLayout {
  return { ...layout, sections: layout.sections.filter((s) => s.id !== id) };
}

export function duplicateSection(layout: ComposerLayout, id: string): { layout: ComposerLayout; id: string } {
  const index = layout.sections.findIndex((s) => s.id === id);
  if (index < 0) return { layout, id };
  const copy: PageSection = structuredClone(layout.sections[index]!);
  copy.id = newBlockId();
  const sections = [...layout.sections];
  sections.splice(index + 1, 0, copy);
  return { layout: { ...layout, sections }, id: copy.id };
}

export function updateSection(layout: ComposerLayout, id: string, patch: Partial<PageSection>): ComposerLayout {
  return { ...layout, sections: layout.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

/**
 * Reorder inside a region: move `id` to the position of `overId` (both in
 * the same region). Sections of other regions keep their relative order.
 */
export function reorderWithinRegion(layout: ComposerLayout, id: string, overId: string): ComposerLayout {
  const from = layout.sections.findIndex((s) => s.id === id);
  const to = layout.sections.findIndex((s) => s.id === overId);
  if (from < 0 || to < 0 || from === to) return layout;
  if (regionOf(layout.sections[from]!) !== regionOf(layout.sections[to]!)) return layout;
  const sections = [...layout.sections];
  const [moved] = sections.splice(from, 1);
  sections.splice(to, 0, moved!);
  return { ...layout, sections };
}

/** Move one step up (-1) or down (+1) within its region (keyboard alternative to drag). */
export function stepSection(layout: ComposerLayout, id: string, delta: -1 | 1): ComposerLayout {
  const section = layout.sections.find((s) => s.id === id);
  if (!section) return layout;
  const peers = sectionsIn(layout, regionOf(section));
  const at = peers.findIndex((s) => s.id === id);
  const target = peers[at + delta];
  return target ? reorderWithinRegion(layout, id, target.id) : layout;
}

/** Move a section to the end of another region. */
export function moveToRegion(layout: ComposerLayout, id: string, region: string): ComposerLayout {
  const section = layout.sections.find((s) => s.id === id);
  if (!section || regionOf(section) === region) return layout;
  const rest = layout.sections.filter((s) => s.id !== id);
  return { ...layout, sections: [...rest, withRegion(section, region)] };
}

/** `[]` or `null` = visible in every locale. */
export function setLocales(layout: ComposerLayout, id: string, locales: string[] | null): ComposerLayout {
  return {
    ...layout,
    sections: layout.sections.map((s) => {
      if (s.id !== id) return s;
      const styleConfig = { ...s.styleConfig };
      if (!locales || locales.length === 0) delete styleConfig.locales;
      else styleConfig.locales = [...new Set(locales)];
      return { ...s, styleConfig };
    }),
  };
}

export type RegionProblem = 'invalid' | 'duplicate' | 'limit';

const REGION_KEY = /^[a-z][a-z0-9_-]{0,31}$/;

export function addRegion(layout: ComposerLayout, key: string, label?: string): ComposerLayout | RegionProblem {
  const regions = layout.regions ?? [{ key: PAGE_LAYOUT_DEFAULT_REGION }];
  if (!REGION_KEY.test(key)) return 'invalid';
  if (regions.some((r) => r.key === key)) return 'duplicate';
  if (regions.length >= PAGE_LAYOUT_MAX_REGIONS) return 'limit';
  return { ...layout, regions: [...regions, { key, ...(label ? { label } : {}) }] };
}

/** Remove an empty, non-default region; `null` when it cannot be removed. */
export function removeRegion(layout: ComposerLayout, key: string): ComposerLayout | null {
  if (key === PAGE_LAYOUT_DEFAULT_REGION || sectionsIn(layout, key).length > 0) return null;
  return { ...layout, regions: (layout.regions ?? []).filter((r) => r.key !== key) };
}

export interface ServerIssue {
  code: string;
  message: string;
  field?: string;
}

/**
 * Map server validation errors (`field: "sections.2.data.title"`) onto
 * section ids, so the composer can flag the right card and field.
 *
 * Pass the layout that was *submitted*: the indexes refer to it. Mapping
 * against a layout edited since would put the errors on other sections.
 */
export function issuesBySection(
  layout: ComposerLayout,
  issues: ServerIssue[],
): { bySection: Map<string, ServerIssue[]>; general: ServerIssue[] } {
  const bySection = new Map<string, ServerIssue[]>();
  const general: ServerIssue[] = [];
  for (const issue of issues) {
    const match = /^sections\.(\d+)(?:\.(.*))?$/.exec(issue.field ?? '');
    const section = match ? layout.sections[Number(match[1])] : undefined;
    if (!section) {
      general.push(issue);
      continue;
    }
    const list = bySection.get(section.id) ?? [];
    list.push({ ...issue, field: match?.[2] ?? '' });
    bySection.set(section.id, list);
  }
  return { bySection, general };
}
