# Requirements Document

## Introduction

LumiBase Docs Viewer là một ứng dụng web tích hợp vào monorepo LumiBase, cho phép đọc và điều hướng toàn bộ tài liệu kỹ thuật của dự án (các file `.md` trong thư mục `docs/`) trực tiếp trên trình duyệt. Ứng dụng được xây dựng như một app mới trong monorepo (`apps/docs`), sử dụng React + Vite + Tailwind — nhất quán với `apps/studio` — và phục vụ file Markdown trực tiếp từ filesystem thông qua Vite plugin, không cần database hay backend riêng.

Mục tiêu cốt lõi là tạo nền tảng vững chắc (routing, sidebar điều hướng, render Markdown, code highlighting) để mọi tài liệu tính năng mới viết ra đều hiển thị được ngay mà không cần cấu hình thêm.

## Glossary

- **Docs Viewer**: Ứng dụng web (`apps/docs`) dùng để đọc tài liệu Markdown của LumiBase.
- **Doc File**: Một file `.md` nằm trong thư mục `docs/` của workspace.
- **Doc Tree**: Cây thư mục phản ánh cấu trúc `docs/` — dùng để render sidebar điều hướng.
- **Doc Page**: Một trang hiển thị nội dung đã render của một Doc File.
- **Sidebar**: Panel điều hướng bên trái liệt kê toàn bộ Doc Tree.
- **Slug**: Đường dẫn URL tương ứng với đường dẫn tương đối của Doc File so với thư mục `docs/` (ví dụ: `features/collections-builder`).
- **Front Matter**: Metadata YAML tùy chọn ở đầu file Markdown (title, description, v.v.).
- **Code Block**: Đoạn code trong Markdown được bao bởi triple backtick với ngôn ngữ chỉ định.
- **Active Doc**: Doc File đang được hiển thị trên Doc Page hiện tại.

---

## Requirements

### Requirement 1: Khởi tạo ứng dụng Docs Viewer

**User Story:** As a developer, I want a standalone docs app in the monorepo, so that I can run it independently without affecting other apps.

#### Acceptance Criteria

1. THE Docs_Viewer SHALL be a separate Vite + React application located at `apps/docs` within the monorepo.
2. THE Docs_Viewer SHALL share `packages/ui` và `packages/shared` với các app khác trong monorepo thông qua workspace dependencies.
3. WHEN `pnpm dev --filter @lumibase/docs` is executed, THE Docs_Viewer SHALL start a development server on port `5174`.
4. WHEN `pnpm build --filter @lumibase/docs` is executed, THE Docs_Viewer SHALL produce a static build artifact in `apps/docs/dist`.
5. THE Docs_Viewer SHALL use Tailwind CSS consistent with the configuration in `apps/studio`.

---

### Requirement 2: Nạp và phân giải Doc Tree từ filesystem

**User Story:** As a developer, I want the app to automatically discover all Markdown files in `docs/`, so that I don't have to manually register each document.

#### Acceptance Criteria

1. THE Doc_Loader SHALL use Vite's `import.meta.glob` to discover all `.md` files under `docs/` at build time.
2. THE Doc_Loader SHALL build a Doc Tree reflecting the directory structure of `docs/`, with each node containing the Slug, display title, and file path.
3. WHEN a Doc File contains a Front Matter `title` field, THE Doc_Loader SHALL use that value as the display title for the node.
4. WHEN a Doc File does not contain a Front Matter `title` field, THE Doc_Loader SHALL derive the display title from the filename by replacing hyphens with spaces and applying title case.
5. THE Doc_Loader SHALL sort nodes within each directory: directories first (alphabetically), then files (alphabetically).
6. IF a `.md` file cannot be parsed, THEN THE Doc_Loader SHALL log a warning to the browser console and exclude that file from the Doc Tree.

---

### Requirement 3: Sidebar điều hướng

**User Story:** As a developer, I want a sidebar listing all documents grouped by directory, so that I can quickly navigate to any doc.

#### Acceptance Criteria

1. THE Sidebar SHALL render the full Doc Tree as a collapsible tree, with each directory as a collapsible group and each Doc File as a clickable link.
2. WHEN a user clicks a Doc File link in the Sidebar, THE Sidebar SHALL navigate to the corresponding Doc Page without a full page reload.
3. WHEN a Doc Page is active, THE Sidebar SHALL highlight the corresponding Doc File link as the Active Doc.
4. WHEN a directory group is clicked, THE Sidebar SHALL toggle its expanded/collapsed state.
5. THE Sidebar SHALL persist the expanded/collapsed state of each directory group in `localStorage` so that the state is restored on page reload.
6. THE Sidebar SHALL be responsive: on screens narrower than `768px`, THE Sidebar SHALL be hidden by default and togglable via a menu button.

---

### Requirement 4: Render nội dung Markdown

**User Story:** As a developer, I want Markdown content to be rendered as formatted HTML, so that I can read documents with proper headings, lists, tables, and code blocks.

#### Acceptance Criteria

