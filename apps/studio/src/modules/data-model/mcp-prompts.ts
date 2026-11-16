/**
 * Copy-ready starter prompts shown on the MCP setup page.
 *
 * Every prompt names the `@lumibase/mcp-server` tools it is expected to use;
 * `__tests__/mcp-prompts.test.ts` checks those names against the tools the
 * server actually registers, so a renamed/removed tool fails CI instead of
 * leaving a prompt that silently cannot work.
 */

export type McpPromptCategory = 'explore' | 'content' | 'schema' | 'ops';

/** `read` never mutates; `write` changes data; `admin` needs an admin-capable role. */
export type McpPromptAccess = 'read' | 'write' | 'admin';

export interface McpPrompt {
  id: string;
  category: McpPromptCategory;
  title: string;
  access: McpPromptAccess;
  prompt: string;
  tools: readonly string[];
  /** Vietnamese version. Must keep the same quoted names and `<placeholders>` as `prompt`. */
  vi: { title: string; prompt: string };
}

export type McpPromptLanguage = 'en' | 'vi';

export const MCP_PROMPT_LANGUAGES: ReadonlyArray<{ id: McpPromptLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'vi', label: 'Tiếng Việt' },
];

/** Default prompt language from the Studio UI language (`vi`, `vi-VN` → `vi`). */
export function defaultPromptLanguage(uiLanguage: string | undefined): McpPromptLanguage {
  return uiLanguage?.toLowerCase().startsWith('vi') ? 'vi' : 'en';
}

export function localizePrompt(prompt: McpPrompt, lang: McpPromptLanguage): { title: string; prompt: string } {
  return lang === 'vi' ? prompt.vi : { title: prompt.title, prompt: prompt.prompt };
}

export const MCP_PROMPT_CATEGORIES: ReadonlyArray<{ id: McpPromptCategory; label: string }> = [
  { id: 'explore', label: 'Explore' },
  { id: 'content', label: 'Content' },
  { id: 'schema', label: 'Schema' },
  { id: 'ops', label: 'Operations' },
];

