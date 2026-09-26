import { z } from 'zod';
import { CdcOperationSchema, CdcSubscriptionKindSchema } from '../schemas/cdc-feed';

/**
 * Nguồn schema **chuẩn duy nhất** cho agent tool (governed MCP contract, #454).
 *
 * Vì sao tồn tại: trước đây `tools/list` quảng bá `{type:'object'}` cho mọi tool
 * và harness **không validate gì**, nên `createItem {}` vẫn tới được
 * `ItemService.create(undefined, …)` và `deleteItem {}` vẫn park được một
 * approval không thể thực thi. Hai transport lại có hai bộ schema rời nhau —
 * stdio validate bằng Zod riêng, HTTP MCP không validate.
 *
 * File này là **một** định nghĩa cho cả hai:
 *   - harness CMS validate `args` trước mọi side effect (`AgentToolSchemas`);
 *   - `tools/list` quảng bá JSON Schema suy ra từ đúng Zod đó (`jsonSchemaFor`).
 *
 * Nguyên tắc khi thêm schema mới:
 *   1. Chỉ khai field mà **handler thật sự đọc**. Khai rộng hơn handler là hứa
 *      một contract không được tôn trọng (xem ca `create_collection` quảng bá 18
 *      property nhưng handler đọc 2).
 *   2. `.strict()` để field lạ bị **từ chối** thay vì rụng âm thầm — chính lớp
 *      lỗi của `update_item` (REST strip key ngoài envelope ⇒ 200 OK, patch rỗng).
 *   3. Giữ nguyên tên key mà handler đọc. Cần đổi tên thì làm ở tầng alias
 *      mapping, không phải ở đây.
 */

/** Tên collection/field: snake_case, khớp validator của REST. */
const slug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'phải là snake_case bắt đầu bằng chữ thường');

const id = z.string().min(1);
const record = z.record(z.string(), z.unknown());

/**
 * Outbound webhook fields, mirroring `webhookSchema` in `apps/cms/src/routes/webhooks.ts`.
 *
 * The route's `.default()`s are written as `.optional()` here on purpose: the
 * harness validates but forwards the caller's own `args`, so a default would only
 * describe what REST does, not what the skill receives. The columns carry the
 * same defaults (`[]`, `[]`, `{}`, `'active'`) at the DB level.
 */
const webhookInput = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url(),
  actions: z.array(z.string()).optional(),
  collections: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  secret: z.string().nullable().optional(),
});

/** Extension slot types, matching `EXTENSION_TYPES` in `apps/cms/src/routes/extensions.ts`. */
const EXTENSION_TYPES = ['interface', 'display', 'layout', 'panel', 'module', 'hook', 'endpoint'] as const;

/**
 * Same protocol gate as `bundleUrlSchema` in `apps/cms/src/routes/extensions.ts`:
 * `https:`/`http:`, or `data:text/javascript`. Without it the skill would persist a
 * `javascript:` bundle URL that `POST /extensions` refuses.
 */
const extensionBundleUrl = z
  .string()
  .min(1)
  .refine(
    (raw) => {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return false;
      }
      if (url.protocol === 'https:' || url.protocol === 'http:') return true;
      if (url.protocol === 'data:') return url.pathname.startsWith('text/javascript');
      return false;
    },
    { message: 'bundleUrl must be an https:, http:, or data:text/javascript URL.' },
  );

/** Fields `ExtensionsService.installExtension` writes (`ExtensionInput`). */
const extensionInput = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_:-]+$/)
    .optional(),
  name: z.string().min(1),
  version: z.string().min(1),
  type: z.enum(EXTENSION_TYPES),
  enabled: z.boolean().optional(),
  bundleUrl: extensionBundleUrl,
  manifest: z.record(z.string(), z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
});

/** Canonical flow node, the runtime `FlowNode` shape (`schemas/flow-graph.ts`). */
const flowNode = z.object({
  id: z.string(),
  key: z.string(),
  options: record.optional(),
  next: z.string().nullable().optional(),
  onError: z.string().nullable().optional(),
});

