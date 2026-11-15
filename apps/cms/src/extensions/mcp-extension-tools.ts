/**
 * Extension-contributed MCP tools, prompts and resources (#715).
 *
 * The surface an extension adds is read from its MANIFEST (`mcp` block), never
 * from its bundle, so listing requires no extension code to run and what an
 * admin reviewed before granting is exactly what is offered. Each block is
 * offered only when the installed row was granted the matching capability
 * (`mcp:tools`, `mcp:prompts`, `mcp:resources`).
 *
 * Tools are projected into external-action tool definitions and handed to the
 * harness as its `externalTools` registry. That is the whole governance story:
 * they ride the same path as every other non-core tool — kill switch, input
 * validation against the declared schema, the caller's capability, the
 * autonomy gradient, human-only approval for anything high-risk or
 * irreversible, the run / tool-call audit — and the handler is only reached
 * from the harness's guarded executor. There is no extension-specific
 * decision code here.
 *
 * HITL rule (CLAUDE.md §4): a tool whose capability is `schema:write`, or
 * whose name starts with `delete`, is forced to `high` risk whatever it
 * declares, which no autonomy level runs without a signed-in human.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { extensions, type Database } from '@lumibase/database';
import {
  EXTENSION_MCP_DEFAULT_READ_CAPABILITY,
  EXTENSION_MCP_GRANTS,
  extensionResourceUri,
  extensionToolName,
  parseExtensionMcpManifest,
  type ExtensionMcpManifest,
  type ExtensionMcpToolDeclaration,
} from '@lumibase/contracts/extensions';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { Bindings } from '../env';
import { buildSandboxVerifyOptions } from '../services/extension-verifier';
import {
  ExternalActionToolError,
  ExternalActionToolRegistry,
  externalActionTools,
  type ExternalActionToolDefinition,
} from '../services/external-action-tools';
import { ExtensionSandbox, type ExtensionActorDataAccess, type ExtensionModule } from './sandbox';

type ExtensionRow = typeof extensions.$inferSelect;

/** Extension types that run server-side and may therefore ship tool handlers. */
const SERVER_EXTENSION_TYPES = ['hook', 'endpoint'] as const;

/** Wall-clock budget for one extension tool handler. */
export const EXTENSION_TOOL_TIMEOUT_MS = 10_000;

export interface ExtensionMcpPrompt {
  /** `ext:<extension key>:<prompt>`. */
  name: string;
  title?: string;
  description?: string;
  capability: string;
  text: string;
  extension: { key: string; version: string };
}

export interface ExtensionMcpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  capability: string;
  text: string;
  extension: { key: string; version: string };
}

export interface SiteExtensionMcp {
  tools: ExternalActionToolDefinition[];
  prompts: ExtensionMcpPrompt[];
  resources: ExtensionMcpResource[];
  /** Extensions (or entries) left out, with why. For logs and tests. */
  skipped: Array<{ extension: string; reason: string }>;
}

/** Loads a row's module. Injected in tests; production uses the sandbox. */
export type ExtensionModuleLoader = (row: ExtensionRow) => Promise<ExtensionModule | null>;

export interface SiteExtensionMcpDeps {
  db: Database;
  siteId: string;
  env?: Bindings | Record<string, unknown>;
  /** Actor-scoped item access handed to the sandbox (the request's ItemService). */
  dataAccess?: ExtensionActorDataAccess;
  loadModule?: ExtensionModuleLoader;
  timeoutMs?: number;
}

export function extensionKeyOf(row: Pick<ExtensionRow, 'key' | 'name'>): string {
  return (
    row.key?.trim() ||
    row.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  );
}

function granted(row: ExtensionRow, grant: string): boolean {
  const caps = Array.isArray(row.capabilities) ? (row.capabilities as unknown[]) : [];
  return caps.includes(grant);
}

/**
 * Effective governance of a declaration. `read_only` keeps no gradient; the
 * HITL rule upgrades schema writes and deletes to `high`.
 */
export function extensionToolGovernance(tool: Pick<ExtensionMcpToolDeclaration, 'name' | 'capability' | 'riskClass' | 'reversible'>): Pick<
  ExternalActionToolDefinition,
  'risk' | 'reversibility' | 'blastRadius'
