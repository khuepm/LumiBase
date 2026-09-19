import type { Database } from '@lumibase/database';
import { aiMessages } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { asc, eq } from 'drizzle-orm';
import { AISecureHarness } from './ai-harness';
import { EffectiveCapabilityService } from './effective-capability-service';
import { resolvePrincipalCapabilities } from './governed-capabilities';
import { itemServiceForPrincipal, itemServiceForSystem } from './item-service-factory';
import { createConfiguredLLMProvider, createLLMProvider, type LLMMessage } from './llm-provider';
import { SchemaService } from './schema-service';
import { markRunRunning, persistAiChatOutcome, type AiChatRunJob } from './flow-run-service';

const MAX_CONTEXT_MESSAGES = 20;

/**
 * Worker path for `Prefer: respond-async` AI chat (high-load §10.3).
 * HITL semantics unchanged: dangerous skills still return `pending_approval`
 * in the run output — they are never auto-executed.
 */
export async function executeAiChatRun(
  db: Database,
  job: AiChatRunJob,
  keys?: KeyProvider,
  env?: Record<string, string | undefined>,
): Promise<void> {
  await markRunRunning(db, job.runId, job.siteId);
  const envRecord = env ?? {};

  try {
    const historyRows = await db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, job.conversationId))
      .orderBy(asc(aiMessages.createdAt))
      .limit(MAX_CONTEXT_MESSAGES);

    const llmMessages: LLMMessage[] = historyRows.map((row) => ({
      role: row.role as LLMMessage['role'],
      content: row.content,
    }));

    const llmProvider = createLLMProvider(envRecord);
    const llmResponse = await llmProvider.chat(llmMessages);

    if (llmResponse.toolCalls.length === 0) {
      const responseText =
        llmResponse.content ?? 'Could not determine action from your message.';
      await db.insert(aiMessages).values({
        conversationId: job.conversationId,
        role: 'assistant',
        content: responseText,
        metadata: { status: 'denied', runId: job.runId },
      });
      await persistAiChatOutcome(
        db,
        job.runId,
        job.siteId,
        {
          status: 'denied',
          message: responseText,
          conversationId: job.conversationId,
        },
        'success',
      );
      return;
    }

    const toolCall = llmResponse.toolCalls[0]!;
    const schemaService = new SchemaService({ db, siteId: job.siteId });

    // Capabilities are re-resolved at pickup, not taken from the enqueued
    // snapshot (#472), so a grant revoked while the job queued is honoured.
    // Jobs enqueued before `principal` existed fall back to their snapshot.
    const capabilities = job.principal
      ? await resolvePrincipalCapabilities(
          new EffectiveCapabilityService({ db, siteId: job.siteId }),
          job.principal,
        )
      : { allowed: true as const, capabilities: job.userCapabilities ?? [], controlPlaneAdmin: false };

    // ItemService must be PRINCIPAL-BOUND here, and this is the reason it has to
    // be built after resolution rather than before.
    //
    // Capabilities are the coarse gate; row rules and field masks live in
    // `ItemService` and apply only when it receives a `permissionCtx`. Without
    // one, a user whose policy grants `create` on `articles` alone resolves to
    // `items:write` — which is true, they may write *something* — and then
    // writes to any collection, because nothing narrower is left to stop them.
    // The coarse check passing is exactly what makes the gap easy to miss.
    //
    // It also made the two halves of one endpoint disagree: the synchronous
    // `POST /ai/chat` builds its harness with `itemServiceForRequest(c)`, so the
    // same message enforced row/field RBAC when answered inline and skipped it
    // when answered through the queue. Same request, same user, different
    // authorization — decided by a `Prefer` header.
    const itemDeps = { db, siteId: job.siteId, userId: job.userId, keyProvider: keys ?? undefined };
    const itemService = capabilities.permissionContext
      ? itemServiceForPrincipal(itemDeps, capabilities.permissionContext)
      : // Legacy jobs (enqueued before `principal`) have no principal to bind, so
        // there is nothing to derive a context from. Named rather than implicit,
        // and it disappears once the queue has drained past the deploy.
        itemServiceForSystem(itemDeps, 'background-worker');

    const harness = new AISecureHarness({
      db,
      siteId: job.siteId,
      schemaService,
      itemService,
      llm: createConfiguredLLMProvider(envRecord),
      keys,
    });

    const result = capabilities.allowed
      ? await harness.execute(
          toolCall.name,
          toolCall.arguments,
          capabilities.capabilities,
          job.message,
        )
      : {
          status: 'denied' as const,
          code: capabilities.code,
          message: capabilities.message ?? 'Capability resolution denied',
        };

    const responseMessage =
      result.message ??
      (llmResponse.content
        ? llmResponse.content
        : result.status === 'executed'
          ? 'Done.'
          : result.status);

    await db.insert(aiMessages).values({
      conversationId: job.conversationId,
      role: 'assistant',
      content: responseMessage,
      toolCalls: llmResponse.toolCalls,
      metadata: {
        status: result.status,
        approvalId: result.approvalId,
        runId: job.runId,
      },
    });

    await persistAiChatOutcome(
      db,
      job.runId,
      job.siteId,
      {
        ...result,
        message: responseMessage,
        conversationId: job.conversationId,
      },
      'success',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await persistAiChatOutcome(
      db,
      job.runId,
      job.siteId,
      { status: 'error', conversationId: job.conversationId },
      'error',
      message,
    );
  }
}
