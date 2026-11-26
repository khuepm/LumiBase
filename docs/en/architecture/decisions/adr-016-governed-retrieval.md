---
version: 4
sourceLang: en
lastUpdated: 2026-11-26T05:30:36.622Z
contentHash: c60d115fbb5a8ddf
codeVerified: 2026-11-26T05:30:36.622Z
codeVerifiedHash: c60d115fbb5a8ddf
codeVerifiedClaims: 16
---

# ADR-016: Governed retrieval — evidence-driven engine choice

**Date:** 2026-11-26  
**Status:** Proposed (Decision Gate A decides whether another engine is tried; only R06 closes B180)

## Context

AI skills need content that is relevant to the instruction they were given.
Today they do not get it. Audit #581
(`docs/review-agent/2026-11-01-ai-audit-581-embedding-retrieval-baseline.md`)
measured Recall@3 0.5 and MRR@3 0.4583 on `apps/cms/eval/retrieval/dataset.v1.json`,
and states why: the retriever ignores the query and returns the three most
recently edited items, so the numbers measure `updated_at`, not relevance. The
audit leaves the choice of a real retriever to the owner (**B180**), recommends
pgvector before corpora reach 10⁴–10⁵ vectors, and leaves two related decisions
open: whether decrypted PII/PHI may be sent to an external model provider
(**B179**), and that the search index applies row rules to a stale snapshot and
drops failed index jobs (**B181**).

What exists in the tree:

- `apps/cms/src/services/embedding-service.ts` has OpenAI, Workers AI and Echo
  providers. `createEmbeddingProvider` picks one from `LLM_PROVIDER` and returns
  `EchoEmbeddingProvider` silently when a key is missing or the provider is
  unknown. With `LLM_PROVIDER=anthropic` it uses OpenAI when `OPENAI_API_KEY` is
  set and Echo otherwise.
- `lumibase_ai_embeddings` (`packages/database/src/schema/ai.ts`) stores vectors
  as JSONB with `site_id`; similarity is brute-force `cosineSimilarity` in JS.
  No pipeline writes to it.
- `SearchProvider` (`packages/runtime/src/interfaces/search.ts`) already covers
  `index`, `search`, `delete`, `getIndex` and `configureIndex`, with MeiliSearch
  adapters for both runtimes. The tenant boundary lives in the index name
  (`searchIndexName(siteId, collection)`). The code supports Meili on Workers;
  whether production has a Meili instance provisioned is not verified.
