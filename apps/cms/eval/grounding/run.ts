import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateGroundedContent, type GroundingSource } from '../../src/services/grounded-content';
const dataset = JSON.parse(readFileSync(join(import.meta.dirname, 'dataset.v1.json'), 'utf8')) as {
  version: number; mode: string; sources: GroundingSource[];
  cases: Array<{ id: string; sources?: GroundingSource[]; candidate: unknown; accepted: boolean }>;
};
const cases = dataset.cases.map((entry) => {
  let accepted = false;
  try { validateGroundedContent(entry.candidate, entry.sources ?? dataset.sources); accepted = true; } catch { /* refusal expected for invalid outputs */ }
  return { id: entry.id, passed: accepted === entry.accepted };
});
const report = { version: dataset.version, mode: dataset.mode, total: cases.length, passed: cases.filter((entry) => entry.passed).length, threshold: 1, cases };
console.log(JSON.stringify(report, null, 2));
if (report.passed !== report.total) process.exitCode = 1;