/** Standard 5-field cron — the same pattern `intentInputSchema` enforces. */
const CRON_5_FIELD = /^(\S+\s+){4}\S+$/;

/**
 * Schema theo **tên skill** trong `CORE_SKILLS`.
 *
 * Chỉ phủ các skill **ghi** — đó là chỗ validation ngăn được side effect. Skill
 * đọc chưa có schema thì harness bỏ qua validation (fail-open **có chủ ý**, để
 * không phá hành vi read đang chạy); xem `requiresValidation` bên dưới.
 */
export const AgentToolSchemas = {
  // ── items ────────────────────────────────────────────────────────────────
  createItem: z
    .object({
      collection: slug,
      data: record,
      status: z.enum(['draft', 'published']).optional(),
    })
    .strict(),
  updateItem: z
    .object({
      collection: slug,
      id,
      data: record,
      status: z.enum(['draft', 'published', 'archived']).optional(),
    })
    .strict(),
  deleteItem: z.object({ collection: slug, id }).strict(),

  // ── schema ───────────────────────────────────────────────────────────────
  createCollection: z.object({ name: slug, singleton: z.boolean().optional() }).strict(),
  deleteCollection: z.object({ name: slug }).strict(),
  createField: z
    .object({
      collection: slug,
      name: slug,
      type: z.string().min(1),
      required: z.boolean().optional(),
      /** Forwarded to `FieldInput.interface`; defaults to `'input'`. */
      interface: z.string().min(1).optional(),
      note: z.string().nullable().optional(),
    })
    .strict(),
  deleteField: z
    .object({
      collection: slug,
      name: slug,
      /**
       * Forwarded to `SchemaService.deleteField`'s `FieldDeleteOptions.force`,
       * which is what `DELETE …/fields/:field?force=true` uses. Declared because
       * the handler honours it — omitting it would have made the governed path
       * reject an argument REST accepts.
       */
      force: z.boolean().optional(),
    })
    .strict(),
  /**
   * The handler passes `args` straight to `SchemaService.createRelation`, which
   * takes the whole `RelationInput`; this mirrors `relationInputSchema` in
   * `routes/relations.ts` field for field. Strict matters beyond hygiene here: the
   * service spreads its input into the insert, so an unlisted key such as `id`
   * would otherwise reach the row.
   */
  createRelation: z
    .object({
      manyCollection: z.string().min(1),
      manyField: z.string().min(1),
      oneCollection: z.string().min(1),
      oneField: z.string().nullable().optional(),
      junctionCollection: z.string().nullable().optional(),
      type: z.enum(['m2o', 'o2m', 'm2m', 'm2a']).optional(),
      aliasField: z.string().nullable().optional(),
      relatedDisplayTemplate: z.string().nullable().optional(),
      junctionManyField: z.string().nullable().optional(),
      junctionOneField: z.string().nullable().optional(),
      sortField: z.string().nullable().optional(),
      onDelete: z.enum(['restrict', 'cascade', 'set null', 'no action']).optional(),
      meta: record.optional(),
    })
    .strict(),
  deleteRelation: z.object({ id }).strict(),

  // ── access ───────────────────────────────────────────────────────────────
  createRole: z
    .object({
      name: z.string().min(1).max(128),
      key: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      parentId: z.string().nullable().optional(),
      adminAccess: z.boolean().optional(),
      appAccess: z.boolean().optional(),
    })
    .strict(),
  deleteRole: z.object({ id }).strict(),
  createPolicy: z
    .object({
      name: z.string().min(1).max(128),
      key: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      icon: z.string().nullable().optional(),
      adminAccess: z.boolean().optional(),
      appAccess: z.boolean().optional(),
      rules: z.unknown().optional(),
    })
    .strict(),
  deletePolicy: z.object({ id }).strict(),

  // ── automation ───────────────────────────────────────────────────────────
  /**
   * The six columns the handler inserts, with the shapes of `flowSchema` in
   * `routes/flows.ts`. `graph` and its nodes stay non-strict like the route's: the
   * runtime `FlowNode` carries editor keys such as `position`.
   *
   * This validates the input only. `POST /flows` additionally refuses an `active`
   * flow whose graph does not validate, requires a cron for an active schedule
   * trigger and computes `nextRunAt`; the handler does none of that, which is why
   * the stdio `create_flow` tool is not routed here (see `governed.ts`).
   */
  createFlow: z
    .object({
      name: z.string().min(1),
      description: z.string().optional(),
      status: z.enum(['active', 'inactive', 'draft']).optional(),
      triggerType: z.enum(['webhook', 'event', 'schedule', 'manual']),
      triggerOptions: record.optional(),
      graph: z.object({
        entry: z.string().optional(),
        nodes: z.array(flowNode).optional(),
      }),
    })
    .strict(),
  deleteFlow: z.object({ id }).strict(),
  runFlow: z.object({ id, input: record.optional() }).strict(),
  /**
   * Top-level constraints of `intentInputSchema` (`services/intent-service.ts`).
   * `IntentService.create` re-parses with that schema, so the rule union, `budget`
   * and `maintenanceWindow` internals are checked there; this layer refuses what
   * can be refused without duplicating the rule DSL — unknown keys, a missing or
   * empty rule list, a malformed cron — before an approval can be parked for it.
   */
  createIntent: z
    .object({
      name: z.string().min(1).max(120),
      collection: z.string().min(1).max(120),
      rules: z.array(record).min(1).max(50),
      schedule: z.string().regex(CRON_5_FIELD, 'schedule must be a 5-field cron expression'),
      budget: record.optional(),
      autonomyCap: z.number().int().min(0).max(4).optional(),
      maintenanceWindow: record.nullable().optional(),
    })
    .strict(),
  deleteIntent: z.object({ id }).strict(),

  // ── config ───────────────────────────────────────────────────────────────
  upsertSetting: z.object({ key: z.string().min(1), value: z.unknown(), scope: z.string().optional() }).strict(),
  deleteSetting: z.object({ key: z.string().min(1) }).strict(),
  createTranslation: z
    .object({
      language: z.string().min(1),
      namespace: z.string().min(1),
      key: z.string().min(1),
      value: z.string(),
      status: z.string().optional(),
    })
    .strict(),
  /**
   * `ConfigService.updateTranslation` spreads the patch into `.set()`, so without
   * `.strict()` a `siteId` key would reach the UPDATE.
   */
  updateTranslation: z
    .object({
      id,
      language: z.string().min(1).optional(),
      namespace: z.string().min(1).optional(),
      key: z.string().min(1).optional(),
      value: z.string().optional(),
      status: z.string().optional(),
    })
    .strict(),
  deleteTranslation: z.object({ id }).strict(),
  createWebhook: webhookInput.strict(),
  /**
   * `ConfigService.updateWebhook` hands the patch to `.set()` verbatim — the same
   * `siteId` exposure as `updateTranslation`, closed the same way.
   */
  updateWebhook: webhookInput.partial().extend({ id }).strict(),
  deleteWebhook: z.object({ id }).strict(),

  // ── api keys / users / teams ──────────────────────────────────────────────
  createApiKey: z
    .object({
      name: z.string().min(1).max(96),
      description: z.string().max(512).optional(),
      expiresAt: z.string().nullable().optional(),
      metadata: record.optional(),
    })
    .strict(),
  rotateApiKey: z.object({ id, expiresAt: z.string().nullable().optional() }).strict(),
  revokeApiKey: z.object({ id }).strict(),
  inviteUser: z.object({ email: z.string().email(), roleId: z.string().optional() }).strict(),
  updateUser: z
    .object({ id, roleId: z.string().nullable().optional(), status: z.string().optional() })
    .strict(),
  removeUser: z.object({ id }).strict(),
  createTeam: z.object({ name: z.string().min(1).max(128), description: z.string().nullable().optional() }).strict(),
  deleteTeam: z.object({ id }).strict(),
  addTeamMember: z.object({ teamId: id, userId: id }).strict(),
  removeTeamMember: z.object({ teamId: id, userId: id }).strict(),

  // ── extensions ───────────────────────────────────────────────────────────
  /**
   * Input only. `POST /extensions` also verifies the bundle signature, refuses the
   * reserved `lumibase-*` namespace without an official signature and checks the
   * per-action `extensions:*` permissions; `ExtensionsService` does none of that,
   * so the stdio tool stays on REST (see `governed.ts`).
   */
  installExtension: extensionInput.strict(),
  /**
   * `ExtensionsService.updateExtension` hands the patch to `.set()` verbatim, so
   * before this schema `siteId` (null means "global"), `isOfficial` or
   * `verifiedAt` could reach the UPDATE. Strict closes that.
   */
  updateExtension: extensionInput.partial().extend({ id }).strict(),
  uninstallExtension: z.object({ id }).strict(),

  // ── cdc ──────────────────────────────────────────────────────────────────
  /**
   * What the handler reads before it re-parses with `CdcSubscriptionCreateSchema`.
   * `payload_mode` is absent on purpose: the handler never forwards it, so
   * declaring it would accept a `snapshot` request and create a `reference`
   * subscription.
   */
  createCdcSubscription: z
    .object({
      name: z.string().min(1).max(128),
      kind: CdcSubscriptionKindSchema,
      collections: z.array(z.string().min(1)).optional(),
      operations: z.array(CdcOperationSchema).optional(),
      webhookId: z.string().min(1).optional(),
      extensionName: z.string().min(1).optional(),
    })
    .strict()
    .superRefine((sub, ctx) => {
      // Same conditional requirements as `CdcSubscriptionCreateSchema`, raised
      // here so the call is refused before an approval is parked for it.
      if (sub.kind === 'webhook' && !sub.webhookId) {
        ctx.addIssue({ code: 'custom', path: ['webhookId'], message: 'webhookId is required for kind=webhook' });
      }
      if (sub.kind === 'extension' && !sub.extensionName) {
        ctx.addIssue({
          code: 'custom',
          path: ['extensionName'],
          message: 'extensionName is required for kind=extension',
        });
      }
    }),
  replayCdcSubscription: z
    .object({ subscriptionId: id, occurredAfter: z.string().optional() })
    .strict(),
  deleteCdcSubscription: z.object({ subscriptionId: id }).strict(),
} as const satisfies Record<string, z.ZodType>;

