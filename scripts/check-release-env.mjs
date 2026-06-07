#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_CONFIG = 'apps/cms/wrangler.toml';
const DEFAULT_ENV = 'production';
const DEFAULT_REQUIRED_SECRETS = ['JWT_SECRET', 'CF_ACCESS_CERTS_URL', 'CF_ACCESS_AUDIENCE'];
const DEV_JWT_SECRET = 'dev_secret_key';

function parseArgs(argv) {
  const args = {
    config: process.env.LUMIBASE_RELEASE_CONFIG || DEFAULT_CONFIG,
    env: process.env.LUMIBASE_RELEASE_ENV || DEFAULT_ENV,
    requiredSecrets: process.env.LUMIBASE_REQUIRED_RELEASE_SECRETS
      ? process.env.LUMIBASE_REQUIRED_RELEASE_SECRETS.split(',').map((name) => name.trim()).filter(Boolean)
      : DEFAULT_REQUIRED_SECRETS,
    checkCloudflare: process.env.LUMIBASE_CHECK_CLOUDFLARE_SECRETS !== 'false',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--config') args.config = argv[++index];
    else if (value === '--env') args.env = argv[++index];
    else if (value === '--required-secret') args.requiredSecrets.push(argv[++index]);
    else if (value === '--required-secrets') {
      args.requiredSecrets = argv[++index].split(',').map((name) => name.trim()).filter(Boolean);
    } else if (value === '--no-cloudflare') args.checkCloudflare = false;
    else if (value === '--help' || value === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  args.requiredSecrets = [...new Set(args.requiredSecrets)];
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/check-release-env.mjs [options]\n\nOptions:\n  --config <path>              Wrangler config path (default: ${DEFAULT_CONFIG})\n  --env <name>                 Deployment environment to validate (default: ${DEFAULT_ENV})\n  --required-secrets <csv>     Replace the default required production secrets\n  --required-secret <name>     Add one required production secret\n  --no-cloudflare              Only inspect local environment and wrangler.toml\n\nEnvironment overrides:\n  LUMIBASE_RELEASE_CONFIG\n  LUMIBASE_RELEASE_ENV\n  LUMIBASE_REQUIRED_RELEASE_SECRETS\n  LUMIBASE_CHECK_CLOUDFLARE_SECRETS=false\n`);
}

function stripComment(line) {
  let inQuote = false;
  let result = '';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') inQuote = !inQuote;
    if (char === '#' && !inQuote) break;
    result += char;
  }
  return result.trim();
}

function parseScalar(value) {
  const trimmed = value.trim().replace(/,$/, '').trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1).replace(/\\"/g, '"');
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function parseInlineTable(value) {
  const entries = {};
  const inner = value.trim().replace(/^\{/, '').replace(/\}$/, '');
  const pairs = inner.match(/(?:[^,"{}]|"(?:\\.|[^"])*")+/g) || [];
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const key = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    entries[key] = parseScalar(rawValue);
  }
  return entries;
}

function parseWranglerToml(filePath) {
  const parsed = { vars: {}, env: {} };
  let section = [];
  const text = readFileSync(filePath, 'utf8');

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].split('.');
      if (section[0] === 'env' && section[1]) parsed.env[section[1]] ||= { vars: {} };
      continue;
    }

    if (line.startsWith('[[')) {
      section = [];
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue.startsWith('{') ? parseInlineTable(rawValue) : parseScalar(rawValue);

    if (section.length === 1 && section[0] === 'vars') {
      parsed.vars[key] = value;
    } else if (section[0] === 'env' && section[1]) {
      parsed.env[section[1]] ||= { vars: {} };
      if (section[2] === 'vars') parsed.env[section[1]].vars[key] = value;
      else if (key === 'vars' && typeof value === 'object') parsed.env[section[1]].vars = { ...parsed.env[section[1]].vars, ...value };
    }
  }

  return parsed;
}

function getEffectiveVars(parsed, envName) {
  // Wrangler environment-level vars are non-inheritable: deploying with
  // `--env production` uses `[env.production.vars]`, not top-level `[vars]`.
  // Fall back to top-level vars only when the named environment is absent.
  return parsed.env[envName] ? { ...(parsed.env[envName].vars || {}) } : { ...parsed.vars };
}

function getConfiguredVars(parsed, envName) {
  return {
    topLevel: parsed.vars,
    envLevel: parsed.env[envName]?.vars || {},
    effective: getEffectiveVars(parsed, envName),
  };
}

function listCloudflareSecrets({ config, env }) {
  const args = ['wrangler', 'secret', 'list', '--config', config, '--env', env, '--json'];
  const result = spawnSync('pnpm', ['exec', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Unable to list Cloudflare secrets with \`pnpm exec ${args.join(' ')}\`.\n${result.stderr || result.stdout}`.trim());
  }

  const output = result.stdout.trim();
  if (!output) return new Set();

  const records = JSON.parse(output);
  return new Set(records.map((record) => record.name).filter(Boolean));
}

function isPresent(value) {
  return value !== undefined && value !== null && `${value}`.trim() !== '';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.isAbsolute(args.config) ? args.config : path.resolve(REPO_ROOT, args.config);
  args.config = configPath;
  const failures = [];
  const warnings = [];

  if (!existsSync(configPath)) {
    failures.push(`Wrangler config does not exist: ${args.config}`);
  }

  const parsed = existsSync(configPath) ? parseWranglerToml(configPath) : { vars: {}, env: {} };
  const configured = getConfiguredVars(parsed, args.env);
  const effectiveVars = configured.effective;

  if (args.env === 'production') {
    if (String(effectiveVars.LUMIBASE_DEV_AUTH ?? process.env.LUMIBASE_DEV_AUTH ?? '').toLowerCase() === 'true') {
      failures.push('Production deploy cannot run with LUMIBASE_DEV_AUTH="true".');
    }

    const configuredJwt = effectiveVars.JWT_SECRET;
    const envJwt = process.env.JWT_SECRET;
    if (configuredJwt === DEV_JWT_SECRET || envJwt === DEV_JWT_SECRET) {
      failures.push(`Production deploy cannot use JWT_SECRET="${DEV_JWT_SECRET}".`);
    }
  }

  const hardcodedSecrets = args.requiredSecrets.filter((name) => isPresent(configured.envLevel[name]));
  for (const name of hardcodedSecrets) {
    failures.push(`${name} is configured in [env.${args.env}.vars]; store production secrets with Wrangler secrets or CI environment instead.`);
  }

  let cloudflareSecrets = new Set();
  if (args.checkCloudflare) {
    try {
      cloudflareSecrets = listCloudflareSecrets({ config: args.config, env: args.env });
    } catch (error) {
      warnings.push(error.message);
    }
  }

  for (const name of args.requiredSecrets) {
    if (isPresent(process.env[name]) || cloudflareSecrets.has(name)) continue;
    failures.push(`${name} is missing. Set it as a CI environment variable or with \`pnpm exec wrangler secret put ${name} --env ${args.env} --config ${args.config}\`.`);
  }

  if (warnings.length > 0) {
    console.warn('Release config warnings:');
    for (const warning of warnings) console.warn(`- ${warning}`);
  }

  if (failures.length > 0) {
    console.error('Release config check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Release config check passed for ${args.env} using ${args.config}.`);
}

main();