export const MCP_PROMPTS: readonly McpPrompt[] = [
  {
    id: 'list-collections',
    category: 'explore',
    title: 'Map the data model',
    access: 'read',
    prompt: 'List all LumiBase collections on this site and summarize each one\'s fields in a table.',
    tools: ['list_collections', 'list_fields'],
    vi: {
      title: 'Xem tổng quan data model',
      prompt: 'Liệt kê tất cả collection LumiBase của site này và tóm tắt các field của từng collection thành một bảng.',
    },
  },
  {
    id: 'recent-items',
    category: 'explore',
    title: 'Recently updated items',
    access: 'read',
    prompt: 'Show me the 10 most recently updated items in the "posts" collection with their title, status and updated date.',
    tools: ['list_items'],
    vi: {
      title: 'Item cập nhật gần đây',
      prompt: 'Cho tôi xem 10 item được cập nhật gần nhất trong collection "posts", kèm title, status và ngày cập nhật.',
    },
  },
  {
    id: 'search',
    category: 'explore',
    title: 'Search across content',
    access: 'read',
    prompt: 'Search LumiBase for content mentioning "pricing" and group the results by collection.',
    tools: ['search'],
    vi: {
      title: 'Tìm kiếm trong nội dung',
      prompt: 'Tìm nội dung LumiBase có nhắc tới "pricing" và nhóm kết quả theo collection.',
    },
  },
  {
    id: 'my-permissions',
    category: 'explore',
    title: 'What can this key do?',
    access: 'read',
    prompt: 'What permissions does this LumiBase MCP key have? List what I can and cannot do.',
    tools: ['get_my_permissions'],
    vi: {
      title: 'Key này làm được gì?',
      prompt: 'MCP key LumiBase này có những quyền gì? Liệt kê những việc tôi được và không được làm.',
    },
  },
  {
    id: 'create-draft',
    category: 'content',
    title: 'Create a draft',
    access: 'write',
    prompt: 'Create a draft item in the LumiBase "posts" collection titled "Hello from my IDE" with a short intro paragraph. Keep it as draft.',
    tools: ['create_item'],
    vi: {
      title: 'Tạo bản nháp',
      prompt: 'Tạo một item nháp trong collection "posts" của LumiBase với tiêu đề "Hello from my IDE" và một đoạn mở đầu ngắn. Giữ ở trạng thái draft.',
    },
  },
  {
    id: 'stale-drafts',
    category: 'content',
    title: 'Find stale drafts (preview only)',
    access: 'read',
    prompt: 'Find all draft items in "posts" that have not been updated for more than 30 days and list them. Do not change anything yet.',
    tools: ['list_items'],
    vi: {
      title: 'Tìm bản nháp cũ (chỉ xem trước)',
      prompt: 'Tìm tất cả item nháp trong "posts" đã hơn 30 ngày không được cập nhật và liệt kê ra. Chưa thay đổi gì cả.',
    },
  },
  {
    id: 'translate',
    category: 'content',
    title: 'Translate with translation memory',
    access: 'write',
    prompt: 'Translate the LumiBase item <id> in "posts" to Vietnamese, reuse the translation memory where it matches, and save the result as a draft.',
    tools: ['get_item', 'lookup_tm', 'translate_text', 'update_item'],
    vi: {
      title: 'Dịch bằng translation memory',
      prompt: 'Dịch item LumiBase <id> trong "posts" sang tiếng Việt, dùng lại translation memory khi khớp, và lưu kết quả dưới dạng draft.',
    },
  },
  {
    id: 'new-collection',
    category: 'schema',
    title: 'Propose a new collection',
    access: 'admin',
    prompt: 'Propose an "events" collection in LumiBase with title, slug, start_date, location and a relation to "authors". Show me the schema diff and wait for my confirmation before applying it.',
    tools: ['diff_schema', 'apply_schema'],
    vi: {
      title: 'Đề xuất collection mới',
      prompt: 'Đề xuất một collection "events" trong LumiBase gồm title, slug, start_date, location và một relation tới "authors". Cho tôi xem schema diff và chờ tôi xác nhận rồi mới apply.',
    },
  },
  {
    id: 'diff-schema',
    category: 'schema',
    title: 'Compare schemas',
    access: 'read',
    prompt: 'Compare the current LumiBase schema with this JSON and explain the differences, without applying anything:\n<paste schema JSON>',
    tools: ['diff_schema'],
    vi: {
      title: 'So sánh schema',
      prompt: 'So sánh schema LumiBase hiện tại với JSON này và giải thích các khác biệt, không apply gì cả:\n<dán schema JSON>',
    },
  },
  {
    id: 'health',
    category: 'ops',
    title: 'Health check',
    access: 'read',
    prompt: 'Check LumiBase health and metrics, and tell me if anything looks wrong.',
    tools: ['get_health', 'get_metrics'],
    vi: {
      title: 'Kiểm tra sức khoẻ hệ thống',
      prompt: 'Kiểm tra health và metrics của LumiBase, cho tôi biết có gì bất thường không.',
    },
  },
  {
    id: 'intent-drifts',
    category: 'ops',
    title: 'Triage intent drifts',
    access: 'read',
    prompt: 'List open LumiBase intent drifts and explain which ones need my attention first.',
    tools: ['list_intent_drifts'],
    vi: {
      title: 'Phân loại intent drift',
      prompt: 'Liệt kê các intent drift đang mở của LumiBase và giải thích cái nào cần tôi xử lý trước.',
    },
  },
  {
    id: 'deployments',
    category: 'ops',
    title: 'Recent deployments',
    access: 'read',
    prompt: 'Show the last 5 LumiBase deployments, and fetch the logs of any that failed.',
    tools: ['list_deployments', 'get_deployment_logs'],
    vi: {
      title: 'Deployment gần đây',
      prompt: 'Cho tôi xem 5 deployment gần nhất của LumiBase, và lấy log của những cái bị lỗi.',
    },
  },
];

export const MCP_PROMPT_ACCESS_LABEL: Record<McpPromptAccess, string> = {
  read: 'Read-only',
  write: 'Writes data',
  admin: 'Admin role',
};
