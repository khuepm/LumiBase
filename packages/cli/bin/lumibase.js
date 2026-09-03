#!/usr/bin/env node
// Guard BEFORE loading the ESM graph so the message is a plain sentence rather
// than a syntax/import error from a Node 22+ feature further down the tree.
const major = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(major) || major < 22) {
  console.error(`lumibase requires Node.js 22+. Current: ${process.versions.node}`);
  process.exit(1);
}

import('../dist/index.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
