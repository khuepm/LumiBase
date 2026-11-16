import { z } from 'zod';

/**
 * Extension-contributed MCP surface (#715).
 *
 * An extension declares the MCP tools, prompts and resources it adds in the
 * `mcp` block of its manifest. The manifest — not the bundle — is what the
 * host lists and what an admin reviews before granting, so nothing an
 * extension advertises requires running its code. Only tools have code (a
 * handler exported by the bundle, matched by name); prompts and resources are
 * static text shipped in the manifest.
 *
 * Every block is offered only when the admin granted the matching capability
 * on the installed row: `mcp:tools`, `mcp:prompts`, `mcp:resources`.
 */

/** Grants an admin must give on the installed extension row. */
export const EXTENSION_MCP_GRANTS = {
  tools: 'mcp:tools',
  prompts: 'mcp:prompts',
  resources: 'mcp:resources',
} as const;

/**
 * How bad a wrong call is. `read_only` runs on the caller's capability alone;
 * every other class is governed by the autonomy gradient, and `high` always
 * needs a signed-in human's approval.
 */
export const EXTENSION_TOOL_RISK_CLASSES = ['read_only', 'low', 'medium', 'high'] as const;
export type ExtensionToolRiskClass = (typeof EXTENSION_TOOL_RISK_CLASSES)[number];

/** Same shape as an external-action tool name: the host prefixes it. */
export const EXTENSION_TOOL_NAME_RE = /^[a-z][a-zA-Z0-9_]{2,40}$/;
/** `namespace:action`, e.g. `items:write`, `tickets:comment`. */
export const EXTENSION_CAPABILITY_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema['type'] === 'object', { message: 'inputSchema must be a JSON Schema of type "object"' });

export const extensionMcpToolSchema = z.object({
  name: z.string().regex(EXTENSION_TOOL_NAME_RE),
  description: z.string().trim().min(1).max(1000),
  /** The one capability a caller must hold to call (and to see) the tool. */
  capability: z.string().regex(EXTENSION_CAPABILITY_RE),
  riskClass: z.enum(EXTENSION_TOOL_RISK_CLASSES),
  /** Whether the effect can be undone. Ignored for `read_only`. Default true. */
  reversible: z.boolean().optional(),
  inputSchema: jsonSchemaObject,
});
export type ExtensionMcpToolDeclaration = z.infer<typeof extensionMcpToolSchema>;

export const extensionMcpPromptSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  /** Capability a caller must hold to see the prompt. Default `items:read`. */
  capability: z.string().regex(EXTENSION_CAPABILITY_RE).optional(),
  text: z.string().min(1).max(12_000),
});
export type ExtensionMcpPromptDeclaration = z.infer<typeof extensionMcpPromptSchema>;

export const extensionMcpResourceSchema = z.object({
  /** Path segment of `lumibase-ext://<extension key>/<name>`. */
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  mimeType: z.enum(['text/plain', 'text/markdown', 'application/json']).default('text/markdown'),
  /** Capability a caller must hold to see and read the resource. Default `items:read`. */
  capability: z.string().regex(EXTENSION_CAPABILITY_RE).optional(),
  text: z.string().min(1).max(64_000),
});
export type ExtensionMcpResourceDeclaration = z.infer<typeof extensionMcpResourceSchema>;

const uniqueNames = (list: ReadonlyArray<{ name: string }>) => new Set(list.map((entry) => entry.name)).size === list.length;

export const extensionMcpManifestSchema = z.object({
  tools: z
    .array(extensionMcpToolSchema)
    .max(32)
    .default([])
    .refine(uniqueNames, { message: 'tool names must be unique' }),
  prompts: z
    .array(extensionMcpPromptSchema)
    .max(32)
    .default([])
    .refine(uniqueNames, { message: 'prompt names must be unique' }),
  resources: z
    .array(extensionMcpResourceSchema)
    .max(32)
    .default([])
    .refine(uniqueNames, { message: 'resource names must be unique' }),
});
export type ExtensionMcpManifest = z.infer<typeof extensionMcpManifestSchema>;

/** Default capability for a prompt or resource that names none. */
export const EXTENSION_MCP_DEFAULT_READ_CAPABILITY = 'items:read';

/**
 * Reads the `mcp` block of a stored manifest. `null` when there is none;
 * throws a `ZodError` when it is malformed.
 */
export function parseExtensionMcpManifest(manifest: unknown): ExtensionMcpManifest | null {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  const block = (manifest as Record<string, unknown>)['mcp'];
  if (block === undefined || block === null) return null;
  return extensionMcpManifestSchema.parse(block);
}

/**
 * The advertised name of an extension tool: `ext_<key>__<tool>`. The prefix
 * keeps an extension from shadowing a core skill or another extension's tool.
 * `null` when the result would not be a valid tool name (too long).
 */
export function extensionToolName(extensionKey: string, toolName: string): string | null {
  const key = extensionKey.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('_');
  if (!key) return null;
  const name = `ext_${key}__${toolName}`;
  return /^[a-z][a-zA-Z0-9_]{2,63}$/.test(name) ? name : null;
}

/** URI of an extension resource. */
export function extensionResourceUri(extensionKey: string, resourceName: string): string {
  return `lumibase-ext://${encodeURIComponent(extensionKey)}/${resourceName}`;
}
