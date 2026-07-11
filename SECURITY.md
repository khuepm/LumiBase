# Security Policy

LumiBase is a multi-tenant Content Operating System. We take the security of the
project and of the instances people run in production seriously. This document
explains which versions receive security fixes and how to report a vulnerability.

## Supported versions

Security fixes are backported to the **current major** and the **immediately
preceding major** for **6 months** after a new major ships. Within a supported
major, only the **latest minor** receives fixes — upgrade to the latest patch of
the newest minor before requesting a backport.

| Version | Supported |
|---------|-----------|
| Latest `0.x` (pre-1.0) | ✅ Active development — fixes land on `main` and the latest release |
| Older `0.x` | ❌ Best effort only; upgrade to the latest release |

> Until `1.0.0`, the `0.x` line is under active development and only the most
> recent release is supported. Once `1.0.0` ships, this table is replaced by the
> major/minor window described above and by the
> [versioning policy](docs/en/contributing/versioning-policy.md).

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through **GitHub Security Advisories**:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (this opens a private [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
2. Include:
   - Affected version(s) and deployment target (Cloudflare Workers or Docker).
   - A description of the issue and its impact (what a malicious actor could do).
   - Reproduction steps or a proof of concept, if you have one.
   - Any suggested remediation.

If you cannot use GitHub Security Advisories, open a minimal public issue titled
"Security contact request" (no vulnerability details) asking a maintainer to open
a private channel.

## What to expect

- **Acknowledgement:** within **3 business days**.
- **Initial assessment:** within **7 business days** — we confirm whether the
  report is in scope and estimate severity (CVSS-style: low / medium / high /
  critical).
- **Fix & disclosure:** we aim to ship a fix and a coordinated advisory within
  **90 days** of confirmation. We will keep you updated on progress and credit
  you in the advisory unless you prefer to remain anonymous.

## Scope

In scope — anything that lets an actor cross a trust boundary in a default or
documented configuration:

- **Tenant isolation** bypass (reading/writing another site's data via the REST
  or GraphQL API, `X-Lumi-Site` handling, or RLS).
- **Authentication / authorization** flaws: session/token handling, RBAC/policy
  bypass, privilege escalation, the AI approval (HITL) flow.
- **Injection**: SQL, path traversal, SSRF, template/expression injection.
- **Secret exposure**: leakage of `JWT_SECRET`, `ENCRYPTION_KEY`, API keys, or
  connection strings; insecure defaults.
- **AI harness** abuse: prompt-injection paths that reach `schema:write` or
  destructive skills without an `ai_approvals` gate.

Out of scope (report as a normal issue, not a security report):

- Vulnerabilities that require a pre-compromised host or an already-privileged
  admin account acting within their own tenant.
- Findings only reachable with a knowingly insecure configuration you set
  yourself (e.g. `CORS_ALLOWED_ORIGINS=*` in production, a disabled auth
  middleware, a self-signed dev `JWT_SECRET` shipped to prod).
- Denial of service from unrealistic request volumes against a single-node dev
  setup with no rate limiting configured.
- Reports generated solely by an automated scanner with no demonstrated impact.

## Hardening references

Operators deploying LumiBase should also review:

- [`docs/en/DEPLOYMENT-CHECKLIST.md`](docs/en/DEPLOYMENT-CHECKLIST.md) — production
  configuration and required secrets.
- [`docs/en/security/cwe-top-100-audit.md`](docs/en/security/cwe-top-100-audit.md)
  — the living CWE audit and current mitigations.
- [`docs/en/security/user-management.md`](docs/en/security/user-management.md)
  — auth realms and RBAC model (ADR-010).
