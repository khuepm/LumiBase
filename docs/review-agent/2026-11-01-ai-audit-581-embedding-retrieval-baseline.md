# #581 audit: embedding compatibility, chunking and retrieval quality

- **Parent:** #577 (workstream 4, P1)
- **Audited commit:** `f3ae224c` (`origin/main`, 2026-11-01)
- **Fix branch:** `feature/581-embedding-retrieval-baseline`
- **Model:** none. A recording provider captures the prompt that would be sent; no live
  model is called, so there are **no model-sensitive results** in this report.
- **Coordination:** #580 (PR #595) owns the queued Agent API worker, which on the audited
  commit gives `aiContentAssist` a system `ItemService` (its F1). #579 (PR #587) owns
  prompt-injection through sample content. #359 owns benchmark infrastructure. #507 (Jev)
  owns semantic review.

## 1. What exists (the issue asks not to assume)

| Question | Answer at `f3ae224c` | Evidence |
|---|---|---|
| Embedding provider / model / dimensions | `embedding-service.ts`: OpenAI `text-embedding-3-small` (declared 1536), Workers AI `@cf/baai/bge-base-en-v1.5` (768), Echo (8). | `apps/cms/src/services/embedding-service.ts` |
| Who calls it | **Nobody.** No import of `embedding-service` and no reference to `aiEmbeddings` outside the schema. | `grep -rn "createEmbeddingProvider\|aiEmbeddings\|embedding-service" apps packages` |
| Storage | `lumibase_ai_embeddings`: `embedding jsonb`, `model text default 'text-embedding-3-small'`, `chunk_text`, `field_name`, `item_id` (nullable). No dimension column, no unique key, no writer. | `packages/database/src/schema/ai.ts:99-131`, migration `0000` |
| Similarity | `cosineSimilarity` in JS (brute force). No pgvector column, no ANN index. | `embedding-service.ts` |
| Chunking / overlap | None. No code splits content. | — |
| What the "RAG" skills send to the model | `aiSuggestField`: existing field names of the collection + the admin's description. `aiContentAssist`: `itemService.list(collection, { limit: 3 })`, i.e. the 3 most recently updated items the caller may read (default sort `updated_at DESC`), serialised and cut at 4000 chars. | `ai-harness.ts` `aiSuggestField`/`aiContentAssist`; `item-service.ts` `buildSort` |
| Which `ItemService` each entry point gives the skill | Copilot sync (`routes/ai.ts`), MCP (`routes/mcp.ts`), Copilot worker (`ai-chat-run-worker.ts`): principal-bound. Agent API worker (`agent-run-worker.ts`): system service on this commit, fixed by #580 F1 (PR #595). | code refs listed |

So the subsystem the issue describes (index, chunks, re-index lifecycle, mixed models) does
not run anywhere. The only retrieval that reaches a model is the live `ItemService` sample.
The audit therefore splits into (a) the live sample path, tested end to end, and (b) the
dormant embedding primitives, tested as units.

The docs said both skills retrieve "similar vectors from the database via cosine similarity".
That is a documentation inaccuracy, not reported as a defect. It is corrected in
`docs/{en,vi}/features/ai-copilot.md` in this PR.

## 2. Matrix

| Concern | Live sample path (`aiContentAssist`) | Embedding primitives |
|---|---|---|
| Tenant isolation | **pass** (site B item, newer than all of site A, never sampled) | N/A (no index) |
| Row rule | **pass** (draft excluded by `status = published` rule) | N/A |
| Field rule | **pass** (ungranted `internalNote` canary absent) | N/A |
| Internal metadata | **fail → fixed (F1)** | N/A |
| Freshness: update / delete | **pass** (next call shows new title, drops deleted item) | N/A (nothing to go stale) |
| Revocation | **pass** (collection read revoked → 0 samples; every read revoked → denied before any model call) | N/A |
| Cost per call | **fail → fixed (F2)** | — |
| Mixed dimensions / models | N/A | **fail → fixed (F3)** |
| Re-index reproducible | N/A | **N/A, justified:** no writer, no rows, no job exists to re-run |
| Chunk boundaries / overlap | N/A (whole rows, 4000-char cut) | **N/A, justified:** no chunker exists |
| Recall@k / ranking | measured (§5) | N/A |

