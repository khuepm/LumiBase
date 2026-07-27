# Design Document: LumiBase Docs Viewer

## Overview

LumiBase Docs Viewer is a standalone, statically-built documentation app that lives at `apps/docs` in the monorepo. It reads Markdown files from the `docs/` directory at build time using Vite's `import.meta.glob`, renders them client-side with syntax highlighting, and provides sidebar navigation, a table of contents, and full-text search — all without a backend or database.

The app mirrors the tech stack of `apps/studio` (React 18 + Vite 5 + Tailwind CSS 3) to maintain consistency across the monorepo, and consumes shared packages (`@lumibase/ui`, `@lumibase/shared`) via workspace dependencies.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Routing | React Router v7 (library mode) | Lightweight, well-supported, HTML5 History API. Studio uses TanStack Router but docs app is simpler and doesn't need its type-safe file routing. |
| Markdown rendering | `react-markdown` + remark/rehype plugins | Mature unified ecosystem, renders to React VDOM (no `dangerouslySetInnerHTML`), extensible via plugins. |
| Syntax highlighting | Shiki (via `rehype-shiki`) | VS Code-quality highlighting, supports all required languages, tree-shakeable. |
| Front matter parsing | `gray-matter` | De-facto standard, fast YAML parsing, used at build time in the Vite plugin. |
| Client-side search | MiniSearch | Tiny (~7 KB gzipped), fast in-memory full-text search, no server needed. |
| State management | React Context + `useState` | App state is minimal (sidebar open/collapsed, active doc). No need for Zustand here. |

---

## Architecture

```mermaid
graph TD
    subgraph Build Time
        A[docs/*.md files] -->|import.meta.glob| B[Vite Plugin: docs-loader]
        B -->|parse front matter| C[Doc Registry Module]
        C -->|exports| D[docTree: DocNode[]]
        C -->|exports| E[docIndex: Record<slug, DocEntry>]
    end

    subgraph Runtime - Client
        D --> F[Sidebar Component]
        E --> G[Router - React Router v7]
        G --> H[DocPage Component]
        H --> I[MarkdownRenderer]
        I --> J[react-markdown + rehype-shiki]
        H --> K[ToC Generator]
        E --> L[Search Engine - MiniSearch]
        L --> M[SearchDialog Component]
    end

    F -->|navigate| G
    M -->|navigate| G
    K -->|scroll to| H
```

### Data Flow

1. **Build time**: Vite's `import.meta.glob('../../docs/**/*.md', { query: '?raw', import: 'default' })` collects all Markdown files as raw strings. A virtual module (`virtual:docs-registry`) processes them through `gray-matter` to extract front matter and content, then builds the `DocTree` and search index data.

2. **Runtime**: The app loads the pre-built registry. React Router maps `/docs/:slug*` to the `DocPage` component. The sidebar renders the tree. MiniSearch indexes document titles and content on first load. The Markdown renderer processes content on each page navigation.

---

## Components and Interfaces

### 1. Vite Plugin: `vite-plugin-docs-loader`

A custom Vite plugin that provides a virtual module `virtual:docs-registry`.

```typescript
// Plugin responsibilities:
// - Glob docs/**/*.md at build time
// - Parse front matter with gray-matter
// - Build DocTree structure
// - Export registry as a virtual module
// - Support HMR in dev mode (re-process on file change)

interface VitePluginDocsLoaderOptions {
  docsDir: string; // relative path to docs directory (default: '../../docs')
}
```

### 2. Doc Registry (Virtual Module)

```typescript
// virtual:docs-registry
export interface DocEntry {
  slug: string;           // e.g. "features/collections-builder"
  title: string;          // from front matter or derived from filename
  filePath: string;       // relative path from docs root
  content: string;        // raw markdown content (front matter stripped)
  lastModified?: string;  // ISO date string if available from build
}

export interface DocNode {
  type: 'file' | 'directory';
  name: string;           // display name
  slug?: string;          // only for files
  children?: DocNode[];   // only for directories, sorted: dirs first then files
}

export const docTree: DocNode[];
export const docIndex: Record<string, DocEntry>;
export const docList: DocEntry[]; // flat list for search indexing
```

### 3. Sidebar Component

```typescript
interface SidebarProps {
  tree: DocNode[];
  activeSlug: string;
  onNavigate: (slug: string) => void;
}

// Features:
// - Recursive tree rendering with collapsible directories
// - Active doc highlighting
// - Expanded/collapsed state persisted in localStorage
// - Responsive: hidden on mobile, togglable via hamburger button
```

### 4. MarkdownRenderer Component

