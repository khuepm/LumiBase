# #582 audit: token budgets, factual grounding and structured output

- **Parent:** #577 (P1)
- **Audited commit:** `5a92d6ea` (`origin/main`, 2026-11-01)
- **Fix branch:** `feature/582-token-budgets-grounding`
- **Model:** none. The real provider adapters run with `fetch` stubbed; every "model
  answer" is a fixed response, so there are **no model-sensitive results** in this report
  and no repeat counts are needed.
- **Coordination:** #579 (PR #587) already moves the non-Copilot completions
  (`completeJson`, intent compile, constitution compile and judge) to
  `completeWithInstructions` (own system slot, `tools: false`). That fix is not repeated
  here; §4 gives its measured token cost. #581 (PR #596) established that no vector
  retrieval runs (B180). #507/#513 (Jev) own the decision benchmark and its abstention
  metrics. #359 owns benchmark infrastructure.

## 1. Decision points (code at `5a92d6ea`)

| # | Concern | Where | Behaviour |
|---|---|---|---|
| D1 | Copilot history window | `routes/ai.ts` `POST /chat` step 4; `services/ai-chat-run-worker.ts` | `ORDER BY created_at ASC LIMIT 20` in both (**F1**) |
| D2 | Copilot system prompt | `llm-provider.ts` `SYSTEM_PROMPT`, every adapter | Sent in the provider's system slot, apart from history; never part of the cut |
| D3 | Copilot output reserve | `DEFAULT_CHAT_MAX_OUTPUT_TOKENS = 1024` | OpenAI/NVIDIA/Anthropic/Gemini/Vertex send 1024; Workers AI sends no cap |
| D4 | Copilot input size | `chatSchema` (`message` ≤ 2000 chars), 20 messages, full tool catalogue | No token count, no context-window check (B184) |
| D5 | Tool catalogue | `skillsToOpenAITools()` | 74 skills, 24 212 chars of JSON, ~6 053 tokens estimated (chars/4), every Copilot turn |
| D6 | Decision input/output budget | `decision-provider.ts` `assertDecisionInputBudget`, `assertDecisionOutputBudget` | Estimated tokens (non-ASCII counted per code point) checked before any fetch; 413 when over |
| D7 | Decision retries | `DecisionProvider.decide` | Bounded by `maxRetries` (default 2) and a total deadline; parse failures never retried |
| D8 | Copilot tool-call parsing | `OpenAIProvider`/`WorkersAIProvider` `JSON.parse` inside `readLLMBody` | Malformed arguments → `LLMResponseError` → `500`, no retry |
| D9 | Tool input contract | `AISecureHarness.validateToolInput` → `validateAgentToolInput` | Write skills have `.strict()` schemas; refused as `VALIDATION` before any run row |
| D10 | Multiple tool calls | `routes/ai.ts`, worker | Only `toolCalls[0]` executes; the rest are stored in `ai_messages.tool_calls` only |
| D11 | Provider error to client | `routes/ai.ts` catch | `500 INTERNAL` with the upstream body in `message` (B182) |
| D12 | Constitution judge | `constitution-service.ts` `runLlmJudge`, `publishGate` | Content cut at 6000 chars; publish gate built without `llm` (B183) |
| D13 | Grounding / citations | — | No feature returns claims tied to evidence (see §5) |

## 2. Matrix

