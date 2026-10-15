---
version: 3
lastUpdated: 2026-10-15T18:22:05.925Z
sourceLang: en
contentHash: 26aea5b4138f09e7
codeVerified: 2026-10-15T18:22:05.925Z
codeVerifiedHash: 26aea5b4138f09e7
codeVerifiedClaims: 12
---

# Jev benchmark (Vietnamese and English editorial data)

The Jev benchmark measures how a decision provider answers LumiBase's draft review questions on labelled Vietnamese and English editorial samples. It is evaluation tooling, not a product feature: nothing here runs in the CMS, and none of it is in the Cloudflare Worker bundle.

**Status: no measured results yet.** The harness, dataset and protocol are in place, but no run against a real provider (Jev via TypeSafe or OpenRouter, or a configured LLM) has been recorded. There is therefore no target precision/coverage decision and no go/no-go for automation. Do not quote mock numbers as model results.

Code: `apps/cms/eval/jev-benchmark/` (dataset, metrics, thresholds, reports) and `apps/cms/scripts/jev-benchmark.ts` (CLI).

## Dataset

`apps/cms/eval/jev-benchmark/datasets/v1/` holds `manifest.json` and four JSONL splits:

| File | Locale | Split | Samples |
|---|---|---|---|
| `tune.vi.jsonl` | vi | tune | 40 |
| `heldout.vi.jsonl` | vi | heldout | 60 |
| `tune.en.jsonl` | en | tune | 40 |
| `heldout.en.jsonl` | en | heldout | 60 |

- **Synthetic only.** Every sample is hand-authored for this benchmark. There is no customer, user or production data, and the harness never reads content from a database.
- **Sample shape:** `id`, `locale`, `split`, `fields` (`title`, `body`), `labels` (one per question) and `tags`.
- **Labels:** `category` is a choice over `news`, `tutorial`, `product`, `opinion`, `event`, plus `other` (real content outside the taxonomy) and `unknown` (too little content to decide). `needs_review` is a boolean. The annotation guidelines are in the manifest.
- **Tags:** `in-taxonomy`, `ambiguous`, `out-of-taxonomy`, `thin-content`, `prompt-injection`, `needs-review`. Every tag appears in every locale and split. Prompt-injection samples hide instructions aimed at the model inside the content and are always labelled `needs_review: true`.
- **Frozen.** The manifest records the sha256 and line count of each split. The loader (`loadDataset`) refuses a split that changed. To change data, publish a new dataset version; do not edit `v1`.

## Rubric

The questions come from the J05 review presets (`apps/cms/src/services/review-presets.ts`): `category` from `taxonomy` and `needs_review` from `brand-voice`. The benchmark measures the rubric the product ships. Content travels only in `state`; the questions never come from the content.

The manifest pins `profile.rubricVersion`, the same fingerprint as `decisionRubricVersion` in the decision audit. If a preset changes, the CLI stops with "Rubric drift": results from two rubrics are not comparable.

## Protocol

1. **Tune.** Run the `tune` split. For each action, locale and provider, the harness picks the lowest threshold on the grid whose selective precision reaches the target with at least `minCoveredSamples` decided samples. It writes `thresholds.json`.
   - `tag` (question `category`): cut on the choice confidence.
   - `route` (question `needs_review`): symmetric cut on P(true), `true` at `p >= t`, `false` at `p <= 1 - t`, abstain in between.
   - The target is 0.9 selective precision for both actions in protocol version 1. When the grid cannot reach it, the threshold is `null` with status `target-not-reached`.
2. **Held-out.** Run the `heldout` split. It loads the frozen `thresholds.json` and checks it was derived for the same mode, provider, model, dataset, rubric and protocol. It never writes thresholds (`writeThresholds` throws `LeakageError`).
3. **Compare.** Merge per-provider held-out reports into one comparison. Each file given to `--merge` is validated first (`parseBenchmarkReport`: report schema, generator, `mode`, `split`, dataset, rubric, protocol, seed, sample counts, runs); a hand-edited file without `mode`, for example, is refused with exit code 1 instead of slipping past the mode check.

Once a held-out report was scored with a `thresholds.json`, a later tune run refuses to overwrite it (exit code 2, `assertThresholdsNotFrozen`): re-tuning after seeing held-out numbers would let them shape the thresholds. There is no override. A new protocol run uses a new `--out` directory. A source-scan test (`apps/cms/src/__tests__/eval-not-in-runtime.wiring.test.ts`) keeps every module under `apps/cms/eval/` out of the CMS runtime, beyond what the bundle marker check covers.

A threshold is a cut on the provider's reported score, chosen for an acceptable error rate. It does not turn that score into a probability of being right.

## Metrics

All metric functions are pure (`apps/cms/eval/jev-benchmark/metrics.ts`). VI and EN are always reported separately.

