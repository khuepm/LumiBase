import type { BenchmarkReport } from './report';

/** Candidate release floors, not a claim that a provider has passed them. */
export function qualityGate(report: BenchmarkReport): string[] {
  const failures: string[] = [];
  if (report.mode !== 'live' || report.split !== 'heldout') failures.push('requires live heldout evidence');
  if (!report.source?.commit || report.source.dirty !== false) failures.push('requires a clean, known source commit');
  if (!report.runs.length) failures.push('missing provider runs');
  for (const run of report.runs) {
    for (const locale of ['en', 'vi'] as const) {
      const result = run.locales?.[locale];
      if (!result || result.sampleCount !== 60) { failures.push(`${locale}: requires 60 heldout samples`); continue; }
      if (result.calls.failures.k !== 0) failures.push(`${locale}: provider call failures`);
      for (const action of ['tag', 'route']) {
        const metrics = result.actions[action]?.atThreshold;
        if (!metrics || (metrics.selectivePrecision.value ?? 0) < 0.9 || (metrics.coverage.value ?? 0) < 0.5) {
          failures.push(`${locale}/${action}: precision < 0.90 or coverage < 0.50, or missing threshold`);
        }
      }
    }
  }
  return failures;
}
