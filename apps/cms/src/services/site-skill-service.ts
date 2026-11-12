import { activity, siteSkills, siteSkillVersions } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalize } from './constitution-service';
import { satisfiesCapability } from './effective-capability-service';
import { COPILOT_SYSTEM_PROMPT, type LLMMessage } from './llm-provider';
import { runSiteTransaction, type SiteTransaction } from './rls-transaction';

/**
 * Site Skills (#712) — editorial playbooks a site writes down for agents.
 *
 * A site skill is Markdown with a small front matter block. Active skills
 * whose scope matches a run are appended to that run's instructions: the
 * Copilot chat, the harness generation tools, and MCP `prompts/*`.
 *
 * What a site skill is NOT: a tool, a permission, or a way around governance.
 * It is text in the instruction slot. Capability checks, autonomy, HITL and the
 * constitution publish gate all run exactly as they do without it, so the worst
 * a badly written skill can do is make the model write badly.
 *
 * Trust: every skill write needs a control-plane admin on a control-plane
 * route — the same trust level as a constitution `llm_judge` prompt. That is
 * why a skill may sit in the system slot, and why content, retrieved documents
 * and user chat can never be saved as one. There is no delegated (non-admin)
 * author yet; `riskClass` is a stored review-priority label, not a permission
 * tier. Reads are admin-only too: REST through the control-plane guard, MCP
 * `prompts/*` by the same rule in `routes/mcp.ts`.
 *
 * Every content change appends an immutable version row (author, source,
 * hash). A run that used a skill records `slug@version` + hash, so "which
 * house rules produced this text" stays answerable after the skill changes.
 */

export const SITE_SKILL_SURFACES = ['copilot', 'generation', 'mcp'] as const;
export type SiteSkillSurface = (typeof SITE_SKILL_SURFACES)[number];

export const SITE_SKILL_RISK_CLASSES = ['low', 'medium', 'high'] as const;
export type SiteSkillRiskClass = (typeof SITE_SKILL_RISK_CLASSES)[number];

export const SITE_SKILL_STATUSES = ['draft', 'active', 'archived'] as const;
export type SiteSkillStatus = (typeof SITE_SKILL_STATUSES)[number];

export const SITE_SKILL_SOURCES = ['studio', 'api', 'cli', 'package'] as const;
export type SiteSkillSource = (typeof SITE_SKILL_SOURCES)[number];

/** At most this many skills are injected into one run. */
export const MAX_INJECTED_SKILLS = 6;
/** Total body characters injected into one run (≈3k tokens). */
export const MAX_INJECTED_CHARS = 12_000;
/**
 * Hard ceiling on one playbook body. Equal to the per-run budget on purpose:
 * a larger body could be saved and activated but never fit into any run, so
 * it would look live while doing nothing.
 */
export const MAX_SKILL_BODY_CHARS = MAX_INJECTED_CHARS;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Path segments of the skills API that a slug must not shadow. */
const RESERVED_SLUGS = new Set(['import', 'export', 'match']);
const stringList = (maxItems: number, maxLength: number) =>
  z.array(z.string().trim().min(1).max(maxLength)).max(maxItems).default([]);

/**
 * The body as stored: leading blank lines and trailing whitespace dropped.
 * `parseSkillDocument` and the JSON API share this, so a body that differs
 * only in trailing whitespace hashes the same on both paths — `pull` → `push`
 * cannot mint a whitespace-only version.
 */
export function normalizeSkillBody(body: string): string {
  return body.replace(/^\n+/, '').replace(/\s+$/, '');
}

export const siteSkillInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(SLUG, 'slug must be lowercase letters, digits and single hyphens')
    .refine((slug) => !RESERVED_SLUGS.has(slug), 'slug is reserved'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  riskClass: z.enum(SITE_SKILL_RISK_CLASSES).default('low'),
  priority: z.number().int().min(-100).max(100).default(0),
  triggers: stringList(32, 80),
  surfaces: z.array(z.enum(SITE_SKILL_SURFACES)).max(SITE_SKILL_SURFACES.length).default([]),
  tools: stringList(64, 120),
  collections: stringList(64, 120),
  requiredCapabilities: stringList(16, 80),
  body: z.string().overwrite(normalizeSkillBody).min(1).max(MAX_SKILL_BODY_CHARS),
});
export type SiteSkillInput = z.infer<typeof siteSkillInputSchema>;

