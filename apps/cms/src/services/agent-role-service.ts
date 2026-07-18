import { agentRoles } from '@lumibase/database';
import type { Database } from '@lumibase/database';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Multi-agent role library (content-os task 10; Req 10.2-10.4).
 *
 * Roles are data, not code: each row carries a minimal capability set and
 * the Harness enforces `effective capability = role ∩ grant` — an agent
 * acting under a role can never exceed the role's declared capabilities,
 * and a role can never exceed what the caller's token grants.
 */

export interface AgentRoleDefinition {
  name: string;
  description: string;
  systemPromptRef: string;
  /** Minimal capability strings. The Writer deliberately has no `schema:*`. */
  capabilities: string[];
}

/**
 * Seed library (Req 10.3). Capability sets are intentionally minimal —
 * widening one is a human decision in Studio, never an agent's.
 */
export const ROLE_LIBRARY: readonly AgentRoleDefinition[] = [
  {
    name: 'planner',
    description: 'Decomposes goals into role-scoped sub-goals with inherited budgets.',
    systemPromptRef: 'roles/planner.v1',
    capabilities: ['goals:write', 'items:read', 'schema:read'],
  },
  {
    name: 'writer',
    description: 'Drafts and edits item content. No schema access by design.',
    systemPromptRef: 'roles/writer.v1',
    capabilities: ['items:read', 'items:write'],
  },
  {
    name: 'translator',
    description: 'Translates item content across locales.',
    systemPromptRef: 'roles/translator.v1',
    capabilities: ['items:read', 'items:write', 'translations:write'],
  },
  {
    name: 'taxonomist',
    description: 'Maintains tags, categories and relations between items.',
    systemPromptRef: 'roles/taxonomist.v1',
    capabilities: ['items:read', 'items:write', 'schema:read'],
  },
  {
    name: 'seo',
    description: 'Optimises titles, descriptions and metadata for search.',
    systemPromptRef: 'roles/seo.v1',
    capabilities: ['items:read', 'items:write'],
  },
  {
    name: 'fact_checker',
    description: 'Verifies claims and reviews item changes. Read + review only.',
    systemPromptRef: 'roles/fact-checker.v1',
    capabilities: ['items:read', 'review:items'],
  },
  {
    name: 'librarian',
    description: 'Curates media assets and keeps references healthy.',
    systemPromptRef: 'roles/librarian.v1',
    capabilities: ['items:read', 'media:read', 'media:write'],
  },
  {
    name: 'git-sync',
    description:
      'Reconciles content/intents with a connected Git repository and resolves CI-driven follow-ups.',
    systemPromptRef: 'roles/git-sync.v1',
    capabilities: ['items:read', 'items:write', 'schema:read'],
  },
] as const;

/**
 * Pure capability intersection (Req 10.4) — exported for property tests.
 *
 * - `*` in the grant means "everything the role allows" → role capabilities.
 * - `*` in the role means "everything the grant allows" → grant capabilities.
 * - Otherwise the strict set intersection. Result never exceeds either side.
 */
export function intersectCapabilities(
  roleCapabilities: readonly string[],
  grant: readonly string[],
): string[] {
  if (grant.includes('*')) return [...new Set(roleCapabilities.filter((c) => c !== '*'))];
  if (roleCapabilities.includes('*')) return [...new Set(grant)];
  const granted = new Set(grant);
  return [...new Set(roleCapabilities.filter((c) => granted.has(c)))];
}

export class AgentRoleError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'AgentRoleError';
  }
}

export interface AgentRoleServiceDeps {
  db: Database;
  siteId: string;
}

export class AgentRoleService {
  constructor(private readonly deps: AgentRoleServiceDeps) {}

  /** Inserts any library role the site is missing. Idempotent. */
  async ensureSeeded(): Promise<void> {
    const existing = await this.deps.db
      .select({ name: agentRoles.name })
      .from(agentRoles)
      .where(eq(agentRoles.siteId, this.deps.siteId));
    const present = new Set(existing.map((row) => row.name));
    const missing = ROLE_LIBRARY.filter((role) => !present.has(role.name));
    if (missing.length === 0) return;
    await this.deps.db
      .insert(agentRoles)
      .values(
        missing.map((role) => ({
          siteId: this.deps.siteId,
          name: role.name,
          description: role.description,
          systemPromptRef: role.systemPromptRef,
          capabilities: role.capabilities,
        })),
      )
      .onConflictDoNothing();
  }

  async list() {
    await this.ensureSeeded();
    return this.deps.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.siteId, this.deps.siteId))
      .orderBy(asc(agentRoles.name));
  }

  async getRole(name: string) {
    const [row] = await this.deps.db
      .select()
      .from(agentRoles)
      .where(and(eq(agentRoles.siteId, this.deps.siteId), eq(agentRoles.name, name)))
      .limit(1);
    return row;
  }

  /**
   * Effective capabilities for a run executing under `roleName` with the
   * caller's `grant` (Req 10.4). Unknown or disabled roles yield the empty
   * set — fail closed, the run can do nothing.
   */
  async effectiveCapabilities(roleName: string, grant: readonly string[]): Promise<string[]> {
    const role = await this.getRole(roleName);
    if (!role || !role.enabled) return [];
    const capabilities = Array.isArray(role.capabilities) ? (role.capabilities as string[]) : [];
    return intersectCapabilities(capabilities, grant);
  }

  async create(input: {
    name: string;
    description?: string;
    systemPromptRef?: string;
    model?: string;
    capabilities: string[];
    enabled?: boolean;
  }) {
    const [row] = await this.deps.db
      .insert(agentRoles)
      .values({ siteId: this.deps.siteId, ...input })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      throw new AgentRoleError('CONFLICT', `Role "${input.name}" already exists.`, 409);
    }
    return row;
  }

  async update(
    name: string,
    patch: Partial<{
      description: string;
      systemPromptRef: string;
      model: string | null;
      capabilities: string[];
      enabled: boolean;
    }>,
  ) {
    const [row] = await this.deps.db
      .update(agentRoles)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(agentRoles.siteId, this.deps.siteId), eq(agentRoles.name, name)))
      .returning();
    if (!row) {
      throw new AgentRoleError('NOT_FOUND', `Role "${name}" not found.`, 404);
    }
    return row;
  }

  async delete(name: string): Promise<void> {
    const [row] = await this.deps.db
      .delete(agentRoles)
      .where(and(eq(agentRoles.siteId, this.deps.siteId), eq(agentRoles.name, name)))
      .returning({ id: agentRoles.id });
    if (!row) {
      throw new AgentRoleError('NOT_FOUND', `Role "${name}" not found.`, 404);
    }
  }
}