| Concern | Copilot (sync) | Copilot (async worker) | AI decisions (`/ai/decisions`, Flows, review) |
|---|---|---|---|
| Newest turn in request | **fail → fixed (F1)** | **fail → fixed (F1)** | N/A (single request) |
| Policy context kept | **pass** (system slot, separate) | **pass** | **pass** (`LLM_DECISION_PROMPT` in system slot) |
| Output reserve | pass: 1024 (Workers AI: model default) | same | pass: computed per request (D6) |
| Input budget vs provider limit | not enforced (B184) | not enforced (B184) | **pass** (D6) |
| Oversized single message | pass: `chatSchema` refuses > 2000 chars (`ai-chat-validation.property.test.ts`), route answers 400 `VALIDATION` | same (validated at enqueue) | pass: 413 |
| Long conversation | **fail → fixed (F1)** | **fail → fixed (F1)** | N/A |
| Large tool result | N/A: tool results are not sent back to the model (single shot) | N/A | N/A |
| Summarization | N/A: none exists; older messages are dropped | N/A | N/A |
| Malformed output | pass: 500 once, no write (new case) | pass: run `error`, no redelivery | pass: `DECISION_PARSE_FAILED`, not retried |
| Well-formed but wrong id / enum | pass (new cases) | same harness | pass: J01 strict validation (#508) |
| Contradictory actions | pass: first only, second neither runs nor parks (new case) | same | N/A |
| Streaming interruption | N/A: no adapter streams | N/A | N/A |
| Retries bounded | pass: none | pass: none | pass (D7) |
| Actionable failure | **gap (B182)** | gap (same message in `flow_runs.error`) | pass (fixed error codes, B141) |

## 3. Findings

### F1: Copilot sent the oldest 20 messages, so the new turn was missing (fixed)

- **Severity: medium.** From the 21st stored message of a conversation (the 11th user
  turn) on, the request ended at message 20 of the conversation. The model never saw what
  the user had just asked and answered turns 1–10 again. A tool call in that answer ran
  with the user's rights through the harness, so non-dangerous writes (`createItem`,
  draft `updateItem`) that the user asked for in an early turn could run again without
  being asked. No privilege boundary is crossed: everything runs as the user, and
  dangerous skills still park for approval. On Anthropic the request also ended on an
  assistant turn, which the API treats as a prefill to continue. Both the sync route and
  the async worker had their own copy of the query.
- **Reproduction:** seed 24 messages (12 turns) in a conversation, `POST /ai/chat` with a
  new message; the captured request body ends with `old assistant turn 10`.
- **Fix:** `services/copilot-history.ts` `loadCopilotHistory`: `ORDER BY created_at DESC
  LIMIT 20`, reversed, and a leading assistant message dropped so the window opens on a
  user turn. Both entry points call it. The limit (20) and the system prompt are unchanged.
- **Evidence:** `routes/__tests__/ai-chat-context-window.db.integration.test.ts` (real
  PostgreSQL, real router, real worker, real `OpenAIProvider` with `fetch` stubbed):
  the sync and async cases assert the last message is the new turn, the first history
  message is `old user turn 4`, 19 history messages, system prompt first, `max_tokens`
  1024, tools present. Tripwire `__tests__/copilot-history.wiring.test.ts` keeps both
  entry points on the shared loader.

## 4. Controls verified correct (no change)

New cases in `ai-chat-context-window.db.integration.test.ts`, run through `POST /ai/chat`
with a user principal holding an Administrator role (resolved by
`EffectiveCapabilityService`) and a principal-bound `ItemService`:

- a short conversation sends every message, oldest first;
- `updateItem` naming another site's item id: not executed, message "not found", the
  other site's row unchanged;
- `updateItem` with `status: 'live'`: `denied` / `VALIDATION`, row unchanged;
- `[updateItem, deleteItem]` for the same item: the update executes (so the principal can
  write), the item is not deleted and no `ai_approvals` / `agent_approvals` row exists;
- malformed tool arguments: `500`, one upstream request, row unchanged, no assistant turn.

Existing suites re-run on this branch (no change): `decision-budgets.test.ts`,
`decision-provider.test.ts`, `llm-decision-mode.test.ts`, `decision-governance.test.ts`,
`routes/__tests__/ai-decisions.test.ts`, `ai-chat-validation.property.test.ts`:
**273/273 pass**. They cover input and output budgets before any fetch (Vietnamese
counted tighter than ASCII), retry bounds under a total deadline, `Retry-After`, no retry
after cancel, and no retry of an unparseable body.

