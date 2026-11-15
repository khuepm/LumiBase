/**
 * `@lumibase/svelte` — Svelte stores and actions over `@lumibase/sdk`.
 *
 * Every request goes through the SDK commands (`readItems`, `readItem`) and
 * every realtime subscription through `RealtimeClient`; this package only
 * adds Svelte stores and lifecycle. Stores work in Svelte 4 and 5; in a
 * Svelte 5 runes component, wrap one with `fromStore()` from `svelte/store`
 * to read it as `.current`.
 *
 * Lifecycle: a store starts its work when it gets its first subscriber and
 * stops it when the last one leaves — which, for `$store` in a component, is
 * the component's destroy. Realtime work only ever starts in the browser, so
 * SSR renders never open a socket. Importing touches no browser global.
 */
import { getContext, setContext } from "svelte";
import { readable, type Readable } from "svelte/store";
import type { Action } from "svelte/action";
import {
  readItem,
  readItems,
  retainRealtime,
  type DefaultSchema,
  type ItemRow,
  type ListItemsParams,
  type ListItemsResponse,
  type LumiClient,
  type PresenceEntry,
  type RealtimeClient,
  type RealtimeEvent,
} from "@lumibase/sdk";

/** The content shape of `collection` in `TSchema` (what lives under `row.data`). */
export type CollectionData<TSchema extends DefaultSchema, C extends keyof TSchema> =
  TSchema[C] extends Record<string, unknown> ? TSchema[C] : Record<string, unknown>;

/**
 * Extension hook — the documented seam for features that layer on top of the
 * adapter. Visual editing (V03, `@lumibase/visual-editing`, issue #681) is
 * expected to plug in here once it exists; nothing here implements it.
 * `setup` runs in the browser only; its return value runs on `destroy()`.
 */
export interface LumiExtension<TSchema extends DefaultSchema = DefaultSchema> {
  name: string;
  setup(ctx: LumiBaseContext<TSchema>): void | (() => void);
}

export interface LumiBaseContext<TSchema extends DefaultSchema = DefaultSchema> {
  client: LumiClient<TSchema>;
  realtime?: RealtimeClient | null;
}

const CONTEXT_KEY = Symbol.for("@lumibase/svelte");

/** True in a browser. Evaluated per call — never at import. */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

/**
 * Provide the client to descendants (call during component init, e.g. in the
 * root `+layout.svelte`). Runs extensions in the browser and returns a
 * `destroy` that runs their cleanups — call it from `onDestroy`.
 */
export function setLumiContext<TSchema extends DefaultSchema>(
  ctx: LumiBaseContext<TSchema> & { extensions?: LumiExtension<TSchema>[] },
): { destroy: () => void } {
  const value: LumiBaseContext<TSchema> = { client: ctx.client, realtime: ctx.realtime ?? null };
  setContext(CONTEXT_KEY, value);
  const cleanups: Array<() => void> = [];
  if (isBrowser()) {
    for (const extension of ctx.extensions ?? []) {
      const cleanup = extension.setup(value);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    }
  }
  return { destroy: () => cleanups.splice(0).forEach((cleanup) => cleanup()) };
}

/** The context from {@link setLumiContext}; throws when missing. */
export function getLumiContext<TSchema extends DefaultSchema = DefaultSchema>(): LumiBaseContext<TSchema> {
  const ctx = getContext<LumiBaseContext<TSchema> | undefined>(CONTEXT_KEY);
  if (!ctx) {
    throw new Error("[@lumibase/svelte] No LumiBase client in context. Call setLumiContext({ client }) in a parent.");
  }
  return ctx;
}

export function getLumiClient<TSchema extends DefaultSchema = DefaultSchema>(): LumiClient<TSchema> {
  return getLumiContext<TSchema>().client;
}

export interface AsyncValue<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

export type RefreshableStore<T> = Readable<AsyncValue<T>> & {
  /** Fetch again now (no-op while nobody is subscribed). */
  refresh: () => Promise<void>;
};

interface StoreOptions<T> {
  /** Seed value (e.g. from a SvelteKit `load`); skips the first fetch. */
  initialData?: T | null;
  /** Realtime client for `live` (browser only). */
  realtime?: RealtimeClient | null;
}

/** Subscribe `handler` to `collection` and hold the shared connection; returns the undo. */
function attachRealtime(
  realtime: RealtimeClient,
  collection: string,
  handler: (event: RealtimeEvent) => void,
  filter?: Record<string, unknown>,
): () => void {
  const release = retainRealtime(realtime);
  const off = realtime.subscribe(collection, handler, { filter });
  return () => {
    off();
    release();
  };
}

/**
 * Generic fetch-backed store. Only the latest fetch may write, the first
 * fetch starts on first subscribe, and `onEvent` — when given — wires a
 * realtime listener (browser only) that triggers a coalesced re-fetch.
 */
function asyncStore<T>(
  load: () => Promise<T>,
  options: StoreOptions<T>,
  live?: (refresh: () => void) => () => void,
): RefreshableStore<T> {
  let set: ((value: AsyncValue<T>) => void) | null = null;
  let state: AsyncValue<T> = { data: options.initialData ?? null, error: null, loading: false };
  let ticket = 0;
  let running = false;
  let dirty = false;

  const write = (next: AsyncValue<T>) => {
    state = next;
    set?.(state);
  };

  async function refresh(): Promise<void> {
    if (!set) return;
    const mine = ++ticket;
    write({ ...state, loading: true });
    try {
      const data = await load();
      if (mine === ticket) write({ data, error: null, loading: false });
    } catch (error) {
      if (mine === ticket) write({ ...state, error, loading: false });
    }
  }

  const coalesced = () => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          dirty = false;
          await refresh();
        } while (dirty);
      } finally {
        running = false;
      }
    })();
  };

  const store = readable<AsyncValue<T>>(state, (setter) => {
    set = setter;
    setter(state);
    if (!options.initialData) void refresh();
    const stopLive = live && isBrowser() ? live(coalesced) : null;
    return () => {
      stopLive?.();
      set = null;
      ticket++; // drop any in-flight result
    };
  });

  return { subscribe: store.subscribe, refresh };
}