## 3. Findings

### F1: whole item rows went to the model provider (fixed)

- **Severity: low.** The samples were full `lumibase_items` rows: `siteId`, `collectionId`,
  `userCreated`/`userUpdated`, `pinnedFields`, timestamps and `dekWrapped`. No privilege
  boundary is crossed: the same principal gets these columns from the items API. The impact
  is disclosure of internal identifiers and the wrapped DEK to a third-party provider. A
  provider-side copy of the wrapped DEK outlives the crypto-shred that deletes it from
  `lumibase_items` (Req 11.2). That only matters together with a later KEK compromise, and
  envelope encryption is off by default. The metadata also spent part of the 4000-char budget.
- **Reproduction:** run `aiContentAssist` with a recording provider; the user turn contains
  `"siteId":"site_581_a"` and every sample id.
- **Fix:** samples are projected to `{ status, data }`.
- **Evidence:** `ai-content-assist-retrieval.db.integration.test.ts` case 1 asserts the
  prompt contains no site id, collection id, item id, `"dekWrapped"`, `"userCreated"`.

### F2: a `count(*)` over the collection for a 3-row sample (fixed)

- **Severity: low.** `ItemService.list` counts by default. The skill never reads the
  total, so every call paid a scan of the whole permitted collection. The cost is small
  next to the model call, but it grows with the collection and with concurrent calls.
- **Measurement** (local only: PostgreSQL 17.11 in Docker, arm64, 8 vCPU, macOS host,
  pgbench, one run each, 80 % `published` rows; scripts in the PR body):

  | Items | 1 client, list only | 1 client, list + count | 16 clients, list only | 16 clients, list + count |
  |---|---|---|---|---|
  | 1 000 | 0.127 ms | 0.561 ms | 32 625 tps | 7 328 tps |
  | 10 000 | 0.184 ms | 0.871 ms | 20 462 tps | 3 323 tps |
  | 100 000 | 0.148 ms | 8.537 ms | 25 802 tps | 97 tps (165 ms avg) |

  The list itself stays flat (index `items_site_coll_updated_idx`); the count is what scales.
  These numbers are not a Cloudflare/Hyperdrive measurement.
- **Fix:** `withTotal: false`. **Evidence:** case 1 asserts the exact `list` arguments.

### F3: embedding primitives did not fail on mixed dimensions (fixed, latent)

- **Severity: low.** Unreachable today (no caller). Three behaviours would have hidden a
  mixed index once wired: `cosineSimilarity` returned `0` for vectors of different length
  (ranked as "unrelated" instead of failing); Workers AI turned a malformed answer into
  `[]` for N inputs; the OpenAI provider declared 1536 dimensions for any model
  (`text-embedding-3-large` returns 3072). Providers also exposed no model id to store.
- **Fix:** `cosineSimilarity` throws `EMBEDDING_DIMENSION_MISMATCH`; `assertEmbeddings`
  checks count, size and finiteness for both providers (`EMBEDDING_RESPONSE_INVALID` /
  `EMBEDDING_DIMENSION_MISMATCH`); OpenAI dimensions come from a per-model table and an
  unknown model throws `EMBEDDING_MODEL_UNKNOWN`; every provider has `model`.
- **Evidence:** `services/__tests__/embedding-service.test.ts` (12 cases, `fetch` stubbed).

## 4. Controls verified correct (no change)

All in `services/__tests__/ai-content-assist-retrieval.db.integration.test.ts`: real
PostgreSQL, real `ItemService` bound to an API-key principal resolved by
`EffectiveCapabilityService`, two sites, called through `AISecureHarness.execute`.

- tenant, row and field rules on the sample (case 1);
- update and soft delete visible on the next call: the context is read live, there is no
  cache or index to go stale (case 3);
