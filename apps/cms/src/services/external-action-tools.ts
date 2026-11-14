/**
 * External-action tools: agent tools whose effect lands OUTSIDE the CMS.
 *
 * Every core skill acts on content, schema or configuration that LumiBase
 * owns, so the harness can reason about it from the skill's name and
 * capabilities and can revert most of it from revisions. A tool that calls a
 * third-party API has none of that: the harness cannot see what it changed and
 * cannot undo it. Such a tool therefore DECLARES what the harness would
 * otherwise have to guess:
 *
 * - `risk`: how bad a wrong call is (`low` | `medium` | `high`);
 * - `reversibility`: `read_only`, `reversible` or `irreversible`;
 * - `blastRadius`: how many external parties one call can reach;
 * - `capability`: the single capability a caller must hold;
 * - `secrets`: the NAMES of the secrets it needs. Values are resolved by the
 *   harness at execution time and handed to the handler only; they are never
 *   part of the arguments, the prompt, the tool result or any stored row.
 *
 * The declaration is the input to the decision (see {@link governanceFor});
 * the handler has no say in whether it runs.
 *
 * This module is pure: no database, no runtime bindings. Registration only
 * records a definition in memory. The harness reads the registry when it is
 * constructed.
 */

export type ExternalActionRisk = 'low' | 'medium' | 'high';

/**
 * - `read_only`: the call changes nothing at the remote system.
 * - `reversible`: the effect can be fully undone by a later call.
 * - `irreversible`: it cannot (a message was delivered, money moved, a build
 *   was published).
 */
export type ExternalActionReversibility = 'read_only' | 'reversible' | 'irreversible';

/**
 * How many external parties one call can affect.
 *
 * - `none`: nobody outside the caller (reads);
 * - `single`: exactly one external record, account or recipient;
 * - `bounded`: at most `maxAffected` of them;
 * - `broad`: no bound the tool can state (a production deploy, a public post).
 */
export type ExternalActionBlastRadius =
  | { scope: 'none' }
  | { scope: 'single' }
  | { scope: 'bounded'; maxAffected: number }
  | { scope: 'broad' };

/** What a handler receives besides its arguments. */
export interface ExternalActionContext {
  siteId: string;
  /** The run this call belongs to, when the governed path created one. */
  runId: string | null;
  /**
   * Resolved secret values, by declared name. Asking for a name the tool did
   * not declare throws: a handler cannot reach a secret it did not announce.
   */
  secret(name: string): string;
}

export interface ExternalActionToolDefinition {
  /** Tool name as advertised in `tools/list`. Must not shadow a core skill. */
  name: string;
  description: string;
  /** The one capability a caller needs, e.g. `tickets:comment`. */
  capability: string;
  risk: ExternalActionRisk;
  reversibility: ExternalActionReversibility;
  blastRadius: ExternalActionBlastRadius;
  /** Names of the secrets the handler needs. Empty when it needs none. */
  secrets: readonly string[];
  /** JSON Schema (object) for the arguments; enforced before anything runs. */
  inputSchema: Record<string, unknown>;
  /** Who maintains the tool; shown in the registry. */
  owner?: string;
  handler: (args: Record<string, unknown>, context: ExternalActionContext) => Promise<unknown>;
}

/** The declared metadata without the handler: safe to list, store and audit. */
export interface ExternalActionMetadata {
  capability: string;
  risk: ExternalActionRisk;
  reversibility: ExternalActionReversibility;
  blastRadius: ExternalActionBlastRadius;
  secrets: readonly string[];
}

export function externalActionMetadata(tool: ExternalActionToolDefinition): ExternalActionMetadata {
  return {
    capability: tool.capability,
    risk: tool.risk,
    reversibility: tool.reversibility,
    blastRadius: tool.blastRadius,
    secrets: [...tool.secrets],
  };
}

/** Approval policy stored on an approval only a human may decide. */
export const HUMAN_REQUIRED_APPROVAL_POLICY = 'human_required';

export interface ExternalActionGovernance {
  /** False for `read_only` tools: they run on capability alone, like any read. */
  effectful: boolean;
  /**
   * True when no autonomy level may run the tool without a human decision:
   * the tool is high-risk or its effect cannot be undone.
   */
  alwaysRequiresApproval: boolean;
  /**
   * The lowest autonomy level at which the tool may run without an approval,
   * or `null` when no level allows it.
   */
  minAutonomousLevel: 2 | 4 | null;
}

