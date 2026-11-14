---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:41.087Z
contentHash: f236f43b948f3ba7
codeVerified: 2026-11-14T01:59:41.087Z
codeVerifiedHash: f236f43b948f3ba7
codeVerifiedClaims: 8
---

# Security Advisory Runbook

The maintainer procedure from a private vulnerability report to a published
GitHub Security Advisory (GHSA) and CVE. It implements the
[vulnerability disclosure policy](./vulnerability-disclosure.md) and uses the
[advisory template](./advisory-template.md). The last section records the dry
run of the first advisory, which walked every step with a fictional advisory.

## 0. Roles and prerequisites

- **Advisory coordinator:** one maintainer per report, with the repository
  **admin** or **security manager** role (needed to edit drafts, request a CVE,
  merge from the temporary private fork and publish). The coordinator owns the
  thread and the dates; others may write the fix.
- **Repository settings** (Settings → Code security), checked once a quarter and
  before relying on this runbook: **Private vulnerability reporting** is enabled,
  **Dependabot alerts** are enabled, and the **Security policy** shows
  `SECURITY.md`.
- The issue chooser (`.github/ISSUE_TEMPLATE/config.yml`) links to the private
  reporting form, so nobody has to file a public issue to find it.
- Never discuss an unpublished vulnerability in a public issue, pull request,
  commit message, branch name, CI log or chat channel. Commit messages for the
  fix describe the change neutrally ("tighten site scope on export"), not the
  exploit.

## 1. Intake and acknowledgement

1. GitHub notifies admins and security managers of a new private report. The
   first maintainer to see it assigns themselves as coordinator in the thread.
2. Within **3 business days**, post the acknowledgement reply from the template.
3. If the report arrived another way (email, a public issue), move it: delete or
   hide public details, open a draft advisory yourself (Security → Advisories →
   **New draft security advisory**), paste the report in, and add the reporter as
   a collaborator.

## 2. Triage

Within **7 business days** of a complete report:

1. **Check completeness** against policy §1 and §8. If the PoC is missing or does
   not reproduce, post the "needs PoC" reply and set a 14-day reminder. If it
   cites code that does not exist, or is a scanner/LLM dump, close it with the
   matching reply (§10).
2. **Reproduce** on the reported version and on the latest release of each
   supported major (policy §2), from a clean install. Timebox about 30 minutes
   before asking the reporter for more.
3. **Decide scope** against policy §3. Out of scope but a real bug: thank the
   reporter, close the draft, and open a normal public issue only if it reveals
   nothing exploitable.
4. **Score severity** with the CVSS calculator in the draft, applying the floors
   in policy §4. Record the vector in the draft.
5. **Find affected versions:** the first release containing the flaw and every
   supported line it reaches. Fill the draft's affected-version ranges.
6. Post the triage reply with severity, affected versions and the target date
   from policy §5.

## 3. Coordination

- Keep all discussion in the draft advisory thread.
- Ask the reporter how they want to be credited, and add them to the draft's
  credits.
- Note the embargo end: the target release date, and at most 90 days after the
  report. If that will slip, ask the reporter for an extension in the thread
  before it passes, with the reason and a new date.

## 4. Fix in the temporary private fork

1. In the draft, choose **Start a temporary private fork**. Work only there (or
   in a local branch that is pushed only there) until publication.
2. Write the fix with a **regression test** that fails before it and passes after.
   Cross-tenant fixes follow [IDOR testing](./idor-testing.md).
3. GitHub Actions does not run in temporary private forks, so run the gates
   locally before review:

   ```bash
   pnpm install --frozen-lockfile
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

4. Review: at least one maintainer other than the author. The reporter may review
   if invited.
5. Do not merge yet. The merge happens at release time (§8).

## 5. Backports

For every other supported major in the affected range (today: `1.0.x` until
2027-05-10), open a second pull request in the private fork that applies the fix
on top of the latest tag of that line, with the same regression test. If the fix
cannot be backported safely, say so in the advisory and offer a workaround.

## 6. CVE request

For Medium severity and above (policy §6), once severity and affected versions
are final: in the draft, **Request CVE**. GitHub reviews the request and assigns
an ID to the draft; it stays private until publication. If GitHub asks for
changes, fix the draft and request again. Do not publish while the request is
pending unless the embargo forces it; a CVE can be added after publication.

## 7. Prepare the advisory text

1. Fill the advisory description from the template: Summary, Affected versions,
   Impact, Patches (with the version numbers you will release), Workarounds,
   Detection, References, Credits. Leave the PoC out (policy §7).
2. Prepare the `CHANGELOG.md` `### Security` line for each release and the
   advisories index row. They go public with the release, so keep them out of
   public branches until then.
3. Ask the reporter to review the text.

## 8. Release and publish

Do these on release day, in this order, without long gaps between them:

1. In the draft, **Merge** the private-fork pull requests. This lands the fix on
   `main` (and the backport on its maintenance line).
