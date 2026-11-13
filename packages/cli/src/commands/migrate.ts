import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { createLumiClient, legacyRest, LumiError } from '@lumibase/sdk';
import {
  buildMigrationPlan,
  ContentfulExportError,
  formatMigrationPlan,
  parseContentfulExport,
  transformContext,
  transformEntry,
  type ExistingCollection,
  type MigrationPlan,
  type SourceAsset,
  type SourceExport,
} from '@lumibase/contracts/migrate';
import { requireConnection, resolveConfig } from '../config.js';
import { CliError } from '../errors.js';
import { boolFlag, stringFlag, type ParsedArgs } from '../utils/args.js';
import { log } from '../utils/log.js';

/**
 * `lumibase migrate <source> --file <export>` (#728).
 *
 * Dry run by default: parses the export, reads the site's schema and prints
 * the plan (collections and fields to create, conflicts, warnings). Nothing
 * is written until `--apply`, and `--apply` asks for confirmation unless
 * `--yes` is given — the schema change is a human decision.
 *
 * Apply is idempotent and resumable:
 * - new collections use a string primary key, so items keep their source ids;
 *   re-running updates them (create → 409 ITEM_ID_EXISTS → patch) instead of
 *   duplicating;
 * - uploaded asset keys are saved to a state file after each upload, so an
 *   interrupted run does not upload the same file twice. The state records its
 *   destination (CMS URL + site) and is refused for any other destination.
 */

export const SUPPORTED_SOURCES = ['contentful'] as const;
type Source = (typeof SUPPORTED_SOURCES)[number];

export interface MigrateTarget {
  /** CMS base URL, normalised (origin + path, no trailing slash). */
  url: string;
  siteId: string;
}

export interface MigrateState {
  source: Source;
  sourceId?: string;
  /** The LumiBase site the asset keys below were uploaded to. */
  target: MigrateTarget;
  /** Source asset id → LumiBase storage key (valid only on `target`). */
  assets: Record<string, string>;
}

/** Normalise a CMS URL so `https://x.dev/` and `https://X.dev` name the same target. */
export function migrateTarget(url: string, siteId: string): MigrateTarget {
  let normalised = url.trim();
  try {
    const u = new URL(normalised);
    normalised = `${u.origin}${u.pathname}`;
  } catch {
    // Not a URL: keep it as given; requireConnection reports bad URLs elsewhere.
  }
  return { url: normalised.replace(/\/+$/, ''), siteId };
}

/**
 * Default resume-state path. Keyed by source, source id AND destination, so
 * migrating one space into two sites (or two CMS instances) from the same
 * directory never shares uploaded asset keys.
 */
export function defaultStatePath(source: Source, sourceId: string | undefined, target: MigrateTarget): string {
  const site = target.siteId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(`${target.url}\n${target.siteId}`).digest('hex').slice(0, 10);
  return `.lumibase/migrate-${source}${sourceId ? `-${sourceId}` : ''}-${site}-${hash}.json`;
}

/**
 * Load the resume state, trusting cached asset keys only when the file was
 * written for this source and this destination. Anything else is an error:
 * reusing another site's storage keys would point file fields at assets that
 * do not exist there (or belong to another tenant).
 */
export function loadMigrateState(path: string, source: Source, sourceId: string | undefined, target: MigrateTarget): MigrateState {
  const fresh: MigrateState = { source, ...(sourceId ? { sourceId } : {}), target, assets: {} };
  if (!existsSync(path)) return fresh;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`State file ${path} is not valid JSON.`, 'Delete it to upload the assets again, or pass another --state path.');
  }
  const st = raw as Partial<MigrateState> | null;
  const same =
    !!st &&
    st.source === source &&
    (st.sourceId ?? undefined) === sourceId &&
    st.target?.url === target.url &&
    st.target?.siteId === target.siteId &&
    !!st.assets &&
    typeof st.assets === 'object' &&
    Object.values(st.assets).every((k) => typeof k === 'string');
  if (!same) {
    const was = st?.target ? `${st.target.url} site ${st.target.siteId}` : 'an unknown destination';
    throw new CliError(
      `State file ${path} belongs to another migration (${st?.source ?? '?'}${st?.sourceId ? ` ${st.sourceId}` : ''} → ${was}).`,
      `Its asset keys are only valid there. Use the default state path for ${target.url} site ${target.siteId}, or pass a new --state file.`,
    );
  }
  return st as MigrateState;
}

