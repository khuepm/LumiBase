import { aiApprovals, aiConversations, aiMessages } from '@lumibase/database';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { buildAgentNotifier } from '../modules/notifications/notify-context';
import { AISecureHarness } from '../services/ai-harness';
import { SchemaService } from '../services/schema-service';
import { itemServiceForRequest } from '../services/item-service-factory';
import { createConfiguredLLMProvider, createLLMProvider, type LLMMessage } from '../services/llm-provider';
import { formatSafeError } from '@lumibase/shared/utils';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const chatSchema = z.object({
  message: z
    .string()
    .max(2000)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'Message must not be empty after trimming')),
  conversationId: z.string().optional(),
});

export const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max messages to load from conversation history as LLM context. */
const MAX_CONTEXT_MESSAGES = 20;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const aiRouter = new Hono<AppEnv>();

function getUserCapabilities(c: Context<AppEnv>): string[] {
  const auth = c.get('auth');
  return Array.isArray(auth.roles) ? auth.roles : [];
}

function requireAdmin(c: Context<AppEnv>) {
  const roles = getUserCapabilities(c);

  if (!roles.includes('admin')) {
    return c.json(
      {
        errors: [
          {
            code: 'FORBIDDEN',
            message: 'Admin role required.',
          },
        ],
      },
      403,
    );
  }

  return null;
}

// ItemService for AI routes is built via the shared `itemServiceForRequest`
// factory so LLM-driven skills enforce the same row/field RBAC as the normal
// `/items` API (see item-service-factory.ts).

/**
 * POST /chat
 * Receives a natural language message, analyzes intent via LLM (or echo
 * fallback), and executes via AISecureHarness.
 * Supports conversation history via `conversationId`.
 */
aiRouter.post('/chat', async (c) => {
  // Step 1: Parse and validate input
  const body = await c.req.json().catch(() => null);
  const parsed = chatSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((issue) => ({
          code: 'VALIDATION',
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
      400,
    );
  }

  const { message, conversationId: inputConversationId } = parsed.data;

  try {
    const db = c.get('db');
    const siteId = c.get('siteId');
    const auth = c.get('auth');
    const runtime = c.get('runtime');
    const userId = auth.userId ?? null;

    // Step 2: Resolve or create conversation
    let conversationId = inputConversationId;

    if (conversationId) {
      // Verify conversation belongs to this site
      const [conv] = await db
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(
          and(
            eq(aiConversations.id, conversationId),
            eq(aiConversations.siteId, siteId),
          ),
        );
      if (!conv) {
        conversationId = undefined; // Will create new
      }
    }

    if (!conversationId) {
      // Create a new conversation
      const title =
        message.length > 60 ? `${message.substring(0, 57)}...` : message;
      const [newConv] = await db
        .insert(aiConversations)
        .values({ siteId, userId, title })
        .returning();
      conversationId = newConv!.id;
    }

    // Step 3: Persist user message
    await db.insert(aiMessages).values({
      conversationId,
      role: 'user',
      content: message,
    });

    // Step 4: Load conversation history for LLM context
    const historyRows = await db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conversationId))
      .orderBy(asc(aiMessages.createdAt))
      .limit(MAX_CONTEXT_MESSAGES);

    const llmMessages: LLMMessage[] = historyRows.map((row) => ({
      role: row.role as LLMMessage['role'],
      content: row.content,
    }));

    // Step 5: Call LLM
    const llmProvider = createLLMProvider(
      c.env as unknown as Record<string, string | undefined>,
    );
    const llmResponse = await llmProvider.chat(llmMessages);

    // Step 6: Handle response
    if (llmResponse.toolCalls.length === 0) {
      const responseText =
        llmResponse.content ?? 'Could not determine action from your message.';

      // Persist assistant response
      await db.insert(aiMessages).values({
        conversationId,
        role: 'assistant',
        content: responseText,
        metadata: { status: 'denied' },
      });

      // Update conversation timestamp
      await db
        .update(aiConversations)
        .set({ updatedAt: new Date() })
        .where(eq(aiConversations.id, conversationId));

      return c.json(
        {
          data: {
            status: 'denied' as const,
            message: responseText,
            conversationId,
          },
        },
        200,
      );
    }

    // Execute the first tool call via AISecureHarness
    const toolCall = llmResponse.toolCalls[0]!;
    const userCapabilities = getUserCapabilities(c);

    const schemaService = new SchemaService({
      db,
      siteId,
      cache: runtime.cache,
    });
    const itemService = itemServiceForRequest(c);

    const harness = new AISecureHarness({
      db,
      siteId,
      schemaService,
      itemService,
      llm: createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>),
      queue: runtime.queue,
      notify: buildAgentNotifier(c),
    });
    const result = await harness.execute(
      toolCall.name,
      toolCall.arguments,
      userCapabilities,
      message,
    );

    const responseMessage =
      result.message ??
      (llmResponse.content
        ? llmResponse.content
        : result.status === 'executed'
          ? 'Done.'
          : result.status);

    // Persist assistant response
    await db.insert(aiMessages).values({
      conversationId,
      role: 'assistant',
      content: responseMessage,
      toolCalls: llmResponse.toolCalls,
      metadata: {
        status: result.status,
        approvalId: result.approvalId,
      },
    });

    // Update conversation timestamp
    await db
      .update(aiConversations)
      .set({ updatedAt: new Date() })
      .where(eq(aiConversations.id, conversationId));

    return c.json(
      {
        data: {
          ...result,
          message: responseMessage,
          conversationId,
        },
      },
      200,
    );
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    console.error('[ai/chat] execution error', formatSafeError(err));
    return c.json(
      {
        errors: [{ code: 'INTERNAL', message: errorMessage }],
      },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Conversation management routes
// ---------------------------------------------------------------------------

/**
 * GET /conversations
 * Lists conversations for the current user/site, most recent first.
 */
aiRouter.get('/conversations', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');

  const rows = await db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.siteId, siteId),
        ...(auth.userId ? [eq(aiConversations.userId, auth.userId)] : []),
      ),
    )
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50);

  return c.json({ data: rows });
});

