/**
 * `@lumibase/svelte/kit` — SvelteKit server helpers.
 *
 * ```ts
 * // src/hooks.server.ts
 * import { env } from '$env/dynamic/private';
 * import { createLumiHandle } from '@lumibase/svelte/kit';
 * export const handle = createLumiHandle(() => ({
 *   url: env.LUMIBASE_URL, siteId: env.LUMIBASE_SITE_ID, token: env.LUMIBASE_TOKEN,
 * }));
 *
 * // src/routes/+page.server.ts
 * import { readItems } from '@lumibase/sdk';
 * export const load = async ({ locals }) => ({ posts: await locals.lumi.request(readItems('posts')) });
 * ```
 *
 * Typed structurally against the SvelteKit `Handle` / `RequestEvent` shape so
 * this package does not depend on `@sveltejs/kit` (any 2.x or 3.x works).
 * Configuration is resolved per request through a function, so the token is
 * read from `$env/dynamic/private` at runtime and never baked into a bundle.
 */
import { createLumiClient, type DefaultSchema, type LumiClient, type LumiClientOptions } from "@lumibase/sdk";

/** The part of SvelteKit's `RequestEvent` these helpers use. */
export interface KitEventLike {
  fetch: typeof fetch;
  locals: object;
}

export type LumiKitConfig = Pick<LumiClientOptions, "url" | "siteId" | "token" | "headers">;

/**
 * A client for one request. Uses SvelteKit's `event.fetch`, which carries
 * cookies for same-origin calls and lets SSR responses be inlined for
 * hydration instead of fetched twice.
 */
export function lumiForEvent<TSchema extends DefaultSchema = DefaultSchema>(
  event: Pick<KitEventLike, "fetch">,
  config: LumiKitConfig,
): LumiClient<TSchema> {
  return createLumiClient<TSchema>({ ...config, fetcher: event.fetch });
}

export interface KitHandleInput<E extends KitEventLike> {
  event: E;
  resolve: (event: E) => Response | Promise<Response>;
}

/**
 * A `handle` hook that puts a per-request client on `event.locals.lumi`
 * (or `event.locals[localsKey]`). Compose with `sequence()` if you have other
 * hooks. Declare the type in `src/app.d.ts`:
 *
 * ```ts
 * declare global { namespace App { interface Locals { lumi: import('@lumibase/sdk').LumiClient<Schema> } } }
 * ```
 */
export function createLumiHandle<E extends KitEventLike>(
  config: LumiKitConfig | ((event: E) => LumiKitConfig),
  options: { localsKey?: string } = {},
): (input: KitHandleInput<E>) => Response | Promise<Response> {
  const key = options.localsKey ?? "lumi";
  return ({ event, resolve }) => {
    const resolved = typeof config === "function" ? config(event) : config;
    (event.locals as Record<string, unknown>)[key] = lumiForEvent(event, resolved);
    return resolve(event);
  };
}
