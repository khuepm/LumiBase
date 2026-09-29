# RC.5 candidate acceptance — local build, not a release verdict

Date: 2026-09-29. Performed in a fresh disposable Docker project. This is
implementer evidence, not independent reviewer sign-off or published RC.5 evidence.

## Artifacts

- Public `npm create lumibase@next`: resolved to 1.0.0-rc.4 and generated the
  Next.js starter successfully in an empty directory.
- Candidate CMS/Studio image built from main SHA
  `069add9064fd93f39908fc8dfa56a2cfdf34f5a3`, with release channel `acceptance`.
  Its version remains 1.0.0-rc.4; RC.5 has not been tagged.
- Separate compose project, database and loopback ports: CMS 21989,
  Postgres 25432, Redis 26379, website 23000.

## Observed results

- Bootstrap and seed completed. `cms:verify` passed; the optional second-existing-
  tenant probe was skipped. Draft access, public writes and nonexistent tenant
  access were denied. CMS remained healthy.
- Studio login succeeded under `/admin-a7f3c1`; footer reported the actual backend
  version. Content list showed `Realtime connected`.
- Created `rc5-acceptance-first-post` through Studio with multiline body text.
  Observed transitions: draft → in review → approved → published, using the
  bootstrap administrator for all steps. Separate reviewer authorization was
  not tested in this pass.
- Next.js website rendered the newly published article and the two published
  seed articles, without the seed draft.
- Versions panel loaded its empty state without a tenant error.
- System version endpoint returned the candidate SHA and channel.

## Additional defect fixed

Fresh npm installation of the published starter reported one high and one
moderate vulnerability through Next.js's PostCSS dependency. The starter did
not inherit the monorepo overrides. Added PostCSS overrides for npm and pnpm to
its generated manifest and included Next.js in the existing real-install smoke
suite, including an installed production dependency audit.

Validation: 57 scaffolder tests passed; fresh npm and pnpm installations,
production audits (zero reported vulnerabilities), and typechecks passed.
Next.js production build passed. `pnpm check:all` passed.

## Governed translation preparation (#359)

Ran the existing `scripts/acceptance/content-os-http-proof.mjs` against the same
isolated CMS with Redis/BullMQ and a local deterministic HTTP LLM fixture.
The script still uses RC.2 sample strings; those are fixture text, not the tested
artifact version.

- Intent scan detected missing translation; generation waited for approval.
- Draft worker called the fixture exactly once; the published translation
  remained absent until the separate publish approval.
- HTTP approval published the translation. A subsequent scan resolved the drift,
  marked the goal done, and did not call the provider again.
- Revision endpoint returned `authorType: agent` and
  `createdByRunId: n1eVKHeyRSY17p8ylpsPx`, matching the approved publish run.
  Revision `HZ3udVU82PRmEfvfurfRd` contains the before/after translation.
- `model`, `constitutionHash`, `sources` and `confidence` were null on that
  revision. This proves the run linkage, not complete model provenance.

This is not real-model evidence, an independently reviewed demonstration, or a
public deployment. The test driver simulates both human approval decisions.

## Outstanding release gates

- `pnpm release:check` failed with four missing production secret checks; this
  environment has no Cloudflare API credentials configured for that check.
  No release tag was created. The runbook requires this gate even though the
  prerelease workflow skips Cloudflare production deployment; scope needs resolving.
- Repeat acceptance using published RC.5 packages/image after release.
- Independent verification, two-user review separation, presence with two
  simultaneous editors, and a real-model governed translation demo remain unverified.
