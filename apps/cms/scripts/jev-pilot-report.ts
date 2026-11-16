#!/usr/bin/env tsx
/**
 * Jev draft-review pilot report (J09, #516).
 *
 *   # 1. Export the metrics as a site admin (window at most 366 days):
 *   curl -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
 *     "$CMS/api/v1/ai/reviews/metrics?from=2026-11-01&to=2026-12-01" > metrics.json
 *   # 2. Build the versioned report (adjudication is optional, recorded by hand):
 *   pnpm -F @lumibase/cms pilot:report -- --metrics metrics.json [--adjudication adjudication.json] [--out <dir>]
 *   # An empty template with no data:
 *   pnpm -F @lumibase/cms pilot:report -- --template [--out <dir>]
 *
 * Writes `<out>/<protocol>-<date>.json` and `.md` (`<protocol>.template.*` for a
 * template). The report never fills in a missing value.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildPilotReport,
  parseMetricsJson,
  PilotReportError,
  renderPilotReportMarkdown,
  type Adjudication,
} from '../eval/jev-pilot/report';

const CMS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage:
  pilot:report -- --metrics <metrics.json> [--adjudication <adjudication.json>] [--out <dir>]
  pilot:report -- --template [--out <dir>]`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown;
  } catch (err) {
    fail(`Could not read ${path}: ${(err as Error).message}`);
  }
}

const { values } = parseArgs({
  // pnpm forwards a literal `--` separator.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    metrics: { type: 'string' },
    adjudication: { type: 'string' },
    template: { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.template === (values.metrics !== undefined)) fail(`Pass exactly one of --metrics or --template.\n${USAGE}`);

try {
  const metrics = values.metrics ? parseMetricsJson(readJson(values.metrics)) : null;
  const adjudication = values.adjudication ? (readJson(values.adjudication) as Adjudication) : undefined;
  const report = buildPilotReport(metrics, { adjudication });
  const out = resolve(values.out ?? join(CMS_ROOT, 'eval/jev-pilot/reports'));
  const base = report.status === 'template'
    ? `${report.protocolVersion}.template`
    : `${report.protocolVersion}-${report.window.to.slice(0, 10)}`;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${base}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, `${base}.md`), renderPilotReportMarkdown(report));
  console.log(`${report.status} report → ${join(out, base)}.{json,md} · decision: ${report.decision}`);
} catch (err) {
  if (err instanceof PilotReportError) fail(err.message);
  throw err;
}