```typescript
interface MarkdownRendererProps {
  content: string;        // raw markdown (front matter already stripped)
  currentSlug: string;    // for resolving relative links
  knownSlugs: Set<string>; // for validating internal links
}

// Pipeline:
// react-markdown
//   → remark-gfm (tables, strikethrough, task lists)
//   → remark-frontmatter (strip any remaining front matter)
//   → rehype-slug (add IDs to headings for ToC anchors)
//   → rehype-shiki (syntax highlighting)
//   → custom component overrides (links, tables, code blocks)
```

### 5. ToC Generator Component

```typescript
interface TocEntry {
  id: string;       // heading element ID
  text: string;     // heading text content
  level: 2 | 3;    // H2 or H3
}

interface TocProps {
  entries: TocEntry[];
  activeId: string | null;
}

// Features:
// - Extracts H2/H3 from rendered DOM via rehype-slug IDs
// - Sticky positioning on right side (screens > 1024px)
// - Intersection Observer for active heading tracking
// - Smooth scroll on click
// - Hidden when fewer than 2 headings
```

### 6. Search Engine

```typescript
interface SearchResult {
  slug: string;
  title: string;
  snippet: string;    // text excerpt with matched terms
  score: number;
}

// MiniSearch configuration:
// - Fields: title (boost: 2), content (boost: 1)
// - Stored fields: title, slug
// - Prefix search enabled
// - Fuzzy matching with distance 1
// - Index built on app startup from docList
```

### 7. Router Configuration

```typescript
// React Router v7 routes:
// /              → Redirect to /docs/README
// /docs/:slug*   → DocPage component
// *              → NotFoundPage component

// Uses createBrowserRouter with HTML5 History API
// No hash fragments in URLs
```

### 8. Link Rewriter (custom react-markdown component)

```typescript
// Custom <a> component for react-markdown:
// - Relative .md links → rewrite to /docs/{slug}, use React Router navigate
// - Absolute URLs (http/https) → open in new tab with rel="noopener noreferrer"
// - Relative links to unknown slugs → render as broken link (strikethrough, no-op click)
```

---

## Data Models

### DocEntry

| Field | Type | Description |
|-------|------|-------------|
| `slug` | `string` | URL path segment, derived from file path relative to `docs/` without `.md` extension |
| `title` | `string` | Display title from front matter or filename |
| `filePath` | `string` | Relative path from docs root (e.g., `features/collections-builder.md`) |
| `content` | `string` | Markdown content with front matter stripped |
| `lastModified` | `string \| undefined` | ISO date from build-time file stat |

### DocNode (Tree)

| Field | Type | Description |
|-------|------|-------------|
| `type` | `'file' \| 'directory'` | Node type |
| `name` | `string` | Display name (title-cased for files, raw for directories) |
| `slug` | `string \| undefined` | Only present for file nodes |
| `children` | `DocNode[] \| undefined` | Only present for directory nodes, sorted: directories first (alpha), then files (alpha) |

### Title Derivation Rules

1. If front matter contains `title` field → use that value
2. Otherwise → take filename without extension, replace hyphens with spaces, apply title case
   - Example: `collections-builder.md` → `"Collections Builder"`

### Slug Derivation Rules

- Take file path relative to `docs/` directory
- Remove `.md` extension
- Preserve directory separators as `/`
- Example: `docs/features/collections-builder.md` → `features/collections-builder`
- Special case: `docs/README.md` → `README`

### Search Index Schema (MiniSearch)

| Field | Type | Indexed | Stored | Boost |
|-------|------|---------|--------|-------|
| `id` | `string` (slug) | — | Yes | — |
| `title` | `string` | Yes | Yes | 2 |
| `content` | `string` | Yes | No | 1 |

### LocalStorage Keys

| Key | Value Type | Purpose |
|-----|-----------|---------|
| `lumibase-docs:sidebar-state` | `Record<string, boolean>` | Expanded/collapsed state of sidebar directory groups |

---


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Doc Tree structure and sorting invariant

*For any* set of file paths under `docs/`, the built Doc Tree SHALL contain exactly one node per file, nested according to directory structure, with directories sorted alphabetically before files (also sorted alphabetically) at every level.

**Validates: Requirements 2.2, 2.5**

### Property 2: Title derivation correctness

*For any* Doc File, if it contains a front matter `title` field, the display title SHALL equal that field's value. If it does not contain a front matter `title` field, the display title SHALL equal the filename with hyphens replaced by spaces and title case applied.

**Validates: Requirements 2.3, 2.4**

### Property 3: Front matter stripping

