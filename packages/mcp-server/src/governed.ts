import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpUnavailableError, type LumiBaseClient } from './client.js';
import { asGovernedDecision, fail, renderDecision } from './tools/_shared.js';

/**
 * Routing a stdio tool call through the governed harness instead of plain REST
 * (#454).
 *
 * The defect. This package registers ~161 tools that each call a REST endpoint
 * directly. REST enforces RBAC, so the calls are authorized — but the agent
 * governance layer (kill switch, autonomy/trust gradient, HITL approval, veto
 * window, `agent_runs` / `agent_tool_calls` audit) lives in the harness behind
 * `POST /api/v1/mcp`, and nothing on this transport ever reached it. The same
 * logical operation was therefore governed over HTTP MCP and ungoverned over
 * stdio.
 *
 * What is routed, and why not everything. A tool can only be routed when a
 * canonical skill accepts the arguments it advertises. That was measured, not
 * assumed: each candidate tool's advertised properties were compared against the
 * canonical contract in `@lumibase/contracts` (`AgentToolSchemas`). Tools whose
 * advertised surface exceeds the contract would have their extra arguments
 * REJECTED once routed — silently dropping them is the exact class of bug this
 * change exists to remove — so they stay on REST and are listed in
 * {@link UNGOVERNED_MUTATIONS} with the reason. `governed-inventory.test.ts`
 * fails if a mutation tool appears in neither table, so the gap cannot grow
 * quietly.
 */

export interface GovernedBinding {
  /** Canonical skill name executed by the harness. */
  skill: string;
  /**
   * stdio argument name → skill argument name, for the cases where the two
   * surfaces genuinely disagree. Everything else is snake_case → camelCase.
   */
  rename?: Record<string, string>;
}

/**
 * Tools routed through the governed harness.
 *
 * Every entry was verified to satisfy: a skill with the same token set exists,
 * the canonical contract has a schema for it, the advertised arguments (minus
 * `confirm`) map into that schema's properties, and no required property is
 * unreachable from the advertised set.
 */
export const GOVERNED_TOOLS: Readonly<Record<string, GovernedBinding>> = {
  // ── items ────────────────────────────────────────────────────────────────
  create_item: { skill: 'createItem' },
  update_item: { skill: 'updateItem' },
  delete_item: { skill: 'deleteItem' },

  // ── schema ───────────────────────────────────────────────────────────────
  delete_collection: { skill: 'deleteCollection' },
  // `field_name` is this transport's name for the field; the skill reads `name`.
  // Renamed explicitly rather than dropped (see repro R17).
  delete_field: { skill: 'deleteField', rename: { field_name: 'name' } },
  delete_relation: { skill: 'deleteRelation' },

  // ── access ───────────────────────────────────────────────────────────────
  delete_role: { skill: 'deleteRole' },
  delete_policy: { skill: 'deletePolicy' },

  // ── automation ───────────────────────────────────────────────────────────
  delete_flow: { skill: 'deleteFlow' },
  run_flow: { skill: 'runFlow' },
  delete_intent: { skill: 'deleteIntent' },

  // ── config ───────────────────────────────────────────────────────────────
  upsert_setting: { skill: 'upsertSetting' },
  delete_setting: { skill: 'deleteSetting' },
  create_translation: { skill: 'createTranslation' },
  delete_translation: { skill: 'deleteTranslation' },
  delete_webhook: { skill: 'deleteWebhook' },

  // ── api keys / users / teams ──────────────────────────────────────────────
  create_api_key: { skill: 'createApiKey' },
  rotate_api_key: { skill: 'rotateApiKey' },
  revoke_api_key: { skill: 'revokeApiKey' },
  invite_user: { skill: 'inviteUser' },
  update_user: { skill: 'updateUser' },
  remove_user: { skill: 'removeUser' },
  create_team: { skill: 'createTeam' },
  delete_team: { skill: 'deleteTeam' },
  // The team tools take the team as `id`; the skill names it `teamId` because it
  // also takes a `userId` and one bare `id` would be ambiguous.
  add_team_member: { skill: 'addTeamMember', rename: { id: 'teamId' } },
  remove_team_member: { skill: 'removeTeamMember', rename: { id: 'teamId' } },

  // ── extensions ───────────────────────────────────────────────────────────
  uninstall_extension: { skill: 'uninstallExtension' },
};

