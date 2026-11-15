---
sourceLang: en
version: 1
lastUpdated: 2026-11-14T01:59:40.964Z
contentHash: db84dfc33d0b34e2
codeVerified: 2026-11-14T01:59:40.964Z
codeVerifiedHash: db84dfc33d0b34e2
codeVerifiedClaims: 2
---

# Advisory and CVE Post Template

Maintainers copy these blocks when they write a GitHub Security Advisory (GHSA),
the matching `CHANGELOG.md` line, and the replies to reporters. The procedure
around them is the [advisory runbook](./advisory-runbook.md); the rules they
implement are the [vulnerability disclosure policy](./vulnerability-disclosure.md).

Advisories, CVE descriptions and reporter replies are written in **English**, the
language of the GitHub Advisory Database and of cve.org. Placeholders are in
`<angle brackets>`; delete any section that does not apply rather than leaving
it empty.

## GHSA form fields

| Field | What to enter |
|-------|---------------|
| Title | `<Component>: <weakness> allows <actor> to <impact>` — e.g. "CMS: missing site scope on item export allows an authenticated user to read another site's items". Under 100 characters, no version numbers. |
| CVE identifier | Leave "Request CVE ID later" until triage is done; request it from the draft before publishing (runbook §6). |
| Ecosystem / package | `npm` and the package name for an npm package. For the CMS, its Docker image, Studio or the shell, choose `Other` and the product name `lumibase`. Add one entry per affected package. |
| Affected versions | A range per supported major, e.g. `>= 2.0.0, < 2.0.1` and `>= 1.0.0, < 1.0.2`. |
| Patched versions | The first fixed version for each range, e.g. `2.0.1`, `1.0.2`. |
| Severity | Use the CVSS calculator in the form; the vector is published. Apply the floors in policy §4. |
| Weaknesses (CWE) | The most specific CWE, e.g. `CWE-639` (authorization bypass through user-controlled key) for a tenant-isolation bypass. |
| Credits | The reporter as "Reporter"; anyone who wrote or reviewed the fix as "Remediation developer" or "Remediation reviewer". Skip for anonymous reporters. |

## Advisory description

```markdown
### Summary

<One or two sentences: what is wrong, who can exploit it, what they gain.>

### Affected versions

| Component | Affected | Patched |
|-----------|----------|---------|
| <CMS (Workers and Docker image ghcr.io/khuepm/lumibase-cms)> | <>= 2.0.0, < 2.0.1> | <2.0.1> |
| <CMS 1.0.x line> | <>= 1.0.0, < 1.0.2> | <1.0.2> |

Deployments on <Cloudflare Workers / Docker / both> are affected.
<State any configuration that is required for exposure, or "in the default configuration".>

### Impact

<What an attacker can read, change or execute, and which trust boundary
(tenant, organization, role, approval gate, secret) is crossed. State the
privileges the attacker needs.>

### Patches

Fixed in <2.0.1> and <1.0.2>. Upgrade to the patched release for your major.
Docker: `ghcr.io/khuepm/lumibase-cms:<2.0.1>`. npm: `<package>@<version>`.
<Say whether a migration or any operator action is needed after upgrading.>

### Workarounds

<Mitigations for operators who cannot upgrade at once, e.g. revoke a key type,
disable a route at the proxy, turn off a feature flag. Write "None. Upgrade." if
there is none.>

### Detection

<How an operator can tell whether this was exploited: audit-log action names,
log lines, queries. Omit if there is no reliable signal.>

### References

- <Fix commit or pull request>
- <Release notes for 2.0.1>
- <Relevant LumiBase docs page>

### Credits

Reported by <name or handle>. <Thanks to … for the fix review.>
```

Publish proof-of-concept details with the advisory or up to 14 days later
(policy §7). When added, they go under `### Details` between Impact and Patches.

## CHANGELOG line

Under `### Security` in the fixed release's `CHANGELOG.md` section, and in the
`## Security` section of `.github/RELEASE_TEMPLATE.md` for the GitHub Release
that `.github/workflows/release.yml` publishes:

```markdown
### Security
- <Component>: <one-sentence fix description, in the past tense, without exploit detail>. <Severity> (CVSS <score>). [GHSA-xxxx-xxxx-xxxx](https://github.com/khuepm/lumibase/security/advisories/GHSA-xxxx-xxxx-xxxx), CVE-YYYY-NNNNN. Reported by <name or handle>.
```

## Advisories index row

For the table on the [security advisories](./advisories.md#published-advisories)
page:

```markdown
| [GHSA-xxxx-xxxx-xxxx](https://github.com/khuepm/lumibase/security/advisories/GHSA-xxxx-xxxx-xxxx) — <title> | CVE-YYYY-NNNNN | <High> | <2.0.0; 1.0.0–1.0.1> | <2.0.1; 1.0.2> | <YYYY-MM-DD> |
```

## Reporter replies

### Reply: acknowledgement

```markdown
Thanks for the report. We have received it and will triage it within 7 business
days of a complete report (version, reproduction steps, working PoC). We will
keep you updated in this thread. Please keep the details private while we work
on it; our policy is at https://github.com/khuepm/lumibase/blob/main/docs/en/security/vulnerability-disclosure.md.
```

### Reply: triage result

```markdown
We reproduced this on <version>. We rate it <severity> (CVSS <vector>), affecting
<versions>. Our target for a fixed release is <date>. <We will request a CVE ID.>
Would you like to be credited, and under what name? You are welcome to review
the fix in the temporary private fork; let us know.
```

### Reply: needs a working proof of concept

```markdown
Thanks for the report. We could not reproduce it from the information given.
Our policy requires a working proof of concept against a supported version
(https://github.com/khuepm/lumibase/blob/main/docs/en/security/vulnerability-disclosure.md#8-ai-generated-and-automated-reports):
the exact version or commit, steps from a clean install, and the requests or
script with the output you observed. Please add them here within 14 days;
otherwise we will close this report. It can be reopened when a PoC is available.
```

### Reply: closed — not a vulnerability report

```markdown
We are closing this report without further action. <It cites code that does not
exist in LumiBase: <file/function/route>.> / <It is scanner or AI output without
a demonstrated impact.> / <The impact does not cross a boundary in our scope.>
If you can show a working proof of concept against a supported version, reply
here and we will reopen it.
```

### Reply: published

```markdown
The fix is released in <versions> and the advisory is published:
<GHSA URL> (<CVE ID>). Thank you for reporting it and for keeping it private
until now. You are free to publish your own write-up.
```
