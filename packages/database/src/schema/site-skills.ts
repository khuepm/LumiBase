import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Site Skills (#712): editorial playbooks a site writes down for agents.
 *
 * Not to be confused with harness skills (`lumibase_agent_tools`, the callable
 * tools). A site skill is prose — "how this site works" — that the harness
 * injects into the instructions of a matching run. It grants nothing: tools,
 * capabilities, autonomy and HITL are decided exactly as before.
 *
 * `site_skills` holds the current state of each skill; every content change
 * appends an immutable row to `site_skill_versions`, which is the provenance
 * trail (who, from where, which hash).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const siteSkills = pgTable(
  'lumibase_site_skills',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable handle, unique per site: `house-style`, `product-translations`. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').default('').notNull(),
    /** `draft` | `active` | `archived`. Only `active` skills are injected. */
    status: text('status').default('draft').notNull(),
    /** `low` | `medium` | `high`. `high` needs a control-plane admin to activate. */
    riskClass: text('risk_class').default('low').notNull(),
    /** Higher first when several skills match and the prompt budget is tight. */
    priority: integer('priority').default(0).notNull(),
    /** Keywords; empty means "applies whenever scope matches". */
    triggers: jsonb('triggers').$type<string[]>().default([]).notNull(),
    /** Where the skill is offered: `copilot` | `generation` | `mcp`. Empty = all. */
    surfaces: jsonb('surfaces').$type<string[]>().default([]).notNull(),
    /** Harness tool names the skill is limited to. Empty = any tool. */
    tools: jsonb('tools').$type<string[]>().default([]).notNull(),
    /** Collection names the skill is limited to. Empty = any collection. */
    collections: jsonb('collections').$type<string[]>().default([]).notNull(),
    /** Capabilities the caller must hold for the skill to be offered. */
    requiredCapabilities: jsonb('required_capabilities').$type<string[]>().default([]).notNull(),
    /** Markdown playbook body (current version). */
    body: text('body').notNull(),
    /** Current version number; matches the newest `site_skill_versions` row. */
    version: integer('version').default(1).notNull(),
    /** sha256 of the canonical content of the current version. */
    hash: text('hash').notNull(),
    /** `studio` | `api` | `cli` | `package` */
    source: text('source').default('api').notNull(),
    /** Free-form origin: package name@version, repo path, … */
    sourceRef: text('source_ref'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: timestamp('activated_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteSlugUnique: uniqueIndex('site_skills_site_slug_unique').on(t.siteId, t.slug),
    siteStatusIdx: index('site_skills_site_status_idx').on(t.siteId, t.status),
  }),
);

export const siteSkillVersions = pgTable(
  'lumibase_site_skill_versions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => siteSkills.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    hash: text('hash').notNull(),
    /** Full content snapshot: name, description, frontmatter fields and body. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    source: text('source').default('api').notNull(),
    sourceRef: text('source_ref'),
    changeNote: text('change_note'),
    /** User who wrote the version; null for API keys (see `authorLabel`). */
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** Non-user principal label, e.g. `api_key:<id>`. */
    authorLabel: text('author_label'),
    createdAt: createdAt(),
  },
  (t) => ({
    skillVersionUnique: uniqueIndex('site_skill_versions_skill_version_unique').on(t.skillId, t.version),
    siteSkillIdx: index('site_skill_versions_site_skill_idx').on(t.siteId, t.skillId),
  }),
);
