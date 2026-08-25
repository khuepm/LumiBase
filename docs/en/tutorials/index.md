---
title: Tutorials
version: 1
lastUpdated: 2026-08-02T19:07:54.568Z
sourceLang: en
contentHash: ec70515719fa4318
---

# Tutorials

Hands-on, end-to-end guides that take you from zero to a working result. Each tutorial
assumes no prior LumiBase knowledge and lists its prerequisites up front.

<table>
<thead>
<tr><th>Tutorial</th><th>What you'll build</th><th>Min. version</th><th>Level</th></tr>
</thead>
<tbody>
<tr>
  <td><a href="./nextjs-quickstart.md">Display LumiBase content in a Next.js app</a></td>
  <td>A Next.js page that fetches a <code>posts</code> collection and renders it</td>
  <td><img alt="0.9.0" src="https://img.shields.io/badge/%E2%89%A5%200.9.0-F5A623"></td>
  <td>Beginner</td>
</tr>
</tbody>
</table>

## How tutorial versions work

> [!NOTE]
> Tutorials are **pinned to a minimum LumiBase version**, not cloned per release.

- The **Min. version** badge is the lowest LumiBase version a tutorial is valid for.
- A tutorial stays valid for every newer release **until** one of the API contracts it
  depends on changes. So a tutorial written for `0.9.0` keeps working on `0.10`, `0.15`, …
  with no edits, as long as those contracts hold.
- Each tutorial ends with a **Compatibility** section listing its version table
  (**newest on top**) and the exact contracts it relies on. Match your LumiBase version to
  the top-most row that applies.
- When a release breaks a contract, we bump that one tutorial's table and re-verify —
  enforced by the [Definition of Done](../../../.kiro/steering/definition-of-done.md) §5
  (Tutorial impact). We **don't** create a fresh copy per version.

> Looking for how to scaffold a brand-new LumiBase project instead? See
> [Getting Started](../getting-started.md). For running the whole monorepo locally, see
> [Local Development](../deployment/local-development.md).
