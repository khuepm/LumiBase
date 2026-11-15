#!/usr/bin/env node
// Guard BEFORE loading the ESM graph. `src/index.ts` static-imports
// install/git → execa, and execa 10 fails at import-time on Node <22
// (`TEXT_ENCODINGS.union is not a function`). A check inside `main()` is
// unreachable on those runtimes.
// The supported range is this package's `engines.node` (kept equal to the
// repo root's by `scripts/check-runtime-matrix.mjs`): below its lowest major
// the scaffolder exits 1, outside the range it only warns (#760).
import { enforceNodeSupport } from './node-support.js';

enforceNodeSupport({
  name: 'create-lumibase',
  packageJsonUrl: new URL('../package.json', import.meta.url),
});

import('../dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