/** The fields that make up a version's content (and therefore its hash). */
type SkillContent = Omit<SiteSkillInput, 'slug'>;

const CONTENT_KEYS = [
  'name',
  'description',
  'riskClass',
  'priority',
  'triggers',
  'surfaces',
  'tools',
  'collections',
  'requiredCapabilities',
  'body',
] as const satisfies ReadonlyArray<keyof SkillContent>;

export class SiteSkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    /** Extra fields for the error object, e.g. `currentVersion`. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SiteSkillError';
  }
}

// ---------------------------------------------------------------------------
// Document format (Markdown + front matter)
// ---------------------------------------------------------------------------

const LIST_KEYS = new Set(['triggers', 'surfaces', 'tools', 'collections', 'requiredCapabilities']);
const KEY_ALIASES: Record<string, string> = {
  risk_class: 'riskClass',
  'risk-class': 'riskClass',
  required_capabilities: 'requiredCapabilities',
  'required-capabilities': 'requiredCapabilities',
  capabilities: 'requiredCapabilities',
};
const KNOWN_KEYS = new Set([
  'slug',
  'name',
  'description',
  'riskClass',
  'priority',
  ...LIST_KEYS,
]);

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      try {
        return String(JSON.parse(value));
      } catch {
        return value.slice(1, -1);
      }
    }
    if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Splits `a, "b, c", d` on top-level commas. Inside a double-quoted item a
 * backslash escapes the next character, so `"say \"hi\""` stays one item and
 * {@link unquote} (JSON.parse) turns it back into `say "hi"` — the form
 * `serializeSkillDocument` writes.
 */
function splitInlineList(inner: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1]!;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current);
  return out.map(unquote).filter((entry) => entry !== '');
}

/**
 * Parses a skill document. The front matter is a deliberately small subset of
 * YAML — `key: scalar`, `key: [a, b]`, and `key:` followed by `- item` lines —
 * so the same parser runs on Workers with no YAML dependency. Unknown keys are
 * an error rather than ignored: a typo in `triggers` must not silently turn a
 * narrow skill into one that applies to everything.
 */
export function parseSkillDocument(
  content: string,
  fallback: { slug?: string } = {},
): SiteSkillInput {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const raw: Record<string, unknown> = {};
  let body = text;

  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 3);
    if (end === -1) {
      throw new SiteSkillError('INVALID_DOCUMENT', 'Front matter starts with "---" but is never closed.');
    }
    const afterFence = text.indexOf('\n', end + 1);
    body = afterFence === -1 ? '' : text.slice(afterFence + 1);
    const lines = text.slice(4, end).split('\n');
    let listKey: string | null = null;
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
      if (item) {
        if (!listKey) {
          throw new SiteSkillError('INVALID_DOCUMENT', `Front matter line ${index + 2}: list item without a key.`);
        }
        const value = unquote(item[1] ?? '');
        if (value !== '') (raw[listKey] as string[]).push(value);
        continue;
      }
      const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!pair) {
        throw new SiteSkillError('INVALID_DOCUMENT', `Front matter line ${index + 2}: expected "key: value".`);
      }
      const key = KEY_ALIASES[pair[1]!] ?? pair[1]!;
      if (!KNOWN_KEYS.has(key)) {
        throw new SiteSkillError('INVALID_DOCUMENT', `Front matter: unknown key "${pair[1]}".`);
      }
      const value = (pair[2] ?? '').trim();
      listKey = null;
      if (LIST_KEYS.has(key)) {
        if (value === '') {
          raw[key] = [];
          listKey = key;
        } else if (value.startsWith('[') && value.endsWith(']')) {
          raw[key] = splitInlineList(value.slice(1, -1));
        } else {
          raw[key] = [unquote(value)];
        }
      } else if (key === 'priority') {
        const parsed = Number(unquote(value));
        if (!Number.isInteger(parsed)) {
          throw new SiteSkillError('INVALID_DOCUMENT', 'Front matter: priority must be an integer.');
        }
        raw[key] = parsed;
      } else {
        raw[key] = unquote(value);
      }
    }
  }

  const trimmedBody = normalizeSkillBody(body);
  const heading = /^#\s+(.+)$/m.exec(trimmedBody)?.[1]?.trim();
  const candidate = {
    ...raw,
    slug: raw['slug'] ?? fallback.slug,
    name: raw['name'] ?? heading ?? raw['slug'] ?? fallback.slug,
    body: trimmedBody,
  };
  const parsed = siteSkillInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    throw new SiteSkillError('INVALID_DOCUMENT', `${where}${issue.message}`);
  }
  return parsed.data;
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9 _./:@-]*$/.test(value) && !/:\s/.test(value) && !/\s$/.test(value)
    ? value
    : JSON.stringify(value);
}