/**
 * The decision rule, as a pure function of the declaration.
 *
 * | declaration                          | L0     | L1   | L2   | L3   | L4   |
 * |--------------------------------------|--------|------|------|------|------|
 * | `read_only`                          | runs on capability; no gradient   |
 * | `high` risk or `irreversible`        | denied | park | park | park | park |
 * | `medium` risk, reversible            | denied | park | park | park | run  |
 * | `low` risk, reversible               | denied | park | run  | run  | run  |
 *
 * "park" is a pending approval. For every external-action tool that approval
 * can only be decided by a human (see `executeApproved`).
 */
export function governanceFor(
  tool: Pick<ExternalActionMetadata, 'risk' | 'reversibility'>,
): ExternalActionGovernance {
  if (tool.reversibility === 'read_only') {
    return { effectful: false, alwaysRequiresApproval: false, minAutonomousLevel: null };
  }
  if (tool.risk === 'high' || tool.reversibility === 'irreversible') {
    return { effectful: true, alwaysRequiresApproval: true, minAutonomousLevel: null };
  }
  return {
    effectful: true,
    alwaysRequiresApproval: false,
    minAutonomousLevel: tool.risk === 'medium' ? 4 : 2,
  };
}

const TOOL_NAME_RE = /^[a-z][a-zA-Z0-9_]{2,63}$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function isValidToolSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export class ExternalActionToolError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DEFINITION'
      | 'DUPLICATE_TOOL'
      | 'RESERVED_NAME',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalActionToolError';
  }
}

/**
 * Refuses a declaration that is malformed or internally inconsistent.
 *
 * The consistency rules exist because the declaration is trusted by the
 * decision: a tool that says "low risk" while reaching an unbounded audience,
 * or "read only" while declaring an audience at all, would talk its way past
 * the gate it is supposed to feed.
 */
export function validateExternalActionTool(tool: ExternalActionToolDefinition): void {
  const fail = (message: string): never => {
    throw new ExternalActionToolError('INVALID_DEFINITION', `External tool "${tool?.name}": ${message}`);
  };
  if (!tool || typeof tool !== 'object') fail('definition must be an object');
  if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) {
    fail('name must match /^[a-z][a-zA-Z0-9_]{2,63}$/');
  }
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0) {
    fail('description is required');
  }
  if (typeof tool.capability !== 'string' || !CAPABILITY_RE.test(tool.capability)) {
    fail('capability must look like "namespace:action"');
  }
  if (!['low', 'medium', 'high'].includes(tool.risk)) fail('risk must be low, medium or high');
  if (!['read_only', 'reversible', 'irreversible'].includes(tool.reversibility)) {
    fail('reversibility must be read_only, reversible or irreversible');
  }
  const radius = tool.blastRadius;
  if (!radius || !['none', 'single', 'bounded', 'broad'].includes(radius.scope)) {
    fail('blastRadius.scope must be none, single, bounded or broad');
  }
  if (radius.scope === 'bounded' && (!Number.isInteger(radius.maxAffected) || radius.maxAffected < 1)) {
    fail('blastRadius.maxAffected must be a positive integer for a bounded scope');
  }
  if (tool.reversibility === 'read_only' && radius.scope !== 'none') {
    fail('a read_only tool affects nobody: blastRadius.scope must be "none"');
  }
  if (tool.reversibility !== 'read_only' && radius.scope === 'none') {
    fail('a tool with an effect must declare who it reaches: blastRadius.scope cannot be "none"');
  }
  if (radius.scope === 'broad' && tool.risk !== 'high') {
    fail('a broad blast radius must be declared high risk');
  }
  if (!Array.isArray(tool.secrets) || tool.secrets.some((name) => typeof name !== 'string' || !SECRET_NAME_RE.test(name))) {
    fail('secrets must be names matching /^[A-Z][A-Z0-9_]{1,63}$/');
  }
  if (new Set(tool.secrets).size !== tool.secrets.length) fail('secrets must not repeat a name');
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || tool.inputSchema['type'] !== 'object') {
    fail('inputSchema must be a JSON Schema of type "object"');
  }
  if (typeof tool.handler !== 'function') fail('handler must be a function');
}

/**
 * In-memory registry of external-action tools.
 *
 * Process-wide by design: a tool is code (a handler), so it is registered by
 * whatever loads that code, not stored per site. What IS per site is
 * everything that decides whether a call may run: the caller's capabilities,
 * the autonomy grant, the `agent_tools` override row (which can disable or
 * rate-limit a tool for one site) and the tool's secrets.
 */