> {
  const forcedHigh = tool.capability === 'schema:write' || tool.name.startsWith('delete');
  if (tool.riskClass === 'read_only' && !forcedHigh) {
    return { risk: 'low', reversibility: 'read_only', blastRadius: { scope: 'none' } };
  }
  const risk = forcedHigh ? 'high' : tool.riskClass === 'read_only' ? 'low' : tool.riskClass;
  return {
    risk,
    reversibility: tool.reversible === false ? 'irreversible' : 'reversible',
    blastRadius: { scope: 'single' },
  };
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`EXTENSION_TOOL_TIMEOUT: ${label} did not finish in ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sandboxLoader(deps: SiteExtensionMcpDeps): ExtensionModuleLoader {
  const env = (deps.env ?? {}) as Record<string, unknown>;
  const sandbox = new ExtensionSandbox(env, deps.db, deps.dataAccess);
  return (row) =>
    sandbox.load({
      name: row.name,
      bundleUrl: row.bundleUrl,
      capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
      ...buildSandboxVerifyOptions(row, deps.db, env as unknown as Bindings),
    });
}

function toolDefinition(
  row: ExtensionRow,
  key: string,
  advertised: string,
  declaration: ExtensionMcpToolDeclaration,
  loadModule: ExtensionModuleLoader,
  timeoutMs: number,
): ExternalActionToolDefinition {
  return {
    name: advertised,
    description: `${declaration.description} (extension: ${key})`,
    capability: declaration.capability,
    ...extensionToolGovernance(declaration),
    secrets: [],
    inputSchema: declaration.inputSchema,
    owner: `extension:${key}`,
    // Reached only through the harness's guarded executor: by then the call
    // passed the kill switch, input validation, capability and autonomy, and
    // any approval it needed was decided by a human.
    handler: async (args, context) => {
      const mod = await loadModule(row);
      const impl = mod?.mcp?.tools?.find((tool) => tool.name === declaration.name);
      if (!impl || typeof impl.handler !== 'function') {
        throw new Error(
          `EXTENSION_TOOL_UNAVAILABLE: extension "${key}" did not load or does not implement "${declaration.name}"`,
        );
      }
      return withTimeout(
        Promise.resolve(impl.handler(args, { siteId: context.siteId, runId: context.runId })),
        timeoutMs,
        advertised,
      );
    },
  };
}

/**
 * Reads the MCP surface every enabled server-side extension of the site
 * contributes. Malformed manifests are skipped (and reported), never fatal:
 * one broken extension must not take the site's MCP endpoint down.
 */
export async function loadSiteExtensionMcp(deps: SiteExtensionMcpDeps): Promise<SiteExtensionMcp> {
  const out: SiteExtensionMcp = { tools: [], prompts: [], resources: [], skipped: [] };
  const rows = await deps.db
    .select()
    .from(extensions)
    .where(
      and(
        eq(extensions.siteId, deps.siteId),
        eq(extensions.enabled, true),
        inArray(extensions.type, [...SERVER_EXTENSION_TYPES]),
      ),
    );
  const loadModule = deps.loadModule ?? sandboxLoader(deps);
  const timeoutMs = deps.timeoutMs ?? EXTENSION_TOOL_TIMEOUT_MS;

  for (const row of rows) {
    let manifest: ExtensionMcpManifest | null;
    try {
      manifest = parseExtensionMcpManifest(row.manifest);
    } catch (err) {
      out.skipped.push({ extension: row.name, reason: `invalid mcp manifest: ${formatSafeError(err)}` });
      continue;
    }
    if (!manifest) continue;
    const key = extensionKeyOf(row);
    const extension = { key, version: row.version };

    if (manifest.tools.length > 0) {
      if (!granted(row, EXTENSION_MCP_GRANTS.tools)) {
        out.skipped.push({ extension: row.name, reason: `tools not granted (${EXTENSION_MCP_GRANTS.tools})` });
      } else {
        for (const declaration of manifest.tools) {
          const advertised = extensionToolName(key, declaration.name);
          if (!advertised) {
            out.skipped.push({ extension: row.name, reason: `tool name too long: ${declaration.name}` });
            continue;
          }
          out.tools.push(toolDefinition(row, key, advertised, declaration, loadModule, timeoutMs));
        }
      }
    }

    if (manifest.prompts.length > 0) {
      if (!granted(row, EXTENSION_MCP_GRANTS.prompts)) {
        out.skipped.push({ extension: row.name, reason: `prompts not granted (${EXTENSION_MCP_GRANTS.prompts})` });
      } else {
        for (const prompt of manifest.prompts) {
          out.prompts.push({
            name: `ext:${key}:${prompt.name}`,
            ...(prompt.title ? { title: prompt.title } : {}),
            ...(prompt.description ? { description: prompt.description } : {}),
            capability: prompt.capability ?? EXTENSION_MCP_DEFAULT_READ_CAPABILITY,
            text: prompt.text,
            extension,
          });
        }
      }
    }

    if (manifest.resources.length > 0) {
      if (!granted(row, EXTENSION_MCP_GRANTS.resources)) {
        out.skipped.push({ extension: row.name, reason: `resources not granted (${EXTENSION_MCP_GRANTS.resources})` });
      } else {
        for (const resource of manifest.resources) {
          out.resources.push({
            uri: extensionResourceUri(key, resource.name),
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            mimeType: resource.mimeType,
            capability: resource.capability ?? EXTENSION_MCP_DEFAULT_READ_CAPABILITY,
            text: resource.text,
            extension,
          });
        }
      }
    }
  }
  return out;
}

/**
 * The external-tool registry a harness for this site should use: every
 * process-wide external-action tool plus this site's extension tools.
 *
 * Build it for EVERY harness of the site that can execute — the request path
 * and the approval-decision path alike — or an approved extension call would
 * find its tool unknown when it is released.
 */
export async function siteExternalToolRegistry(
  deps: SiteExtensionMcpDeps & { base?: ExternalActionToolRegistry; preloaded?: SiteExtensionMcp },
): Promise<ExternalActionToolRegistry> {
  const base = deps.base ?? externalActionTools;
  let contributed: SiteExtensionMcp;
  try {
    contributed = deps.preloaded ?? (await loadSiteExtensionMcp(deps));
  } catch (err) {
    // Reading the rows failed: offer the process-wide tools only. Fail-closed
    // for the extension tools, not for the whole harness.
    console.error('[extensions] could not load extension MCP tools', formatSafeError(err));
    return base;
  }
  if (contributed.tools.length === 0) return base;
  const registry = new ExternalActionToolRegistry();
  for (const tool of base.list()) registry.register(tool);
  for (const tool of contributed.tools) {
    try {
      registry.register(tool);
    } catch (err) {
      const reason = err instanceof ExternalActionToolError ? `${err.code}: ${err.message}` : formatSafeError(err);
      console.warn(`[extensions] extension tool "${tool.name}" was not registered: ${reason}`);
    }
  }
  return registry;
}
