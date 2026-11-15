import type { LumiClient } from '@lumibase/sdk';

import type { Schema } from './lib/schema';

// What a SvelteKit app declares in src/app.d.ts so `locals.lumi` is typed.
declare global {
  namespace App {
    interface Locals {
      lumi: LumiClient<Schema>;
    }
  }
}

export {};