/**
 * GET /conversations/:id/messages
 * Returns all messages in a conversation, oldest first.
 */
aiRouter.get('/conversations/:id/messages', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const conversationId = c.req.param('id');

  // Verify conversation belongs to this site
  const [conv] = await db
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.siteId, siteId),
      ),
    );

  if (!conv) {
    return c.json(
      { errors: [{ code: 'NOT_FOUND', message: 'Conversation not found' }] },
      404,
    );
  }

  const messages = await db
    .select()
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt))
    .limit(200);

  return c.json({ data: messages });
});

/**
 * DELETE /conversations/:id
 * Deletes a conversation and all its messages.
 */
aiRouter.delete('/conversations/:id', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const conversationId = c.req.param('id');

  await db
    .delete(aiConversations)
    .where(
      and(
        eq(aiConversations.id, conversationId),
        eq(aiConversations.siteId, siteId),
      ),
    );

  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Approval routes
// ---------------------------------------------------------------------------

/**
 * GET /approvals
 * Returns pending approval records for the current site, sorted by createdAt DESC, max 100.
 */
aiRouter.get('/approvals', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  const db = c.get('db');
  const siteId = c.get('siteId');
  const userCapabilities = getUserCapabilities(c);
  const harness = new AISecureHarness({ db, siteId });

  const pendingApprovals = await db
    .select()
    .from(aiApprovals)
    .where(
      and(
        eq(aiApprovals.siteId, siteId),
        eq(aiApprovals.status, 'pending'),
      ),
    )
    .orderBy(desc(aiApprovals.createdAt))
    .limit(100);

  const data = pendingApprovals.filter((approval) => {
    const skill = harness.validateSkill(approval.skillName);
    return Boolean(skill && harness.checkCapabilities(skill, userCapabilities));
  });

  return c.json({ data });
});

/**
 * POST /approvals/:id/decide
 * Approves or rejects a pending approval record.
 */
aiRouter.post('/approvals/:id/decide', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;

  // Step 1: Parse and validate input
  const body = await c.req.json().catch(() => null);
  const parsed = decideSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        errors: parsed.error.issues.map((issue) => ({
          code: 'VALIDATION',
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
      400,
    );
  }

  const { decision } = parsed.data;
  const approvalId = c.req.param('id');
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const runtime = c.get('runtime');
  const userId = auth.userId ?? auth.externalId ?? 'unknown';
  const userCapabilities = getUserCapabilities(c);
  const harness = new AISecureHarness({ db, siteId });

  const [approval] = await db
    .select({
      id: aiApprovals.id,
      status: aiApprovals.status,
      skillName: aiApprovals.skillName,
    })
    .from(aiApprovals)
    .where(
      and(
        eq(aiApprovals.id, approvalId),
        eq(aiApprovals.siteId, siteId),
      ),
    );

  const skill = approval ? harness.validateSkill(approval.skillName) : undefined;
  if (!approval || approval.status !== 'pending' || !skill) {
    return c.json(
      {
        errors: [{ code: 'FORBIDDEN', message: 'Approval not found or already processed' }],
      },
      403,
    );
  }

  if (!harness.checkCapabilities(skill, userCapabilities)) {
    return c.json(
      {
        errors: [{ code: 'FORBIDDEN', message: 'Insufficient capabilities' }],
      },
      403,
    );
  }

  if (decision === 'approved') {
    // Wire up real services for skill execution on approval only after authorization.
    const schemaService = new SchemaService({
      db,
      siteId,
      cache: runtime.cache,
    });
    const itemService = itemServiceForRequest(c);
    const authorizedHarness = new AISecureHarness({
      db,
      siteId,
      schemaService,
      itemService,
      llm: createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>),
      queue: runtime.queue,
      notify: buildAgentNotifier(c),
    });
    const result = await authorizedHarness.executeApproved(
      approvalId,
      userId,
      userCapabilities,
    );

    if (result.status === 'denied') {
      return c.json(
        {
          errors: [
            {
              code: 'FORBIDDEN',
              message: result.message ?? 'Approval not found or already processed',
            },
          ],
        },
        403,
      );
    }

    return c.json({ data: result });
  }

  // decision === 'rejected'
  const rejected = await harness.rejectApproval(approvalId, userId);
  if (!rejected) {
    return c.json(
      {
        errors: [
          {
            code: 'CONFLICT',
            message: 'Approval not found or already processed',
          },
        ],
      },
      409,
    );
  }
  return c.json({ data: { success: true } });
});
