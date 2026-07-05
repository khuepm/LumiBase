/**
 * SDK commands for feature-gap specs: content versions, view presets, and
 * translation memory. Each is a command factory `(client) => Promise<T>` used
 * with `client.request(...)`, matching the rest of the REST module.
 *
 * Specs: content-versioning, presets-inheritance, translation-memory-ui.
 */

import type { LumiClient } from "../client";

// ── Content versions (content-versioning) ─────────────────────────────────────

export interface ContentVersion {
  id: string;
  itemId: string;
  collectionId: string;
  key: string;
  name: string;
  data: Record<string, unknown>;
  hash: string;
  /** True when main has diverged from the snapshot this version was cut from. */
  mainChanged?: boolean;
  createdAt: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  status: "added" | "removed" | "changed" | "unchanged";
}

export interface VersionCompare {
  changes: FieldChange[];
}

const versionsBase = (collection: string, id: string) =>
  `/api/v1/items/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/versions`;

export function listVersions(collection: string, id: string) {
  return async (client: LumiClient): Promise<ContentVersion[]> => {
    const res = await client.rawRequest<ContentVersion[]>(versionsBase(collection, id));
    return res.data;
  };
}

export function createVersion(collection: string, id: string, input: { key: string; name: string }) {
  return async (client: LumiClient): Promise<ContentVersion> => {
    const res = await client.rawRequest<ContentVersion>(versionsBase(collection, id), {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function getVersion(collection: string, id: string, key: string) {
  return async (client: LumiClient): Promise<ContentVersion> => {
    const res = await client.rawRequest<ContentVersion>(
      `${versionsBase(collection, id)}/${encodeURIComponent(key)}`,
    );
    return res.data;
  };
}

export function updateVersion(
  collection: string,
  id: string,
  key: string,
  input: { data?: Record<string, unknown>; name?: string },
) {
  return async (client: LumiClient): Promise<ContentVersion> => {
    const res = await client.rawRequest<ContentVersion>(
      `${versionsBase(collection, id)}/${encodeURIComponent(key)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
    return res.data;
  };
}

export function deleteVersion(collection: string, id: string, key: string) {
  return async (client: LumiClient): Promise<null> => {
    const res = await client.rawRequest<null>(
      `${versionsBase(collection, id)}/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
    return res.data;
  };
}

export function compareVersion(collection: string, id: string, key: string) {
  return async (client: LumiClient): Promise<VersionCompare> => {
    const res = await client.rawRequest<VersionCompare>(
      `${versionsBase(collection, id)}/${encodeURIComponent(key)}/compare`,
    );
    return res.data;
  };
}

export function promoteVersion(collection: string, id: string, key: string) {
  return async (
    client: LumiClient,
  ): Promise<{ item: Record<string, unknown>; meta?: { mainDiverged: boolean } }> => {
    // The endpoint returns `{ data: item, meta: { mainDiverged } }`.
    const res = await client.rawRequest<Record<string, unknown>>(
      `${versionsBase(collection, id)}/${encodeURIComponent(key)}/promote`,
      { method: "POST" },
    );
    return { item: res.data, meta: res.meta as { mainDiverged: boolean } | undefined };
  };
}

// ── View presets (presets-inheritance) ────────────────────────────────────────

export type PresetScope = "user" | "role" | "global";

export interface ViewPreset {
  id: string;
  bookmark: string | null;
  collection: string;
  userId: string | null;
  roleId: string | null;
  layout: string;
  layoutQuery: Record<string, unknown>;
  layoutOptions: Record<string, unknown>;
  search: string | null;
  filter: Record<string, unknown>;
  icon: string | null;
  color: string | null;
  refreshInterval: number;
}

export interface ScopedViewPreset extends ViewPreset {
  sourceScope: PresetScope;
  roleDistance?: number;
}

export function getEffectivePreset(collection: string) {
  return async (client: LumiClient): Promise<ScopedViewPreset | null> => {
    const res = await client.rawRequest<ScopedViewPreset | null>(
      `/api/v1/presets/effective?collection=${encodeURIComponent(collection)}`,
    );
    return res.data;
  };
}

export function listBookmarks(collection: string) {
  return async (client: LumiClient): Promise<ScopedViewPreset[]> => {
    const res = await client.rawRequest<ScopedViewPreset[]>(
      `/api/v1/presets/bookmarks?collection=${encodeURIComponent(collection)}`,
    );
    return res.data;
  };
}

/** Save (or overwrite) the acting user's default view for a collection. */
export function saveUserView(input: Partial<ViewPreset> & { collection: string }) {
  return async (client: LumiClient): Promise<ViewPreset> => {
    const res = await client.rawRequest<ViewPreset>("/api/v1/presets", {
      method: "POST",
      body: JSON.stringify({ ...input, bookmark: null }),
    });
    return res.data;
  };
}

export function createBookmark(input: Partial<ViewPreset> & { collection: string; bookmark: string }) {
  return async (client: LumiClient): Promise<ViewPreset> => {
    const res = await client.rawRequest<ViewPreset>("/api/v1/presets", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function updateBookmark(id: string, input: Partial<ViewPreset>) {
  return async (client: LumiClient): Promise<ViewPreset> => {
    const res = await client.rawRequest<ViewPreset>(`/api/v1/presets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function deleteBookmark(id: string) {
  return async (client: LumiClient): Promise<null> => {
    const res = await client.rawRequest<null>(`/api/v1/presets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return res.data;
  };
}

// ── Media transform URLs (image-transform-dsl) ────────────────────────────────

export interface MediaTransform {
  width?: number;
  height?: number;
  format?: "webp" | "avif" | "jpeg" | "png";
  quality?: number;
  fit?: "cover" | "contain" | "fill" | "inside" | "outside";
}

/**
 * Build a delivery URL for a media asset, optionally with a transform. Pass a
 * `MediaTransform` for inline params, or `{ preset }` to reference a named
 * server-side preset. Returns a path relative to the API base — the SDK client
 * resolves it against its configured URL.
 */
export function mediaUrl(
  key: string,
  transform?: MediaTransform | { preset: string },
): (client: LumiClient) => string {
  return (client: LumiClient): string => {
    const base = client.url.replace(/\/$/, "");
    const path = `/api/v1/media/${key.split("/").map(encodeURIComponent).join("/")}`;
    if (!transform) return `${base}${path}`;
    const qs = new URLSearchParams();
    if ("preset" in transform) {
      qs.set("preset", transform.preset);
    } else {
      if (transform.width !== undefined) qs.set("width", String(transform.width));
      if (transform.height !== undefined) qs.set("height", String(transform.height));
      if (transform.format) qs.set("format", transform.format);
      if (transform.quality !== undefined) qs.set("quality", String(transform.quality));
      if (transform.fit) qs.set("fit", transform.fit);
    }
    const query = qs.toString();
    return query ? `${base}${path}?${query}` : `${base}${path}`;
  };
}

// ── Translation memory (translation-memory-ui) ─────────────────────────────────

export type TmSource = "human" | "mt" | "imported";

export interface TmEntry {
  id: string;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  context?: string | null;
  source: TmSource;
  quality: number;
  createdAt?: string;
}

/** Best fuzzy match returned by `/tm/lookup` (null when nothing crosses the threshold). */
export interface TmSuggestion {
  entry: TmEntry;
  score: number;
}

export interface TmListMeta {
  total: number;
  limit: number;
  offset: number;
}

export function listTm(params: {
  /** Source language code — maps to the `source` query param. */
  sourceLang?: string;
  /** Target language code — maps to the `target` query param. */
  targetLang?: string;
  /** Entry origin filter: human | mt | imported. */
  entrySource?: TmSource;
  limit?: number;
  offset?: number;
} = {}) {
  return async (client: LumiClient): Promise<{ data: TmEntry[]; meta: TmListMeta }> => {
    const qs = new URLSearchParams();
    if (params.sourceLang) qs.set("source", params.sourceLang);
    if (params.targetLang) qs.set("target", params.targetLang);
    if (params.entrySource) qs.set("entrySource", params.entrySource);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const res = await client.rawRequest<TmEntry[]>(`/api/v1/tm?${qs.toString()}`);
    return { data: res.data, meta: (res.meta ?? { total: res.data.length, limit: 50, offset: 0 }) as unknown as TmListMeta };
  };
}

export function upsertTm(input: {
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  context?: string;
  source?: TmSource;
  quality?: number;
  provider?: string;
}) {
  return async (client: LumiClient): Promise<TmEntry> => {
    const res = await client.rawRequest<TmEntry>("/api/v1/tm", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function updateTm(
  id: string,
  input: { targetText?: string; quality?: number; context?: string | null; source?: TmSource },
) {
  return async (client: LumiClient): Promise<TmEntry> => {
    const res = await client.rawRequest<TmEntry>(`/api/v1/tm/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}

export function deleteTm(id: string) {
  return async (client: LumiClient): Promise<null> => {
    const res = await client.rawRequest<null>(`/api/v1/tm/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return res.data;
  };
}

export function lookupTm(input: {
  query: string;
  sourceLang: string;
  targetLang: string;
  threshold?: number;
}) {
  return async (client: LumiClient): Promise<TmSuggestion | null> => {
    const res = await client.rawRequest<{ match: TmSuggestion | null }>("/api/v1/tm/lookup", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data.match;
  };
}

export interface TranslateResult {
  text: string;
  /** `tm` when served from memory, `mt` when the provider translated. */
  source: "tm" | "mt";
  tmScore?: number;
  provider?: string;
}

export function translate(input: { text: string; from: string; to: string; provider?: string }) {
  return async (client: LumiClient): Promise<TranslateResult> => {
    const res = await client.rawRequest<TranslateResult>("/api/v1/tm/translate", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return res.data;
  };
}