/** Inverse of {@link parseSkillDocument}; `parse(serialize(x))` equals `x`. */
export function serializeSkillDocument(skill: SiteSkillInput): string {
  const lines = ['---', `slug: ${skill.slug}`, `name: ${yamlScalar(skill.name)}`];
  if (skill.description) lines.push(`description: ${yamlScalar(skill.description)}`);
  lines.push(`riskClass: ${skill.riskClass}`);
  if (skill.priority !== 0) lines.push(`priority: ${skill.priority}`);
  for (const key of ['surfaces', 'tools', 'collections', 'triggers', 'requiredCapabilities'] as const) {
    if (skill[key].length > 0) lines.push(`${key}: [${skill[key].map(yamlScalar).join(', ')}]`);
  }
  lines.push('---', '', skill.body.replace(/\s+$/, ''), '');
  return lines.join('\n');
}

/** Derives a slug from a file path: `skills/House Style.skill.md` → `house-style`. */
export function slugFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const base = path.split(/[\\/]/).pop() ?? '';
  const slug = base
    .replace(/\.(skill\.)?(md|markdown)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || undefined;
}

// ---------------------------------------------------------------------------
// Hashing, matching, prompt composition (pure)
// ---------------------------------------------------------------------------

function contentOf(input: SkillContent): SkillContent {
  const out = {} as Record<string, unknown>;
  for (const key of CONTENT_KEYS) out[key] = input[key];
  return out as SkillContent;
}

