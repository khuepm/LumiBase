/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LUMIBASE_VERSION?: string;
  readonly VITE_LUMIBASE_GIT_SHA?: string;
  readonly VITE_LUMIBASE_BUILD_TIME?: string;
  readonly VITE_LUMIBASE_RELEASE_CHANNEL?: string;
}
