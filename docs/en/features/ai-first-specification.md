# Đặc tả Kỹ thuật: Phát triển AI-First CMS Engine cho Lumibase

Tài liệu này cung cấp hướng dẫn lập trình chi tiết, thiết kế kiến trúc, ranh giới mã nguồn và cấu trúc API/Database để các **AI Agent** khác có thể độc lập triển khai các mảnh ghép của hệ thống **AI-First CMS Engine** trên Lumibase mà không gây xung đột code.

---

## 1. Ranh giới Phân chia Công việc (Task Breakdown for Agents)

Hệ thống được chia làm 4 Module độc lập. Mỗi Agent có thể nhận 1 Module để lập trình:

| Module | Tên Công việc | Tệp tin Tác động | Trách nhiệm |
|---|---|---|---|
| **Module A** | Database & HITL Approvals | `packages/database/src/schema/platform.ts` | Tạo bảng `ai_approvals` và viết các migrations tương ứng. |
| **Module B** | AI Secure Harness Service | `apps/cms/src/services/ai-harness.ts` | Triển khai bộ khung kiểm tra Capabilities, phân tích payload và xử lý chặn duyệt HITL. |
| **Module C** | AI HTTP API Routes | `apps/cms/src/routes/ai.ts` | Tạo các endpoints `/ai/chat`, `/ai/approvals` để Studio tương tác. |
| **Module D** | Studio AI Assistant & Approvals UI | `apps/studio/src/...` | Giao diện Chat Assistant nổi và màn hình phê duyệt hành động của AI. |

---

## 2. Chi tiết Kỹ thuật từng Module

### ── Module A: Database Schema cho AI Approvals (HITL) ──

Để đảm bảo an toàn tuyệt đối, các hành động nguy hiểm của AI (như sửa schema, xóa dữ liệu) phải được lưu vào hàng đợi chờ duyệt (HITL - Human in the Loop).

#### Bảng `ai_approvals`
Được định nghĩa trong `packages/database/src/schema/platform.ts` (hoặc tạo file mới `ai.ts` cùng thư mục):

```typescript
import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

export const aiApprovals = pgTable(
  'ai_approvals',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    agentName: text('agent_name').default('lumibase-copilot').notNull(),
    skillName: text('skill_name').notNull(),
    /** Lưu trữ đối số của hàm AI định gọi dưới dạng JSON (ví dụ: { name: 'posts', fields: [...] }) */
    arguments: jsonb('arguments').notNull(),
    /** Trạng thái duyệt: 'pending' | 'approved' | 'rejected' */
    status: text('status').default('pending').notNull(),
    /** Lý do hoặc ngữ cảnh yêu cầu của AI (để hiển thị cho admin) */
    context: text('context'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    decidedAt: timestamp('decided_at'),
    decidedBy: text('decided_by').references(() => users.id),
  },
  (t) => ({
    siteIdx: index('ai_approvals_site_idx').on(t.siteId, t.status),
  })
);
```

**Yêu cầu đối với Agent Module A:**
1. Khai báo bảng `aiApprovals` và export tại `packages/database/src/schema/index.ts`.
2. Chạy lệnh: `DATABASE_URL=... pnpm --filter @lumibase/database generate` để sinh file migration.
3. Chạy `pnpm --filter @lumibase/database migrate` để áp dụng vào PostgreSQL.

---

### ── Module B: AI Secure Harness Service ──

Harness là bộ não điều phối an toàn. Nó nhận yêu cầu gọi Skill từ AI, kiểm tra quyền hạn (Capabilities) và quyết định thực thi hay tạm giữ chờ duyệt.

#### Vị trí file: `apps/cms/src/services/ai-harness.ts`