export interface MigrateCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  /** Answers the confirmation prompt (tests). Defaults to reading stdin. */
  confirm?: (question: string) => Promise<boolean>;
  /** Sleep used between 429 retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

function parseLocaleMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [from, to] = pair.split('=').map((s) => s.trim());
    if (!from || !to) throw new CliError(`Invalid --locale-map entry "${pair}".`, 'Use --locale-map en-US=en,de-DE=de');
    map[from] = to;
  }
  return map;
}

function loadExport(source: Source, file: string): SourceExport {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseContentfulExport(json);
  } catch (err) {
    if (err instanceof ContentfulExportError) throw new CliError(err.message, 'Create the file with `contentful space export --include-drafts`.');
    throw err;
  }
}

async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new CliError('Refusing to apply without confirmation in a non-interactive shell.', 'Review the dry run, then pass --yes.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function migrateCommand(args: ParsedArgs, options: MigrateCommandOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const source = args._[1] as Source | undefined;
  if (!source || !(SUPPORTED_SOURCES as readonly string[]).includes(source)) {
    throw new CliError(
      `Unknown migration source "${source ?? ''}".`,
      `Supported: ${SUPPORTED_SOURCES.join(', ')}. Example: lumibase migrate contentful --file space.json`,
    );
  }
  const file = stringFlag(args, 'file');
  if (!file) throw new CliError('Missing --file <export.json>.', 'Create it with `contentful space export --include-drafts`.');

  const config = resolveConfig(args, { cwd, env: options.env });
  requireConnection(config);
  const client = createLumiClient({
    url: config.url,
    siteId: config.siteId,
    token: config.token,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  }).with(legacyRest());
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  /** Retry a request on 429, honouring Retry-After (up to 5 attempts). */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof LumiError && err.status === 429 && attempt < 5) {
          await sleep(Math.max(1, err.retryAfter ?? 1) * 1000);
          continue;
        }
        throw err;
      }
    }
  };

  const exported = loadExport(source, resolve(cwd, file));

  // Current schema of the collections the plan may touch.
  const listed = (await call(() => client.schema.listCollections())).data as Array<{ name: string }>;
  const existingNames = new Set(listed.map((c) => c.name));
  const draftPlan = buildMigrationPlan(exported, [], {
    collectionPrefix: stringFlag(args, 'prefix'),
    localeMap: parseLocaleMap(stringFlag(args, 'locale-map')),
  });
  const existing: ExistingCollection[] = [];
  for (const c of draftPlan.collections) {
    if (!existingNames.has(c.name)) continue;
    const fields = (await call(() => client.schema.listFields(c.name))).data as Array<{ name: string; type: string; interface?: string }>;
    existing.push({ name: c.name, fields: fields.map((f) => ({ name: f.name, type: f.type, interface: f.interface })) });
  }
  const plan = buildMigrationPlan(exported, existing, {
    collectionPrefix: stringFlag(args, 'prefix'),
    localeMap: parseLocaleMap(stringFlag(args, 'locale-map')),
  });

  if (boolFlag(args, 'json')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } else {
    log.plain(formatMigrationPlan(plan));
  }

  if (!boolFlag(args, 'apply')) {
    log.plain('');
    log.info('Dry run: nothing was written. Re-run with --apply to create the schema and import the content.');
    return 0;
  }

  const schemaWrites = plan.collections.reduce(
    (n, c) => n + (c.action === 'create' ? 1 : 0) + c.fields.filter((f) => f.action === 'create').length + c.relations.length,
    0,
  );
  const question = `Apply ${schemaWrites} schema change(s) and import ${plan.counts.entries} entries and ${plan.counts.assets} assets into site ${config.siteId}?`;
  const ok = boolFlag(args, 'yes') || (await (options.confirm ?? defaultConfirm)(question));
  if (!ok) {
    log.warn('Cancelled. Nothing was written.');
    return 1;
  }

  // Check the resume state before writing anything: a state file from another
  // destination is refused here, not after the schema changed.
  const target = migrateTarget(config.url, config.siteId);
  const statePath = resolve(cwd, stringFlag(args, 'state') ?? defaultStatePath(source, exported.sourceId, target));
  const state = loadMigrateState(statePath, source, exported.sourceId, target);

  await applySchema(plan, client, call);

  const saveState = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  };

  if (boolFlag(args, 'skip-assets')) {
    log.warn('Skipping assets (--skip-assets): file fields stay empty unless a previous run uploaded them.');
  } else {
    await importAssets(exported, plan, state, saveState, client, call, options.fetcher ?? globalThis.fetch);
  }

  const result = await importEntries(exported, plan, new Map(Object.entries(state.assets)), client, call);
  log.plain('');
  log.success(
    `Imported ${result.created} new and ${result.updated} updated items; ${Object.keys(state.assets).length} assets. State: ${relative(cwd, statePath) || statePath}`,
  );
  for (const w of result.warnings.slice(0, 50)) log.warn(w);
  if (result.warnings.length > 50) log.warn(`… and ${result.warnings.length - 50} more warnings.`);
  if (result.failed.length) {
    for (const f of result.failed.slice(0, 50)) log.error(f);
    log.error(`${result.failed.length} item(s) failed. Fix them and re-run: the migration is idempotent.`);
    return 1;
  }
  return 0;
}

