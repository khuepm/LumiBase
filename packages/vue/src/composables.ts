import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  onBeforeUnmount,
  onMounted,
  onScopeDispose,
  onServerPrefetch,
  ref,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
  type ShallowRef,
} from "vue";
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

import { isBrowser, useLumiBase } from "./context";

/** The content shape of `collection` in `TSchema` (what lives under `row.data`). */
export type CollectionData<TSchema extends DefaultSchema, C extends keyof TSchema> =
  TSchema[C] extends Record<string, unknown> ? TSchema[C] : Record<string, unknown>;

export interface LiveOptions {
  /** Server-side envelope filter forwarded to `RealtimeClient.subscribe`. */
  filter?: Record<string, unknown>;
}

export interface UseItemsOptions<TSchema extends DefaultSchema, C extends keyof TSchema & string> {
  /** Use this client instead of the injected one (also lets TS infer the schema). */
  client?: LumiClient<TSchema>;
  /** Realtime client for `live`; defaults to the injected one. */
  realtime?: RealtimeClient | null;
  /** Re-fetch when a realtime event arrives for the collection. Browser only. */
  live?: boolean | LiveOptions;
  /**
   * Data you already have (e.g. from Nuxt `useAsyncData` or an SSR payload).
   * When set, the first fetch is skipped; later param changes still fetch.
   */
  initialData?: ListItemsResponse<CollectionData<TSchema, C>> | null;
  /** Fetch on creation. Default `true`. */
  immediate?: boolean;
}

export interface AsyncState<T> {
  data: ShallowRef<T | null>;
  error: ShallowRef<unknown>;
  pending: Ref<boolean>;
  refresh: () => Promise<void>;
}

export interface UseItemsReturn<TData extends Record<string, unknown>>
  extends AsyncState<ListItemsResponse<TData>> {
  /** `data.value?.data ?? []` — the rows. */
  items: ComputedRef<ItemRow<TData>[]>;
}

function resolveClient<TSchema extends DefaultSchema>(explicit?: LumiClient<TSchema>): LumiClient<TSchema> {
  return explicit ?? useLumiBase<TSchema>().client;
}

