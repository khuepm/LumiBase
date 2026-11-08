import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateGroundedContent, type GroundingSource } from '../grounded-content';
const dataset = JSON.parse(readFileSync(new URL('../../../eval/grounding/dataset.v1.json', import.meta.url), 'utf8')) as {
  sources: GroundingSource[]; cases: Array<{ id: string; sources?: GroundingSource[]; candidate: unknown; accepted: boolean }>;
};
describe('#582 runtime grounding contract corpus', () => {
  it.each(dataset.cases)('$id', (entry) => {
    const validate = () => validateGroundedContent(entry.candidate, entry.sources ?? dataset.sources);
    if (entry.accepted) expect(validate).not.toThrow();
    else expect(validate).toThrow('LLM_GROUNDING_INVALID');
  });
});
