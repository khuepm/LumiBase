/**
 * External-action tools — contracts.
 *
 * An external-action tool is an agent tool whose effect lands outside the CMS
 * (a third-party API). It declares what the harness cannot infer: how risky a
 * wrong call is, whether the effect can be undone, how many parties it reaches,
 * the one capability a caller needs and the NAMES of the secrets it uses. The
 * harness decides from that declaration; the handler has no say in whether it
 * runs. Validation, the decision rule and the registry live in
 * `apps/cms/src/services/external-action-tools.ts`.
 *
 * A package outside the CMS supplies tools through the `externalActions` seam:
 * a deployment entry registers a source once, and the CMS validates and
 * registers every definition it returns before the first request.
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

/**
 * Facts the harness knows about one call, independent of the tool. Passed to
 * {@link ExternalActionPolicy.record} and always present in the record the
 * constitution evaluates, under these names; a tool cannot overwrite them.
 */
export interface ExternalActionFacts {
  tool: string;
  capability: string;
  risk: ExternalActionRisk;
  /** The blast-radius scope: `none` | `single` | `bounded` | `broad`. */
  blastRadius: ExternalActionBlastRadius['scope'];
  /** The agent the run belongs to. */
  agentName: string;
  /** Role from the agent role library, when the run is role-scoped. */
  agentRole: string | null;
  /** Governing intent of the run, when it has one. */
  intentId: string | null;
  runId: string;
}

/** Keys of {@link ExternalActionFacts}: reserved in a policy record. */
export const EXTERNAL_ACTION_FACT_KEYS: readonly (keyof ExternalActionFacts)[] = Object.freeze([
  'tool',
  'capability',
  'risk',
  'blastRadius',
  'agentName',
  'agentRole',
  'intentId',
  'runId',
]);

/**
 * Pre-execution policy for one tool: whether and how the site's constitution
 * is evaluated before the tool runs.
 *
 * The constitution is the site's versioned, hash-identified evaluator set
 * (`rule` and `llm_judge` evaluators). With a policy declared, the harness
 * evaluates the constitution pinned to the run on a flat record describing the
 * call BEFORE it decides anything else about that call — before it parks an
 * approval, before it runs autonomously, and again before an approved call
 * executes. A blocking failure refuses the call; a blocking failure of an
 * evaluator marked `onViolation: 'require_approval'` sends the call to a human
 * instead. Every evaluation is written to the external-action audit trail.
 *
 * A tool without a policy is not evaluated, which is how every external tool
 * behaved before policies existed.
 */
export interface ExternalActionPolicy {
  /**
   * - `required`: the call is refused unless the site has an active
   *   constitution (fail closed). Use for any tool whose safety depends on it.
   * - `if_active`: evaluated when the site has an active constitution, run
   *   without one.
   */
  constitution: 'required' | 'if_active';
  /**
   * When set, the constitution pinned to the run must have one of these
   * hashes (`sha256:<hex>`, as computed by the CMS over the canonical
   * evaluator list). Any other version, including a later edit, refuses the
   * call, so a tool can be bound to the exact rules it was reviewed against.
   */
  constitutionHashes?: readonly string[];
  /**
   * Builds the record the evaluators read, from the call's arguments and the
   * harness's facts. Values should be flat (strings, numbers, booleans): the
   * rule evaluators read top-level fields only. Defaults to the arguments.
   * The facts are added afterwards and win over any key of the same name.
   * Must be pure and synchronous: it runs on every decision.
   */
  record?: (args: Readonly<Record<string, unknown>>, facts: Readonly<ExternalActionFacts>) => Record<string, unknown>;
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
  /** Constitution evaluation before execution. Absent: not evaluated. */
  policy?: ExternalActionPolicy;
  handler: (args: Record<string, unknown>, context: ExternalActionContext) => Promise<unknown>;
}

/**
 * The `externalActions` seam: where a package outside the CMS hands over its
 * tool definitions.
 *
 * `tools()` is called once, inside `registerPlatformSeams()`. Every definition
 * is validated and registered right there, so a malformed or duplicate
 * definition fails the deployment entry at boot rather than a request later.
 * Unlike the other seams, a failure here is NOT absorbed: a tool that silently
 * failed to load would be a governance surprise, not a degraded feature.
 *
 * Default: no tools.
 */
export interface ExternalActionToolSource {
  tools(): readonly ExternalActionToolDefinition[];
}
