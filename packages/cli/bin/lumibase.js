#!/usr/bin/env node
// Guard BEFORE loading the ESM graph. `lumibase init` spawns create-lumibase,
// which static-imports execa 10 and fails at import-time on Node <22. Checking
// inside main() would be unreachable on those runtimes.
const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  console.error(`lumibase requires Node.js 22+. Current: ${process.versions.node}`);
  process.exit(1);
}

import('../dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