```typescript
import type { Database } from '@lumibase/database';
import { aiApprovals } from '@lumibase/database';
import { CORE_SKILLS } from '@lumibase/ai-skills';
import { eq, and } from 'drizzle-orm';

export interface HarnessExecutionResult {
  status: 'executed' | 'pending_approval' | 'denied';
  data?: any;
  approvalId?: string;
  message?: string;
}

export class AISecureHarness {
  constructor(private db: Database, private siteId: string) {}

  /**
   * Đánh giá và thực thi một skill do AI yêu cầu.
   */
  async execute(
    skillName: string,
    args: Record<string, any>,
    userCapabilities: string[],
    contextMessage?: string
  ): Promise<HarnessExecutionResult> {
    const skill = CORE_SKILLS[skillName];
    if (!skill) {
      return { status: 'denied', message: `Skill ${skillName} không tồn tại.` };
    }

    // 1. Kiểm tra quyền của User/Session so với yêu cầu của Skill
    const hasCapabilities = skill.requiredCapabilities.every((cap) =>
      userCapabilities.includes(cap) || userCapabilities.includes('*')
    );

    if (!hasCapabilities) {
      return { status: 'denied', message: `Thiếu quyền (Capabilities) để thực hiện hành động này.` };
    }

    // 2. Phân loại mức độ rủi ro (Risk Evaluation)
    // Các skill làm thay đổi Schema hoặc Xóa dữ liệu bắt buộc phải duyệt (HITL)
    const requiresApproval = 
      skill.requiredCapabilities.includes('schema:write') || 
      skillName.startsWith('delete');

    if (requiresApproval) {
      // Ghi nhận vào hàng đợi chờ duyệt trong DB
      const [approval] = await this.db
        .insert(aiApprovals)
        .values({
          siteId: this.siteId,
          skillName,
          arguments: args,
          status: 'pending',
          context: contextMessage,
        })
        .returning();

      return {
        status: 'pending_approval',
        approvalId: approval.id,
        message: `Hành động này cần sự phê duyệt của quản trị viên hệ thống.`,
      };
    }

    // 3. Thực thi trực tiếp các skill an toàn (Ví dụ: Read hoặc List)
    const result = await this.runSkillDirectly(skillName, args);
    return { status: 'executed', data: result };
  }

  /**
   * Thực thi trực tiếp sau khi đã được phê duyệt.
   */
  async executeApproved(approvalId: string, userId: string): Promise<HarnessExecutionResult> {
    const [approval] = await this.db
      .select()
      .from(aiApprovals)
      .where(and(eq(aiApprovals.id, approvalId), eq(aiApprovals.siteId, this.siteId)))
      .limit(1);

    if (!approval || approval.status !== 'pending') {
      return { status: 'denied', message: 'Yêu cầu không hợp lệ hoặc đã được xử lý.' };
    }

    // Thực thi trực tiếp
    const data = await this.runSkillDirectly(approval.skillName, approval.arguments as Record<string, any>);

    // Cập nhật trạng thái duyệt
    await this.db
      .update(aiApprovals)
      .set({
        status: 'approved',
        decidedAt: new Date(),
        decidedBy: userId,
      })
      .where(eq(aiApprovals.id, approvalId));

    return { status: 'executed', data };
  }

  private async runSkillDirectly(skillName: string, args: Record<string, any>): Promise<any> {
    // Agent lập trình phần này sẽ kết nối trực tiếp đến:
    // - SchemaService (nếu là schema:write)
    // - ItemService (nếu là items:read/write)
    // Ví dụ:
    // if (skillName === 'listCollections') return schemaService.listCollections();
    return { success: true, executed: skillName, args };
  }
}
```

---

### ── Module C: AI HTTP API Routes ──

API Route cung cấp cổng giao tiếp HTTP JSON để gửi lệnh từ giao diện Studio.

#### Vị trí file: `apps/cms/src/routes/ai.ts`
Và được mount vào `index.ts` dưới path `/api/v1/ai`.

