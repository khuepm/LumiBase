# 🔎 Reviewer — RC.2 clean-install and Content OS acceptance

Date: 2026-09-26. Inspected source: `a1b7cc3fae2ac47481cb9d10c38a4c2e8cc38252` on `main`. Release under test: `1.0.0-rc.2`. Coordination: [#331](https://github.com/khuepm/LumiBase/issues/331); Content OS implementation: [#481](https://github.com/khuepm/LumiBase/pull/481). This is a reviewer-run local acceptance record, not approval of a new implementation PR.

**Verdict: local API and Content OS repair-loop evidence passes; complete Studio acceptance and performance readiness remain unaccepted.** No Cloudflare deployment, paid model call, or public demo was performed. No performance task is marked complete by this report.

## Release recheck

[Release run 35883571701](https://github.com/khuepm/LumiBase/actions/runs/35883571701), attempt 2, succeeded. RC.2 is available on npm `next`; `latest` was intentionally not promoted. Docker image digest: `sha256:c8e591545be3a728a4481b46845ad57949c68fd84a31bd43ea35d1bd834d234e`. Prerelease Workers/Pages jobs were skipped, so release success does not establish Cloudflare deployment parity.

## Step 5 — clean installation and editorial acceptance

Scaffolds came from the published `create-lumibase@1.0.0-rc.2` tarball into `/tmp/lumibase-rc2-acceptance-20260926`, outside this checkout. Node 24.15.0 was used. Docker resources, ports and databases were dedicated to this test; existing shared databases were not reset.

| Check | Reviewer-run result |
| --- | --- |
| Next.js scaffold, npm install, typecheck, production build | Pass |
| Bootstrap setup, seed, public-client verification | Pass |
| Draft hidden from list, direct ID and explicit draft filter | Pass |
| Publishable key cannot write or read a second seeded tenant | Pass: 403 and 401 respectively; no skipped tenant check |
| Explicit RC.2 SDK/client install, generated types, typecheck/build | Pass |
| Fresh `npm ci` from generated lockfile | Pass; npm reported two advisories, not remediated in this acceptance pass |
| Strict pnpm 9.12 RC.2 SDK/client import identity and CLI version | Pass |
| CLI doctor and both generated-type import modes | Exit 0; doctor correctly warns that deployment health is degraded |
| Fresh default starter with pnpm 9.12, generate/migrate, typecheck, HTTP `/` and `/posts` | Pass |
| Cloudflare starter npm install/typecheck and local Wrangler HTTP smoke | Pass for the thin starter only; not a deployed CMS test |
| Studio login, open seeded draft, edit and Save & stay | Pass; edited draft remained hidden from public Next.js page |
| API create → edit → submit-review → approve → publish → frontend read | Pass; same disposable admin approved, separate-reviewer setting off |
| Admin token absent from rendered HTML and `.next/static` bytes | Pass for the exact token and generated build tested |

### Remaining acceptance findings

1. **P1 — the RC.2 Next.js scaffold does not select an RC.2 platform by default.** Its compose file pins `sha256:3f125caabb455bd66cdbece68c7af82a65fea3e7f30db0938ac8219701577ebf` (older edge build), and the `^1.0.0-rc.1` client dependency resolved to RC.1. The shipped scaffold bootstrapped successfully, but that is not RC.2 acceptance. RC.2 checks above used an explicit Docker override and exact RC.2 npm versions. Update the template release inputs and verify the published tarball's resolved versions before claiming one-command RC.2 onboarding.
2. **P1 — Studio loses the configured private admin prefix.** From `/admin-a7f3c1`, content navigation becomes `/content/posts`. Client-side navigation initially works, but reload/direct access returns HTTP 404; `/admin-a7f3c1/content/posts` returns 200. Relevant links: `apps/studio/src/modules/content/items-list.tsx:332`, `item-detail.tsx:222`, `224`, `302`. Verify base-path handling across the router and links rather than fixing one link in isolation.
3. **P2 — the tested Studio path cannot demonstrate the complete editorial journey.** The posts list exposed no Create action; the item editor exposed Save, Share and Delete, but no Review/Approve/Publish/Preview action. The API proof is not a substitute for this UI acceptance criterion. This observation is limited to the tested content list/editor and does not assert that every Studio surface lacks these capabilities.

Health was **degraded**: database, cache and queue worked; storage/search were unconfigured. No full storage/search acceptance, mobile/desktop shell test, yarn/bun matrix, external auth provider or independent reviewer-role test is claimed.

## Step 6 — Content OS evidence

[`content-os-http-proof.mjs`](../../scripts/acceptance/content-os-http-proof.mjs) exercised the published RC.2 Docker CMS through HTTP and its Redis/BullMQ worker. A deterministic local HTTP fixture replaced only the model provider. The test driver submitted approvals through the real HTTP decision endpoint; this was not a person clicking Mission Control.

The final run recorded:

1. A translations intent detected a missing Vietnamese translation and opened a goal.
2. The low-trust translator required draft approval before any model call.
3. The queue worker created the draft; the published item's Vietnamese translation remained absent.
4. Promotion waited for a second approval; the published value remained absent until that decision.
5. Approval published the translation; a verification scan resolved the drift and completed the goal.
6. A repeated scan did not trigger another provider call during the observation window. Total provider calls: one.

The trace includes correlated intent, goal, run, approval and drift IDs. Separately, 54 tests in `g3-repair-loop`, `g3-run-claim` and `g3-dispatch-reliability` passed against a migrated disposable PostgreSQL database in 16.57 seconds. Those tests use their own model/queue doubles and are not real-broker evidence; the HTTP proof supplies that distinct evidence. These successful cases do not establish real-model quality, production failure recovery, cross-runtime parity or long-duration duplicate suppression.

## Step 6 — performance measurements

Artifacts: [RC.2 Docker baseline](../../.kiro/specs/high-load-cache-readiness/baseline/2026-09-26-rc2-docker/). The dataset contains 500,000 domain items across five collections, two sites and 100 pages per site. Docker VM: ARM64, 8 CPUs, approximately 7.82 GiB RAM, shared local host. k6 1.3.0 ran the repository workloads sequentially. This environment differs from earlier baselines; these numbers cannot establish a version regression or Cloudflare capacity.

| Workload / metric | p50 ms | p95 ms | p99 ms | Result |
| --- | ---: | ---: | ---: | --- |
| Smoke HTTP | 33.43 | 206.62 | 385.58 | 100/100 checks, 0% HTTP errors |
| Concurrent item list | 3211.75 | 16036.44 | 20835.69 | Fails p95 <800 ms |
| Concurrent item detail | 4062.09 | 9408.00 | 12131.67 | Fails p95 <800 ms |
| Concurrent item create | 8972.00 | 18895.80 | 20146.88 | Fails p95 <1200 ms |
| WebSocket connect | 7668.40 | 10558.24 | 11579.67 | Fails p95 <500 ms |
| Origin public delivery, mixed workload | 16.61 | 135.49 | 667.08 | Delivery latency threshold passes; mixed workload fails |

Items: 854 requests, 6.61 req/s, 0% HTTP errors. Realtime: 119 sessions and 161 received messages; checks passed but connection latency failed. Origin delivery mix: 12,970 requests, 107.94 req/s. All 11,730 public-delivery requests returned 200. The authenticated list segment had 132 HTTP 429 responses: the default 600 requests/minute/principal API limiter remained active. `LUMIBASE_RATE_LIMIT_DISABLED` does not disable that limiter; its actual switch is `LUMIBASE_API_RATE_LIMIT=0`. Consequently, the mixed 1.018% HTTP error rate is a rate-limited harness result, not an unexplained server failure. The raw constrained run is retained rather than relabelled as a pass.

The documented development token also failed RBAC preflight. A short-lived fixture Studio JWT with seeded user/role identity was used for the measured runs. Credentials are not committed. Legacy k6 summary files use `true` in a threshold map to mean a breached threshold; read that together with exit code 99.

### Local proxy offload and cold/warm check

A separate sequential run used the same 20-VU, two-minute delivery workload through nginx 1.28-alpine with the committed `nginx.conf`. The log window contained 19,527 public cache HITs, 100 MISSes and 100 EXPIRED responses: **98.99% public origin offload**, defined as HIT / all public delivery requests. Authenticated item-list requests bypassed cache and are excluded from that denominator. Public delivery p50/p95/p99 was **0.29 / 1.70 / 13.97 ms**. The mixed run still failed its error threshold because 957 authenticated list requests hit the API limiter; it is not an overall pass. Raw counters and k6 summary are committed.

A subsequent, non-concurrent host probe fetched 20 distinct query-keyed pages twice each. Proxy MISS p50/p95/p99 was **68.28 / 283.00 / 1164.98 ms**; immediate proxy HIT was **1.24 / 2.11 / 4.33 ms**. Timing includes connection and body read. These small-sample percentiles are descriptive only. “Cold” means cold proxy key; the CMS cache/database was already warm. This is a local reverse-proxy demonstration, not CDN/Cloudflare edge evidence, cache-invalidation acceptance, or proof that a production offload target is met.

## Reproduction and applicable gates

For the Content OS proof, start a disposable local CMS with Docker queue transport and `LLM_PROVIDER=nvidia`, `NVIDIA_API_KEY=local-fixture`, `NVIDIA_BASE_URL=http://host.docker.internal:23999/v1`, `LLM_MODEL=deterministic-translation-fixture`. Bootstrap a site and keep its admin token in the generated starter's ignored `.env`. Then run:

```sh
PROOF_DISPOSABLE=1 PROOF_OUTPUT=/tmp/content-os-proof.json \
  node --env-file=/absolute/path/to/starter/.env scripts/acceptance/content-os-http-proof.mjs
```

The script enables the reconciler and creates content, intent and approval records. Use only a disposable site. It listens on port 23999 so Docker can reach the fixture and shuts that server down on completion. Reports retain record IDs but no bearer credentials. Reproduce benchmark data with `apps/cms/k6/seed.ts` in a separate database, then run the checked-in k6 workloads against that deployment; supply a valid disposable JWT privately. See `environment.json` for exact recorded conditions and image digest.

No production service, schema, policy or UI implementation changed in this acceptance work. Setup/backfill, new route guards, runtime provider changes and shell changes are n/a. The proof tool is exercised by the recorded end-to-end run; report JSON is checked for validity and secrets before commit. Repository validation passed with Node 24.15.0 and pnpm 9.12.0: `pnpm typecheck` completed 18/18 tasks (17 cached); normal commit hooks ran `pnpm check:all` (including 43 script tests) and `pnpm test` (14/14 tasks, no cache). CMS reported 2,861 tests passed and 181 skipped across 333 passed/31 skipped files; Studio reported 383 passed. `DATABASE_URL` was removed for this full hook run, so skipped DB suites are not integration evidence. The 54 explicitly executed disposable-DB tests above are separate. Locale pairing is n/a for this reviewer record and raw evidence outside `docs/en` and `docs/vi`.

Next acceptance work: correct scaffold release selection; restore private-prefix Studio navigation; expose and test the complete Studio editorial flow; profile item/realtime latency under an isolated controlled environment; repeat rate-limit-free capacity measurements explicitly; obtain a Cloudflare staging target and model/demo scope before claiming public release evidence.