/**
 * Mutation tools that stay on REST, each with the measured reason.
 *
 * These are governance gaps, stated rather than hidden. Two shapes of reason:
 * `no-canonical-contract` (the skill has no entry in `AgentToolSchemas`, so
 * routing has nothing to validate against) and `contract-narrower-than-tool`
 * (routing would reject arguments the tool advertises today).
 */
export const UNGOVERNED_MUTATIONS: Readonly<Record<string, string>> = {
  // Skill exists, but the canonical contract is narrower than what this tool
  // advertises. Routing now would reject arguments callers legitimately send.
  create_collection: 'contract-narrower-than-tool: 16 advertised properties have no canonical counterpart',
  create_policy: 'contract-narrower-than-tool: enforceTfa/ipAllow/ipDeny/validFrom/validUntil',
  create_role: 'contract-narrower-than-tool: systemKey',
  cdc_subscription_replay: 'contract-narrower-than-tool: cursor has no canonical counterpart',

  // Skill exists but has no canonical input contract yet.
  create_cdc_subscription: 'no-canonical-contract',
  delete_cdc_subscription: 'no-canonical-contract',
  create_flow: 'no-canonical-contract',
  create_intent: 'no-canonical-contract',
  create_relation: 'no-canonical-contract',
  create_webhook: 'no-canonical-contract',
  update_webhook: 'no-canonical-contract',
  update_translation: 'no-canonical-contract',
  install_extension: 'no-canonical-contract',
  update_extension: 'no-canonical-contract',

  // No skill at all: nothing to route to. Listed so the set is closed.
  add_policy_permission: 'no-skill',
  apply_access_import: 'no-skill',
  apply_schema: 'no-skill',
  approve_content: 'no-skill',
  assign_role_user: 'no-skill',
  attach_api_key_policy: 'no-skill',
  attach_api_key_role: 'no-skill',
  attach_policy_user: 'no-skill',
  attach_role_policy: 'no-skill',
  compile_intent: 'no-skill',
  create_preset: 'no-skill',
  create_release: 'no-skill',
  create_share: 'no-skill',
  delete_media: 'no-skill',
  delete_policy_permission: 'no-skill',
  delete_preset: 'no-skill',
  delete_release: 'no-skill',
  delete_tm: 'no-skill',
  detach_api_key_policy: 'no-skill',
  detach_api_key_role: 'no-skill',
  detach_policy_user: 'no-skill',
  detach_role_policy: 'no-skill',
  drop_materialization: 'no-skill',
  install_marketplace_extension: 'no-skill',
  publish_extension: 'no-skill',
  publish_release: 'no-skill',
  refresh_materialization: 'no-skill',
  reject_content: 'no-skill',
  remove_role_user: 'no-skill',
  restore_backup: 'no-skill',
  revoke_share: 'no-skill',
  run_panel: 'no-skill',
  submit_review: 'no-skill',
  translate_text: 'no-skill',
  update_cdc_subscription: 'no-skill',
  update_collection: 'no-skill',
  update_flow: 'no-skill',
  update_intent: 'no-skill',
  update_policy: 'no-skill',
  update_policy_permission: 'no-skill',
  update_preset: 'no-skill',
  update_release: 'no-skill',
  update_role: 'no-skill',
  update_team: 'no-skill',
  update_tm: 'no-skill',
  upsert_field: 'no-skill',
  upsert_tm: 'no-skill',
};

/**
 * Tool names that change state.
 *
 * Lives here rather than in the test that used to own it, because two places now
 * depend on the answer: the inventory tripwire, and the fail-closed refusal in
 * mode `on`. Two copies of this regex would drift, and the copy that drifted
 * would be the one deciding whether a write is allowed.
 *
 * Deliberately matched on the verb rather than looked up in
 * {@link UNGOVERNED_MUTATIONS}: a mutation tool added tomorrow and forgotten in
 * both tables must be refused by mode `on`, not waved through. The tripwire
 * catches it in CI; this catches it at runtime if CI did not.
 */
