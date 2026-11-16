import { readFileSync } from 'node:fs';
import { parseBenchmarkReport } from '../eval/jev-benchmark/report';
import { qualityGate } from '../eval/jev-benchmark/quality-gate';
const failures = qualityGate(parseBenchmarkReport(JSON.parse(readFileSync(process.argv[2]!, 'utf8'))));
console.log(JSON.stringify({ status: failures.length ? 'failed' : 'passed', failures }, null, 2));
if (failures.length) process.exitCode = 1;