1. WHEN a Doc Page is loaded, THE Markdown_Renderer SHALL render the Markdown content of the corresponding Doc File into formatted HTML.
2. THE Markdown_Renderer SHALL support the following Markdown elements: headings (H1–H6), paragraphs, bold, italic, blockquotes, ordered lists, unordered lists, inline code, fenced code blocks, tables, and horizontal rules.
3. THE Markdown_Renderer SHALL render fenced code blocks with syntax highlighting for at minimum the following languages: `typescript`, `javascript`, `json`, `yaml`, `sql`, `bash`, `markdown`.
4. WHEN a fenced code block specifies a language, THE Markdown_Renderer SHALL apply syntax highlighting for that language.
5. WHEN a fenced code block does not specify a language, THE Markdown_Renderer SHALL render it as plain monospace text without highlighting.
6. THE Markdown_Renderer SHALL render Markdown tables as styled HTML `<table>` elements with visible borders and alternating row colors.
7. WHEN a Doc File contains Front Matter, THE Markdown_Renderer SHALL strip the Front Matter block before rendering and SHALL NOT display raw YAML to the user.

---

### Requirement 5: Routing theo Slug

**User Story:** As a developer, I want each document to have a stable URL, so that I can share links to specific docs.

#### Acceptance Criteria

1. THE Router SHALL map each Doc File to a URL path of the form `/docs/{slug}`, where `{slug}` is the relative path of the file under `docs/` without the `.md` extension.
2. WHEN a user navigates directly to `/docs/{slug}` in the browser, THE Router SHALL load and display the corresponding Doc Page.
3. WHEN a user navigates to `/`, THE Router SHALL redirect to `/docs/README`.
4. WHEN a user navigates to a URL that does not match any Doc File, THE Router SHALL display a 404 Not Found page with a link back to the home page.
5. THE Router SHALL use the HTML5 History API (pushState) so that URLs do not contain hash fragments.

---

### Requirement 6: Hiển thị Table of Contents (ToC) nội tuyến

**User Story:** As a developer, I want a table of contents generated from headings in the document, so that I can jump to specific sections in long documents.

#### Acceptance Criteria

1. THE ToC_Generator SHALL extract all H2 and H3 headings from the rendered Doc Page and generate a Table of Contents.
2. THE ToC_Generator SHALL render the Table of Contents as a sticky panel on the right side of the Doc Page on screens wider than `1024px`.
3. WHEN a user clicks a ToC entry, THE ToC_Generator SHALL scroll the page to the corresponding heading smoothly.
4. WHEN the user scrolls the Doc Page, THE ToC_Generator SHALL highlight the ToC entry corresponding to the heading currently in the viewport.
5. WHEN a Doc Page contains fewer than 2 H2 or H3 headings, THE ToC_Generator SHALL not render the ToC panel.

---

### Requirement 7: Tìm kiếm tài liệu

**User Story:** As a developer, I want to search across all documents by keyword, so that I can find relevant content without manually browsing the tree.

#### Acceptance Criteria

1. THE Search_Engine SHALL index the title and full text content of all Doc Files at application startup.
2. WHEN a user types a query of at least 2 characters into the search input, THE Search_Engine SHALL return matching Doc Files ranked by relevance within 300ms.
3. THE Search_Engine SHALL highlight the matched terms in the search result snippets.
4. WHEN a user selects a search result, THE Search_Engine SHALL navigate to the corresponding Doc Page.
5. THE Search_Engine SHALL perform all indexing and searching client-side, without any server-side API calls.
6. WHEN the search input is cleared, THE Search_Engine SHALL hide the results panel and return focus to the search input.

---

### Requirement 8: Liên kết nội bộ giữa các tài liệu

**User Story:** As a developer, I want relative Markdown links between documents to work correctly, so that I can navigate the doc graph without leaving the app.

#### Acceptance Criteria

1. WHEN the Markdown_Renderer encounters a relative link pointing to another `.md` file, THE Markdown_Renderer SHALL rewrite the `href` to the corresponding `/docs/{slug}` URL.
2. WHEN a user clicks a rewritten internal link, THE Router SHALL navigate to the target Doc Page without a full page reload.
3. WHEN the Markdown_Renderer encounters an absolute URL (starting with `http://` or `https://`), THE Markdown_Renderer SHALL render it as an external link that opens in a new tab with `rel="noopener noreferrer"`.
4. WHEN the Markdown_Renderer encounters a relative link that does not resolve to any known Doc File, THE Markdown_Renderer SHALL render it as a visually distinct broken link (e.g., strikethrough style) and SHALL NOT navigate on click.

---

### Requirement 9: Hiển thị metadata trang

**User Story:** As a developer, I want each doc page to show its title and last-modified date, so that I can quickly assess the document's relevance and freshness.

#### Acceptance Criteria

1. THE Doc_Page SHALL display the document title at the top of the content area as an H1 element.
2. WHEN a Doc File contains a Front Matter `title` field, THE Doc_Page SHALL use that value as the page title.
3. WHEN a Doc File does not contain a Front Matter `title` field, THE Doc_Page SHALL derive the title from the filename (same rule as Doc_Loader in Requirement 2).
4. THE Doc_Page SHALL set the browser `<title>` tag to `{document title} — LumiBase Docs`.
5. WHERE the build tooling provides file modification timestamps, THE Doc_Page SHALL display the last-modified date below the document title in the format `DD/MM/YYYY`.

---

### Requirement 10: Khả năng mở rộng cho tài liệu mới

**User Story:** As a developer, I want new Markdown files added to `docs/` to appear automatically in the Docs Viewer, so that I don't need to update any configuration when writing new docs.

#### Acceptance Criteria

1. WHEN a new `.md` file is added to any subdirectory of `docs/`, THE Doc_Loader SHALL include it in the Doc Tree on the next build or hot-reload without any manual configuration change.
2. WHEN a new subdirectory is created under `docs/`, THE Sidebar SHALL render it as a new collapsible group automatically.
3. THE Doc_Loader SHALL NOT require a static manifest file or hardcoded list of documents.
