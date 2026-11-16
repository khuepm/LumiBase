---
version: 1
lastUpdated: 2026-11-05T15:42:10.810Z
sourceLang: en
contentHash: e59720ec7277c668
---

# AI evaluation gates (#585)

The versioned suite index is `apps/cms/eval/ai-audit-suites.json`. It reuses existing authorization, compromised-model injection, structured-output, budget, governance and multi-step repair fixtures. Deterministic contract checks and PostgreSQL assertions are PR gates in `.github/workflows/ci.yml`; model quality is a separate scheduled/manual workflow, `.github/workflows/ai-evaluation.yml`.

## Reproduce an audited revision

Check out the exact PR commit with a clean working tree, install with `pnpm install --frozen-lockfile`, then run:

```bash
pnpm -F @lumibase/cms eval:ai
# Use a disposable database: integration fixtures can delete shared rows.
DATABASE_URL=postgresql://... pnpm db:migrate
DATABASE_URL=postgresql://... pnpm -F @lumibase/cms eval:ai --database
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
pnpm -F @lumibase/cms exec tsx scripts/jev-quality-gate.ts eval/jev-benchmark/reports/v1/typesafe/report.heldout.json
```

Use a fresh report directory for each protocol run. The [benchmark protocol](./jev-benchmark.md) describes the frozen datasets, rubric fingerprint, seed, model/provider identity, threshold file hash, metrics and per-sample failure artifacts. Reports additionally record the source commit and working-tree dirtiness; unknown and mixed revisions are explicit. A clean commit pins prompts, schemas, provider adapter and configuration defaults. Provider-side model aliases can change, so identical input does not guarantee identical live answers.

## Gates and evidence

- Contract parity: canonical validation matches advertised schemas, Copilot required fields/capabilities and harness risk classification. Write-capable tools require schemas (the documented seed-artifact exception persists no data). Database overrides may add permissions but cannot remove core permissions or downgrade a dangerous core risk policy.
- PostgreSQL: malformed inputs write no runs/approvals/versions; a capability downgrade cannot create a collection or bypass approval. Existing G3 repair-loop fixtures read final items, versions, drift and goal rows after the multi-step flow; G1 concurrency fixtures verify a single execution.
- Missing database: the audit command fails without `DATABASE_URL`; individual Vitest suites explicitly skip when no DB was requested and fail if a configured DB cannot connect. Neither is silently counted as a pass.
- Live quality: each VI/EN heldout split must contain 60 samples, no failed provider calls, selective precision at least 0.90 and coverage at least 0.50 for both tag and route. Missing thresholds, mock evidence and unknown/dirty source revisions fail. These are candidate acceptance floors, not measured provider baselines or approval to enable automation. The precision target comes from protocol v1; the coverage floor prevents an almost-always-abstaining model passing.
- The live workflow runs weekly and manually, requires its provider secret explicitly, and retains reports, thresholds and per-sample outcomes for 30 days even on quality failure. No key means a failed dependency step, never a quality pass. PR checks require no paid provider.

The gate tests contain a passing synthetic control followed by a deliberately degraded precision result that must fail. Permission/schema assertions similarly fail if required capabilities are removed or contracts diverge. Full CI additionally runs the existing MCP canonical-schema snapshot and DB guard tests.

## Remaining limitations

No live provider baseline is established by this change; #548 remains the live-data go/no-go task. Frozen synthetic editorial and drift samples test relevance, injection handling and structured answers; they do not establish general RAG retrieval quality or factual grounding. The broader retrieval, routing and reliability investigations remain in #581–#584. This index consolidates reusable evidence rather than claiming those investigations complete. Dataset expansion or floor changes require a reviewed version change and new heldout evidence. See [benchmark limitations](./jev-benchmark.md#limitations).
