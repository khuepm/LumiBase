# 🔎 Reviewer — coordination protocol

Owner-approved on 2026-09-07. Pilot: [issue #331](https://github.com/khuepm/LumiBase/issues/331).

## Identity and language

- The pilot uses one independent reviewer and two implementers. All participants share the GitHub account `khuepm`; the account name does not identify the role.
- Every reviewer-authored GitHub comment, PR review, inline review comment, issue/project update and review document starts with `🔎 Reviewer` (Markdown heading syntax may precede the prefix).
- Reviewer feedback and coordination records are written in English.
- Implementers write their responses, PR titles/descriptions, PR comments, issue comments and project updates in Vietnamese. Code identifiers, commands, logs and quoted evidence retain their original language.
- Do not infer authorship of old comments from `khuepm`. Only relabel historical feedback whose authorship is established from this review session.

## Review records

- Store review Markdown in `/Users/khuepm/workplace/Lumibase/docs/review-agent`.
- Use `YYYY-MM-DD-pr-NNN-HEAD.md` for commit-specific reviews. Preserve earlier records and explicitly supersede findings when new evidence changes the verdict.
- Each review names the canonical issue, PR URL, full inspected head SHA, verdict, evidence, applicable DoD gates and remaining work.
- Distinguish reviewer-run checks, CI results, implementer claims and unverified cases. Missing or skipped evidence is not pass.
- Publish the review to its PR and link the outcome from the canonical issue. Issue #331 is the pilot's coordination source; do not create a competing roadmap.

## Responsibilities

- The reviewer assesses scope, correctness, integration interactions and the complete applicable DoD. Implementers fix production code and return updated PR heads with evidence.
- One implementer owns one active work item in an isolated checkout. Respect the file grants and dependencies recorded in the canonical issue.
- New commits invalidate affected earlier review conclusions. Check the actual diff and relevant tests before updating a verdict.
- Owner approval of the plan is distinct from PR acceptance. Merge, release, deployment and issue closure follow their existing authorization and acceptance gates.
- A COMMENT review with a written changes-required verdict is not an approval. The shared author account may prevent GitHub's formal self-review states.

## Current review round

The owner explicitly selected all four PRs on 2026-09-07: #456, #462, #458 and #457. Earlier references to three PRs are superseded.
