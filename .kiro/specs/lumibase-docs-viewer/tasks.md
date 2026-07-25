# Implementation Plan: LumiBase Docs Viewer

## Overview

Build a standalone documentation viewer app at `apps/docs` using Vite + React + Tailwind CSS. The implementation proceeds in layers: project scaffolding → data layer (Vite plugin + registry) → core UI components (Sidebar, Markdown renderer, ToC) → search → link rewriting → final integration and wiring. Each step builds on the previous, ensuring no orphaned code.

## Tasks

- [x] 1. Scaffold the `apps/docs` project
  - [x] 1.1 Initialize project structure and configuration files
    - Create `apps/docs/` with `package.json` (`@lumibase/docs`), `tsconfig.json`, `vite.config.ts`, `index.html`, `postcss.config.js`, `tailwind.config.ts`
    - Configure Vite with React plugin, dev server on port 5174
    - Set up Tailwind CSS consistent with `apps/studio` configuration
    - Add workspace dependencies: `@lumibase/ui`, `@lumibase/shared`
    - Add runtime dependencies: `react`, `react-dom`, `react-router-dom`, `react-markdown`, `remark-gfm`, `rehype-slug`, `rehype-shiki`, `shiki`, `gray-matter`, `minisearch`, `lucide-react`
    - Add dev dependencies: `@vitejs/plugin-react`, `tailwindcss`, `postcss`, `autoprefixer`, `typescript`, `@types/react`, `@types/react-dom`, `vitest`, `fast-check`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`
    - Create `src/main.tsx` entry point and `src/App.tsx` shell
    - Create `src/index.css` with Tailwind directives
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 1.2 Configure Vitest for unit and property-based testing
    - Add `vitest.config.ts` with jsdom environment
    - Create `src/test/setup.ts` with testing-library matchers
    - Verify `fast-check` is importable and working with a trivial test
    - _Requirements: 1.1_

- [x] 2. Implement the Vite plugin and Doc Registry
  - [x] 2.1 Create `vite-plugin-docs-loader` virtual module plugin
    - Create `src/plugins/vite-plugin-docs-loader.ts`
    - Implement plugin that resolves `virtual:docs-registry` module ID
    - Use `fs` and `glob` to discover all `.md` files under `docs/` at build time
    - Parse each file with `gray-matter` to extract front matter and content
    - Build `DocTree` (sorted: directories first alphabetically, then files alphabetically)
    - Build `docIndex` (Record<slug, DocEntry>) and `docList` (flat array)
    - Derive titles: use front matter `title` if present, otherwise filename → replace hyphens → title case
    - Derive slugs: relative path from `docs/` without `.md` extension
    - Handle parse errors: log warning, exclude file from tree
    - Support HMR: watch `docs/` directory for changes in dev mode
    - Export `docTree`, `docIndex`, `docList` from the virtual module
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 10.1, 10.2, 10.3_

  - [x] 2.2 Add TypeScript type declarations for the virtual module
    - Create `src/types/virtual-docs-registry.d.ts` declaring module `virtual:docs-registry`
    - Define and export `DocEntry`, `DocNode`, `docTree`, `docIndex`, `docList` types
    - _Requirements: 2.1_

  - [x] 2.3 Write property test for Doc Tree structure and sorting (Property 1)
    - **Property 1: Doc Tree structure and sorting invariant**
    - Generate random sets of file paths, build tree, verify: one node per file, correct nesting, directories sorted before files at every level
    - **Validates: Requirements 2.2, 2.5**

  - [x] 2.4 Write property test for title derivation (Property 2)
    - **Property 2: Title derivation correctness**
    - Generate random filenames with/without front matter title fields, verify correct title derivation logic
    - **Validates: Requirements 2.3, 2.4**

- [x] 3. Checkpoint - Verify plugin and registry
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement routing and page layout
  - [x] 4.1 Set up React Router v7 with route configuration
    - Create `src/router.tsx` with `createBrowserRouter`
    - Define routes: `/` → redirect to `/docs/README`, `/docs/:slug*` → DocPage, `*` → NotFoundPage
    - Use HTML5 History API (no hash fragments)
    - Wire router into `App.tsx` with `RouterProvider`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 4.2 Create the app layout shell with responsive structure
    - Create `src/components/Layout.tsx` with three-column layout: Sidebar (left), Content (center), ToC (right)
    - Implement responsive behavior: sidebar hidden on mobile (<768px) with hamburger toggle
    - ToC panel visible only on screens >1024px
    - _Requirements: 3.6, 6.2_

  - [x] 4.3 Create the NotFoundPage component
    - Create `src/pages/NotFoundPage.tsx`
    - Display "404 — Document Not Found" message with a link back to `/docs/README`
    - _Requirements: 5.4_

- [x] 5. Implement the Sidebar component
  - [x] 5.1 Build the recursive tree Sidebar component
    - Create `src/components/Sidebar.tsx` and `src/components/SidebarNode.tsx`
    - Render `DocTree` as a collapsible tree: directories as collapsible groups, files as clickable links
    - Highlight the active doc based on current route slug
    - Use React Router's `useNavigate` for client-side navigation (no full page reload)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 5.2 Add localStorage persistence for sidebar state
    - Persist expanded/collapsed state per directory in `localStorage` under key `lumibase-docs:sidebar-state`
    - Restore state on page load; default to all expanded if localStorage unavailable
    - Gracefully handle private browsing / storage errors
    - _Requirements: 3.5_

  - [x] 5.3 Implement mobile responsive sidebar toggle
    - Add hamburger menu button visible on screens <768px
    - Toggle sidebar visibility with overlay on mobile
    - _Requirements: 3.6_

- [x] 6. Implement the Markdown Renderer
  - [x] 6.1 Create the MarkdownRenderer component with plugin pipeline
    - Create `src/components/MarkdownRenderer.tsx`
    - Configure `react-markdown` with plugins: `remark-gfm`, `rehype-slug`, `rehype-shiki`
    - Configure Shiki with languages: `typescript`, `javascript`, `json`, `yaml`, `sql`, `bash`, `markdown`
    - Render all standard Markdown elements: headings, paragraphs, bold, italic, blockquotes, lists, inline code, fenced code blocks, tables, horizontal rules
    - Style tables with visible borders and alternating row colors via Tailwind
    - Code blocks without language → plain monospace, no highlighting
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 6.2 Implement the Link Rewriter component
    - Create custom `<a>` component override for `react-markdown`
    - Relative `.md` links → rewrite href to `/docs/{slug}`, use React Router navigate (no page reload)
    - Absolute URLs (`http://`, `https://`) → `target="_blank"` + `rel="noopener noreferrer"`
    - Relative links to unknown slugs → render as strikethrough broken link, prevent navigation on click
    - Accept `currentSlug` and `knownSlugs` props for resolution
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 6.3 Write property test for front matter stripping (Property 3)
    - **Property 3: Front matter stripping**
    - Generate random YAML front matter content, verify rendered output contains no front matter delimiters or raw YAML
    - **Validates: Requirements 4.7**

  - [x] 6.4 Write property test for link classification and rewriting (Property 6)
    - **Property 6: Link classification and rewriting**
    - Generate random links (relative .md to known slugs, absolute URLs, relative to unknown slugs), verify correct href rewriting and attributes
    - **Validates: Requirements 8.1, 8.3, 8.4**

