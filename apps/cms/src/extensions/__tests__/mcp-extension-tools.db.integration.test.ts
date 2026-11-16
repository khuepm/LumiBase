import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentAutonomyGrants,
  extensions,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness, skillCatalog, type HarnessExecutionResult } from '../../services/ai-harness';
import { McpService, type McpHarnessPort, type McpToolDecision } from '../../services/mcp-service';
import { ToolRegistryService } from '../../services/tool-registry-service';
import { ExternalActionToolRegistry } from '../../services/external-action-tools';
import type { ApprovalDecider } from '../../services/external-action-audit';
import { satisfiesCapability } from '../../services/effective-capability-service';
import { loadSiteExtensionMcp, siteExternalToolRegistry, type ExtensionModuleLoader } from '../mcp-extension-tools';
import type { ExtensionModule } from '../sandbox';

/**
 * Extension-contributed MCP tools (#715) against REAL PostgreSQL.
 *
 * Only the extension bundle is a stand-in: `loadModule` returns an in-memory
 * module, so "did the extension run" is a counter. Everything that decides —
 * the installed row and its grants, autonomy grants, runs, tool calls, both
 * approval tables — is real.
 */

const SITE = 'site_extmcp_a';
const OTHER_SITE = 'site_extmcp_b';
const ADMIN = 'usr_extmcp_admin';
const ADMIN_ROLE = 'role_extmcp_admin';
const AGENT = 'extmcp-agent';
const HUMAN: ApprovalDecider = { kind: 'human', userId: ADMIN };

const MANIFEST = {
  mcp: {
    tools: [
      {
        name: 'countNotes',
        description: 'Count notes',
        capability: 'notes:read',
        riskClass: 'read_only',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'appendNote',
        description: 'Append a note',
        capability: 'notes:write',
        riskClass: 'low',
        inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 200 } }, required: ['text'] },
      },
      {
        // Declares itself low — the HITL rule makes it high (schema:write).
        name: 'addNoteField',
        description: 'Add a field to the notes collection',
        capability: 'schema:write',
        riskClass: 'low',
        inputSchema: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] },
      },
      {
        name: 'missingHandler',
        description: 'Declared but not implemented by the bundle',
        capability: 'notes:read',
        riskClass: 'read_only',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    prompts: [{ name: 'house-style', text: 'Write in sentence case.' }],
    resources: [{ name: 'glossary', mimeType: 'text/markdown', text: '# Glossary' }],
  },
};