```typescript
import { Hono } from 'hono';
import { z } from 'zod';
import { aiApprovals } from '@lumibase/database';
import { eq, and } from 'drizzle-orm';
import { AISecureHarness } from '../services/ai-harness';
import type { AppEnv } from '../env';

export const aiRouter = new Hono<AppEnv>();

const chatSchema = z.object({
  message: z.string(),
  // Có thể truyền thêm ngữ cảnh hoặc lịch sử hội thoại
});

// 1. Nhận câu lệnh tự nhiên từ Admin Chat UI
aiRouter.post('/chat', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const { message } = chatSchema.parse(await c.req.json());

  // Giả lập Mock LLM phân tích Intent -> gọi Skill.
  // Trong phiên bản sau, tích hợp Gemini/OpenAI API tại đây.
  // Ví dụ mock: User gõ "tạo bảng posts" -> LLM nhận diện skill 'createCollection'
  let parsedSkill = 'createCollection';
  let parsedArgs = { name: 'posts', description: 'Tạo bởi AI Copilot' };

  const harness = new AISecureHarness(db, siteId);
  const userCapabilities = auth.roles?.includes('admin') ? ['*'] : ['items:read'];

  const result = await harness.execute(parsedSkill, parsedArgs, userCapabilities, message);
  return c.json({ data: result });
});

// 2. Lấy danh sách yêu cầu chờ duyệt (HITL)
aiRouter.get('/approvals', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');

  const pending = await db
    .select()
    .from(aiApprovals)
    .where(and(eq(aiApprovals.siteId, siteId), eq(aiApprovals.status, 'pending')));

  return c.json({ data: pending });
});

// 3. Phê duyệt hoặc từ chối hành động của AI
aiRouter.post('/approvals/:id/decide', async (c) => {
  const id = c.req.param('id');
  const { decision } = await c.req.json(); // 'approved' | 'rejected'
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');

  if (decision === 'rejected') {
    await db
      .update(aiApprovals)
      .set({ status: 'rejected', decidedAt: new Date(), decidedBy: auth.userId })
      .where(and(eq(aiApprovals.id, id), eq(aiApprovals.siteId, siteId)));
    return c.json({ data: { success: true } });
  }

  const harness = new AISecureHarness(db, siteId);
  const result = await harness.executeApproved(id, auth.userId || 'system');
  return c.json({ data: result });
});
```

---

### ── Module D: Studio AI Assistant & Approvals UI ──

Giao diện trực quan để Admin tương tác với AI và duyệt yêu cầu.

#### Component 1: Floating AI Chat Panel (`apps/studio/src/components/ai-assistant.tsx`)
Hiển thị một nút bong bóng góc phải màn hình, click sẽ mở khung chat. Giao diện tối giản, hiện đại bằng CSS Glassmorphism:

```typescript
// Gợi ý cấu trúc Component:
export function AIAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant', text: string }>>([]);
  const [input, setInput] = useState('');

  const send = async () => {
    // POST /api/v1/ai/chat
    // Nhận về: { status: 'pending_approval', message: 'Cần duyệt...' }
    // Thêm vào messages.
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Bong bóng chat */}
      <button onClick={() => setOpen(!open)} className="rounded-full bg-primary p-4 text-white shadow-lg">
        AI
      </button>
      
      {/* Khung chat */}
      {open && (
        <div className="absolute bottom-16 right-0 w-80 rounded-2xl border bg-background/80 p-4 shadow-xl backdrop-blur-md">
          {/* Messages list & input form */}
        </div>
      )}
    </div>
  );
}
```

#### Component 2: AI Approvals Dashboard (`apps/studio/src/modules/settings/ai-approvals.tsx`)
Hiển thị danh sách các hành động AI đang đề xuất (ở trạng thái `pending`).
- Giao diện dạng thẻ (Card) ghi rõ: **"AI Copilot muốn thực thi kỹ năng: createCollection với đối số: { name: 'posts' }"**.
- Kèm theo lý do ngữ cảnh: **"Yêu cầu từ tin nhắn: 'Tạo bảng posts cho tôi'"**.
- Cung cấp 2 nút bấm nổi bật: **[ Approve ]** (gửi `decision: 'approved'`) và **[ Reject ]** (gửi `decision: 'rejected'`).

---

## 3. Quy chuẩn Kiểm thử & Review

Mọi Agent khi hoàn thành phần việc của mình phải đáp ứng:
1. **TypeScript strict mode**: Không được phép sử dụng kiểu `any` trừ trường hợp bắt buộc (cần có comment giải thích rõ).
2. **Không phá vỡ cấu trúc tenancy**: Mọi câu lệnh truy vấn dữ liệu từ database bắt buộc phải có điều kiện `eq(table.siteId, siteId)`.
3. **Chạy kiểm thử build**: Đảm bảo dự án tổng build bình thường thông qua lệnh `pnpm build` trước khi đề xuất gộp nhánh.
