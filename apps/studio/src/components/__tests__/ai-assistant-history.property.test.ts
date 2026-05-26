import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

/**
 * Feature: ai-first-cms-engine, Property 13: Message history limit
 *
 * For any sequence of messages added to the AI Chat Panel,
 * the number of messages in history never exceeds 50.
 *
 * **Validates: Requirements 7.8**
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  approvalId?: string;
}

const MAX_MESSAGES = 50;

/**
 * Pure implementation of the addMessage logic extracted from AIAssistant component.
 * This mirrors: setMessages((prev) => [...prev, msg].slice(-MAX_MESSAGES))
 */
function addMessage(history: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  return [...history, msg].slice(-MAX_MESSAGES);
}

/**
 * Simulate adding a sequence of messages one by one, applying the slice logic each time.
 */
function addAllMessages(messages: ChatMessage[]): ChatMessage[] {
  let history: ChatMessage[] = [];
  for (const msg of messages) {
    history = addMessage(history, msg);
  }
  return history;
}

/** Arbitrary for a single ChatMessage */
const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  role: fc.constantFrom('user' as const, 'assistant' as const),
  text: fc.string({ minLength: 1, maxLength: 100 }),
});

/** Arbitrary for a sequence of 1 to 200 messages */
const messageSequenceArb: fc.Arbitrary<ChatMessage[]> = fc.array(chatMessageArb, {
  minLength: 1,
  maxLength: 200,
});

describe('Feature: ai-first-cms-engine, Property 13: Message history limit', () => {
  it('history length never exceeds 50 after adding any number of messages', () => {
    fc.assert(
      fc.property(messageSequenceArb, (messages) => {
        const history = addAllMessages(messages);

        // Property: message history must never exceed MAX_MESSAGES (50)
        expect(history.length).toBeLessThanOrEqual(MAX_MESSAGES);
      }),
      { numRuns: 100 },
    );
  });

  it('history preserves the most recent messages when exceeding limit', () => {
    fc.assert(
      fc.property(messageSequenceArb, (messages) => {
        const history = addAllMessages(messages);

        // When more than 50 messages are added, only the last 50 are kept
        if (messages.length > MAX_MESSAGES) {
          expect(history.length).toBe(MAX_MESSAGES);
          // The last message in history should be the last message added
          expect(history[history.length - 1]).toEqual(messages[messages.length - 1]);
        } else {
          // When fewer than or equal to 50 messages, all are preserved
          expect(history.length).toBe(messages.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('history length is bounded at every intermediate step', () => {
    fc.assert(
      fc.property(messageSequenceArb, (messages) => {
        let history: ChatMessage[] = [];

        // Property: at every step during message addition, length <= 50
        for (const msg of messages) {
          history = addMessage(history, msg);
          expect(history.length).toBeLessThanOrEqual(MAX_MESSAGES);
        }
      }),
      { numRuns: 100 },
    );
  });
});
