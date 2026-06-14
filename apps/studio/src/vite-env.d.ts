/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the LumiBase CMS API (e.g. `https://api.lumibase.dev`).
   * Unset in dev/Docker so the Studio uses same-origin requests; set at build
   * time for standalone (Cloudflare Pages) deployments. See `lib/api-base.ts`.
   */
  readonly VITE_API_URL?: string;
  readonly VITE_LUMIBASE_VERSION?: string;
  readonly VITE_LUMIBASE_GIT_SHA?: string;
  readonly VITE_LUMIBASE_BUILD_TIME?: string;
  readonly VITE_LUMIBASE_RELEASE_CHANNEL?: string;
  readonly VITE_LUMIBASE_ALLOW_ADMIN_PATH_REDIRECT?: string;
}
