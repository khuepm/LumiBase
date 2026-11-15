#!/usr/bin/env node
// Guard BEFORE loading the ESM graph so the message is a plain sentence rather
// than a syntax/import error from a Node 22+ feature further down the tree.
// The supported range is this package's `engines.node` (kept equal to the
// repo root's by `scripts/check-runtime-matrix.mjs`): below its lowest major
// the CLI exits 1, outside the range it only warns (#760).
import { enforceNodeSupport } from './node-support.js';

enforceNodeSupport({
  name: 'lumibase',
  packageJsonUrl: new URL('../package.json', import.meta.url),
});

import('../dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