type Client = ReturnType<typeof createLumiClient> & ReturnType<ReturnType<typeof legacyRest>>;
type Call = <T>(fn: () => Promise<T>) => Promise<T>;

/** Create new collections, add missing fields, then relations (after every collection exists). */
export async function applySchema(plan: MigrationPlan, client: Client, call: Call): Promise<void> {
  for (const c of plan.collections) {
    if (c.action === 'create') {
      await call(() =>
        client.schema.createCollection({
          name: c.name,
          label: c.label,
          primaryKeyField: 'id',
          primaryKeyType: 'string',
          ...(c.displayTemplate ? { displayTemplate: c.displayTemplate } : {}),
          ...(c.note ? { note: c.note } : {}),
        } as never),
      );
      log.success(`Created collection ${c.name}`);
    }
    for (const f of c.fields.filter((x) => x.action === 'create')) {
      await call(() =>
        client.schema.upsertField(c.name, f.name, {
          name: f.name,
          type: f.type,
          interface: f.interface,
          label: f.label,
          required: f.required,
          ...(f.options ? { options: f.options } : {}),
          ...(f.note ? { note: f.note } : {}),
        } as never),
      );
    }
  }
  for (const c of plan.collections) {
    for (const r of c.relations) {
      await call(() => client.schema.createRelation(r as never));
    }
  }
}

function pickFile(asset: SourceAsset, plan: MigrationPlan) {
  return asset.file[plan.defaultLocale.source] ?? Object.values(asset.file)[0];
}

/** Download each asset from the source and upload it to LumiBase storage. */
export async function importAssets(
  exported: SourceExport,
  plan: MigrationPlan,
  state: MigrateState,
  saveState: () => void,
  client: Client,
  call: Call,
  fetcher: typeof fetch,
): Promise<void> {
  let done = 0;
  for (const asset of exported.assets) {
    if (state.assets[asset.id]) continue;
    const file = pickFile(asset, plan);
    if (!file) {
      log.warn(`Asset ${asset.id} has no file; skipped.`);
      continue;
    }
    const download = await fetcher(file.url);
    if (!download.ok) {
      log.warn(`Could not download asset ${asset.id} (${download.status}); skipped.`);
      continue;
    }
    const bytes = new Uint8Array(await download.arrayBuffer());
    const presigned = (await call(() => client.files.getPresignedUrl(file.fileName))).data;
    const put = await fetcher(presigned.url, {
      method: 'PUT',
      headers: { 'content-type': file.contentType },
      body: bytes,
    });
    if (!put.ok) throw new CliError(`Upload of asset ${asset.id} failed with HTTP ${put.status}.`);
    await call(() =>
      client.files.create({
        filenameDisk: presigned.key,
        filenameDownload: file.fileName,
        mime: file.contentType,
        filesize: file.size ?? bytes.byteLength,
        ...(file.width ? { width: file.width } : {}),
        ...(file.height ? { height: file.height } : {}),
      }),
    );
    state.assets[asset.id] = presigned.key;
    saveState();
    done++;
  }
  if (done) log.success(`Uploaded ${done} asset(s).`);
}

/**
 * Create each item with its source id; when that id already exists
 * (`409` with code `ITEM_ID_EXISTS`) update it instead. Any other 409 (an
 * editorial gate refusing `published`, a missing or unknown code, a non-JSON
 * body) is a real failure for that entry.
 */
function isItemIdExists(err: unknown): boolean {
  if (!(err instanceof LumiError) || err.status !== 409) return false;
  // Only the explicit code proves the id exists. A 409 with no code, a
  // non-JSON body or another code is a real conflict, never a reason to patch.
  const body = err.body as { errors?: Array<{ code?: unknown }> } | null;
  return typeof body === 'object' && body !== null && body.errors?.[0]?.code === 'ITEM_ID_EXISTS';
}

export async function importEntries(
  exported: SourceExport,
  plan: MigrationPlan,
  assetKeys: Map<string, string>,
  client: Client,
  call: Call,
): Promise<{ created: number; updated: number; failed: string[]; warnings: string[] }> {
  const ctx = transformContext(exported, plan, assetKeys);
  let created = 0;
  let updated = 0;
  const failed: string[] = [];
  const warnings: string[] = [];
  for (const entry of exported.entries) {
    const out = transformEntry(entry, ctx);
    if (!out) continue;
    warnings.push(...out.warnings);
    const items = client.items(out.collection as never);
    const data = { id: out.item.id, ...out.item.data };
    try {
      try {
        await call(() => items.create({ data, status: out.item.status } as never));
        created++;
      } catch (err) {
        if (!isItemIdExists(err)) throw err;
        await call(() => items.patch(out.item.id, { data: out.item.data, status: out.item.status } as never));
        updated++;
      }
    } catch (err) {
      failed.push(`${out.collection}/${out.item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((created + updated) % 100 === 0 && created + updated > 0) log.dim(`  … ${created + updated} items`);
  }
  return { created, updated, failed, warnings };
}