**Token cost of #579's fix (measured, supports PR #587):** on `5a92d6ea` every non-Copilot
completion (`completeJson`, intent compile, constitution compile and judge) also sent the
Copilot prompt and the 74-tool catalogue, about 24 212 characters (~6 053 estimated
tokens) per call that the caller never uses. PR #587 removes it; nothing is changed for it
here.

**Negative checks** (fix files restored to `5a92d6ea` with `git checkout`, then the new
tests run; measured):

| Change reverted | Result |
|---|---|
| `routes/ai.ts` + `ai-chat-run-worker.ts` | 5 of 11 fail: the 2 window cases (`expected { role: 'assistant' … } to deeply equal { role: 'user' … }`) and 3 tripwire cases. The other 6 pass, as expected for controls that already worked |
| only the leading-assistant trim in `copilot-history.ts` | 2 of 7 DB cases fail (sync and async window) |

## 5. Grounding, citations and abstention

- **Groundedness / citation validity: N/A, justified.** No code path at `5a92d6ea` asks a
  model to answer from retrieved evidence or returns citations. #581 found no retrieval
  (embedding service and table have no caller); `aiContentAssist` uses three recent items
  as style samples, not as evidence. A citation dataset would score a feature that does
  not exist. Depends on the retrieval decision in **B180**.
- **Abstention:** the one place a model may abstain is the decision path (`unknown`
  options, confidence threshold). It already has a versioned dataset and a reproducible
  baseline: `apps/cms/eval/jev-benchmark/datasets/v1`, metrics in
  `eval/jev-benchmark/metrics.ts` (coverage, selective precision, Wilson intervals),
  owned by #513/#507. Not re-run here; no live model was available.

## 6. Not covered / residual

- **Provider failures in Copilot** return `500 INTERNAL` with the upstream body; a 429
  loses `Retry-After` (measured, **B182**, owner decision on the response contract).
- **Constitution `llm_judge`** never runs in the publish gate (no `llm` wired), so a
  blocking judge always blocks; if wired, content after 6000 chars is never judged
  (**B183**).
- **No token accounting or context-window check** in Copilot; supported limits are now
  documented in `docs/{en,vi}/features/ai-copilot.md` §2 (**B184**).
- **Live models:** not called. No claim about how a model behaves with the new window.
- **Only the first tool call runs**; the others are stored without telling the user.
  Bounded and safe; a UX question, not logged.

## 7. Acceptance criteria of #582

| Criterion | Status |
|---|---|
| Boundary tests prove provider limits and output reserves are respected without dropping critical policy context | **partly met.** Decision path: met (D6, existing suites). Copilot: the system prompt and the newest turn are kept and the output reserve is fixed (new cases, F1); no token limit is enforced, documented as a supported limit (B184) |
| Groundedness, citation validity and abstention have a versioned dataset and reproducible baseline | **abstention: met** by the Jev benchmark (#513). **Grounding/citations: N/A, justified** (no such feature, B180) |
| Invalid structure or semantics cannot trigger a write; failures are actionable and retries bounded | **writes: met** (new cases). **Retries bounded: met.** **Actionable: not met** for Copilot provider failures (B182, owner decision) |
| Record current behaviour/code paths, fix confirmed gaps and document supported limits | met: §1–§4, F1 fixed, limits in `ai-copilot.md` §2 |


## Completion verification (2026-11-08)

Completion baseline `a59d11c9`: provider calls now bound context, reserve output, keep policy and protect the newest request. Unknown model windows require configuration. Typed Copilot failures preserve actionable classification without exposing provider bodies. Malformed, conflicting or cross-tenant tool requests cannot bypass governed execution. Optional grounded content assistance validates the exact quotes and source references it returns from current permitted samples, with abstention on insufficient evidence. Versioned EN/VI synthetic corpus v1 passed 12/12 runtime contract cases. These are extractive guarantees, not a claim about editorial accuracy or model judgment on contradictory documents. See `docs/en/features/ai-copilot.md` for reproduction and supported limits.
