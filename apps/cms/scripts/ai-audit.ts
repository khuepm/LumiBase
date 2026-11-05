import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const suites = JSON.parse(readFileSync(new URL('../eval/ai-audit-suites.json', import.meta.url), 'utf8'));
const group = process.argv.includes('--database') ? 'database' : 'deterministic';
if (group === 'database' && !process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required: database evaluation cannot claim a pass without persisted-state evidence.');
  process.exit(1);
}
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', ...suites[group]], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