- `buildSearchDocument` (`apps/cms/src/services/search-document.ts`) indexes
  every field of an item as one document. `apps/cms/src/routes/search.ts`
  applies the row rule and masks fields after Meili returns its hits, and
  already reports `totalHits` as the visible count to a restricted caller
  (#738).
- `PlatformSeams` (`apps/cms/src/platform/types.ts`) has `entitlements`,
  `usage` and `externalActions`. There is no seam that resolves the AI provider
  for a call: model calls are configured from instance environment variables,
  and the embedding and decision paths issue their own vendor calls.
- `recordUsage` (`apps/cms/src/platform/usage.ts`) is best-effort: with no
  emitter registered nothing is recorded, an event outside a usage scope is
  dropped, and events are flushed after the response, where a failed flush is
  logged and does not affect the request.
- Content environments (Epic #853) are at Phase A: an optimistic-concurrency
  counter. No `environment_id` column exists yet.

A proposal to adopt MongoDB Atlas and Voyage AI, prompted by startup credits,
was reviewed against this. It mixed three independent decisions — embedding
model, vector store, retrieval strategy — and read the #581 baseline as a vector
store gap, which it is not. This ADR separates them.

## Options

| Option | Reuses current infra | Semantic | Same transaction / RLS as source | Extra ops | Workers path |
| --- | --- | --- | --- | --- | --- |
| A. Meili lexical (`SearchProvider`) | yes | no | no | none (if provisioned) | existing adapter |
| B. Meili hybrid, `userProvided` vectors | yes | yes | no | none (if provisioned) | existing adapter |
| C. pgvector in the CMS database | yes | yes | possible | extension + HNSW tuning | existing PG connection |
| D. MongoDB (Atlas or Community + `mongot`) | no | yes | no | a third datastore | needs a driver spike |

Vendor facts reported during review and not yet re-checked by this ADR's
author: MongoDB Community Search / Vector Search is GA from 8.2 and needs the
`mongot` process, which is SSPL-licensed; Voyage `voyage-4*` embedding and
`rerank-3*` models are active, `rerank-2.5-lite` is legacy. R01 re-checks these
against vendor docs, with access dates, before any of them drives a choice.

## Decision

1. **PostgreSQL stays the source of truth** for items, permissions, approvals,
   audit and provenance. Any retrieval index is derived data.
2. **Four responsibilities, four places.** No new `RetrievalProvider`
   hierarchy and no new package.

   | Layer | Owns | Does not own |
   | --- | --- | --- |
   | `RetrievalService` (`apps/cms/src/services/`) | retrieval orchestration: tenant scope, live authorization, revision checks, candidate fusion and reranking order | provider choice, credentials, egress rules |
   | Data-egress policy (shared) | the decision whether a piece of content may be indexed, and separately whether it may leave to an external provider or index | which provider or credential is used |
   | AI provider resolution seam | which provider, model and credential serve a call | whether the content may be sent |
   | Provider adapters | the technical call, after the two decisions above | policy of any kind |

   `RetrievalService` reuses `ItemService` and the existing policy services for
   authorization and does not implement its own RBAC. Lexical candidates come
   from the existing `SearchProvider`; a lower-level vector interface is added
   only when a vector store is actually built (R05).
3. **One AI provider resolution path for retrieval too.** Document embedding,
   query embedding and reranking resolve their provider through the same seam
   as generation; retrieval adds no gateway, client or credential lookup of its
   own. That seam does not exist yet: it is a separate core issue (single AI
   provider resolution path) that R04 depends on. Its contract is neutral and
   lives in `@lumibase/contracts`; its default resolves from instance
   configuration exactly as today, so Community needs nothing else to use it.
   For retrieval the contract must cover:
   - an `EmbeddingProvider` with an `inputType` of `query` or `document`, and a
     reranking call, resolved per call with the purpose (`embedding.document`,
     `embedding.query`, `rerank`) and the tenant;
   - background indexing jobs, which resolve through the same path inside a
     usage scope (`runWithUsageScope`), not only request-time queries;
   - a resolver failure that surfaces as an error, never as a silent switch to a
     different provider or credential.

   Embedding, reranking and generation are configured separately. Model names
   are configuration; every benchmark run pins model, dimensions, settings and
   index version. Usage (tokens, calls, indexed units) is reported with the
   existing `recordUsage`; no retrieval-specific metering subsystem is built.
   Those events are best-effort reporting. They are not an accounting ledger,
   and nothing in core treats them as one: a deployment that needs exact
   accounting or hard budgets builds reservation, settlement, idempotency and
   reconciliation outside this path.
4. **Meili hybrid with `userProvided` vectors (option B) is the preferred
   experiment**, not a stepping stone: if it meets Gate A it can be the
   production answer. LumiBase computes the vectors through the resolution
   seam and hands them to Meili, so content never leaves through a Meili-side
   REST embedder that would bypass the egress policy, usage reporting and
   audit.
5. **pgvector (option C) is the conditional candidate**, built only if Gate A
   fails. **MongoDB (option D) is deferred**: tried only if R06 names a concrete
   problem C cannot solve. No production datastore is added by this ADR.
   Startup credits count toward R&D budget, never toward steady-state TCO.
6. **Data egress is deny-by-default (B179 — Proposed, owner to approve).**
   - Read access does not imply permission to index or to send content to a
     third party, and the two are separate capabilities: "may be indexed"
     (into a derived index the deployment operates) and "may leave to an
     external provider or index" (a model vendor, a hosted search service).
     A field may be indexable and still not leave.
   - PII/PHI, credentials and encrypted fields are excluded from indexing,
     document and query embedding, and reranking unless a policy allows it.
   - The policy is shared, not owned by `RetrievalService`. It is checked at
     every point where content leaves for an AI provider or an external index:
     retrieval queries, background indexing and reindexing, Copilot, review
     runs, agent runs and flow AI decisions. It applies to every provider
     (OpenAI, Voyage, Workers AI, Anthropic, …).
   - The capabilities are new and are designed in R01; they do not exist today.
     R01 also lists the existing outbound paths, so that each one is either
     wired to the policy or named as a follow-up.
7. **Retrieval invariants**, whichever engine wins:
   - each chunk holds text from exactly one field, and queries filter on the
     fields the principal may read — a vector built from a hidden field leaks
     through ranking even when the field is masked in the result;
   - tenant, status and field scope are pre-filters; row rules that cannot be
     expressed as an index filter are checked at hydration against PostgreSQL,
     with over-fetch, and the short-result rate is measured;
   - live authorization and revision checks run before reranking, before
     anything enters a prompt, and cover results, snippets, scores and
     metadata;
   - deletion, revocation and reclassification must stop a chunk from being
     returned even when the indexer has not caught up (B181);
   - telemetry does not store raw content or queries by default;
   - when Epic #853 adds environments, the index key and every retrieval filter
     include the environment, recorded in the Setup Impact Registry.
8. **Live authorization is not by itself a no-leak guarantee.** Rows the
   principal may not read can still shape what it observes: they can fill the
   top-k so hydration returns fewer or no results, change the order and scores
   of the rows that remain, change counts, and change latency. A principal
   probing a secret term can read those differences. So:
   - R01 writes a threat model for the rank, count, score, short-result and
     timing channels, and states which residual risk the owner accepts (for
     example: a row rule that cannot be an index pre-filter leaves a
     short-result signal);
   - R03 proves, with tests, that unreadable rows do not change the public
     signals beyond that accepted risk: counts follow #738 (visible count for a
     restricted caller), scores are not exposed to a restricted caller, and the
     short-result and timing behaviour is measured with and without unreadable
     matches;
   - anything that can be a pre-filter is a pre-filter; post-filtering is the
     fallback, not the design.
9. **Benchmarks decide; they do not sign off.** A minimal suite first: 80
   human-reviewed queries (15 keyword/entity, 15 paraphrase, 10 EN↔VI,
   5 multi-document, 10 no-answer, 5 stale/conflicting, 20 tenant/permission
   traps). An LLM may draft queries and labels; it is never the only judge.
   The traps complement, not replace, integration tests for isolation,
   revocation and deletion.

   No absolute Recall target is set before E1 exists, but the win condition is
   fixed before any candidate is compared to E1. R02 splits the queries into a
   tuning set and a held-out set, and records in the repository, before E2
   runs:
   - the minimum relevance gain over E1 on the held-out set that a candidate
     must show;
   - the security invariants (decisions 7 and 8), where any violation
     disqualifies a candidate regardless of relevance;
   - the latency budget and the expected workload it is measured at;
   - the acceptable operating cost;
   - the stop rule: when the matrix stops, and when it moves to the next
     candidate.

   Tuning uses only the tuning set; the held-out set is scored once per
   candidate configuration. Changing a criterion after results exist needs a
   written reason in this ADR.

   | ID | Experiment | Run |
   | --- | --- | --- |
   | E0 | latest 3 items (#581 baseline) | always |
   | E1 | Meili lexical | always |
   | E2 | E1 + Voyage rerank | always |
   | E2.5 | Meili hybrid + Voyage embeddings (`userProvided`) | always |
   | E3–E6 | pgvector exact / HNSW / hybrid / + rerank | if Gate A fails |
   | E7 | MongoDB, same embeddings | if R06 needs it |

   The matrix may stop at E2 or E2.5. Whatever is chosen is scale-tested at the
   expected workload, including a concurrent CMS CRUD load.

### Plan and gates

| ID | Work | Depends on |
| --- | --- | --- |
| R01 | this ADR's open items: B179 policy (both capabilities, every outbound path), leakage threat model, Meili production provisioning audit, vendor fact check | — |
| R02 | minimal evaluation suite (relevance + security), tuning/held-out split, pre-registered win conditions | R01 |
| R03 | governed lexical retrieval: `RetrievalService`, live authorization, side-channel tests; minimum index lifecycle shared by every engine — one-field chunks, versioned index, upsert, delete, reindex, failed-job retry (B181) | R01 |
| AI seam | single AI provider resolution path (separate core issue), covering embedding and reranking | — |
| R04 | Voyage adapter behind the seam, E2 and E2.5, usage through `recordUsage` | R01 (B179 approved), R02, R03, AI seam |
| Gate A | does Meili hybrid meet the R02 conditions? Decides whether another engine is tried | R03, R04 |
| R05 | pgvector-specific work only: schema, extension, HNSW, the vector interface (only if Gate A fails) | Gate A |
| R06 | final engine choice and TCO; closes B180 | Gate A, and R05 when it runs |

The index lifecycle is not pgvector work: E2.5 already needs embeddings per
chunk, versioning, upsert, delete and reindex, and so does a Meili hybrid
production answer if R05 never runs. R04 runs E2 and E2.5 on integrated data
only on top of R03's authorization and indexing contract.

### Acceptance criteria

- **Provider calls (R01, R04).** R01 defines the resolution contract: tenant and
  operation (generation, document embedding, query embedding, reranking) in;
  provider, model and credential reference out. The B179 check runs on the
  actual destination and payload before dispatch. R04 integrates the resolver
  before its first provider call.
- **Search visibility (R01, R03).** R03 runs the same principal and query on
  corpora that differ only in inaccessible rows or fields, including rows that
  would exhaust the top-k, and compares visible order, counts, scores, result
  length and latency distributions. The candidate set is restricted before
  ranking, or a permission-scoped fallback is used. Any residual signal is
  recorded and accepted by the owner before rollout.
- **Index lifecycle (R03, R04).** Chunks are keyed by site, collection, item,
  field and chunk position. Writes are versioned by source revision and retried
  idempotently; obsolete chunks are removed on update and deletion; the index
  can be rebuilt from PostgreSQL. Tests cover out-of-order jobs and
  revocations. R04 versions vectors by model and dimensions and reindexes
  before switching versions.
- **Decision criteria (R02, Gate A, R06).** E1 on the tuning set sets the
  minimum relevance gain; thresholds and stop/advance rules are frozen before
  candidate evaluation; held-out results are reported at Gate A; B180 closes at
  R06 only.

Agent memory, contradiction detection, multimodal search, content
relationships and a MongoDB adapter are backlog, not part of this work. The
retrieval foundation is Community (`khuepm/LumiBase`); if a MongoDB adapter is
ever built it is Community too. The resolution and usage seams are the only
extension points a commercial deployment needs; core ships their defaults and
does not depend on any other implementation.

## Consequences

- No new datastore, package or runtime dependency until evidence asks for one.
  `apps/cms/wrangler.toml` keeps `compatibility_date = "2024-10-01"`; the bump a
  MongoDB driver on Workers would need is not made by this ADR.
- The silent Echo fallback is a bug on `main` and is fixed separately, under the
  release freeze, as `fix(ai)`. The fix distinguishes three states:

  | State | Behaviour |
  | --- | --- |
  | Embeddings disabled (no embedding provider configured) | the CMS starts and works; features that need embeddings report that they are disabled |
  | A provider configured but its credential missing, or an unknown provider | a clear error naming the setting, without the credential |
  | Echo | only when chosen explicitly, and only in development or test |

  A deployment that uses Anthropic for generation and has configured no
  embedding provider falls in the first row: it keeps working, it just stops
  receiving fake Echo vectors. Adding `EMBEDDING_PROVIDER`, Voyage and
  reranking is feature work for the epic branch.
- Feature work lands on an `epic/<issue>-governed-retrieval` branch while the
  v2.2.0 freeze is active.
- Option B keeps retrieval outside the source transaction, so B181 and live
  authorization stay mandatory; choosing B does not remove R03's work.
- B180 stays open until R06; Gate A only decides whether another engine is
  tried. B179 is decided by the owner; until then R04 does not send content to
  an external provider outside test fixtures.
