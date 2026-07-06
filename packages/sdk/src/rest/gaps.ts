/**
 * SDK commands for view presets (presets-inheritance) and media transform URLs
 * (image-transform-dsl). Each is a command factory `(client) => Promise<T>`
 * used with `client.request(...)`, matching the rest of the REST module.
 *
 * Content-version and translation-memory helpers live in the core SDK
 * (`client.items(...).versions` and `client.tm`).
 */

import type { LumiClient } from "../client";

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
  opts?: { sign?: string },
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
      // Signature (image-transform-dsl task 5) applies to custom transforms only;
      // presets are already trusted server-side.
      if (opts?.sign) qs.set("sig", opts.sign);
    }
    const query = qs.toString();
    return query ? `${base}${path}?${query}` : `${base}${path}`;
  };
}