export async function computeSkillHash(input: SkillContent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(contentOf(input)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

export interface SiteSkillContext {
  surface: SiteSkillSurface;
  /** Harness tool the run is executing, when there is one. */
  tool?: string;
  collection?: string;
  /** The request text triggers are matched against. */
  text?: string;
  /**
   * Caller capabilities. `undefined` means "not known on this path": skills
   * that declare `requiredCapabilities` are then withheld (fail closed).
   */
  capabilities?: readonly string[];
  /** Listing mode (MCP `prompts/list`): the client picks, so triggers do not filter. */
  ignoreTriggers?: boolean;
}

/** The subset of a skill row the matcher needs. */
export interface MatchableSkill {
  slug: string;
  priority: number;
  triggers: string[];
  surfaces: string[];
  tools: string[];
  collections: string[];
  requiredCapabilities: string[];
}

function mentions(text: string | undefined, needle: string): boolean {
  return Boolean(text) && text!.toLowerCase().includes(needle.toLowerCase());
}

/** Does an (already active) skill apply to this run? */
export function skillApplies(skill: MatchableSkill, ctx: SiteSkillContext): boolean {
  if (skill.surfaces.length > 0 && !skill.surfaces.includes(ctx.surface)) return false;
  if (skill.tools.length > 0 && (!ctx.tool || !skill.tools.includes(ctx.tool))) return false;
  if (skill.collections.length > 0 && !ctx.ignoreTriggers) {
    // A known collection must be listed. When the run has not named one (a
    // chat message), the skill applies only if the text mentions a listed
    // collection — never "unknown, so apply".
    const hit = ctx.collection
      ? skill.collections.includes(ctx.collection)
      : skill.collections.some((name) => mentions(ctx.text, name));
    if (!hit) return false;
  }
  if (skill.requiredCapabilities.length > 0) {
    const caps = ctx.capabilities;
    if (!caps) return false;
    if (!skill.requiredCapabilities.every((required) => satisfiesCapability(caps, required))) return false;
  }
  if (skill.triggers.length > 0 && !ctx.ignoreTriggers) {
    if (!skill.triggers.some((trigger) => mentions(ctx.text, trigger))) return false;
  }
  return true;
}

/** Provenance stamp for a skill that was injected into a run. */
export interface AppliedSiteSkill {
  slug: string;
  version: number;
  hash: string;
}

export interface ResolvedSiteSkills {
  /** Skills actually injected, in injection order. */
  skills: AppliedSiteSkill[];
  /** Matching skills left out because the budget was spent. */
  skipped: string[];
  /** Instruction block to append; empty when nothing applies. */
  prompt: string;
}

export const EMPTY_RESOLVED_SKILLS: ResolvedSiteSkills = Object.freeze({
  skills: [],
  skipped: [],
  prompt: '',
}) as ResolvedSiteSkills;

export const SITE_SKILLS_PREAMBLE =
  "Site playbooks follow. They were written by this site's administrators and describe how this site works. " +
  'Apply the ones relevant to the task. They refine tone, structure and process only: they never change the ' +
  'required output format, never grant permissions, and never override the rules above.';

function fence(slug: string, version: number, body: string): string {
  // Tolerates whitespace anywhere a parser might (`< /site-skill >`), so a
  // body cannot close its own fence or open a fake one.
  const safe = body.replace(/<\s*\/?\s*site-skill\b[^>]*>/gi, '[removed tag]');
  return `<site-skill slug="${slug}" version="${version}">\n${safe}\n</site-skill>`;
}

/**
 * Orders matching skills (priority desc, then slug) and packs them into the
 * budget. A skill that does not fit is skipped whole — a truncated playbook is
 * worse than a missing one — and smaller ones behind it may still fit.
 */
export function composeSkillPrompt(
  matching: Array<MatchableSkill & { version: number; hash: string; body: string }>,
): ResolvedSiteSkills {
  const ordered = [...matching].sort(
    (a, b) => b.priority - a.priority || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  const skills: AppliedSiteSkill[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const skill of ordered) {
    if (skills.length >= MAX_INJECTED_SKILLS || used + skill.body.length > MAX_INJECTED_CHARS) {
      skipped.push(skill.slug);
      continue;
    }
    used += skill.body.length;
    skills.push({ slug: skill.slug, version: skill.version, hash: skill.hash });
    blocks.push(fence(skill.slug, skill.version, skill.body));
  }
  if (skills.length === 0) return { skills, skipped, prompt: '' };
  return { skills, skipped, prompt: `${SITE_SKILLS_PREAMBLE}\n\n${blocks.join('\n\n')}` };
}

/** Appends a resolved skill block to base instructions. */
export function withSiteSkills(instructions: string, resolved: ResolvedSiteSkills): string {
  return resolved.prompt ? `${instructions}\n\n${resolved.prompt}` : instructions;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SiteSkillActor {
  userId?: string | null;
  /** Label for a non-user principal, e.g. `api_key:<id>`. */
  label?: string | null;
}

export interface SiteSkillWriteMeta {
  /**
   * Where the client says the change came from. A client-declared label for
   * the version trail, not proof: the server-recorded author (`authorId` /
   * `authorLabel`) is the authoritative "who".
   */
  source?: SiteSkillSource;
  /** Client-declared reference (path, package@version); a label like `source`. */
  sourceRef?: string | null;
  changeNote?: string | null;
}

export interface SiteSkillServiceDeps {
  db: Database;
  siteId: string;
  actor?: SiteSkillActor;
}

export interface ImportDocument {
  path?: string;
  content: string;
}

export interface ImportOptions extends SiteSkillWriteMeta {
  activate?: boolean;
  dryRun?: boolean;
  /**
   * Allow a content change to a skill that is already `active`. Off by
   * default: such a change alters agent behaviour the moment it lands, so an
   * import (e.g. `lumibase skills install`) must not do it without the caller
   * saying so. `lumibase skills push` — the documented deploy path — opts in.
   */
  updateActive?: boolean;
}

export interface ImportResult {
  path?: string;
  slug?: string;
  action: 'created' | 'updated' | 'unchanged' | 'error';
  version?: number;
  status?: string;
  code?: string;
  message?: string;
}

type SkillRow = typeof siteSkills.$inferSelect;

function rowContent(row: SkillRow): SkillContent {
  return {
    name: row.name,
    description: row.description,
    riskClass: row.riskClass as SiteSkillRiskClass,
    priority: row.priority,
    triggers: row.triggers,
    surfaces: row.surfaces as SiteSkillSurface[],
    tools: row.tools,
    collections: row.collections,
    requiredCapabilities: row.requiredCapabilities,
    body: row.body,
  };
}

function versionMismatch(current: SkillRow, expected: number): SiteSkillError {
  return new SiteSkillError(
    'VERSION_MISMATCH',
    `The skill is at version ${current.version}, not ${expected}; reload it and retry.`,
    409,
    { currentVersion: current.version },
  );
}

export class SiteSkillService {
  constructor(private readonly deps: SiteSkillServiceDeps) {}

  private get actor(): SiteSkillActor {
    return this.deps.actor ?? {};
  }

  async list(filter: { status?: string } = {}): Promise<SkillRow[]> {
    const where = filter.status
      ? and(eq(siteSkills.siteId, this.deps.siteId), eq(siteSkills.status, filter.status))
      : eq(siteSkills.siteId, this.deps.siteId);
    return this.deps.db.select().from(siteSkills).where(where).orderBy(desc(siteSkills.priority), asc(siteSkills.slug));
  }

  /** Looks a skill up by id, falling back to slug. */
  async find(idOrSlug: string): Promise<SkillRow | undefined> {
    const [byId] = await this.deps.db
      .select()
      .from(siteSkills)
      .where(and(eq(siteSkills.siteId, this.deps.siteId), eq(siteSkills.id, idOrSlug)))
      .limit(1);
    if (byId) return byId;
    const [bySlug] = await this.deps.db
      .select()
      .from(siteSkills)
      .where(and(eq(siteSkills.siteId, this.deps.siteId), eq(siteSkills.slug, idOrSlug)))
      .limit(1);
    return bySlug;
  }

  async get(idOrSlug: string): Promise<SkillRow> {
    const row = await this.find(idOrSlug);
    if (!row) throw new SiteSkillError('NOT_FOUND', 'Skill not found.', 404);
    return row;
  }

  /**
   * Runs one write — skill row, version row and audit row — as a single
   * transaction, so a failure in any statement leaves none of them behind.
   * A unique violation that escapes is a lost race and becomes a 409.
   */
  private async write<T>(fn: (tx: SiteTransaction) => Promise<T>, onUnique: () => SiteSkillError): Promise<T> {
    try {
      return await runSiteTransaction(this.deps.db, this.deps.siteId, fn);
    } catch (err) {
      if (isUniqueViolation(err)) throw onUnique();
      throw err;
    }
  }

  /** Re-reads the skill inside the transaction and holds its row lock until commit. */
  private async lock(tx: SiteTransaction, id: string): Promise<SkillRow> {
    const [row] = await tx
      .select()
      .from(siteSkills)
      .where(and(eq(siteSkills.siteId, this.deps.siteId), eq(siteSkills.id, id)))
      .limit(1)
      .for('update');
    if (!row) throw new SiteSkillError('NOT_FOUND', 'Skill not found.', 404);
    return row;
  }

  private async appendVersion(
    tx: SiteTransaction,
    skillId: string,
    version: number,
    hash: string,
    content: SkillContent,
    meta: SiteSkillWriteMeta,
  ): Promise<void> {
    await tx.insert(siteSkillVersions).values({
      siteId: this.deps.siteId,
      skillId,
      version,
      hash,
      snapshot: contentOf(content) as unknown as Record<string, unknown>,
      source: meta.source ?? 'api',
      sourceRef: meta.sourceRef ?? null,
      changeNote: meta.changeNote ?? null,
      authorId: this.actor.userId ?? null,
      authorLabel: this.actor.userId ? null : this.actor.label ?? null,
    });
  }

  private async audit(tx: SiteTransaction, action: string, payload: Record<string, unknown>): Promise<void> {
    await tx.insert(activity).values({
      siteId: this.deps.siteId,
      action,
      userId: this.actor.userId ?? null,
      collection: 'lumibase_site_skills',
      itemId: typeof payload['skillId'] === 'string' ? payload['skillId'] : null,
      payload: { ...payload, ...(this.actor.userId ? {} : { actor: this.actor.label ?? null }) },
    });
  }

  async create(input: SiteSkillInput, meta: SiteSkillWriteMeta = {}): Promise<SkillRow> {
    const hash = await computeSkillHash(input);
    return this.write(
      async (tx) => {
        const [row] = await tx
          .insert(siteSkills)
          .values({
            siteId: this.deps.siteId,
            slug: input.slug,
            ...contentOf(input),
            status: 'draft',
            version: 1,
            hash,
            source: meta.source ?? 'api',
            sourceRef: meta.sourceRef ?? null,
            createdBy: this.actor.userId ?? null,
            updatedBy: this.actor.userId ?? null,
          })
          .returning();
        await this.appendVersion(tx, row!.id, 1, hash, input, meta);
        await this.audit(tx, 'site_skill.created', { skillId: row!.id, slug: row!.slug, version: 1, hash });
        return row!;
      },
      () => new SiteSkillError('CONFLICT', `A skill with slug "${input.slug}" already exists.`, 409),
    );
  }

  /**
   * Applies a partial change. A change that alters the content creates the
   * next version; a change that does not (same hash) writes nothing. The slug
   * is the skill's identity and cannot be changed. With `expectedVersion`,
   * the change applies only if the skill is still at that version.
   */
  async update(
    idOrSlug: string,
    patch: Partial<SiteSkillInput>,
    meta: SiteSkillWriteMeta & { expectedVersion?: number } = {},
  ): Promise<{ skill: SkillRow; changed: boolean }> {
    const found = await this.get(idOrSlug);
    if (patch.slug !== undefined && patch.slug !== found.slug) {
      throw new SiteSkillError('VALIDATION', 'slug cannot be changed; create a new skill instead.');
    }
    return this.write(
      async (tx) => {
        const current = await this.lock(tx, found.id);
        if (meta.expectedVersion !== undefined && meta.expectedVersion !== current.version) {
          throw versionMismatch(current, meta.expectedVersion);
        }
        const next: SkillContent = { ...rowContent(current) };
        for (const key of CONTENT_KEYS) {
          if (patch[key] !== undefined) (next as Record<string, unknown>)[key] = patch[key];
        }
        const hash = await computeSkillHash(next);
        if (hash === current.hash) return { skill: current, changed: false };

        const version = current.version + 1;
        await this.appendVersion(tx, current.id, version, hash, next, meta);
        const [row] = await tx
          .update(siteSkills)
          .set({
            ...contentOf(next),
            version,
            hash,
            source: meta.source ?? current.source,
            sourceRef: meta.sourceRef === undefined ? current.sourceRef : meta.sourceRef,
            updatedBy: this.actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(siteSkills.id, current.id), eq(siteSkills.siteId, this.deps.siteId)))
          .returning();
        await this.audit(tx, 'site_skill.updated', {
          skillId: current.id,
          slug: current.slug,
          fromVersion: current.version,
          toVersion: version,
          fromHash: current.hash,
          toHash: hash,
          // An edit to an active skill changes agent behaviour immediately.
          live: current.status === 'active',
        });
        return { skill: row!, changed: true };
      },
      () => new SiteSkillError('CONFLICT', 'The skill was changed by someone else; reload and retry.', 409),
    );
  }

  /**
   * Activates, archives or returns a skill to draft. Audited. With
   * `expectedVersion`, applies only if the skill is still at that version —
   * so "activate" activates the content the caller reviewed, not an edit
   * that landed in between.
   */
  async setStatus(
    idOrSlug: string,
    status: SiteSkillStatus,
    options: { expectedVersion?: number } = {},
  ): Promise<SkillRow> {
    const found = await this.get(idOrSlug);
    return this.write(
      async (tx) => {
        const current = await this.lock(tx, found.id);
        if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
          throw versionMismatch(current, options.expectedVersion);
        }
        if (current.status === status) return current;
        const [row] = await tx
          .update(siteSkills)
          .set({
            status,
            ...(status === 'active' ? { activatedAt: new Date() } : {}),
            updatedBy: this.actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(and(eq(siteSkills.id, current.id), eq(siteSkills.siteId, this.deps.siteId)))
          .returning();
        await this.audit(
          tx,
          `site_skill.${status === 'active' ? 'activated' : status === 'archived' ? 'archived' : 'drafted'}`,
          {
            skillId: current.id,
            slug: current.slug,
            version: current.version,
            hash: current.hash,
            fromStatus: current.status,
            toStatus: status,
          },
        );
        return row!;
      },
      () => new SiteSkillError('CONFLICT', 'The skill was changed by someone else; reload and retry.', 409),
    );
  }

  async listVersions(idOrSlug: string) {
    const skill = await this.get(idOrSlug);
    return this.deps.db
      .select()
      .from(siteSkillVersions)
      .where(and(eq(siteSkillVersions.siteId, this.deps.siteId), eq(siteSkillVersions.skillId, skill.id)))
      .orderBy(desc(siteSkillVersions.version));
  }

  /** Restores an old version by writing its content as a NEW version. */
  async restoreVersion(idOrSlug: string, version: number): Promise<{ skill: SkillRow; changed: boolean }> {
    const skill = await this.get(idOrSlug);
    const [old] = await this.deps.db
      .select()
      .from(siteSkillVersions)
      .where(
        and(
          eq(siteSkillVersions.siteId, this.deps.siteId),
          eq(siteSkillVersions.skillId, skill.id),
          eq(siteSkillVersions.version, version),
        ),
      )
      .limit(1);
    if (!old) throw new SiteSkillError('NOT_FOUND', `Version ${version} not found.`, 404);
    const parsed = siteSkillInputSchema.omit({ slug: true }).safeParse(old.snapshot);
    if (!parsed.success) {
      throw new SiteSkillError('CORRUPT_VERSION', `Version ${version} cannot be restored: its snapshot is invalid.`, 422);
    }
    return this.update(skill.id, parsed.data, {
      source: skill.source as SiteSkillSource,
      changeNote: `Restored from version ${version}`,
    });
  }

  /**
   * Deletes a skill that was never live. Deleting cascades the version trail,
   * and a run that used the skill points at `slug@version` in that trail — so
   * a skill that has ever been activated is refused (409) and must be
   * archived instead. Drafts that were never active carry no such provenance.
   */
  async remove(idOrSlug: string): Promise<{ id: string; slug: string }> {
    const found = await this.get(idOrSlug);
    return this.write(
      async (tx) => {
        const current = await this.lock(tx, found.id);
        if (current.activatedAt) {
          throw new SiteSkillError(
            'SKILL_HAS_BEEN_ACTIVE',
            `Skill "${current.slug}" has been active, so runs may reference its versions; archive it instead of deleting it.`,
            409,
          );
        }
        await tx
          .delete(siteSkills)
          .where(and(eq(siteSkills.id, current.id), eq(siteSkills.siteId, this.deps.siteId)));
        await this.audit(tx, 'site_skill.deleted', {
          skillId: current.id,
          slug: current.slug,
          version: current.version,
          hash: current.hash,
          wasStatus: current.status,
        });
        return { id: current.id, slug: current.slug };
      },
      () => new SiteSkillError('CONFLICT', 'The skill was changed by someone else; reload and retry.', 409),
    );
  }

  /**
   * Upserts skill documents by slug (the `lumibase skills push/install` path).
   * New skills land as `draft` unless `activate` is set; existing skills keep
   * their status. A content change to an `active` skill is refused for that
   * document unless `updateActive` is set. Each document is reported on its
   * own — one bad file does not abort the rest — and `dryRun` reports the
   * same plan without writing.
   */
  async importDocuments(documents: ImportDocument[], options: ImportOptions = {}): Promise<ImportResult[]> {
    const results: ImportResult[] = [];
    const seen = new Set<string>();
    const { activate, dryRun, updateActive, ...meta } = options;
    for (const doc of documents) {
      const base: ImportResult = { ...(doc.path ? { path: doc.path } : {}), action: 'error' };
      try {
        const input = parseSkillDocument(doc.content, { slug: slugFromPath(doc.path) });
        base.slug = input.slug;
        if (seen.has(input.slug)) {
          throw new SiteSkillError('DUPLICATE_SLUG', `Slug "${input.slug}" appears more than once in this import.`);
        }
        seen.add(input.slug);
        const existing = await this.find(input.slug);
        if (!existing) {
          if (dryRun) {
            results.push({ ...base, action: 'created', version: 1, status: activate ? 'active' : 'draft' });
            continue;
          }
          let row = await this.create(input, meta);
          if (activate) row = await this.setStatus(row.id, 'active', { expectedVersion: row.version });
          results.push({ ...base, action: 'created', version: row.version, status: row.status });
          continue;
        }
        const hash = await computeSkillHash(input);
        const contentChanged = hash !== existing.hash;
        const wantsActivation = Boolean(activate) && existing.status !== 'active';
        if (!contentChanged && !wantsActivation) {
          results.push({ ...base, action: 'unchanged', version: existing.version, status: existing.status });
          continue;
        }
        if (contentChanged && existing.status === 'active' && !updateActive) {
          throw new SiteSkillError(
            'ACTIVE_SKILL_CHANGE',
            `Skill "${existing.slug}" is active; this import would change live agent behaviour. ` +
              'Review the change in Studio, or re-send with updateActive (what `lumibase skills push` does).',
            409,
          );
        }
        if (dryRun) {
          results.push({
            ...base,
            // An activation-only import is a change too: `push --check` must see it.
            action: 'updated',
            version: contentChanged ? existing.version + 1 : existing.version,
            status: wantsActivation ? 'active' : existing.status,
          });
          continue;
        }
        const { skill, changed } = await this.update(existing.id, input, {
          ...meta,
          expectedVersion: existing.version,
        });
        const final = wantsActivation
          ? await this.setStatus(skill.id, 'active', { expectedVersion: skill.version })
          : skill;
        results.push({
          ...base,
          action: changed || wantsActivation ? 'updated' : 'unchanged',
          version: final.version,
          status: final.status,
        });
      } catch (err) {
        if (!(err instanceof SiteSkillError)) throw err;
        results.push({ ...base, action: 'error', code: err.code, message: err.message });
      }
    }
    return results;
  }

  /** The skill as a Markdown document (front matter + body). */
  toDocument(row: SkillRow): string {
    return serializeSkillDocument({ slug: row.slug, ...rowContent(row) });
  }

  async exportDocuments(filter: { status?: string } = {}) {
    const rows = await this.list(filter);
    return rows.map((row) => ({
      slug: row.slug,
      filename: `${row.slug}.skill.md`,
      status: row.status,
      version: row.version,
      hash: row.hash,
      content: this.toDocument(row),
    }));
  }

  /** Active skills that apply to a run, packed into the prompt budget. */
  async resolve(ctx: SiteSkillContext): Promise<ResolvedSiteSkills> {
    const active = await this.list({ status: 'active' });
    return composeSkillPrompt(active.filter((skill) => skillApplies(skill, ctx)));
  }

  /** Active skills offered to an MCP client with these capabilities. */
  async listForMcp(capabilities: readonly string[]): Promise<SkillRow[]> {
    const active = await this.list({ status: 'active' });
    return active.filter((skill) => skillApplies(skill, { surface: 'mcp', capabilities, ignoreTriggers: true }));
  }

  /**
   * {@link resolve} for run paths. Playbooks are advisory, so a failure to
   * load them (an instance whose code is ahead of its migrations, a database
   * blip) must not fail the run: it proceeds without playbooks and says so in
   * the log. Nothing here is a security control — governance never depends on
   * a skill having been injected.
   */
  async resolveSafe(ctx: SiteSkillContext): Promise<ResolvedSiteSkills> {
    try {
      return await this.resolve(ctx);
    } catch (err) {
      console.warn(
        `[site-skills] could not load playbooks for site ${this.deps.siteId}; continuing without them:`,
        err instanceof Error ? err.message : String(err),
      );
      return EMPTY_RESOLVED_SKILLS;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** How many of the newest user turns Copilot triggers are matched against. */
export const COPILOT_TRIGGER_TURNS = 3;

/**
 * The text Copilot triggers are matched against: the newest
 * {@link COPILOT_TRIGGER_TURNS} user turns of the conversation window the
 * model is about to receive, plus the current message. Matching the current
 * message alone dropped a playbook as soon as the user followed up with
 * "make it shorter" — the follow-up is about the same headline, and the model
 * still sees the earlier turns.
 */
export function copilotTriggerText(message: string, history: readonly LLMMessage[] = []): string {
  const turns = history
    .filter((entry) => entry.role === 'user')
    .slice(-COPILOT_TRIGGER_TURNS)
    .map((entry) => entry.content);
  if (turns.at(-1) !== message) turns.push(message);
  return turns.join('\n');
}

/**
 * Copilot chat instructions for one turn: the stock Copilot prompt plus the
 * site playbooks matching the conversation's latest user turns. `systemPrompt`
 * is `undefined` when nothing applies, so a site with no active skills sends
 * exactly the request it sent before this feature existed.
 *
 * Shared by the synchronous route and the queue worker on purpose — the two
 * halves of `POST /ai/chat` have disagreed before (RBAC, approval provenance),
 * chosen by a `Prefer` header.
 */
export async function resolveCopilotPlaybooks(
  deps: { db: Database; siteId: string },
  input: { text: string; history?: readonly LLMMessage[]; capabilities?: readonly string[] },
): Promise<{ systemPrompt?: string; applied: AppliedSiteSkill[] }> {
  const resolved = await new SiteSkillService(deps).resolveSafe({
    surface: 'copilot',
    text: copilotTriggerText(input.text, input.history),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  if (!resolved.prompt) return { applied: [] };
  return {
    systemPrompt: withSiteSkills(COPILOT_SYSTEM_PROMPT, resolved),
    applied: resolved.skills,
  };
}
