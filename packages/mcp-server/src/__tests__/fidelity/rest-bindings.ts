/**
 * Which REST body each ungoverned stdio mutation tool posts to (#716 review).
 *
 * Governed tools are compared with their canonical skill contract
 * (`validateAgentToolInput`). Ungoverned ones go straight to a REST route, and
 * that is where every field-dropping bug of #716 lived (`apply_schema` without
 * 12 field keys, `update_cdc_subscription` without `status`). Each entry names
 * the route; its body schema comes from `golden/rest-body-schemas.json`, which
 * `apps/cms/src/services/__tests__/mcp-rest-body-golden.test.ts` generates from
 * the exact Zod object the route parses with and pins against the live code.
 *
 * Every key of `UNGOVERNED_MUTATIONS` is in exactly one of the three tables
 * below; the suite fails on a tool in none, so a new tool cannot skip the check.
 */

export interface RestBody {
  /** `METHOD /path` under `/api/v1`, as keyed in `rest-body-schemas.json`. */
  route: string;
  /** Advertised arguments that become path segments, not body keys. */
  path?: string[];
  /** The advertised argument whose value IS the body (e.g. `update_collection.patch`). */
  body?: string;
}

/** Tools that send a JSON body a route validates with a Zod object. */
export const REST_BODIES: Readonly<Record<string, RestBody>> = {
  create_collection: { route: 'POST /collections' },
  update_collection: { route: 'PATCH /collections/:name', path: ['name'], body: 'patch' },
  upsert_field: { route: 'PUT /collections/:name/fields/:field', path: ['collection', 'field_name'] },
  apply_schema: { route: 'PUT /collections/:name/schema', path: ['name'] },
  // Not a mutation (a preview), but it shares `apply_schema`'s field input and
  // dropped the same keys, so it is held to the same body.
  diff_schema: { route: 'POST /collections/diff' },

  create_role: { route: 'POST /roles' },
  update_role: { route: 'PATCH /roles/:id', path: ['id'] },
  attach_role_policy: { route: 'POST /roles/:id/policies', path: ['id'] },
  assign_role_user: { route: 'POST /roles/:id/users', path: ['id'] },

  create_policy: { route: 'POST /policies' },
  update_policy: { route: 'PATCH /policies/:id', path: ['id'] },
  add_policy_permission: { route: 'POST /policies/:id/permissions', path: ['id'] },
  update_policy_permission: { route: 'PATCH /policies/:id/permissions/:permId', path: ['id', 'permId'] },
  attach_policy_user: { route: 'POST /policies/:id/users', path: ['id'] },

  attach_api_key_role: { route: 'POST /api-keys/:id/roles', path: ['id'] },
  attach_api_key_policy: { route: 'POST /api-keys/:id/policies', path: ['id'] },

  update_cdc_subscription: { route: 'PATCH /cdc/subscriptions/:id', path: ['id'] },
  cdc_subscription_replay: { route: 'POST /cdc/subscriptions/:id/replay', path: ['subscription_id'] },

  create_preset: { route: 'POST /presets' },
  update_preset: { route: 'PATCH /presets/:id', path: ['id'] },

  create_release: { route: 'POST /releases' },
  update_release: { route: 'PATCH /releases/:id', path: ['id'] },

  create_share: { route: 'POST /shares' },
  publish_extension: { route: 'POST /marketplace/publish' },
  register_materialization: { route: 'POST /materialize' },

  submit_review: { route: 'POST /editorial/:collection/:id/submit-review', path: ['collection', 'id'] },
  approve_content: { route: 'POST /editorial/:collection/:id/approve', path: ['collection', 'id'] },
  reject_content: { route: 'POST /editorial/:collection/:id/reject', path: ['collection', 'id'] },

  upsert_tm: { route: 'POST /tm' },
  update_tm: { route: 'PATCH /tm/:id', path: ['id'] },
  translate_text: { route: 'POST /tm/translate' },

  update_flow: { route: 'PATCH /flows/:id', path: ['id'] },
  update_intent: { route: 'PATCH /agent/intents/:id', path: ['id'] },
  update_team: { route: 'PATCH /teams/:id', path: ['id'] },
};

/**
 * Tools whose request carries no body (a DELETE, or a POST of `{}`) to a route
 * whose handler reads none. The suite proves the first half (what the tool
 * sends); the second was read from the handlers when this list was written.
 */
export const NO_BODY: ReadonlySet<string> = new Set([
  'delete_media',
  'delete_policy_permission',
  'delete_preset',
  'delete_release',
  'delete_tm',
  'detach_api_key_policy',
  'detach_api_key_role',
  'detach_policy_user',
  'detach_role_policy',
  'drop_materialization',
  'install_marketplace_extension',
  'pause_intent',
  'publish_release',
  'refresh_materialization',
  'remove_role_user',
  'resume_intent',
  'revoke_share',
  'scan_intent',
]);

/**
 * Tools that forward a caller-supplied document verbatim to a route that does
 * not validate it with a Zod object. Nothing is dropped (the tool does not
 * enumerate keys), and nothing here is compared.
 */
export const OPAQUE_BODY: Readonly<Record<string, string>> = {
  apply_access_import: 'manifest forwarded as-is; AccessImportService validates it (dry-run reports errors)',
  restore_backup: 'raw NDJSON text, not JSON; the restore route parses it line by line',
};

/**
 * Accepted shape gaps between a tool and its route, each with the reason it is
 * deliberate. Format: `<tool> <kind> <path>` as `shapeMismatches` reports it.
 * The suite fails when an entry no longer matches a real gap.
 */
export const ACCEPTED_SHAPE_GAPS: Readonly<Record<string, string>> = {
  'apply_schema server-only name':
    'the collection is named by the URL; the body `name` exists only to refuse a rename (COLLECTION_RENAME_UNSUPPORTED)',
};

/**
 * Accepted value gaps: a top-level body key where a value the tool advertises
 * as valid is refused by the route's body schema. Format: `<tool> /<key>`, as
 * the differential probe reports it. The suite fails when an entry stops
 * matching a real refusal.
 */
export const ACCEPTED_VALUE_GAPS: Readonly<Record<string, string>> = {
  'update_intent /rules':
    'the rule DSL (a discriminated union) lives in IntentService, which apps/cms does not export to this package; ' +
    'the canonical createIntent contract keeps `rules` an open record list by the same decision, and the route ' +
    'answers a malformed rule with a 400 naming it',
  'update_intent /maintenanceWindow':
    'same as /rules: `{ tz, windows[] }` is validated by IntentService; advertised as an open record',
};
