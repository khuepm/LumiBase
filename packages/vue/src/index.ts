/**
 * `@lumibase/vue` — Vue 3 composables over `@lumibase/sdk`.
 *
 * Every request goes through the SDK commands (`readItems`, `readItem`) and
 * every realtime subscription through `RealtimeClient`; this package only
 * adds Vue reactivity and lifecycle. Importing it touches no browser global,
 * so it is safe in SSR (Vue SSR, Nuxt).
 */
import type { MaybeRefOrGetter } from "vue";
import type { DefaultSchema, ListItemsParams, LumiClient } from "@lumibase/sdk";

import {
  useItem,
  useItems,
  type UseItemOptions,
  type UseItemsOptions,
} from "./composables";
import { useLumiClient } from "./context";

export * from "./context";
export * from "./composables";

/**
 * Bind the composables to your schema once, so call sites need no generics:
 *
 * ```ts
 * // lumi.ts
 * import type { LumibaseSchema } from './lumibase-types';
 * import type { SchemaOf } from '@lumibase/sdk';
 * export const { useItems, useItem } = defineLumiComposables<SchemaOf<LumibaseSchema>>();
 * ```
 */
export function defineLumiComposables<TSchema extends DefaultSchema>() {
  return {
    useLumiClient: (): LumiClient<TSchema> => useLumiClient<TSchema>(),
    useItems: <C extends keyof TSchema & string>(
      collection: MaybeRefOrGetter<C>,
      params?: MaybeRefOrGetter<ListItemsParams | undefined>,
      options?: UseItemsOptions<TSchema, C>,
    ) => useItems<TSchema, C>(collection, params, options),
    useItem: <C extends keyof TSchema & string>(
      collection: MaybeRefOrGetter<C>,
      id: MaybeRefOrGetter<string>,
      options?: UseItemOptions<TSchema, C>,
    ) => useItem<TSchema, C>(collection, id, options),
  };
}