- [x] 7. Implement the DocPage and metadata display
  - [x] 7.1 Create the DocPage component
    - Create `src/pages/DocPage.tsx`
    - Load doc content from `docIndex` based on route slug parameter
    - Pass content to `MarkdownRenderer`
    - Display document title as H1 at top of content area
    - Display last-modified date below title in `DD/MM/YYYY` format (if available)
    - Set browser `<title>` to `{document title} — LumiBase Docs`
    - If slug not found in `docIndex`, redirect to NotFoundPage
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 5.2_

  - [x] 7.2 Write property test for browser title formatting (Property 7)
    - **Property 7: Browser title formatting**
    - Generate random title strings, verify browser title is `{title} — LumiBase Docs`
    - **Validates: Requirements 9.4**

  - [x] 7.3 Write property test for date formatting (Property 8)
    - **Property 8: Date formatting**
    - Generate random valid ISO date strings, verify displayed format is `DD/MM/YYYY`
    - **Validates: Requirements 9.5**

- [x] 8. Implement the Table of Contents
  - [x] 8.1 Create the ToC Generator component
    - Create `src/components/TableOfContents.tsx`
    - Extract H2 and H3 headings from rendered content using heading IDs (from `rehype-slug`)
    - Render as sticky panel on right side (screens >1024px)
    - Implement smooth scroll on ToC entry click
    - Use Intersection Observer to highlight the active heading as user scrolls
    - Hide ToC when fewer than 2 H2/H3 headings exist
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 8.2 Write property test for ToC heading extraction (Property 4)
    - **Property 4: ToC heading extraction**
    - Generate random markdown with various heading levels, verify ToC contains exactly H2 and H3 headings in order, and is not rendered when fewer than 2 exist
    - **Validates: Requirements 6.1, 6.5**

