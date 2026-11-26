---
version: 2
sourceLang: en
lastUpdated: 2026-11-26T02:34:32.098Z
contentHash: 0f007afe388a83fa
codeVerified: 2026-11-26T02:34:32.098Z
codeVerifiedHash: 0f007afe388a83fa
codeVerifiedClaims: 6
---

# ADR-016: Governed retrieval — evidence-driven engine choice

**Date:** 2026-11-26  
**Status:** Proposed (closes B180 only once Decision Gate A or R06 has evidence)

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
  unknown.
- `lumibase_ai_embeddings` (`packages/database/src/schema/ai.ts`) stores vectors
  as JSONB with `site_id`; similarity is brute-force `cosineSimilarity` in JS.
  No pipeline writes to it.
- `SearchProvider` (`packages/runtime/src/interfaces/search.ts`) already covers
  `index`, `search`, `delete`, `getIndex` and `configureIndex`, with MeiliSearch
  adapters for both runtimes. The tenant boundary lives in the index name
  (`searchIndexName(siteId, collection)`). The code supports Meili on Workers;
  whether production has a Meili instance provisioned is not verified.
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
2. **One `RetrievalService` in `apps/cms/src/services/`** orchestrates retrieval.
   It is the only place that applies tenant scope, live authorization, revision
   checks and the data-egress policy. It reuses `ItemService` and the existing
   policy services for authorization and does not implement its own RBAC. There
   is no new `RetrievalProvider` hierarchy and no new package. Lexical
   candidates come from the existing `SearchProvider`; a lower-level vector
   interface is added only when a vector store is actually built (R05).
3. **The embedding provider is independent of the datastore.** Embedding,
   reranking and generation are configured separately. Voyage is added as an
   `EmbeddingProvider`, with an `inputType` of `query` or `document`. Model names
   are configuration; every benchmark run pins model, dimensions, settings and
   index version.
4. **Meili hybrid with `userProvided` vectors (option B) is the preferred
   experiment**, not a stepping stone: if it meets Gate A it can be the
   production answer. LumiBase calls Voyage itself and hands Meili the vectors,
   so content never leaves through a Meili-side REST embedder that would bypass
   the egress policy, metering and audit.
5. **pgvector (option C) is the conditional candidate**, built only if Gate A
   fails. **MongoDB (option D) is deferred**: tried only if R06 names a concrete
   problem C cannot solve. No production datastore is added by this ADR.
   Startup credits count toward R&D budget, never toward steady-state TCO.
6. **Data egress is deny-by-default (B179 — Proposed, owner to approve).**
   Read access does not imply permission to index or to send content to a third
   party. PII/PHI, credentials and encrypted fields are excluded from indexing,
   query embedding and reranking unless a policy allows it. The policy applies
   to every provider (OpenAI, Voyage, Workers AI, …). The capabilities this needs
   ("may be indexed", "may leave to an external provider") are new and are
   designed in R01; they do not exist today.
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
8. **Benchmarks decide; they do not sign off.** A minimal suite first: 80
   human-reviewed queries (15 keyword/entity, 15 paraphrase, 10 EN↔VI,
   5 multi-document, 10 no-answer, 5 stale/conflicting, 20 tenant/permission
   traps). An LLM may draft queries and labels; it is never the only judge.
   The traps complement, not replace, integration tests for isolation,
   revocation and deletion. No fixed Recall target is set before E1 exists.

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
| R01 | this ADR's open items: B179 policy, Meili production provisioning audit, vendor fact check | — |
| R02 | minimal evaluation suite (relevance + security) | R01 |
| R03 | governed lexical retrieval: `RetrievalService`, live authorization, B181 | R01 |
| R04 | Voyage provider, E2 and E2.5, usage metering | R01 (B179 approved), R02 |
| Gate A | does Meili hybrid meet quality, security, latency and cost? | R03, R04 |
| R05 | pgvector, chunking, index lifecycle (only if Gate A fails) | Gate A |
| R06 | final engine choice and TCO; closes B180 | Gate A or R05 |

Agent memory, contradiction detection, multimodal search, content
relationships and a MongoDB adapter are backlog, not part of this work. The
retrieval foundation is Community (`khuepm/LumiBase`); if a MongoDB adapter is
ever built it is Community too.

## Consequences

- No new datastore, package or runtime dependency until evidence asks for one.
  `apps/cms/wrangler.toml` keeps `compatibility_date = "2024-10-01"`; the bump a
  MongoDB driver on Workers would need is not made by this ADR.
- The silent Echo fallback is a bug on `main` and is fixed separately, under the
  release freeze, as `fix(ai)`: a configured provider with a missing credential
  or an unknown provider fails loudly; Echo runs only when chosen explicitly;
  the CMS still starts with embeddings disabled; errors carry no credential.
  Adding `EMBEDDING_PROVIDER`, Voyage and reranking is feature work for the epic
  branch.
- Feature work lands on an `epic/<issue>-governed-retrieval` branch while the
  v2.2.0 freeze is active.
- Option B keeps retrieval outside the source transaction, so B181 and live
  authorization stay mandatory; choosing B does not remove R03's work.
- B180 stays open until R06. B179 is decided by the owner; until then R04 does
  not send content to an external provider outside test fixtures.