const MUTATION_VERB =
  /^(create|update|delete|remove|upsert|set|add|attach|detach|revoke|rotate|invite|install|uninstall|enable|disable|publish|unpublish|promote|apply|run|trigger|restore|replay|drop|materialize|reset|assign|unassign|approve|reject|submit|claim|decide|import|veto|freeze|lift|seed|sync|purge|bump|stage|commit|schedule|cancel|retry|archive|clone|duplicate|move|rename|reorder|translate|compile|generate|refresh|configure)/;

/** Mutations whose name does not start with a mutation verb. */
const MUTATION_EXCEPTIONS = new Set(['cdc_subscription_replay']);

/** True when calling `name` can change state. */
export function isMutationTool(name: string): boolean {
  return MUTATION_EXCEPTIONS.has(name) || MUTATION_VERB.test(name);
}

/** stdio arguments that exist for the operator, not for the skill. */
const PROMPT_ONLY_ARGS = new Set(['confirm']);

const camel = (key: string): string => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/** Translates advertised stdio arguments into canonical skill arguments. */
export function toSkillArgs(
  args: Record<string, unknown>,
  binding: GovernedBinding,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (PROMPT_ONLY_ARGS.has(key)) continue;
    // `undefined` would be rejected by a `.strict()` optional field check on the
    // server; an absent key and an explicit `undefined` must stay equivalent.
    if (value === undefined) continue;
    out[binding.rename?.[key] ?? camel(key)] = value;
  }
  return out;
}

export type GovernedMode = 'auto' | 'on' | 'off';

/**
 * Reads the mode from the environment.
 *
 * `auto` (default) probes the endpoint once and uses governance when the site
 * has it enabled, warning on stderr when it does not. `on` refuses to fall back
 * — the right setting for a deployment that requires governance. `off` keeps the
 * pre-#454 REST behaviour.
 *
 * `auto` is a convenience, not a security property: the fallback it performs is
 * announced, but a deployment that must not execute ungoverned writes has to set
 * `on`. `contentOs.mcp` also defaults off, which is why `auto` rather than `on`
 * is the default here — defaulting to `on` would break every existing install on
 * upgrade.
 */
export function governedModeFromEnv(env: Record<string, string | undefined> = process.env): GovernedMode {
  const raw = (env['LUMIBASE_MCP_GOVERNED'] ?? 'auto').toLowerCase();
  if (raw === 'true' || raw === 'on' || raw === '1') return 'on';
  if (raw === 'false' || raw === 'off' || raw === '0') return 'off';
  return 'auto';
}

export interface GovernedDispatcherOptions {
  mode?: GovernedMode;
  /** Injected for tests; defaults to `console.error` (stderr, never stdout). */
  warn?: (message: string) => void;
}

/**
 * Decides once whether governance is reachable, then routes or falls back.
 *
 * The probe is cached for the process: a stdio server is a long-lived child
 * process and re-probing on every tool call would add a round-trip to each one.
 */
export class GovernedDispatcher {
  private readonly mode: GovernedMode;
  private readonly warn: (message: string) => void;
  private available: Promise<boolean> | undefined;