- [x] 9. Checkpoint - Verify core rendering pipeline
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement the Search Engine
  - [x] 10.1 Create the search indexing and query service
    - Create `src/lib/search.ts`
    - Initialize MiniSearch with fields: `title` (boost: 2), `content` (boost: 1); stored fields: `title`, `slug`
    - Enable prefix search and fuzzy matching (distance 1)
    - Index all documents from `docList` on app startup
    - Implement `search(query)` function returning `SearchResult[]` with slug, title, snippet, score
    - Highlight matched terms in snippets
    - Return results within 300ms for queries of at least 2 characters
    - _Requirements: 7.1, 7.2, 7.3, 7.5_

  - [x] 10.2 Create the SearchDialog component
    - Create `src/components/SearchDialog.tsx`
    - Render search input with keyboard shortcut (Cmd/Ctrl+K) to open
    - Display results as a list with title and highlighted snippet
    - Navigate to selected result's Doc Page on click/Enter (client-side navigation)
    - Hide results panel when input is cleared, return focus to input
    - _Requirements: 7.2, 7.3, 7.4, 7.6_

  - [x] 10.3 Write property test for search relevance and highlighting (Property 5)
    - **Property 5: Search returns relevant results with highlighted terms**
    - Generate random document sets and queries (≥2 chars), verify matching documents are returned and snippets contain matched terms
    - **Validates: Requirements 7.2, 7.3**

- [x] 11. Integration and final wiring
  - [x] 11.1 Wire all components together in the app shell
    - Connect Sidebar, DocPage, ToC, and SearchDialog in the Layout component
    - Ensure navigation from Sidebar, Search, and internal links all use React Router (no full page reload)
    - Verify `/` redirects to `/docs/README`
    - Verify unknown routes show 404 page
    - Register the `vite-plugin-docs-loader` in `vite.config.ts`
    - _Requirements: 1.1, 3.2, 5.1, 5.3, 5.4, 7.4, 8.2_

  - [x] 11.2 Write integration tests for end-to-end flows
    - Test full app render with test markdown files
    - Test sidebar navigation triggers correct page loads
    - Test search indexes documents and returns results
    - Test internal link navigation works without page reload
    - _Requirements: 3.2, 5.2, 7.4, 8.2_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design (Properties 1–8)
- Unit tests validate specific examples and edge cases
- The Vite plugin is the foundation — it must work before any UI components can render real content
- All navigation must use React Router's client-side navigation to avoid full page reloads

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1", "6.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.2", "6.3", "6.4"] },
    { "id": 6, "tasks": ["7.1", "8.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "8.2", "10.1"] },
    { "id": 8, "tasks": ["10.2", "10.3"] },
    { "id": 9, "tasks": ["11.1"] },
    { "id": 10, "tasks": ["11.2"] }
  ]
}
```
