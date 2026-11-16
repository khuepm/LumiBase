// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Locals {
      /** Set by `hooks.server.ts` from a verified preview cookie. */
      preview: boolean;
    }
  }
}

export {};
