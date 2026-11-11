import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import pc from 'picocolors';
import {
  exportSkills,
  importSkills,
  listSkills,
  type Connection,
  type RequestOptions,
  type SkillImportDocument,
  type SkillImportOptions,
  type SkillImportResult,
} from '../api.js';
import { requireConnection, resolveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { boolFlag, stringFlag, type ParsedArgs } from '../utils/args.js';
import { log } from '../utils/log.js';

/**
 * `lumibase skills` — Site Skills as code (#712).
 *
 * Deliberately thin: the server parses and validates skill documents; this
 * command only moves Markdown files between a directory and the CMS. Nothing
 * here reads front matter, so the CLI cannot disagree with the server about
 * what a valid skill is.
 */

export const DEFAULT_SKILLS_DIR = 'skills';

const SUBCOMMANDS = ['list', 'pull', 'push', 'install'] as const;
const STUDIO_SKILLS = 'Studio (Mission Control → Skills)';

export interface SkillsCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  request?: RequestOptions;
}

interface Context {
  cwd: string;
  connection: Connection;
  request?: RequestOptions;
}

/**
 * The arg parser gives a flag the next token as its value, so in
 * `skills install --dry-run my-pkg` it reads `dry-run = "my-pkg"`. For a flag
 * that is boolean by definition that would silently turn a dry run into a real
 * write, so the swallowed token is handed back as a positional instead.
 */
function switchFlag(args: ParsedArgs, name: string, strays: string[]): boolean {
  const value = args[name];
  if (typeof value === 'string' && value !== 'true' && value !== 'false') {
    strays.push(value);
    return true;
  }
  return boolFlag(args, name);
}