function resolveRealtime(explicit: RealtimeClient | null | undefined): RealtimeClient | null {
  if (explicit !== undefined) return explicit;
  // Optional: a component may use `live` only when a realtime client exists.
  try {
    return useLumiBase().realtime ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `start` while the caller is alive: between mount and unmount inside a
 * component (never during SSR), or immediately in a bare effect scope in the
 * browser. Returns a manual stop.
 */
function whileAlive(start: () => () => void): () => void {
  let stop: (() => void) | null = null;
  const run = () => {
    if (!stop) stop = start();
  };
  const halt = () => {
    stop?.();
    stop = null;
  };
  if (getCurrentInstance()) {
    onMounted(run);
    onBeforeUnmount(halt);
  } else {
    if (isBrowser()) run();
    if (getCurrentScope()) onScopeDispose(halt);
  }
  return halt;
}

/**
 * Turn a fetcher into reactive state. Only the latest call may write the
 * result, so a slow response never overwrites a newer one.
 */
function useAsync<T>(load: () => Promise<T>, initial: T | null): AsyncState<T> {
  const data = shallowRef<T | null>(initial) as ShallowRef<T | null>;
  const error = shallowRef<unknown>(null);
  const pending = ref(false);
  let ticket = 0;

  async function refresh(): Promise<void> {
    const mine = ++ticket;
    pending.value = true;
    try {
      const result = await load();
      if (mine === ticket) {
        data.value = result;
        error.value = null;
      }
    } catch (err) {
      if (mine === ticket) error.value = err;
    } finally {
      if (mine === ticket) pending.value = false;
    }
  }

  return { data, error, pending, refresh };
}

/** Kick off the first load: awaited by SSR via `onServerPrefetch`, else fired. */
function firstLoad(refresh: () => Promise<void>): void {
  if (!isBrowser() && getCurrentInstance()) {
    onServerPrefetch(refresh);
    return;
  }
  void refresh();
}

/**
 * Subscribe to realtime events for a collection while the component is
 * mounted. The handler is removed — and the shared connection released — on
 * unmount or scope dispose. Never connects during SSR.
 */
export function useRealtime(
  collection: MaybeRefOrGetter<string>,
  handler: (event: RealtimeEvent) => void,
  options: LiveOptions & { realtime?: RealtimeClient | null } = {},
): { stop: () => void } {
  const realtime = resolveRealtime(options.realtime);
  if (!realtime) return { stop: () => {} };

  const stop = whileAlive(() => {
    const release = retainRealtime(realtime);
    let off = realtime.subscribe(toValue(collection), handler, { filter: options.filter });
    const stopWatch = watch(
      () => toValue(collection),
      (next) => {
        off();
        off = realtime.subscribe(next, handler, { filter: options.filter });
      },
    );
    return () => {
      stopWatch();
      off();
      release();
    };
  });
  return { stop };
}

/**
 * Coalesce bursts: while a refresh runs, further events mark it dirty and a
 * single follow-up refresh runs afterwards.
 */
function coalesced(refresh: () => Promise<void>): () => void {
  let running = false;
  let dirty = false;
  const loop = async () => {
    running = true;
    try {
      do {
        dirty = false;
        await refresh();
      } while (dirty);
    } finally {
      running = false;
    }
  };
  return () => {
    if (running) dirty = true;
    else void loop();
  };
}

/**
 * Reactive list of a collection's items via `readItems`. `params` may be a
 * ref or getter; changing it re-fetches. With `live`, realtime events for the
 * collection trigger a coalesced re-fetch while mounted.
 *
 * ```ts
 * const { items, pending } = useItems('posts', () => ({ limit: page.value * 10 }), { live: true });
 * ```
 */
export function useItems<
  TSchema extends DefaultSchema = DefaultSchema,
  C extends keyof TSchema & string = keyof TSchema & string,
>(
  collection: MaybeRefOrGetter<C>,
  params?: MaybeRefOrGetter<ListItemsParams | undefined>,
  options: UseItemsOptions<TSchema, C> = {},
): UseItemsReturn<CollectionData<TSchema, C>> {
  type Data = CollectionData<TSchema, C>;
  const client = resolveClient(options.client);
  const state = useAsync<ListItemsResponse<Data>>(
    () =>
      client.request(readItems<TSchema, C>(toValue(collection), toValue(params))) as Promise<
        ListItemsResponse<Data>
      >,
    options.initialData ?? null,
  );

  watch([() => toValue(collection), () => JSON.stringify(toValue(params) ?? null)], () => {
    void state.refresh();
  });

  if (options.immediate !== false && !options.initialData) firstLoad(state.refresh);

  if (options.live) {
    const live = typeof options.live === "object" ? options.live : {};
    useRealtime(collection, coalesced(state.refresh), { ...live, realtime: options.realtime });
  }

  return { ...state, items: computed(() => state.data.value?.data ?? []) };
}

export interface UseItemOptions<TSchema extends DefaultSchema, C extends keyof TSchema & string> {
  client?: LumiClient<TSchema>;
  realtime?: RealtimeClient | null;
  /** Re-fetch when a realtime event for this item id arrives. Browser only. */
  live?: boolean;
  fields?: string[];
  initialData?: ItemRow<CollectionData<TSchema, C>> | null;
  immediate?: boolean;
}

/** Reactive single item via `readItem`. A changing `id` re-fetches. */
export function useItem<
  TSchema extends DefaultSchema = DefaultSchema,
  C extends keyof TSchema & string = keyof TSchema & string,
>(
  collection: MaybeRefOrGetter<C>,
  id: MaybeRefOrGetter<string>,
  options: UseItemOptions<TSchema, C> = {},
): AsyncState<ItemRow<CollectionData<TSchema, C>>> {
  type Row = ItemRow<CollectionData<TSchema, C>>;
  const client = resolveClient(options.client);
  const state = useAsync<Row>(
    () => client.request(readItem<TSchema, C>(toValue(collection), toValue(id), options.fields)) as Promise<Row>,
    options.initialData ?? null,
  );

  watch([() => toValue(collection), () => toValue(id)], () => {
    void state.refresh();
  });

  if (options.immediate !== false && !options.initialData) firstLoad(state.refresh);

  if (options.live) {
    const refresh = coalesced(state.refresh);
    useRealtime(
      collection,
      (event) => {
        if (event.itemId === toValue(id)) refresh();
      },
      { realtime: options.realtime },
    );
  }

  return state;
}

export interface PresenceTarget {
  collection?: string;
  itemId?: string;
  meta?: Record<string, unknown>;
}

/**
 * Announce presence on a collection/item while mounted and expose the peers.
 * Presence is cleared and the listener removed on unmount.
 */
export function usePresence(
  target: MaybeRefOrGetter<PresenceTarget>,
  options: { realtime?: RealtimeClient | null } = {},
): { users: ShallowRef<PresenceEntry[]>; stop: () => void } {
  const users = shallowRef<PresenceEntry[]>([]);
  const realtime = resolveRealtime(options.realtime);
  if (!realtime) return { users, stop: () => {} };

  const stop = whileAlive(() => {
    const release = retainRealtime(realtime);
    const off = realtime.onPresence((next) => {
      users.value = next;
    });
    realtime.presence(toValue(target));
    const stopWatch = watch(
      () => JSON.stringify(toValue(target)),
      () => realtime.presence(toValue(target)),
    );
    return () => {
      stopWatch();
      off();
      realtime.presence({});
      release();
    };
  });
  return { users, stop };
}
