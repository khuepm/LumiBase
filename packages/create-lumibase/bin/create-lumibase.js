#!/usr/bin/env node
// Guard BEFORE loading the ESM graph. `src/index.ts` static-imports
// install/git → execa, and execa 10 fails at import-time on Node <22
// (`TEXT_ENCODINGS.union is not a function`). A check inside `main()` is
// unreachable on those runtimes.
const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  console.error(
    `create-lumibase requires Node.js 22+ (execa 10). Current: ${process.versions.node}`,
  );
  process.exit(1);
}

import('../dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