export class ExternalActionToolRegistry {
  private readonly tools = new Map<string, ExternalActionToolDefinition>();

  register(tool: ExternalActionToolDefinition): void {
    validateExternalActionTool(tool);
    if (this.tools.has(tool.name)) {
      throw new ExternalActionToolError('DUPLICATE_TOOL', `External tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, Object.freeze({ ...tool, secrets: Object.freeze([...tool.secrets]) }));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ExternalActionToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ExternalActionToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get size(): number {
    return this.tools.size;
  }
}

/**
 * The registry every harness reads unless it is given another one. Empty until
 * something registers a tool; LumiBase itself registers none.
 */
export const externalActionTools = new ExternalActionToolRegistry();

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // A property with no declared type (or one this subset does not know)
      // is not checked by type; `enum`, `required` and the closed property
      // set still apply.
      return true;
  }
}

/**
 * Checks arguments against the declared schema, before a run or an approval
 * exists for them.
 *
 * Deliberately a small subset of JSON Schema (top-level `required`,
 * `properties` with `type` / `enum` / `maxLength` / `minimum` / `maximum`) and
 * deliberately CLOSED: a property the schema does not name is refused unless
 * the schema sets `additionalProperties: true`. An approver reads the stored
 * arguments; an argument the tool never declared is one the approver has no
 * way to interpret.
 *
 * @returns `null` when acceptable, otherwise a message naming the field.
 */
export function validateExternalActionInput(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  const properties =
    schema['properties'] && typeof schema['properties'] === 'object'
      ? (schema['properties'] as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
    : [];
  for (const key of required) {
    if (args[key] === undefined) return `${key}: is required`;
  }
  const closed = schema['additionalProperties'] !== true;
  for (const [key, value] of Object.entries(args)) {
    const spec = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!spec) {
      if (closed) return `${key}: is not a declared argument`;
      continue;
    }
    if (!typeMatches(spec['type'], value)) return `${key}: must be of type ${String(spec['type'])}`;
    if (Array.isArray(spec['enum']) && !spec['enum'].includes(value)) {
      return `${key}: must be one of ${spec['enum'].map(String).join(', ')}`;
    }
    if (typeof value === 'string' && typeof spec['maxLength'] === 'number' && value.length > spec['maxLength']) {
      return `${key}: must be at most ${spec['maxLength']} characters`;
    }
    if (typeof value === 'number') {
      if (typeof spec['minimum'] === 'number' && value < spec['minimum']) return `${key}: must be >= ${spec['minimum']}`;
      if (typeof spec['maximum'] === 'number' && value > spec['maximum']) return `${key}: must be <= ${spec['maximum']}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/** What a resolved secret value is replaced with wherever it shows up. */
export function redactedSecretMarker(name: string): string {
  return `[secret:${name}]`;
}

function encodings(value: string): string[] {
  const variants = new Set<string>([value]);
  try {
    variants.add(encodeURIComponent(value));
  } catch {
    // A lone surrogate cannot be URI-encoded; the raw form is still covered.
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  variants.add(base64);
  variants.add(base64.replace(/=+$/, ''));
  variants.add(base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  return [...variants].filter((variant) => variant.length > 0);
}

/**
 * Removes every occurrence of the given secret values from `value`, at any
 * depth, in strings and in object keys, in raw, URL-encoded and base64 form.
 *
 * This is the backstop behind "the handler is the only thing that sees a
 * secret". A handler that copies a remote error body into its result, or
 * throws an error quoting the request it sent, would otherwise put the value
 * into the tool result, the stored tool call and the run. The scrub runs on
 * everything that leaves the handler, so that mistake costs a redaction
 * marker rather than a credential.
 */
export function scrubSecrets<T>(value: T, secrets: ReadonlyMap<string, string>): T {
  if (secrets.size === 0) return value;
  // Longest first, so a secret that contains another is replaced whole.
  const needles = [...secrets.entries()]
    .flatMap(([name, secret]) => encodings(secret).map((needle) => ({ needle, marker: redactedSecretMarker(name) })))
    .sort((a, b) => b.needle.length - a.needle.length);
  const scrubString = (text: string): string => {
    let out = text;
    for (const { needle, marker } of needles) {
      if (out.includes(needle)) out = out.split(needle).join(marker);
    }
    return out;
  };
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') return scrubString(node);
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>).map(([key, entry]) => [scrubString(key), visit(entry)]),
      );
    }
    return node;
  };
  return visit(value) as T;
}
