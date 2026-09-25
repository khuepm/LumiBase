import { z } from 'zod';

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
  deleteFlow: z.object({ id }).strict(),
  runFlow: z.object({ id, input: record.optional() }).strict(),
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
  deleteTranslation: z.object({ id }).strict(),
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
  uninstallExtension: z.object({ id }).strict(),

  // ── cdc ──────────────────────────────────────────────────────────────────
  replayCdcSubscription: z
    .object({ subscriptionId: id, occurredAfter: z.string().optional() })
    .strict(),
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
