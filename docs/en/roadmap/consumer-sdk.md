---
version: 1
lastUpdated: 2026-06-23T12:59:56.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: b248c46ccbdab911
mtEngine: claude
syncStatus: machine-translated
---

# Consumer App & SDK Roadmap

> **Scope:** Build a cross-platform SDK and a demo Consumer app to test it, ensuring the public API works smoothly.

## Goals
1. **SDK Composable Architecture**: Inspired by the Directus SDK. The SDK is extensible (`.with(rest())`, `.with(graphql())`) and supports Typegen.

> **GraphQL (v1):** the `.with(graphql())` adapter has been implemented (items: query + mutation). See the [GraphQL API Spec](../api/graphql-api-spec.md) and [ADR-009](../architecture/decisions/adr-009-graphql-yoga.md).
2. **NPM Package**: Build a build system (tsup) to package the library in ESM, CJS, and DTS formats, ready to publish.
3. **Consumer Demo**: A Next.js app as a worked example of using the SDK (fetch data, render).

## Task Breakdown

### 1. Refactor `@lumibase/sdk`
- [x] Convert the architecture to a Composable Client (`createLumiClient().with(...)`).
- [x] Separate the Core Logic from the Rest Implementation (e.g. `src/rest/readItems.ts`).
- [x] Set up the tsup builder, update `package.json` to export the standard endpoints.

### 2. Update Studio CMS
- [x] Migrate all usages of the old `createLumiClient` to the new syntax (in `apps/studio`).

### 3. Bootstrap the Consumer App (`apps/consumer`)
- [x] Create a Next.js App Router boilerplate.
- [x] Integrate `@lumibase/sdk`.
- [x] Demo fetching items from an arbitrary collection through the SDK with SSR/CSR.