describe.skipIf(!hasDbIntegrationUrl)('extension MCP tools (#715) — DB integration', () => {
  let db: Database;
  const calls: Array<{ tool: string; args: Record<string, unknown>; siteId: string; runId: string | null }> = [];

  const module: ExtensionModule = {
    mcp: {
      tools: ['countNotes', 'appendNote', 'addNoteField'].map((name) => ({
        name,
        handler: async (args: Record<string, unknown>, ctx: { siteId: string; runId: string | null }) => {
          calls.push({ tool: name, args, siteId: ctx.siteId, runId: ctx.runId });
          return { ok: true, tool: name };
        },
      })),
    },
  };
  const loadModule: ExtensionModuleLoader = async () => module;

  async function registry(siteId = SITE): Promise<ExternalActionToolRegistry> {
    return siteExternalToolRegistry({ db, siteId, loadModule, base: new ExternalActionToolRegistry() });
  }

  async function harness(siteId = SITE): Promise<AISecureHarness> {
    return new AISecureHarness({ db, siteId, externalTools: await registry(siteId), enableAgentHarnessAudit: true });
  }

  async function call(tool: string, args: Record<string, unknown>, capabilities: string[]): Promise<HarnessExecutionResult> {
    return (await harness()).execute(tool, args, capabilities, 'extension tool fixture', {
      agentName: AGENT,
      requestedByPrincipal: { kind: 'principal', ref: { type: 'user', siteId: SITE, userId: ADMIN } },
    });
  }

  async function setLevel(capability: string, level: number): Promise<void> {
    await db
      .delete(agentAutonomyGrants)
      .where(and(eq(agentAutonomyGrants.siteId, SITE), eq(agentAutonomyGrants.agentRole, AGENT)));
    await db.insert(agentAutonomyGrants).values({ siteId: SITE, agentRole: AGENT, capability, level });
  }

  async function installExtension(overrides: Partial<typeof extensions.$inferInsert> = {}) {
    const [row] = await db
      .insert(extensions)
      .values({
        siteId: SITE,
        key: 'notes',
        name: 'notes',
        version: '1.2.0',
        type: 'hook',
        enabled: true,
        bundleUrl: 'https://ext.invalid/notes.mjs',
        manifest: MANIFEST,
        capabilities: ['mcp:tools', 'mcp:prompts', 'mcp:resources'],
        ...overrides,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    db = await connectDbIntegration('extension-mcp-tools');
  });

  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.delete(users).where(eq(users.id, ADMIN));
  };

  afterAll(async () => {
    if (!db) return;
    await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    calls.length = 0;
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'Ext MCP A' },
      { organizationId: org, id: OTHER_SITE, name: 'Ext MCP B' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'extmcp-admin@example.dev' });
    await db.insert(roles).values({ id: ADMIN_ROLE, siteId: SITE, name: 'ExtMcp Admin', adminAccess: true, appAccess: true });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
  });

  it('projects the manifest into prefixed tools, prompts and resources — only what was granted', async () => {
    await installExtension();
    const loaded = await loadSiteExtensionMcp({ db, siteId: SITE, loadModule });
    expect(loaded.tools.map((tool) => tool.name)).toEqual([
      'ext_notes__countNotes',
      'ext_notes__appendNote',
      'ext_notes__addNoteField',
      'ext_notes__missingHandler',
    ]);
    const byName = Object.fromEntries(loaded.tools.map((tool) => [tool.name, tool]));
    expect(byName['ext_notes__countNotes']).toMatchObject({ reversibility: 'read_only', capability: 'notes:read' });
    expect(byName['ext_notes__appendNote']).toMatchObject({ risk: 'low', reversibility: 'reversible' });
    // HITL rule: schema:write is high whatever the manifest says.
    expect(byName['ext_notes__addNoteField']).toMatchObject({ risk: 'high', owner: 'extension:notes' });
    expect(loaded.prompts).toEqual([
      expect.objectContaining({ name: 'ext:notes:house-style', capability: 'items:read', extension: { key: 'notes', version: '1.2.0' } }),
    ]);
    expect(loaded.resources).toEqual([
      expect.objectContaining({ uri: 'lumibase-ext://notes/glossary', mimeType: 'text/markdown' }),
    ]);
  });

  it('offers nothing an admin did not grant, nothing disabled, nothing from another site', async () => {
    await installExtension({ capabilities: ['mcp:prompts'] });
    await installExtension({ key: 'off', name: 'off', enabled: false });
    await installExtension({ key: 'ui', name: 'ui', type: 'interface' });
    await installExtension({ key: 'elsewhere', name: 'elsewhere', siteId: OTHER_SITE });

    const loaded = await loadSiteExtensionMcp({ db, siteId: SITE, loadModule });
    expect(loaded.tools).toEqual([]);
    expect(loaded.resources).toEqual([]);
    expect(loaded.prompts.map((prompt) => prompt.name)).toEqual(['ext:notes:house-style']);
    expect(loaded.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ extension: 'notes', reason: expect.stringContaining('mcp:tools') })]),
    );

    const unknown = await call('ext_elsewhere__countNotes', {}, ['notes:read']);
    expect(unknown.status).toBe('denied');
    expect(calls).toHaveLength(0);
  });

  it('skips a malformed manifest instead of failing the site', async () => {
    await installExtension({ manifest: { mcp: { tools: [{ name: 'X' }] } } });
    await installExtension({ key: 'good', name: 'good' });
    const loaded = await loadSiteExtensionMcp({ db, siteId: SITE, loadModule });
    expect(loaded.tools.map((tool) => tool.name)).toContain('ext_good__appendNote');
    expect(loaded.skipped).toEqual([expect.objectContaining({ extension: 'notes', reason: expect.stringContaining('invalid mcp manifest') })]);
  });

  it('runs a read_only tool on capability alone and refuses it without the capability', async () => {
    await installExtension();
    const refused = await call('ext_notes__countNotes', {}, ['items:read']);
    expect(refused).toMatchObject({ status: 'denied', message: 'Insufficient capabilities' });
    const allowed = await call('ext_notes__countNotes', {}, ['notes:read']);
    expect(allowed.status).toBe('executed');
    expect(calls).toEqual([expect.objectContaining({ tool: 'countNotes', siteId: SITE, runId: allowed.runId })]);
  });

  it('validates arguments against the declared schema before anything runs', async () => {
    await installExtension();
    await setLevel('notes:write', 4);
    const result = await call('ext_notes__appendNote', { text: 'hi', extra: 1 }, ['notes:write']);
    expect(result).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    expect(calls).toHaveLength(0);
  });

  it('a low-risk tool follows the autonomy gradient: parks at L1, runs at L2', async () => {
    await installExtension();
    await setLevel('notes:write', 1);
    const parked = await call('ext_notes__appendNote', { text: 'a' }, ['notes:write']);
    expect(parked.status).toBe('pending_approval');
    expect(calls).toHaveLength(0);

    await setLevel('notes:write', 2);
    const executed = await call('ext_notes__appendNote', { text: 'b' }, ['notes:write']);
    expect(executed.status).toBe('executed');
    expect(calls).toEqual([expect.objectContaining({ tool: 'appendNote', args: { text: 'b' } })]);
  });

  it('a schema:write tool always needs a signed-in human — released by a freshly built harness', async () => {
    await installExtension();
    await setLevel('schema:write', 4);
    const parked = await call('ext_notes__addNoteField', { field: 'mood' }, ['schema:write']);
    expect(parked.status).toBe('pending_approval');
    expect(parked.approvalId).toBeTruthy();
    expect(calls).toHaveLength(0);

    // The decision path builds its own harness (buildAuthorizedHarness): the
    // tool must be known there too, and only a human may release it.
    for (const decider of [{ kind: 'api_key' }, { kind: 'agent' }] as ApprovalDecider[]) {
      const refused = await (await harness()).executeApproved(parked.approvalId!, ADMIN, ['admin'], decider);
      expect(refused).toMatchObject({ status: 'denied', code: 'HUMAN_APPROVAL_REQUIRED' });
    }
    expect(calls).toHaveLength(0);

    const approved = await (await harness()).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(approved.status).toBe('executed');
    expect(calls).toEqual([expect.objectContaining({ tool: 'addNoteField', args: { field: 'mood' } })]);
    const [decided] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(decided).toMatchObject({ status: 'approved', decidedBy: ADMIN, siteId: SITE });
  });

  it('a tool the bundle does not implement fails the call, it does not pretend', async () => {
    await installExtension();
    const result = await call('ext_notes__missingHandler', {}, ['notes:read']);
    expect(result.status).not.toBe('executed');
    expect(JSON.stringify(result)).toContain('EXTENSION_TOOL_UNAVAILABLE');
  });

  it('is listed and callable over MCP with the same decision as the harness', async () => {
    await installExtension();
    const externalTools = await registry();
    const h = new AISecureHarness({ db, siteId: SITE, externalTools, enableAgentHarnessAudit: true });
    const toolRegistry = new ToolRegistryService(db, SITE, skillCatalog(externalTools));
    const capabilities = ['notes:read'];
    const port: McpHarnessPort = {
      listTools: async () =>
        (await toolRegistry.listTools())
          .filter((tool) => !tool.external || satisfiesCapability(capabilities, tool.external.capability))
          .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, enabled: tool.enabled })),
      execute: (name, args, caps) =>
        h.execute(name, args, caps, undefined, {
          agentName: AGENT,
          requestedByPrincipal: { kind: 'principal', ref: { type: 'user', siteId: SITE, userId: ADMIN } },
        }),
    };
    const mcp = new McpService(port);
    const listed = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, capabilities)) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    // Listed only for callers holding the tool's capability.
    expect(names).toContain('ext_notes__countNotes');
    expect(names).not.toContain('ext_notes__appendNote');
    expect(names).not.toContain('ext_notes__addNoteField');

    const response = (await mcp.handle(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ext_notes__countNotes', arguments: {} } },
      capabilities,
    )) as { result: { structuredContent: McpToolDecision; isError: boolean } };
    expect(response.result.isError).toBe(false);
    expect(response.result.structuredContent).toMatchObject({ status: 'executed', data: { ok: true, tool: 'countNotes' } });
  });
});
