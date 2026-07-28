---
version: 1
lastUpdated: 2026-07-28T00:04:58.104Z
sourceLang: vi
translatedFrom: vi
sourceHash: bb3a4908115a8717
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:04:58.104Z
codeVerifiedHash: bb3a4908115a8717
codeVerifiedClaims: 16
---

# Technical Specification: Building the AI-First CMS Engine for LumiBase

This document gives detailed implementation guidance — architecture, source-code boundaries, and API/database shapes — so that other **AI agents** can independently build the pieces of the **AI-First CMS Engine** on LumiBase without their code colliding.

---

## 1. Work boundaries (task breakdown for agents)

The system splits into 4 independent modules. Each agent can take one module:

| Module | Task | Files touched | Responsibility |
|---|---|---|---|
| **Module A** | Database & HITL approvals | `packages/database/src/schema/platform.ts` | Create the `ai_approvals` table and write the matching migrations. |
| **Module B** | AI Secure Harness service | `apps/cms/src/services/ai-harness.ts` | Build the capability-checking harness, analyse the payload, and handle the HITL approval gate. |
| **Module C** | AI HTTP API routes | `apps/cms/src/routes/ai.ts` | Create the `/ai/chat` and `/ai/approvals` endpoints that Studio talks to. |
| **Module D** | Studio AI Assistant & approvals UI | `apps/studio/src/...` | The floating chat assistant plus the screen for approving AI actions. |

---

## 2. Per-module technical detail

### ── Module A: database schema for AI approvals (HITL) ──

For absolute safety, dangerous AI actions (editing the schema, deleting data) must land in an approval queue (HITL — human in the loop).

#### The `ai_approvals` table

Defined in `packages/database/src/schema/platform.ts` (or in a new `ai.ts` in the same directory):

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
    /** Stores the arguments the AI intends to call the function with, as JSON (e.g. { name: 'posts', fields: [...] }) */
    arguments: jsonb('arguments').notNull(),
    /** Approval state: 'pending' | 'approved' | 'rejected' */
    status: text('status').default('pending').notNull(),
    /** The AI's reason or request context (shown to the admin) */
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

**What the Module A agent must do:**
1. Declare the `aiApprovals` table and export it from `packages/database/src/schema/index.ts`.
2. Run `DATABASE_URL=... pnpm --filter @lumibase/database generate` to produce the migration file.
3. Run `pnpm --filter @lumibase/database migrate` to apply it to PostgreSQL.

---

### ── Module B: the AI Secure Harness service ──

The harness is the safety brain. It receives the AI's request to call a skill, checks its capabilities, and decides whether to execute it or hold it for approval.