export interface ItemsStoreOptions<TSchema extends DefaultSchema, C extends keyof TSchema & string>
  extends StoreOptions<ListItemsResponse<CollectionData<TSchema, C>>> {
  /** Re-fetch on realtime events for the collection (browser only). */
  live?: boolean | { filter?: Record<string, unknown> };
}

/**
 * A store of `readItems(collection, params)`.
 *
 * ```svelte
 * <script>
 *   const posts = itemsStore(client, 'posts', { limit: 10 }, { live: true, realtime });
 * </script>
 * {#each $posts.data?.data ?? [] as post}<li>{post.data.title}</li>{/each}
 * ```
 */
export function itemsStore<TSchema extends DefaultSchema, C extends keyof TSchema & string>(
  client: LumiClient<TSchema>,
  collection: C,
  params?: ListItemsParams,
  options: ItemsStoreOptions<TSchema, C> = {},
): RefreshableStore<ListItemsResponse<CollectionData<TSchema, C>>> {
  type Resp = ListItemsResponse<CollectionData<TSchema, C>>;
  const realtime = options.realtime;
  const filter = typeof options.live === "object" ? options.live.filter : undefined;
  return asyncStore<Resp>(
    () => client.request(readItems<TSchema, C>(collection, params)) as Promise<Resp>,
    options,
    options.live && realtime ? (refresh) => attachRealtime(realtime, collection, () => refresh(), filter) : undefined,
  );
}

export interface ItemStoreOptions<TSchema extends DefaultSchema, C extends keyof TSchema & string>
  extends StoreOptions<ItemRow<CollectionData<TSchema, C>>> {
  fields?: string[];
  /** Re-fetch on realtime events for this item id (browser only). */
  live?: boolean;
}

/** A store of `readItem(collection, id)`. */
export function itemStore<TSchema extends DefaultSchema, C extends keyof TSchema & string>(
  client: LumiClient<TSchema>,
  collection: C,
  id: string,
  options: ItemStoreOptions<TSchema, C> = {},
): RefreshableStore<ItemRow<CollectionData<TSchema, C>>> {
  type Row = ItemRow<CollectionData<TSchema, C>>;
  const realtime = options.realtime;
  return asyncStore<Row>(
    () => client.request(readItem<TSchema, C>(collection, id, options.fields)) as Promise<Row>,
    options,
    options.live && realtime
      ? (refresh) =>
          attachRealtime(realtime, collection, (event) => {
            if (event.itemId === id) refresh();
          })
      : undefined,
  );
}

/**
 * The latest realtime event for a collection (`null` until one arrives).
 * Subscribes on first subscriber, unsubscribes after the last; browser only.
 */
export function realtimeStore(
  realtime: RealtimeClient,
  collection: string,
  options: { filter?: Record<string, unknown> } = {},
): Readable<RealtimeEvent | null> {
  return readable<RealtimeEvent | null>(null, (set) => {
    if (!isBrowser()) return undefined;
    return attachRealtime(realtime, collection, set, options.filter);
  });
}

export interface PresenceTarget {
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
}

/** Peers present on the target; announces our own presence while subscribed. */
export function presenceStore(realtime: RealtimeClient, target: PresenceTarget): Readable<PresenceEntry[]> {
  return readable<PresenceEntry[]>([], (set) => {
    if (!isBrowser()) return undefined;
    const release = retainRealtime(realtime);
    const off = realtime.onPresence(set);
    realtime.presence(target);
    return () => {
      off();
      realtime.presence({});
      release();
    };
  });
}

export interface PresenceActionParams extends PresenceTarget {
  realtime: RealtimeClient;
}

/**
 * `use:lumiPresence={{ realtime, collection: 'posts', itemId }}` — announce
 * presence while the element exists; updates follow param changes, and
 * presence is cleared (and the connection released) on destroy.
 */
export const lumiPresence: Action<HTMLElement, PresenceActionParams> = (_node, params) => {
  let current = params;
  const release = retainRealtime(current.realtime);
  const announce = (p: PresenceActionParams) => {
    const { realtime, ...target } = p;
    realtime.presence(target);
  };
  announce(current);
  return {
    update(next: PresenceActionParams) {
      current = next;
      announce(current);
    },
    destroy() {
      current.realtime.presence({});
      release();
    },
  };
};

/**
 * Bind the store factories to your schema once:
 *
 * ```ts
 * export const lumi = defineLumiStores(client); // client: LumiClient<Schema>
 * const posts = lumi.items('posts', { limit: 10 });
 * ```
 */
export function defineLumiStores<TSchema extends DefaultSchema>(
  client: LumiClient<TSchema>,
  defaults: { realtime?: RealtimeClient | null } = {},
) {
  return {
    client,
    items: <C extends keyof TSchema & string>(
      collection: C,
      params?: ListItemsParams,
      options: ItemsStoreOptions<TSchema, C> = {},
    ) => itemsStore(client, collection, params, { realtime: defaults.realtime, ...options }),
    item: <C extends keyof TSchema & string>(collection: C, id: string, options: ItemStoreOptions<TSchema, C> = {}) =>
      itemStore(client, collection, id, { realtime: defaults.realtime, ...options }),
  };
}