  constructor(
    private readonly client: LumiBaseClient,
    options: GovernedDispatcherOptions = {},
  ) {
    this.mode = options.mode ?? governedModeFromEnv();
    // stdout is the MCP transport. Anything written there corrupts the protocol
    // stream, so diagnostics go to stderr.
    this.warn = options.warn ?? ((message) => console.error(message));
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /**
   * True when this deployment requires every mutation to go through governance.
   *
   * Read by the registration wrapper to refuse mutations that have no governed
   * mapping. Without it, mode `on` only governed the 27 mapped tools and left the
   * rest on REST — so the setting that exists to guarantee governance did not,
   * and the guarantee failed silently for exactly the calls nobody had mapped
   * yet.
   */
  get requiresGovernance(): boolean {
    return this.mode === 'on';
  }

  /**
   * The refusal returned for a mutation that cannot be governed.
   *
   * Names the reason from {@link UNGOVERNED_MUTATIONS} when there is one, so the
   * operator can tell "we know about this gap" from "nobody classified this tool".
   */
  refuseUngoverned(tool: string): CallToolResult {
    const reason = UNGOVERNED_MUTATIONS[tool];
    return {
      content: [
        {
          type: 'text',
          text:
            `Refused: "${tool}" changes state but has no governed mapping, and ` +
            'LUMIBASE_MCP_GOVERNED=on requires every mutation to run through the agent ' +
            'harness (autonomy levels, HITL approval, kill switch, run audit).\n' +
            (reason
              ? `Known gap: ${reason}.\n`
              : 'This tool is in neither the governed nor the declared-ungoverned table, ' +
                'which means it was added without a governance decision.\n') +
            'Set LUMIBASE_MCP_GOVERNED=auto or off to accept ungoverned REST calls for it.',
        },
      ],
      isError: true,
    };
  }

  /** True when the governed endpoint answered a probe. */
  private probe(): Promise<boolean> {
    // Wrapped in an async IIFE rather than `.then().catch()`: a client whose
    // `jsonRpc` is missing throws SYNCHRONOUSLY, and a synchronous throw never
    // reaches a `.catch` attached to the call expression.
    this.available ??= (async () => {
      try {
        await this.client.jsonRpc('tools/list');
        return true;
      } catch (err: unknown) {
        // Any probe failure means unavailable, including ones that are not the
        // feature flag. Treating an unknown failure as "available" would make
        // every subsequent call fail instead of degrading — worse for `auto`, and
        // for `on` the refusal below is what the operator asked for anyway.
        if (this.mode === 'on') return false;
        this.warn(
          err instanceof McpUnavailableError
            ? '[lumibase-mcp] governed tool calls unavailable: this site has contentOs.mcp disabled. ' +
                'Falling back to direct REST calls, which skip agent governance ' +
                '(autonomy levels, HITL approval, kill switch, run audit). ' +
                'Set LUMIBASE_MCP_GOVERNED=on to refuse instead of falling back.'
            : `[lumibase-mcp] governed endpoint probe failed (${
                err instanceof Error ? err.message : String(err)
              }); falling back to direct REST calls, which skip agent governance. ` +
                'Set LUMIBASE_MCP_GOVERNED=on to refuse instead of falling back.',
        );
        return false;
      }
    })();
    return this.available;
  }

  /**
   * Runs `tool` through the harness.
   *
   * @returns the rendered tool result, or `undefined` when the caller should run
   * its own REST handler instead (mode `auto` with governance unavailable).
   */
  async dispatch(
    tool: string,
    args: Record<string, unknown>,
    binding: GovernedBinding,
  ): Promise<CallToolResult | undefined> {
    if (!this.enabled) return undefined;

    if (!(await this.probe())) {
      if (this.mode === 'on') {
        // Fail closed. A fallback that triggers exactly when governance is
        // unavailable would be a bypass of governance, which is the opposite of
        // what `on` asks for.
        return {
          content: [
            {
              type: 'text',
              text:
                `Refused: "${tool}" must run through the governed harness, but this site has ` +
                'contentOs.mcp disabled. Enable it, or set LUMIBASE_MCP_GOVERNED=off to accept ' +
                'ungoverned REST calls.',
            },
          ],
          isError: true,
        };
      }
      return undefined;
    }

    try {
      const result = await this.client.jsonRpc<{
        content?: Array<{ type: 'text'; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      }>('tools/call', { name: binding.skill, arguments: toSkillArgs(args, binding) });

      const decision = asGovernedDecision(result?.structuredContent);
      if (decision) return renderDecision(decision, `${tool} executed.`);
      // Shape we did not expect: return it verbatim rather than inventing a
      // success sentence for it.
      return {
        content: result?.content ?? [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }],
        ...(result?.isError === undefined ? {} : { isError: result.isError }),
      };
    } catch (err) {
      return fail(err);
    }
  }
}