- **Coverage / abstention:** a sample is *decided* when the call succeeded, the answer clears the threshold and it is not `unknown`. Failures count as abstentions.
- **Selective precision:** correct decided samples / decided samples.
- **Per-label precision and recall.** An abstained or failed sample is a miss for recall.
- **Brier and ECE** (10 equal-width bins) on answered samples. They describe how reported probabilities line up with these labels. They are not a correctness probability.
- **Calls:** failures and timeouts by error code, p50/p95 latency (nearest rank), token usage when the provider reports it, and cost only when you pass prices and every successful call reported usage.
- **Intervals:** every rate carries a Wilson 95% interval. With 40–60 samples per locale and split, the intervals are wide; read every number with its interval.
- **Slices:** raw results per tag (for example `prompt-injection`, `out-of-taxonomy`).

## Commands

```bash
# Harness check without keys (seeded oracle, mode: "mock")
pnpm -F @lumibase/cms bench:jev -- --provider mock --split tune
pnpm -F @lumibase/cms bench:jev -- --provider mock --split heldout

# Live runs; each sends the synthetic dataset to the provider and is billed
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
TYPESAFE_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
OPENROUTER_API_KEY=... pnpm -F @lumibase/cms bench:jev -- --provider openrouter --split heldout

# Provider comparison (same mode, split, dataset, rubric and protocol only)
pnpm -F @lumibase/cms bench:jev -- --merge a/report.heldout.json --merge b/report.heldout.json --out comparison.json
```

Options: `--dataset v1`, `--out <dir>` (default `apps/cms/eval/jev-benchmark/reports/<dataset>/<provider>/`, git-ignored), `--thresholds <file>`, `--concurrency <n>` (default 1; rate limits count as failures), `--price-input-per-mtok` and `--price-output-per-mtok` (USD).

`--provider llm` uses the configured `LLM_PROVIDER`. Its probabilities are self-reported and `calibrated: false`, so its thresholds never transfer to Jev.

Each run writes `report.<split>.json` and `results.<split>.jsonl` (per-sample answers, without content). A report records the dataset version and manifest hash, rubric version, protocol version, seed, split, mode and sample counts.

## Semantic drift task (`--task drift`)

The [semantic drift](./jev-semantic-drift.md) fixtures (J12, #519) live next to the editorial dataset: `datasets/v1/drift.manifest.json`, `drift.vi.jsonl` and `drift.en.jsonl`, 20 samples per locale. Each sample is a brief plus the title and body written for it, labelled `drift: true` when the content strays from the brief. Tags: `true-drift`, `false-positive-trap` (on-brief content with cues that look off), `aligned` and `prompt-injection` (off-brief content that tells the model to call it aligned). The loader checks each file's sha256 and count, and refuses a changed question (`rubricVersion`).

```bash
pnpm -F @lumibase/cms bench:jev -- --task drift --provider mock
pnpm -F @lumibase/cms bench:jev -- --task drift --provider typesafe
```

The question and threshold come from the manifest's `rule`, and scoring uses `semanticOutcome` from `apps/cms/src/services/semantic-drift.ts`, the mapping the drift scan uses. A failed call counts as `unevaluated`, never as clean. The report (`report.drift.json`) gives, per locale: outcome counts, coverage, drift precision and recall (unevaluated counts as not detected), the false-positive-trap rate and the prompt-injection detection rate, plus call failures and latency. There is no tune split and no threshold file: the threshold belongs to the rule. Like the editorial task, a mock run is labelled `mode: "mock"`, and no live drift run has been made yet.

## Mock mode

`--provider mock` answers from the gold labels with seeded noise and injected failures. Its numbers only show that the harness works. Its reports carry `mode: "mock"` and a note saying so, and the harness refuses to merge reports of different modes, so mock results cannot end up in a live comparison.

## Live smoke test

`apps/cms/src/services/__tests__/decision-live.smoke.test.ts` sends one synthetic request (noul, choice and score) to each Jev endpoint. It is skipped unless `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is set, so ordinary CI never calls a provider. It checks the answer contract only, not quality.

```bash
TYPESAFE_API_KEY=... OPENROUTER_API_KEY=... pnpm -F @lumibase/cms exec vitest --run src/services/__tests__/decision-live.smoke.test.ts
```

## Limitations

- No live results yet, so no target, measured held-out numbers or go/no-go for automation. Automation stays off until those exist.
- The samples are synthetic and short. They are not a sample of any real site's content, and results may not carry over to long-form or domain-specific content.
- A single annotator labelled `v1`; no inter-annotator agreement was measured. Samples tagged `ambiguous` have more than one defensible label.
- `score` questions are not labelled in `v1`. Only `category` and `needs_review` are measured.
- The benchmark runs the provider directly, without the CMS governance path (quota, audit). It measures answers, not the product's end-to-end latency.
- Latency depends on the network and region of the machine running the benchmark.