#### File: `apps/cms/src/services/ai-harness.ts`

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
   * Evaluate and execute a skill the AI has requested.
   */
  async execute(
    skillName: string,
    args: Record<string, any>,
    userCapabilities: string[],
    contextMessage?: string
  ): Promise<HarnessExecutionResult> {
    const skill = CORE_SKILLS[skillName];
    if (!skill) {
      return { status: 'denied', message: `Skill ${skillName} does not exist.` };
    }

    // 1. Check the user's/session's capabilities against what the skill requires
    const hasCapabilities = skill.requiredCapabilities.every((cap) =>
      userCapabilities.includes(cap) || userCapabilities.includes('*')
    );

    if (!hasCapabilities) {
      return { status: 'denied', message: `Missing the capabilities needed for this action.` };
    }

    // 2. Risk evaluation
    // Skills that change the schema or delete data always require approval (HITL)
    const requiresApproval =
      skill.requiredCapabilities.includes('schema:write') ||
      skillName.startsWith('delete');

    if (requiresApproval) {
      // Record it in the DB approval queue
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
        message: `This action needs a system administrator's approval.`,
      };
    }

    // 3. Execute safe skills directly (e.g. read or list)
    const result = await this.runSkillDirectly(skillName, args);
    return { status: 'executed', data: result };
  }

  /**
   * Execute directly, after approval has been granted.
   */
  async executeApproved(approvalId: string, userId: string): Promise<HarnessExecutionResult> {
    const [approval] = await this.db
      .select()
      .from(aiApprovals)
      .where(and(eq(aiApprovals.id, approvalId), eq(aiApprovals.siteId, this.siteId)))
      .limit(1);

    if (!approval || approval.status !== 'pending') {
      return { status: 'denied', message: 'Invalid request, or it has already been handled.' };
    }

    // Execute directly
    const data = await this.runSkillDirectly(approval.skillName, approval.arguments as Record<string, any>);

    // Update the approval state
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
    // The agent implementing this part wires it straight into:
    // - SchemaService (for schema:write)
    // - ItemService (for items:read/write)
    // For example:
    // if (skillName === 'listCollections') return schemaService.listCollections();
    return { success: true, executed: skillName, args };
  }
}
```

---

### ── Module C: AI HTTP API routes ──

The API route is the HTTP/JSON gateway for sending commands from the Studio UI.

#### File: `apps/cms/src/routes/ai.ts`
Mounted in `index.ts` under the path `/api/v1/ai`.

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
  // Extra context or conversation history can also be passed
});

// 1. Take a natural-language command from the admin chat UI
aiRouter.post('/chat', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const { message } = chatSchema.parse(await c.req.json());

  // Mock LLM intent analysis -> skill call.
  // In a later version, integrate the Gemini/OpenAI API here.
  // Mock example: the user types "create a posts table" -> the LLM recognises the 'createCollection' skill
  let parsedSkill = 'createCollection';
  let parsedArgs = { name: 'posts', description: 'Created by the AI Copilot' };

  const harness = new AISecureHarness(db, siteId);
  const userCapabilities = auth.roles?.includes('admin') ? ['*'] : ['items:read'];

  const result = await harness.execute(parsedSkill, parsedArgs, userCapabilities, message);
  return c.json({ data: result });
});

// 2. List the requests awaiting approval (HITL)
aiRouter.get('/approvals', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');

  const pending = await db
    .select()
    .from(aiApprovals)
    .where(and(eq(aiApprovals.siteId, siteId), eq(aiApprovals.status, 'pending')));

  return c.json({ data: pending });
});

// 3. Approve or reject an AI action
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

### ── Module D: Studio AI Assistant & approvals UI ──

The visual surface where an admin talks to the AI and approves its requests.

#### Component 1: floating AI chat panel (`apps/studio/src/components/ai-assistant.tsx`)
A bubble button in the bottom-right corner; clicking it opens the chat frame. A minimal, modern look using CSS glassmorphism:

```typescript
// Suggested component structure:
export function AIAssistant() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant', text: string }>>([]);
  const [input, setInput] = useState('');

  const send = async () => {
    // POST /api/v1/ai/chat
    // Returns: { status: 'pending_approval', message: 'Needs approval...' }
    // Append to messages.
  };

  return (
    <div className="fixed bottom-6 right-6 z-50">
      {/* Chat bubble */}
      <button onClick={() => setOpen(!open)} className="rounded-full bg-primary p-4 text-white shadow-lg">
        AI
      </button>

      {/* Chat frame */}
      {open && (
        <div className="absolute bottom-16 right-0 w-80 rounded-2xl border bg-background/80 p-4 shadow-xl backdrop-blur-md">
          {/* Messages list & input form */}
        </div>
      )}
    </div>
  );
}
```

#### Component 2: AI approvals dashboard (`apps/studio/src/modules/settings/ai-approvals.tsx`)
Lists the AI actions currently being proposed (status `pending`).
- A card layout spelling it out: **"AI Copilot wants to run the skill createCollection with arguments: { name: 'posts' }"**.
- Plus the context reason: **"Requested by the message: 'Create a posts table for me'"**.
- Two prominent buttons: **[ Approve ]** (sends `decision: 'approved'`) and **[ Reject ]** (sends `decision: 'rejected'`).

---

## 3. Testing & review standards

Every agent finishing its share of the work must satisfy:
1. **TypeScript strict mode**: no `any` unless unavoidable (and then with a comment explaining why).
2. **Do not break tenancy**: every database query must carry the `eq(table.siteId, siteId)` condition.
3. **Run the build**: make sure the whole project still builds via `pnpm build` before proposing a merge.
