import type { Database } from '@lumibase/database';
import { aiMessages } from '@lumibase/database';
import { desc, eq } from 'drizzle-orm';
import type { LLMMessage } from './llm-provider';

/** Max messages of conversation history sent to the model per Copilot turn. */
export const COPILOT_HISTORY_MAX_MESSAGES = 20;

/**
 * The Copilot context window: the newest {@link COPILOT_HISTORY_MAX_MESSAGES}
 * messages of the conversation, oldest first (#582).
 *
 * Both Copilot entry points (`POST /ai/chat` and its queued worker) used to read
 * `ORDER BY created_at ASC LIMIT 20`, i.e. the OLDEST twenty messages. From the
 * 21st message on, the turn the user had just sent was not in the request, so
 * the model answered (and its tool call ran, with the user's rights) on the
 * first ten turns of the conversation, every time.
 *
 * A window that starts with an assistant message (an odd cut) drops that
 * message, so the model always sees a user turn first; some providers reject or
 * mis-handle a leading assistant turn. The Copilot system prompt is not part of
 * the history: every provider sends it separately, so it is never cut.
 */
export async function loadCopilotHistory(db: Database, conversationId: string): Promise<LLMMessage[]> {
  const newestFirst = await db
    .select({ role: aiMessages.role, content: aiMessages.content })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(desc(aiMessages.createdAt))
    .limit(COPILOT_HISTORY_MAX_MESSAGES);

  const messages: LLMMessage[] = newestFirst.reverse().map((row) => ({
    role: row.role as LLMMessage['role'],
    content: row.content,
  }));
  const firstUser = messages.findIndex((m) => m.role === 'user');
  return firstUser <= 0 ? messages : messages.slice(firstUser);
}
