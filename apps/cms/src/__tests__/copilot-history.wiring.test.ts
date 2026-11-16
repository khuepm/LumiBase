import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tripwire (#582): the Copilot context window is built in ONE place.
 *
 * Both halves of `POST /ai/chat` (inline route and queued worker) used to carry
 * their own copy of the history query, and both copies read the OLDEST twenty
 * messages. A third copy would reintroduce the class, so any file that reads
 * `aiMessages` to build model input must go through `loadCopilotHistory`.
 */
const SRC = resolve(__dirname, '..');
const ENTRY_POINTS = ['routes/ai.ts', 'services/ai-chat-run-worker.ts'];

function source(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8');
}

describe('Copilot history wiring (#582)', () => {
  it.each(ENTRY_POINTS)('%s loads history through loadCopilotHistory', (rel) => {
    const text = source(rel);
    expect(text).toMatch(/loadCopilotHistory\(db,/);
    expect(text).not.toMatch(/MAX_CONTEXT_MESSAGES/);
  });

  it('the shared loader keeps the newest window', () => {
    const text = source('services/copilot-history.ts');
    expect(text).toMatch(/orderBy\(desc\(aiMessages\.createdAt\)\)/);
    expect(text).toMatch(/\.reverse\(\)/);
  });

  it('the worker does not query aiMessages in ascending order for model input', () => {
    expect(source('services/ai-chat-run-worker.ts')).not.toMatch(/asc\(aiMessages\.createdAt\)/);
  });
});