- revoking read on the collection gives 0 samples while the skill still runs; revoking
  every read grant denies the call before any model request (cases 4 and 5). Permission
  caching across requests is covered by the existing `permission-cache-revocation`
  integration suite and is not re-tested here.

**Negative checks** (fix reverted with `git checkout` of `ai-harness.ts` and
`embedding-service.ts`, measured): 11 of 17 new cases fail. DB case 1 fails on
`internal metadata reached the model: site_581_a`; 10 of 12 embedding cases fail. With only
`withTotal: false` removed, 1 of 5 DB cases fails on the `list` arguments. DB cases 2–5 pass
on the audited code, as expected for controls that already worked.

**Wider verification:** `pnpm typecheck` 18/18; `pnpm check:all` exit 0; full apps/cms run
with `DATABASE_URL` (timing test excluded) 4219 passed, 2 skipped, 1 failed. The failure is
the golden-path e2e, which needs `JWT_SECRET` and the docker runtime env; it passes 1/1 when
run alone with them.

## 5. Retrieval baseline

`apps/cms/eval/retrieval/dataset.v1.json` (version `retrieval-baseline@1`) holds 7 site-A
items, 1 site-B item, the permitted scope (row rule `status = published`, fields `title`,
`body`) and 4 queries with their relevant items. k = 3, the skill's sample size. DB case 2
replays it and asserts the numbers below exactly, so a retriever change shows up as a diff.

| Query | Relevant | Retrieved (every query) | Recall@3 | RR@3 |
|---|---|---|---|---|
| Q1 solar cleaning | c1, c4 | c6, c5, c4 | 0.5 | 0.3333 |
| Q2 inverter codes | c2 | c6, c5, c4 | 0 | 0 |
| Q3 heat pump | c3, c5 | c6, c5, c4 | 0.5 | 0.5 |
| Q4 battery size | c6 | c6, c5, c4 | 1 | 1 |
| **Mean** | | | **0.5** | **MRR@3 0.4583** |

**Threshold rationale:** none is set. The retriever ignores the instruction, so these numbers
measure which items were edited last, not relevance. Any threshold would pass or fail by
reordering `updated_at`. Choosing a real retriever (lexical through the masked search index,
or vectors) is an owner decision (B180); the dataset and the freshness/isolation cases are
the harness to set a threshold against once one exists.

**Scaling recommendation, from F2:** at the sizes measured the sample query is flat after the
fix. If vector retrieval is built, brute-force cosine over JSONB is O(n) per query in the
worker; plan pgvector (`vector(d)` with a stored model id and dimension, HNSW index) before
corpora reach the 10⁴–10⁵ range measured here. That is a recommendation, not measured.

## 6. Not covered / residual

- **Live models:** not called. No quality claim about generated content.
- **Encrypted PII/PHI in samples:** decrypted for principals holding `read_decrypted`, then
  sent to the provider. Not a privilege escalation; whether to exclude it is an owner
  decision (**B179**).
- **Search index staleness:** `GET /api/v1/search` applies row rules to the indexed snapshot,
  and failed index jobs are dropped. Not part of model context, not reproduced (**B181**).
- **Agent API queued runs:** sample masking there depends on #580 F1 (PR #595).
- **4000-char cut** can end mid-JSON; a quality issue only, unchanged.
- **Benchmark on Cloudflare/Hyperdrive:** not run (#359, B98).

## 7. Acceptance criteria of #581

| Criterion | Status |
|---|---|
| Versioned dataset with query, relevant items and permitted scope; Recall@k and a ranking metric with chosen k | done: `dataset.v1.json`, k = 3, Recall@3 0.5, MRR@3 0.4583 (§5) |
| Mixed dimensions/versions fail safely or migrate explicitly; re-index reproducible | primitives now fail explicitly (F3). Re-index: N/A, no index or writer exists (B180) |
| Automated isolation/freshness tests pass, incl. removed permissions and deleted items | done: DB cases 1, 3, 4, 5 |
| Baseline/threshold rationale and evidence-based scaling recommendations; confirmed gaps fixed | §5 (no threshold, with reason), F2 measurements; F1–F3 fixed |