*For any* Markdown content containing a YAML front matter block (delimited by `---`), the rendered HTML output SHALL NOT contain the front matter delimiters or any raw YAML key-value pairs from the front matter block.

**Validates: Requirements 4.7**

### Property 4: ToC heading extraction

*For any* rendered document, the Table of Contents SHALL contain exactly the H2 and H3 headings present in the document (in order), and SHALL NOT be rendered when fewer than 2 such headings exist.

**Validates: Requirements 6.1, 6.5**

### Property 5: Search returns relevant results with highlighted terms

*For any* indexed document set and any query of at least 2 characters that matches at least one document's title or content, the search results SHALL include documents containing the query terms, and the result snippets SHALL contain the matched terms marked for highlighting.

**Validates: Requirements 7.2, 7.3**

### Property 6: Link classification and rewriting

*For any* link encountered in Markdown content:
- If it is a relative link to a `.md` file that resolves to a known slug, the href SHALL be rewritten to `/docs/{slug}` and render as an internal navigation link.
- If it is an absolute URL (starting with `http://` or `https://`), it SHALL render with `target="_blank"` and `rel="noopener noreferrer"`.
- If it is a relative link that does not resolve to any known slug, it SHALL render as a visually distinct broken link that does not navigate on click.

**Validates: Requirements 8.1, 8.3, 8.4**

### Property 7: Browser title formatting

*For any* document with a resolved title, the browser `<title>` tag SHALL be set to `{document title} — LumiBase Docs`.

**Validates: Requirements 9.4**

### Property 8: Date formatting

*For any* valid ISO date string provided as a last-modified timestamp, the displayed date SHALL be formatted as `DD/MM/YYYY`.

**Validates: Requirements 9.5**

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Markdown file fails to parse (malformed front matter) | Log warning to console, exclude file from Doc Tree. App continues to function with remaining files. |
| Navigation to unknown slug (`/docs/nonexistent`) | Display 404 Not Found page with link back to home (`/docs/README`). |
| Relative link points to non-existent doc | Render as broken link (strikethrough style), prevent navigation. No error thrown. |
| `import.meta.glob` returns empty (no docs found) | Render empty sidebar with a message: "No documents found." |
| Search query returns no results | Display "No results found" message in search panel. |
| Code block specifies unsupported language | Fall back to plain monospace rendering without highlighting. No error thrown. |
| localStorage unavailable (private browsing) | Sidebar state defaults to all directories expanded. Gracefully catch and ignore storage errors. |
| Very large document causes slow render | No explicit handling — Shiki lazy-loads language grammars. Future optimization: virtualize long documents. |

---

## Testing Strategy

### Unit Tests (Vitest)

Unit tests cover specific examples, edge cases, and component rendering:

- **Doc Loader**: Test tree building with known file sets, title derivation edge cases (empty filename, multiple hyphens, already title-cased), front matter parsing with various YAML structures.
- **Link Rewriter**: Test specific link types (relative .md, absolute URL, anchor-only, broken link).
- **ToC Generator**: Test heading extraction from known HTML, edge cases (no headings, only H1s, mixed levels).
- **Search Engine**: Test indexing and querying with known document sets, empty queries, special characters.
- **Date Formatter**: Test specific dates, edge cases (invalid dates, undefined input).
- **Sidebar Component**: Render tests with React Testing Library for tree structure, active state, collapse/expand.

### Property-Based Tests (Vitest + fast-check)

Property-based tests verify universal correctness properties across generated inputs:

- **Library**: `fast-check` (mature, well-maintained, excellent TypeScript support)
- **Minimum iterations**: 100 per property
- **Tag format**: `Feature: lumibase-docs-viewer, Property {number}: {property_text}`

Each correctness property (1–8) maps to a single property-based test:

1. Generate random file path sets → verify tree structure and sorting invariants
2. Generate random filenames and front matter → verify title derivation
3. Generate random YAML front matter content → verify stripping from rendered output
4. Generate random markdown with various heading levels → verify ToC extraction rules
5. Generate random document sets and queries → verify search relevance and highlighting
6. Generate random links (relative .md, absolute URLs, unknown paths) → verify classification and rewriting
7. Generate random title strings → verify browser title format
8. Generate random valid dates → verify DD/MM/YYYY formatting

### Integration Tests

- Full app render with test markdown files to verify end-to-end routing
- Sidebar navigation triggers correct page loads
- Search indexes all documents and returns results

### What is NOT tested with PBT

- UI layout and responsive behavior (use visual regression / manual testing)
- Syntax highlighting correctness (Shiki is a well-tested third-party library)
- Vite plugin integration (use integration tests with actual builds)
- localStorage persistence (use example-based tests with mocked storage)
