# Security Policy

LumiBase is a multi-tenant Content Operating System. We take the security of the
project and of the instances people run in production seriously. This document
explains which versions receive security fixes, how to report a vulnerability,
what happens after you report, and how we publish advisories.

The full programme — severity rubric, CVE flow, embargo rules and the triage
policy for AI-generated reports — is in the
[vulnerability disclosure policy](docs/en/security/vulnerability-disclosure.md)
([Tiếng Việt](docs/vi/security/vulnerability-disclosure.md)). Published
advisories are listed on the [security advisories](docs/en/security/advisories.md)
page.

## Supported versions

Security fixes follow the support window in the
[versioning policy](docs/en/contributing/versioning-policy.md): the **current
major** and the **immediately preceding major** for **6 months** after a new major
ships. Within a supported major, only the **latest minor** receives fixes —
upgrade to the latest patch of the newest minor before requesting a backport.

| Version | Released | Supported |
|---------|----------|-----------|
| `2.0.x` (current major) | 2026-11-10 | ✅ Yes — fixes ship as `2.0.x` patch releases |
| `1.0.x` (preceding major) | 2026-11-09 | ⚠️ Security fixes only, until **2027-05-10** (6 months after `2.0.0`) |
| `1.0.0-rc.*` pre-releases | 2026-09 | ❌ No — upgrade to `1.0.x` or `2.0.x` |
| `0.x` | before 2026-09 | ❌ No — upgrade to a supported release |

This covers everything released from this repository under that version: the
CMS (Cloudflare Workers and the `ghcr.io/khuepm/lumibase-cms` Docker image),
Studio, the desktop/mobile shell, and the public npm packages (`lumibase`,
`create-lumibase`, `@lumibase/sdk`, `@lumibase/contracts`,
`@lumibase/mcp-server`, `@lumibase/extension-sdk`). Unreleased code on `main` is
in scope too: report it the same way.

## Reporting a vulnerability

**Please do not open a public GitHub issue, discussion or pull request for
security problems.**

Report privately through **GitHub private vulnerability reporting**:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (direct link: <https://github.com/khuepm/lumibase/security/advisories/new>).
   This opens a private draft
   [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
   visible only to you and the maintainers.
2. Include:
   - The **exact affected version** (release tag or commit) and deployment
     target (Cloudflare Workers, Docker, desktop shell, or an npm package).
   - A description of the issue and its **impact** — which trust boundary it
     crosses and what an attacker gains.
   - **Reproduction steps from a clean install** and a **working proof of
     concept** (a request sequence, script or test). Reports without one cannot
     be triaged — see [AI-generated reports](#ai-generated-and-automated-reports).
   - Any suggested remediation, and whether you want to be credited.

If you cannot use GitHub private vulnerability reporting, open a minimal public
issue titled "Security contact request" (no vulnerability details) asking a
maintainer to open a private channel.

## What to expect

| Step | Target |
|------|--------|
| **Acknowledgement** | within **3 business days** of the report |
| **Triage** — in scope or not, CVSS severity, affected versions | within **7 business days** of a complete report |
| **Fix released** — Critical (CVSS 9.0–10.0) | within **14 days** of triage |
| **Fix released** — High (7.0–8.9) | within **30 days** of triage |
| **Fix released** — Medium (4.0–6.9) | within **60 days** of triage |
| **Fix released** — Low (0.1–3.9) | within **90 days**, or the next minor release |
| **Public advisory** | when the fix ships, and no later than **90 days** after the report unless we agree an extension with you |

We keep you updated in the private advisory thread, invite you to collaborate on
the fix in a temporary private fork if you wish, and credit you in the advisory
unless you prefer to remain anonymous. Severity is scored with CVSS; the vector
is published with the advisory. LumiBase does not run a paid bug bounty.

## Advisories and CVEs

Confirmed vulnerabilities are published as **GitHub Security Advisories** at
<https://github.com/khuepm/lumibase/security/advisories>. Maintainers request a
**CVE** ID through GitHub (a CVE Numbering Authority) for every confirmed issue
of Medium severity or higher in a released version. Advisories for the npm
packages also flow into the GitHub Advisory Database, so Dependabot and
`npm audit` alert downstream users. Each fixed release lists the advisory under
`### Security` in [`CHANGELOG.md`](CHANGELOG.md). See
[security advisories](docs/en/security/advisories.md) for the feed and API.

## Embargo and safe harbour

- Please keep details private until the advisory is published, or until 90 days
  after your report, whichever is first. If a fix needs longer we will ask you
  for an extension and explain why. If we see active exploitation we may publish
  earlier, with mitigations.
- We will not pursue legal action against good-faith research that follows this
  policy: test only against instances you run yourself, do not access, modify or
  delete data that is not yours, stop and report as soon as you can show impact,
  and do not degrade service for others. Do not test against `lumibase.dev`,
  `docs.lumibase.dev` or anyone else's deployment.

## AI-generated and automated reports

AI-assisted research is welcome; unverified AI or scanner output is not a
report. Every report — however it was produced — must include a **working proof
of concept against a supported version**, reproduction steps, and a concrete
impact. We close without further action reports that are only scanner or LLM
output, describe code that does not exist in LumiBase, or claim impact they do
not demonstrate. The full rules and the close-out process are in the
[disclosure policy](docs/en/security/vulnerability-disclosure.md#8-ai-generated-and-automated-reports).

## Scope

In scope — anything that lets an actor cross a trust boundary in a default or
documented configuration:

- **Tenant isolation** bypass (reading/writing another site's data via the REST
  or GraphQL API, `X-Lumi-Site` handling, or RLS), and cross-organization access.
- **Authentication / authorization** flaws: session/token handling, RBAC/policy
  bypass, privilege escalation, the AI approval (HITL) flow.
- **Injection**: SQL, path traversal, SSRF, template/expression injection.
- **Secret exposure**: leakage of `JWT_SECRET`, `ENCRYPTION_KEY`, API keys, or
  connection strings; insecure defaults.
- **AI harness** abuse: prompt-injection paths that reach `schema:write` or
  destructive skills without an `ai_approvals` gate.
- **Supply chain** of what we release: the Docker image, release workflow and
  published npm packages.

Out of scope (report as a normal issue, not a security report):

- Vulnerabilities that require a pre-compromised host or an already-privileged
  admin account acting within their own tenant.
- Findings only reachable with a knowingly insecure configuration you set
  yourself (e.g. `CORS_ALLOWED_ORIGINS=*` in production, a disabled auth
  middleware, a self-signed dev `JWT_SECRET` shipped to prod).
- Denial of service from unrealistic request volumes against a single-node dev
  setup with no rate limiting configured.
- A CVE in a dependency with no demonstrated reachable path in LumiBase (send a
  normal issue or let Dependabot raise it).
- Reports generated solely by an automated scanner or AI tool with no
  demonstrated impact.

## Hardening references

Operators deploying LumiBase should also review:

- [`docs/en/DEPLOYMENT-CHECKLIST.md`](docs/en/DEPLOYMENT-CHECKLIST.md) — production
  configuration and required secrets.
- [`docs/en/security/cwe-top-100-audit.md`](docs/en/security/cwe-top-100-audit.md)
  — the living CWE audit and current mitigations.
- [`docs/en/security/user-management.md`](docs/en/security/user-management.md)
  — auth realms and RBAC model (ADR-010).
