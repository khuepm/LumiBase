import { policies, roles, scopeSite, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';

/**
 * Thin, tenant-scoped service over the RBAC role/policy tables, used by the
 * governed AI harness so role/policy skills go through the same audit + autonomy
 * gating as any other dangerous tool. Route handlers keep their own (richer)
 * conflict-report logic; this surface is intentionally minimal — create/list/
 * delete only — to keep agent-driven RBAC changes auditable and reversible
 * within a single table.
 */
export interface AccessServiceDeps {
  db: Database;
  siteId: string;
}

export interface RoleInput {
  name: string;
  key?: string;
  description?: string;
  icon?: string;
  parentId?: string | null;
  adminAccess?: boolean;
  appAccess?: boolean;
}

export interface PolicyInput {
  name: string;
  key?: string;
  description?: string;
  icon?: string;
  adminAccess?: boolean;
  appAccess?: boolean;
  rules?: Record<string, unknown>;
}

export class AccessService {
  constructor(private readonly deps: AccessServiceDeps) {}

  listRoles() {
    return this.deps.db.select().from(roles).where(scopeSite(roles.siteId, this.deps.siteId));
  }

  async createRole(input: RoleInput) {
    const [row] = await this.deps.db
      .insert(roles)
      .values({ ...input, siteId: this.deps.siteId })
      .returning();
    return row;
  }

  async deleteRole(id: string) {
    await this.deps.db
      .delete(roles)
      .where(and(scopeSite(roles.siteId, this.deps.siteId), eq(roles.id, id)));
    return { deleted: true, id };
  }

  listPolicies() {
    return this.deps.db.select().from(policies).where(scopeSite(policies.siteId, this.deps.siteId));
  }

  async createPolicy(input: PolicyInput) {
    const [row] = await this.deps.db
      .insert(policies)
      .values({ ...input, siteId: this.deps.siteId, rules: input.rules ?? {} })
      .returning();
    return row;
  }

  async deletePolicy(id: string) {
    await this.deps.db
      .delete(policies)
      .where(and(scopeSite(policies.siteId, this.deps.siteId), eq(policies.id, id)));
    return { deleted: true, id };
  }
}