2. Cut a patch release for each affected line with the normal release process:
   bump the version, add the `CHANGELOG.md` entry with its `### Security`
   section, and fill the `## Security` section of
   `.github/RELEASE_TEMPLATE.md`. Pushing the `vX.Y.Z` tag runs
   `.github/workflows/release.yml`, which builds, scans, signs and publishes the
   Docker image, the Worker, Pages and the npm packages.
3. Wait for the release workflow to finish and check that the image tag and npm
   versions named in the advisory exist.
4. **Publish** the advisory. If a CVE was assigned, it is published with it.
5. If the release changes which versions are supported (a new major), update the
   supported-versions tables in `SECURITY.md` and policy §2 in the same release.

## 9. After publication

1. Post the "published" reply in the advisory thread.
2. In a public pull request, add the row to the
   [advisories index](./advisories.md#published-advisories) (both locales) and
   link the GHSA from the `CHANGELOG.md` line if it was written before the ID was
   known.
3. Publish proof-of-concept details within 14 days, if the reporter or the team
   wants them public.
4. If the bug was a new class of weakness, add it to the
   [CWE audit](./cwe-top-100-audit.md) or [OWASP API audit](./owasp-api-top-10-audit.md)
   with the control that now prevents it.
5. Delete the temporary private fork if GitHub has not done so.

## 10. Closing a report without an advisory

- **Not reproducible, no PoC after 14 days**, **cites non-existent code**,
  **scanner or LLM dump**, or **out of scope:** post the matching template reply,
  then **Close** the draft advisory. Nothing is published.
- **Duplicate:** close it with a pointer to the earlier report's status, and
  credit both reporters if both are valid.
- A closed draft can be reopened when a working PoC arrives.

## Dry run of the first advisory

> **DRY RUN — FICTIONAL.** Everything in this section is an exercise. The
> advisory `GHSA-TEST-DRY0-RUN0`, the reporter "Test Reporter", the versions
> `2.0.1-dryrun` and `1.0.2-dryrun` and the vulnerability itself do not exist.
> Nothing was created on GitHub: no draft advisory, private fork, CVE request,
> release or tag. The point was to walk every step on paper against the real
> repository and find what was missing before a real report arrives.

**Date:** 2026-11-14. **Scenario:** a fictional report that an authenticated
editor on one site can read items of another site through an export path, on
`v2.0.0`.

| Step | What the dry run did | Result |
|------|----------------------|--------|
| 0. Prerequisites | Checked that the repository has a security policy, a private reporting entry point and Dependabot. | `SECURITY.md` existed but its supported-versions table still described `0.x` while `2.0.0` was current: **fixed** in this change. The issue chooser had no security link: **added** to `.github/ISSUE_TEMPLATE/config.yml`. Whether **private vulnerability reporting** is switched on is a repository setting that cannot be read from the code: **owner to confirm** in Settings → Code security. Dependabot is configured in `.github/dependabot.yml`. |
| 1. Intake | Wrote the acknowledgement reply from the template for the fictional report. | Template sufficient. |
| 2. Triage | Scored the fictional bug: network, low complexity, low privileges (editor), no interaction, high confidentiality impact. Applied the tenant-isolation floor. | **High.** Affected `>= 2.0.0, < 2.0.1-dryrun` and the `1.0.x` line. The CVSS floors in policy §4 decided the case without debate. |
| 3. Coordination | Planned the embargo: target release 30 days after triage (High), well inside 90 days. | No gap. |
| 4. Private fork | Walked the fork workflow on paper. | Actions does not run in temporary private forks, so the runbook now lists the local gate commands (§4). |
| 5. Backport | Checked that `1.0.x` is still supported. | Yes, until 2027-05-10. There is no long-lived `1.0.x` branch: the backport starts from the latest `v1.0.*` tag (§5). |
| 6. CVE | Walked the request on paper; no request was sent. | Medium-and-above rule applied; High gets a CVE. |
| 7. Advisory text | Filled the template for `GHSA-TEST-DRY0-RUN0` (not stored anywhere). | The CMS is not an npm package, so the ecosystem is `Other` and it gets no Dependabot alert; noted in the template and on the advisories page. |
| 8. Release | Walked the release order against `.github/workflows/release.yml` (tag → verify → image gate → publish). | The release notes template had no place for security fixes: **added** a `## Security` section to `.github/RELEASE_TEMPLATE.md` and a `security` label category to `.github/release.yml`. |
| 9. After publication | Drafted (not committed) the index row and the "published" reply. | The advisories page now has an index table to receive the row. |
| 10. Close-out | Rehearsed the "cites non-existent code" close for a second fictional report naming a file that does not exist. | Policy §8 and the template reply covered it. |

**Open items for the owner** after the dry run: confirm private vulnerability
reporting is enabled in the repository settings; decide who acts as advisory
coordinator by default.

The next real report follows §1–§10; replace this section with a link to the
first published advisory once there is one.
