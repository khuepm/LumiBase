import {
  apiKeys,
  policies,
  roles,
  scopeSite,
  teamMembers,
  teams,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createPlaintextToken } from './api-key-token';

/**
 * Thin, tenant-scoped service over RBAC + identity tables, used by the governed
 * AI harness so role/policy/api-key/user/team skills go through the same audit +
 * autonomy gating as any other dangerous tool. Route handlers keep their own
 * (richer) conflict-report / audit logic; this surface is intentionally minimal
 * — create/list/delete + membership — to keep agent-driven changes auditable.
 */
export interface AccessServiceDeps {
  db: Database;
  siteId: string;
  /** Acting principal, recorded as createdBy/rotatedBy/revokedBy on API keys. */
  userId?: string | null;
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

/** Projects an API key row without ever exposing the token hash. */
function publicApiKey(row: typeof apiKeys.$inferSelect) {
  const { tokenHash: _tokenHash, ...rest } = row;
  return rest;
}

export class AccessService {
  constructor(private readonly deps: AccessServiceDeps) {}

  // ── Roles ───────────────────────────────────────────────────────────────
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

  // ── Policies ─────────────────────────────────────────────────────────────
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

  // ── API keys ─────────────────────────────────────────────────────────────
  async listApiKeys() {
    const rows = await this.deps.db
      .select()
      .from(apiKeys)
      .where(scopeSite(apiKeys.siteId, this.deps.siteId));
    return rows.map(publicApiKey);
  }

  async createApiKey(input: { name: string; description?: string; expiresAt?: string | null; metadata?: Record<string, unknown> }) {
    const token = await createPlaintextToken();
    const [row] = await this.deps.db
      .insert(apiKeys)
      .values({
        siteId: this.deps.siteId,
        name: input.name,
        description: input.description,
        prefix: token.prefix,
        tokenHash: token.tokenHash,
        createdBy: this.deps.userId ?? null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        metadata: input.metadata ?? {},
      })
      .returning();
    // The plaintext token is returned exactly once, mirroring the REST route.
    return { ...(row ? publicApiKey(row) : {}), token: token.token };
  }

  async rotateApiKey(id: string, expiresAt?: string | null) {
    const token = await createPlaintextToken();
    const [row] = await this.deps.db
      .update(apiKeys)
      .set({
        prefix: token.prefix,
        tokenHash: token.tokenHash,
        rotatedAt: new Date(),
        rotatedBy: this.deps.userId ?? null,
        revokedAt: null,
        revokedBy: null,
        ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
      })
      .where(and(scopeSite(apiKeys.siteId, this.deps.siteId), eq(apiKeys.id, id)))
      .returning();
    if (!row) throw new Error('API_KEY_NOT_FOUND');
    return { ...publicApiKey(row), token: token.token };
  }

  async revokeApiKey(id: string) {
    const [row] = await this.deps.db
      .update(apiKeys)
      .set({ revokedAt: new Date(), revokedBy: this.deps.userId ?? null })
      .where(and(scopeSite(apiKeys.siteId, this.deps.siteId), eq(apiKeys.id, id)))
      .returning();
    if (!row) throw new Error('API_KEY_NOT_FOUND');
    return publicApiKey(row);
  }

  // ── Users ────────────────────────────────────────────────────────────────
  listUsers() {
    return this.deps.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        status: users.status,
        roleId: userSites.roleId,
        joinedAt: userSites.joinedAt,
      })
      .from(users)
      .innerJoin(userSites, eq(users.id, userSites.userId))
      .where(eq(userSites.siteId, this.deps.siteId));
  }

  /** Create-or-find a user by email and bind them to the site (no email sent). */
  async inviteUser(input: { email: string; roleId?: string }) {
    let [existing] = await this.deps.db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!existing) {
      const [created] = await this.deps.db
        .insert(users)
        .values({ email: input.email, externalId: `shadow_${nanoid()}`, status: 'invited' })
        .returning();
      existing = created!;
    }
    await this.deps.db
      .insert(userSites)
      .values({ userId: existing.id, siteId: this.deps.siteId, roleId: input.roleId })
      .onConflictDoNothing();
    return existing;
  }

  async updateUser(id: string, patch: { roleId?: string | null; status?: string }) {
    if (patch.roleId !== undefined) {
      await this.deps.db
        .update(userSites)
        .set({ roleId: patch.roleId })
        .where(and(eq(userSites.siteId, this.deps.siteId), eq(userSites.userId, id)));
    }
    if (patch.status !== undefined) {
      await this.deps.db.update(users).set({ status: patch.status, updatedAt: new Date() }).where(eq(users.id, id));
    }
    return { id };
  }

  async removeUser(id: string) {
    await this.deps.db
      .delete(userSites)
      .where(and(eq(userSites.siteId, this.deps.siteId), eq(userSites.userId, id)));
    return { deleted: true, id };
  }

  // ── Teams ────────────────────────────────────────────────────────────────
  listTeams() {
    return this.deps.db.select().from(teams).where(eq(teams.siteId, this.deps.siteId));
  }

  async createTeam(input: { name: string; description?: string | null }) {
    const [row] = await this.deps.db
      .insert(teams)
      .values({ siteId: this.deps.siteId, name: input.name, description: input.description })
      .returning();
    return row;
  }

  async deleteTeam(id: string) {
    await this.deps.db.delete(teams).where(and(eq(teams.siteId, this.deps.siteId), eq(teams.id, id)));
    return { deleted: true, id };
  }

  async addTeamMember(teamId: string, userId: string) {
    const [row] = await this.deps.db
      .insert(teamMembers)
      .values({ teamId, userId })
      .onConflictDoNothing()
      .returning();
    return row ?? { teamId, userId };
  }

  async removeTeamMember(teamId: string, userId: string) {
    await this.deps.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    return { deleted: true, teamId, userId };
  }
}