export type AgentToolName = keyof typeof AgentToolSchemas;

/** Có schema chuẩn cho skill này không? */
export function hasAgentToolSchema(name: string): name is AgentToolName {
  return Object.hasOwn(AgentToolSchemas, name);
}

/**
 * Validate `args` của một skill.
 *
 * Trả `{ ok: true, data }` hoặc `{ ok: false, issues }` — **không throw**, để
 * caller quyết định biến nó thành `denied` có cấu trúc thay vì để lỗi rò ra
 * client dưới dạng stack trace.
 */
export function validateAgentToolInput(
  name: string,
  args: unknown,
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: Array<{ path: string; message: string }> } {
  if (!hasAgentToolSchema(name)) return { ok: true, data: (args ?? {}) as Record<string, unknown> };
  const parsed = AgentToolSchemas[name].safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    })),
  };
}

/** JSON Schema để quảng bá trên `tools/list`, suy ra từ đúng Zod ở trên. */
export function jsonSchemaFor(name: string): Record<string, unknown> | undefined {
  if (!hasAgentToolSchema(name)) return undefined;
  const json = z.toJSONSchema(AgentToolSchemas[name], { io: 'input' }) as Record<string, unknown>;
  // Bỏ `$schema` — MCP `tools/list` chỉ cần bản thân object schema.
  const { $schema: _drop, ...rest } = json;
  return rest;
}

/** Mọi tên skill đã có schema chuẩn. */
export function agentToolNamesWithSchema(): AgentToolName[] {
  return Object.keys(AgentToolSchemas) as AgentToolName[];
}
