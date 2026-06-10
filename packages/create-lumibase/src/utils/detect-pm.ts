import type { PackageManager } from '../index.js';

/**
 * Detect which package manager the user is running through by inspecting
 * the npm_config_user_agent env var that npm/pnpm/yarn/bun all set before
 * executing lifecycle scripts and npx.
 */
export function detectPackageManager(): PackageManager {
  const agent = process.env['npm_config_user_agent'] ?? '';

  if (agent.startsWith('pnpm')) return 'pnpm';
  if (agent.startsWith('yarn')) return 'yarn';
  if (agent.startsWith('bun')) return 'bun';
  return 'npm';
}
