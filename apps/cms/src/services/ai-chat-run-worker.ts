import type { Database } from '@lumibase/database';
import { aiMessages } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { asc, eq } from 'drizzle-orm';
import { AISecureHarness } from './ai-harness';
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
    const itemService = new (await import('./item-service')).ItemService({
      db,
      siteId: job.siteId,
      userId: job.userId,
      keyProvider: keys ?? undefined,
    });

    const harness = new AISecureHarness({
      db,
      siteId: job.siteId,
      schemaService,
      itemService,
      llm: createConfiguredLLMProvider(envRecord),
      keys,
    });

    const result = await harness.execute(
      toolCall.name,
      toolCall.arguments,
      job.userCapabilities,
      job.message,
    );

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