export async function skillsCommand(
  args: ParsedArgs,
  options: SkillsCommandOptions = {},
): Promise<number> {
  const strays: string[] = [];
  const flags = {
    json: switchFlag(args, 'json', strays),
    activate: switchFlag(args, 'activate', strays),
    dryRun: switchFlag(args, 'dry-run', strays),
    check: switchFlag(args, 'check', strays),
  };
  const [sub, ...rest] = [...args._.slice(1), ...strays];

  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new CliError(
      sub ? `Unknown skills command: ${sub}` : 'Missing skills command.',
      `Use one of: ${SUBCOMMANDS.map((name) => `lumibase skills ${name}`).join(', ')}. Run \`lumibase --help\` for options.`,
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(args, { cwd, env: options.env });
  requireConnection(config);
  const ctx: Context = {
    cwd,
    connection: { url: config.url, siteId: config.siteId, token: config.token },
    request: options.request,
  };

  const status = stringFlag(args, 'status');
  const dir = stringFlag(args, 'dir') ?? DEFAULT_SKILLS_DIR;

  switch (sub) {
    case 'list':
      return list(ctx, { status, json: flags.json });
    case 'pull':
      return pull(ctx, { dir, status });
    case 'push':
      return push(ctx, { dir, ...flags });
    default:
      return install(ctx, { source: rest[0], ...flags });
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function list(ctx: Context, opts: { status?: string; json: boolean }): Promise<number> {
  const skills = await listSkills(ctx.connection, { status: opts.status }, ctx.request);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
    return 0;
  }

  if (skills.length === 0) {
    log.info(opts.status ? `No ${opts.status} skills on this site.` : 'No skills on this site yet.');
    return 0;
  }

  const cell = (value: unknown): string =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
  const header = ['SLUG', 'STATUS', 'VERSION', 'RISK', 'NAME'];
  const rows = skills.map((skill) => [
    cell(skill['slug']),
    cell(skill['status']),
    skill['version'] === undefined ? '' : `v${cell(skill['version'])}`,
    cell(skill['riskClass']),
    cell(skill['name']),
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: string[]): string =>
    row
      .map((value, column) => value.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();

  log.plain(pc.dim(line(header)));
  for (const row of rows) log.plain(line(row));
  return 0;
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

/**
 * The file name comes from the server, and it decides where we write. Only a
 * plain Markdown basename is accepted, so a hostile or buggy CMS cannot make
 * `pull` write outside `--dir` or drop a non-skill file (a dotfile, a script).
 */
export function isSafeSkillFilename(filename: string): boolean {
  if (!filename || filename.length > 255) return false;
  if (/[\\/:\0]/.test(filename)) return false;
  if (filename.startsWith('.')) return false;
  if (filename !== basename(filename)) return false;
  return /\.md$/i.test(filename);
}

async function pull(ctx: Context, opts: { dir: string; status?: string }): Promise<number> {
  const skills = await exportSkills(ctx.connection, { status: opts.status }, ctx.request);
  const dir = resolve(ctx.cwd, opts.dir);
  const displayDir = relative(ctx.cwd, dir) || '.';

  if (skills.length === 0) {
    log.info(opts.status ? `No ${opts.status} skills to pull.` : 'No skills to pull.');
    return 0;
  }

  // Validate everything before writing anything: a refused pull leaves the
  // directory exactly as it was.
  const seen = new Set<string>();
  for (const skill of skills) {
    if (!isSafeSkillFilename(skill.filename)) {
      throw new CliError(
        `Refusing to write ${JSON.stringify(skill.filename)}: the server sent a file name that is not a plain .md file name.`,
        `Nothing was written. \`skills pull\` only writes directly inside ${displayDir}.`,
      );
    }
    const key = skill.filename.toLowerCase();
    if (seen.has(key)) {
      throw new CliError(
        `The server sent ${skill.filename} more than once.`,
        'Nothing was written.',
      );
    }
    seen.add(key);
  }

  mkdirSync(dir, { recursive: true });

  let written = 0;
  let unchanged = 0;

  for (const skill of skills) {
    const target = join(dir, skill.filename);
    if (dirname(target) !== dir) {
      throw new CliError(`Refusing to write outside ${displayDir}: ${skill.filename}`);
    }

    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
      // A symlink here would redirect the write to wherever it points.
      throw new CliError(
        `Refusing to overwrite ${join(displayDir, skill.filename)}: it is not a regular file.`,
      );
    }

    if (existing && readFileSync(target, 'utf8') === skill.content) {
      unchanged++;
      continue;
    }

    writeFileSync(target, skill.content, 'utf8');
    written++;
    log.plain(`  ${pc.green('wrote')}  ${join(displayDir, skill.filename)}`);
  }

  log.success(
    `Pulled ${skills.length} ${plural(skills.length, 'skill')} into ${displayDir} — ${written} written, ${unchanged} unchanged.`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// push / install — shared upload + report
// ---------------------------------------------------------------------------

interface LocalDocument {
  /** File name sent to the server as `path` (it derives a fallback slug from it). */
  name: string;
  content: string;
}

const isMarkdown = (name: string): boolean => /\.md$/i.test(name);

/** `*.md` directly inside `dir` — sorted, non-recursive, README.md excluded. */
function readSkillDir(dir: string, display: string): LocalDocument[] {
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    throw new CliError(`Skills directory not found: ${display}`);
  }
  if (!stats.isDirectory()) throw new CliError(`${display} is not a directory.`);

  const names = readdirSync(dir)
    .filter((name) => isMarkdown(name) && name.toLowerCase() !== 'readme.md')
    .filter((name) => statSync(join(dir, name), { throwIfNoEntry: false })?.isFile())
    .sort();

  if (names.length === 0) {
    throw new CliError(
      `No skill files (*.md) found in ${display}.`,
      'Skills are Markdown files with front matter, e.g. skills/house-style.skill.md. Run `lumibase skills pull` to fetch the ones on the site.',
    );
  }

  return names.map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
}

interface UploadOptions extends SkillImportOptions {
  /** Report "would create" instead of "created". */
  dryRun: boolean;
}

/** Sends the documents and prints one line per document, in file order. */
async function upload(
  ctx: Context,
  documents: LocalDocument[],
  options: UploadOptions,
): Promise<SkillImportResult[]> {
  // An empty file would fail validation for the *whole* request, taking the
  // valid files down with it — report it as that document's error instead.
  const sendable: SkillImportDocument[] = [];
  for (const doc of documents) {
    if (doc.content.trim()) sendable.push({ path: doc.name, content: doc.content });
  }

  const remote =
    sendable.length > 0
      ? await importSkills(ctx.connection, sendable, options, ctx.request)
      : [];

  let next = 0;
  const results = documents.map((doc): SkillImportResult => {
    if (!doc.content.trim()) {
      return { path: doc.name, action: 'error', code: 'EMPTY_FILE', message: 'The file is empty.' };
    }
    return { ...(remote[next++] as SkillImportResult), path: doc.name };
  });

  for (const result of results) log.plain(describeResult(result, options.dryRun));
  return results;
}

const LABELS: Record<SkillImportResult['action'], [done: string, planned: string]> = {
  created: ['created', 'would create'],
  updated: ['updated', 'would update'],
  unchanged: ['unchanged', 'unchanged'],
  error: ['error', 'error'],
};

const COLORS: Record<SkillImportResult['action'], (text: string) => string> = {
  created: pc.green,
  updated: pc.cyan,
  unchanged: pc.dim,
  error: pc.red,
};

function describeResult(result: SkillImportResult, dryRun: boolean): string {
  const label = LABELS[result.action][dryRun ? 1 : 0].padEnd(12);
  const head = `  ${COLORS[result.action](label)}  ${result.path ?? result.slug ?? '(unnamed)'}`;

  if (result.action === 'error') {
    const reason = [result.code, result.message].filter(Boolean).join(': ');
    return `${head} — ${reason || 'rejected by the server'}`;
  }

  const details = [
    result.slug,
    result.version === undefined ? undefined : `v${result.version}`,
    result.status ? `(${result.status})` : undefined,
  ].filter(Boolean);
  return details.length > 0 ? `${head}  ${pc.dim(`→ ${details.join(' ')}`)}` : head;
}

function tally(results: SkillImportResult[]) {
  const count = (action: SkillImportResult['action']): number =>
    results.filter((result) => result.action === action).length;
  return {
    created: count('created'),
    updated: count('updated'),
    unchanged: count('unchanged'),
    errors: count('error'),
  };
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** Prints the closing summary and maps the outcome to an exit code. */
function conclude(
  results: SkillImportResult[],
  mode: { dryRun: boolean; check: boolean },
): number {
  const { created, updated, unchanged, errors } = tally(results);
  const pending = created + updated;
  const summary = mode.dryRun
    ? `${created} to create, ${updated} to update, ${unchanged} unchanged`
    : `${created} created, ${updated} updated, ${unchanged} unchanged`;

  log.plain();

  if (errors > 0) {
    log.error(
      `${errors} of ${results.length} ${plural(results.length, 'document')} failed (${summary}).`,
    );
    return 1;
  }

  if (mode.check && pending > 0) {
    log.error(`Skills are out of sync with the site: ${summary}.`);
    log.dim('  Run `lumibase skills push` to apply them.');
    return 1;
  }

  if (mode.check) {
    log.success(`Skills are in sync with the site (${results.length} checked).`);
  } else if (mode.dryRun) {
    log.success(`Dry run — nothing was written: ${summary}.`);
  } else {
    log.success(`${summary}.`);
  }
  return 0;
}

/** New skills are drafts until someone activates them — say so, or they look "pushed but ignored". */
function draftNotice(results: SkillImportResult[], opts: { activate: boolean; dryRun: boolean }): void {
  if (opts.activate || tally(results).created === 0) return;
  log.dim(
    opts.dryRun
      ? `  New skills would arrive as drafts. Pass --activate, or review and activate them in ${STUDIO_SKILLS}.`
      : `  New skills are drafts — agents ignore them until activated. Review and activate them in ${STUDIO_SKILLS}, or re-run with --activate.`,
  );
}

async function push(
  ctx: Context,
  opts: { dir: string; activate: boolean; dryRun: boolean; check: boolean },
): Promise<number> {
  const dir = resolve(ctx.cwd, opts.dir);
  const documents = readSkillDir(dir, relative(ctx.cwd, dir) || '.');
  const dryRun = opts.dryRun || opts.check;

  const results = await upload(ctx, documents, {
    activate: opts.activate,
    dryRun,
    source: 'cli',
  });

  const code = conclude(results, { dryRun, check: opts.check });
  if (!opts.check) draftNotice(results, { activate: opts.activate, dryRun });
  return code;
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/** npm's package-name grammar. Also what keeps `..` out of the node_modules lookup. */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

/** Server-side cap on `sourceRef`. */
const MAX_SOURCE_REF = 300;

interface InstallSource {
  documents: LocalDocument[];
  source: 'cli' | 'package';
  sourceRef: string;
  label: string;
}

function findInstalledPackage(name: string, cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(candidate, 'package.json'))) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readPackageSkills(name: string, packageDir: string): InstallSource {
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new CliError(`Could not read package.json of ${name} (${packageDir}).`);
  }

  const section = manifest['lumibase'];
  const declared =
    typeof section === 'object' && section !== null
      ? (section as Record<string, unknown>)['skills']
      : undefined;
  if (declared !== undefined && (typeof declared !== 'string' || !declared.trim())) {
    throw new CliError(`${name}: "lumibase.skills" in package.json must be a directory path.`);
  }
  const skillsPath = typeof declared === 'string' ? declared : DEFAULT_SKILLS_DIR;
  const display = `${name}/${skillsPath.replace(/^\.\//, '')}`;

  // pnpm links packages, so compare real paths: the skills directory has to
  // live inside the package it was declared by.
  const root = realpathSync(packageDir);
  const target = resolve(root, skillsPath);
  if (isAbsolute(skillsPath) || !existsSync(target)) {
    throw new CliError(
      `${name} does not ship a skills directory (${display}).`,
      'A skill package keeps its *.skill.md files in skills/, or names the directory in package.json → "lumibase": { "skills": "<dir>" }.',
    );
  }
  const realTarget = realpathSync(target);
  if (realTarget !== root && !realTarget.startsWith(root + sep)) {
    throw new CliError(`${name}: "lumibase.skills" points outside the package — refusing to read it.`);
  }

  const packageName = typeof manifest['name'] === 'string' ? manifest['name'] : name;
  const version = typeof manifest['version'] === 'string' ? manifest['version'] : 'unknown';

  return {
    documents: readSkillDir(realTarget, display),
    source: 'package',
    sourceRef: `${packageName}@${version}`,
    label: `${packageName}@${version}`,
  };
}

function resolveInstallSource(source: string, cwd: string): InstallSource {
  const path = resolve(cwd, source);
  const stats = statSync(path, { throwIfNoEntry: false });

  // A path that exists always wins over a package of the same name.
  if (stats?.isDirectory()) {
    return { documents: readSkillDir(path, source), source: 'cli', sourceRef: source, label: source };
  }
  if (stats?.isFile()) {
    if (!isMarkdown(source)) {
      throw new CliError(`${source} is not a Markdown (.md) file.`);
    }
    return {
      documents: [{ name: basename(path), content: readFileSync(path, 'utf8') }],
      source: 'cli',
      sourceRef: source,
      label: source,
    };
  }

  if (!PACKAGE_NAME.test(source)) {
    throw new CliError(
      `Nothing to install at ${source}.`,
      '<source> is a directory, a single .md file, or the name of an npm package that is already installed.',
    );
  }

  const packageDir = findInstalledPackage(source, cwd);
  if (!packageDir) {
    throw new CliError(
      `Package ${source} is not installed (no node_modules/${source} found from ${cwd} upwards).`,
      `Install it first — e.g. \`npm install --save-dev ${source}\` — then re-run \`lumibase skills install ${source}\`. The CLI never downloads packages itself.`,
    );
  }

  return readPackageSkills(source, packageDir);
}

async function install(
  ctx: Context,
  opts: { source?: string; activate: boolean; dryRun: boolean },
): Promise<number> {
  if (!opts.source) {
    throw new CliError(
      'Missing <source>.',
      'Usage: lumibase skills install <dir | file.md | package-name> [--activate] [--dry-run]',
    );
  }

  const resolved = resolveInstallSource(opts.source, ctx.cwd);
  log.info(
    `Installing ${resolved.documents.length} ${plural(resolved.documents.length, 'skill')} from ${resolved.label}${opts.dryRun ? ' (dry run)' : ''}`,
  );

  const results = await upload(ctx, resolved.documents, {
    activate: opts.activate,
    dryRun: opts.dryRun,
    source: resolved.source,
    sourceRef: resolved.sourceRef.slice(0, MAX_SOURCE_REF),
  });

  const code = conclude(results, { dryRun: opts.dryRun, check: false });
  draftNotice(results, { activate: opts.activate, dryRun: opts.dryRun });
  return code;
}
