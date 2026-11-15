/**
 * `@lumibase/astro/loader` — Astro Content Layer loader (Astro ≥ 5).
 *
 * ```ts
 * // src/content.config.ts
 * import { defineCollection } from 'astro:content';
 * import { lumibaseLoader } from '@lumibase/astro/loader';
 * export const collections = {
 *   posts: defineCollection({
 *     loader: lumibaseLoader({
 *       client: { url: 'https://cms.example.com', siteId: 'site_123', token: import.meta.env.LUMIBASE_TOKEN },
 *       collection: 'posts',
 *       params: { status: 'published' },
 *     }),
 *   }),
 * };
 * ```
 *
 * Each entry is the full item row (`id`, `status`, `data`, …) keyed by its
 * id; pages are fetched with the SDK's `readItems` until a short page.
 */
import {
  createLumiClient,
  readItems,
  type DefaultSchema,
  type ItemRow,
  type ListItemsParams,
  type LumiClient,
  type LumiClientOptions,
} from "@lumibase/sdk";

/** The part of Astro's `LoaderContext` this loader uses. */
export interface LoaderContextLike {
  store: {
    clear(): void;
    set(entry: { id: string; data: Record<string, unknown>; digest?: string | number }): boolean;
  };
  logger: { info(message: string): void };
  parseData<T extends Record<string, unknown>>(props: { id: string; data: T }): Promise<T>;
  generateDigest(data: Record<string, unknown> | string): string;
}

export interface LumibaseLoaderOptions<TSchema extends DefaultSchema, C extends keyof TSchema & string> {
  /** An SDK client, or the options to build one (build/sync time only — never shipped). */
  client: LumiClient<TSchema> | Pick<LumiClientOptions, "url" | "siteId" | "token" | "fetcher">;
  collection: C;
  /** Filters/sort/fields; `limit`/`offset` are driven by the loader. */
  params?: Omit<ListItemsParams, "limit" | "offset" | "meta">;
  /** Rows per request. Default 100. */
  pageSize?: number;
  /** Optional Astro schema (e.g. a zod object) validated by `parseData`. */
  schema?: unknown;
}

export interface LumibaseLoader {
  name: string;
  schema?: unknown;
  load(context: LoaderContextLike): Promise<void>;
}

function isClient<TSchema extends DefaultSchema>(value: unknown): value is LumiClient<TSchema> {
  return typeof (value as { request?: unknown }).request === "function";
}

export function lumibaseLoader<TSchema extends DefaultSchema = DefaultSchema, C extends keyof TSchema & string = keyof TSchema & string>(
  options: LumibaseLoaderOptions<TSchema, C>,
): LumibaseLoader {
  const pageSize = options.pageSize ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("[@lumibase/astro] pageSize must be a positive integer");

  return {
    name: "lumibase-loader",
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
    async load({ store, logger, parseData, generateDigest }) {
      const client = isClient<TSchema>(options.client) ? options.client : createLumiClient<TSchema>(options.client);
      const rows: ItemRow[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await client.request(
          readItems<TSchema, C>(options.collection, { ...options.params, limit: pageSize, offset, meta: "none" }),
        );
        const batch = page.data as ItemRow[];
        rows.push(...batch);
        if (batch.length < pageSize) break;
      }
      // Clear only after every page arrived: a failed fetch keeps the last good content.
      store.clear();
      for (const row of rows) {
        const raw = row as unknown as Record<string, unknown>;
        const data = await parseData({ id: row.id, data: raw });
        store.set({ id: row.id, data, digest: generateDigest(raw) });
      }
      logger.info(`Loaded ${rows.length} ${options.collection} item(s) from LumiBase`);
    },
  };
}
