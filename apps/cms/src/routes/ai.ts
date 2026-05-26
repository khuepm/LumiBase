import { aiApprovals } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { AISecureHarness } from '../services/ai-harness';
import { SchemaService } from '../services/schema-service';
import { ItemService } from '../services/item-service';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const chatSchema = z.object({
  message: z
    .string()
    .max(2000)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'Message must not be empty after trimming')),
});

export const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
});

// ---------------------------------------------------------------------------
// Intent Analysis (Mock LLM)
// ---------------------------------------------------------------------------

interface IntentResult {
  skillName: string;
  args: Record<string, unknown>;
}

/**
 * Analyzes a user message to determine the intended skill and arguments.
 * This is a mock implementation that maps keywords to skill names.
 * In production, this would be replaced by an actual LLM call.
 */
export function analyzeIntent(message: string): IntentResult | null {
  const lower = message.toLowerCase();

  if (lower.includes('list collections') || lower.includes('show collections')) {
    return { skillName: 'listCollections', args: {} };
  }

  if (lower.includes('create collection')) {
    // Extract collection name from message if possible
    const nameMatch = message.match(/create collection\s+["']?(\w+)["']?/i);
    const name = nameMatch?.[1] ?? 'untitled';
    return { skillName: 'createCollection', args: { name } };
  }

  if (lower.includes('delete collection')) {
    const nameMatch = message.match(/delete collection\s+["']?(\w+)["']?/i);
    const name = nameMatch?.[1] ?? '';
    return { skillName: 'deleteCollection', args: { name } };
  }

  if (lower.includes('list items') || lower.includes('show items')) {
    const collMatch = message.match(/(?:list|show) items\s+(?:in|from|of)\s+["']?(\w+)["']?/i);
    const collection = collMatch?.[1] ?? '';
    return { skillName: 'listItems', args: { collection } };
  }

  if (lower.includes('create item')) {
    const collMatch = message.match(/create item\s+(?:in|for)\s+["']?(\w+)["']?/i);
    const collection = collMatch?.[1] ?? '';
    return { skillName: 'createItem', args: { collection } };
  }

  if (lower.includes('delete item')) {
    const idMatch = message.match(/delete item\s+["']?(\w+)["']?/i);
    const id = idMatch?.[1] ?? '';
    return { skillName: 'deleteItem', args: { id } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const aiRouter = new Hono<AppEnv>();

/**
 * POST /chat
 * Receives a natural language message, analyzes intent, and executes via AISecureHarness.
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

  const { message } = parsed.data;

  // Step 2: Analyze intent (mock LLM)
  const intent = analyzeIntent(message);

  if (!intent) {
    return c.json(
      {
        data: {
          status: 'denied' as const,
          message: 'Could not determine action from your message.',
        },
      },
      200,
    );
  }

  // Step 3: Execute via AISecureHarness
  try {
    const db = c.get('db');
    const siteId = c.get('siteId');
    const auth = c.get('auth');
    const runtime = c.get('runtime');

    // Derive capabilities from auth principal roles or default to empty
    const userCapabilities = auth.roles ?? [];

    // Wire up real services for skill execution
    const schemaService = new SchemaService({
      db,
      siteId,
      cache: runtime.cache,
    });
    const itemService = new ItemService({
      db,
      siteId,
      userId: auth.userId ?? null,
      cache: runtime.cache,
      search: runtime.search,
      queue: runtime.queue,
    });

    const harness = new AISecureHarness({ db, siteId, schemaService, itemService });
    const result = await harness.execute(
      intent.skillName,
      intent.args,
      userCapabilities,
      message,
    );

    return c.json({ data: result }, 200);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error';
    console.error('[ai/chat] execution error', err);
    return c.json(
      {
        errors: [{ code: 'INTERNAL', message: errorMessage }],
      },
      500,
    );
  }
});

/**
 * GET /approvals
 * Returns pending approval records for the current site, sorted by createdAt DESC, max 100.
 */
aiRouter.get('/approvals', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');

  const data = await db
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

  return c.json({ data });
});

/**
 * POST /approvals/:id/decide
 * Approves or rejects a pending approval record.
 */
aiRouter.post('/approvals/:id/decide', async (c) => {
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

  // Wire up real services for skill execution on approval
  const schemaService = new SchemaService({
    db,
    siteId,
    cache: runtime.cache,
  });
  const itemService = new ItemService({
    db,
    siteId,
    userId: auth.userId ?? null,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
  });

  const harness = new AISecureHarness({ db, siteId, schemaService, itemService });

  if (decision === 'approved') {
    const result = await harness.executeApproved(approvalId, userId);

    if (result.status === 'denied') {
      return c.json(
        {
          errors: [{ code: 'FORBIDDEN', message: result.message ?? 'Approval not found or already processed' }],
        },
        403,
      );
    }

    return c.json({ data: result });
  }

  // decision === 'rejected'
  // Verify the approval exists and belongs to the current site before rejecting
  const [existing] = await db
    .select({ id: aiApprovals.id, status: aiApprovals.status })
    .from(aiApprovals)
    .where(
      and(
        eq(aiApprovals.id, approvalId),
        eq(aiApprovals.siteId, siteId),
      ),
    );

  if (!existing || existing.status !== 'pending') {
    return c.json(
      {
        errors: [{ code: 'FORBIDDEN', message: 'Approval not found or already processed' }],
      },
      403,
    );
  }

  await harness.rejectApproval(approvalId, userId);
  return c.json({ data: { success: true } });
});
