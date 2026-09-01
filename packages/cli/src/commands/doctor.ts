import process from 'node:process';
import pc from 'picocolors';
import { fetchTypegenManifest, probeHealth, type RequestOptions } from '../api.js';
import { CONFIG_FILENAME, resolveConfig, type ValueSource } from '../config.js';
import { CliError } from '../errors.js';
import type { ParsedArgs } from '../utils/args.js';
import { log, maskSecret } from '../utils/log.js';

const MIN_NODE_MAJOR = 22;

type CheckStatus = 'ok' | 'warn' | 'fail';

interface Check {
  label: string;
  status: CheckStatus;
  detail: string;
}

function describeSource(source: ValueSource): string {
  switch (source) {
    case 'flag':
      return 'from flag';
    case 'env':
      return 'from environment';
    case 'file':
      return `from ${CONFIG_FILENAME}`;
    case 'missing':
      return 'not set';
  }
}

function printCheck(check: Check): void {
  const mark =
    check.status === 'ok' ? pc.green('✔') : check.status === 'warn' ? pc.yellow('!') : pc.red('✖');
  console.log(`${mark} ${check.label.padEnd(12)} ${pc.dim(check.detail)}`);
}

export interface DoctorCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  request?: RequestOptions;
  nodeVersion?: string;
}

export async function doctorCommand(
  args: ParsedArgs,
  options: DoctorCommandOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(args, { cwd, env: options.env });
  const checks: Check[] = [];

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  checks.push({
    label: 'node',
    status: Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail:
      Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
        ? `v${nodeVersion}`
        : `v${nodeVersion} — LumiBase needs Node ${MIN_NODE_MAJOR}+`,
  });

  checks.push({
    label: 'config',
    status: config.configPath ? 'ok' : 'warn',
    detail: config.configPath ?? `no ${CONFIG_FILENAME} found — using flags and environment only`,
  });

  checks.push({
    label: 'url',
    status: config.url ? 'ok' : 'fail',
    detail: config.url
      ? `${config.url} (${describeSource(config.sources.url)})`
      : 'not set — pass --url or set LUMIBASE_URL',
  });

  checks.push({
    label: 'siteId',
    status: config.siteId ? 'ok' : 'fail',
    detail: config.siteId
      ? `${config.siteId} (${describeSource(config.sources.siteId)})`
      : 'not set — pass --site or set LUMIBASE_SITE_ID',
  });

  checks.push({
    label: 'token',
    status: config.token ? 'ok' : 'fail',
    detail: config.token
      ? `${maskSecret(config.token)} (${describeSource(config.sources.token)})`
      : 'not set — pass --token or set LUMIBASE_TOKEN',
  });

  if (config.url) {
    const health = await probeHealth(config.url, options.request);
    checks.push({
      label: 'health',
      status: health.ok ? (health.status === 'degraded' ? 'warn' : 'ok') : 'fail',
      detail: health.detail,
    });
  }

  if (config.url && config.siteId && config.token) {
    try {
      const manifest = await fetchTypegenManifest(
        { url: config.url, siteId: config.siteId, token: config.token },
        {},
        options.request,
      );
      checks.push({
        label: 'schema',
        status: 'ok',
        detail: `${manifest.collections.length} collections readable`,
      });
    } catch (err) {
      checks.push({
        label: 'schema',
        status: 'fail',
        detail: err instanceof CliError ? err.message : String(err),
      });
    }
  }

  log.plain();
  for (const check of checks) printCheck(check);
  log.plain();

  const failures = checks.filter((check) => check.status === 'fail');
  if (failures.length > 0) {
    log.error(`${failures.length} check${failures.length === 1 ? '' : 's'} failed.`);
    return 1;
  }

  log.success('Everything looks good.');
  return 0;
}
