/**
 * postbuild: copy the bin shim to bin/ and copy templates into dist/templates
 * so the published package is self-contained.
 */
import { copyFileSync, mkdirSync, cpSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(root, '..');

// Ensure bin wrapper exists (already static, just ensure it's executable)
chmodSync(resolve(pkg, 'bin/create-lumibase.js'), 0o755);

// Copy templates into dist so they're resolvable relative to the compiled code
cpSync(resolve(pkg, 'templates'), resolve(pkg, 'dist/templates'), { recursive: true });

console.log('postbuild: bin chmod + templates copied to dist/');
