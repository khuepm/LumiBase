import { createRequire } from 'node:module';

// Resolved relative to this module, which lives one level below package.json
// both in source (`src/`) and in the bundle (`dist/`).
export function readVersion(requireFrom: NodeRequire = createRequire(import.meta.url)): string {
  const manifest = requireFrom('../package.json') as { version?: string };
  return manifest.version ?? '0.0.0';
}
