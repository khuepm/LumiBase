/** Extractive grounding: generated text must consist of verified source quotes. */
export interface GroundingSource { sourceId: string; text: string; itemId?: string }
export interface GroundedContent { content: string; citations: Array<{ sourceId: string; quote: string }>; abstained: boolean }
export function validateGroundedContent(value: unknown, sources: GroundingSource[]): GroundedContent {
  const fail = (): never => { throw new Error('LLM_GROUNDING_INVALID: return exact source quotes with valid citations, or abstain.'); };
  if (!value || typeof value !== 'object') return fail();
  const candidate = value as Record<string, unknown>;
  if (candidate.abstained === true && candidate.content === '' && Array.isArray(candidate.citations) && candidate.citations.length === 0) {
    return { content: '', citations: [], abstained: true };
  }
  if (candidate.abstained !== false || typeof candidate.content !== 'string' || !Array.isArray(candidate.citations) || candidate.citations.length === 0 || candidate.citations.length > 10) return fail();
  const citations = candidate.citations.map((citation: unknown) => {
    if (!citation || typeof citation !== 'object') return fail();
    const { sourceId, quote } = citation as Record<string, unknown>;
    if (typeof sourceId !== 'string' || typeof quote !== 'string' || quote.trim().length < 8) return fail();
    const source = sources.find((entry) => entry.sourceId === sourceId);
    if (!source || !source.text.includes(quote)) return fail();
    return { sourceId, quote };
  });
  if (candidate.content !== citations.map((citation) => citation.quote).join('\n')) return fail();
  return { content: candidate.content, citations, abstained: false };
}
