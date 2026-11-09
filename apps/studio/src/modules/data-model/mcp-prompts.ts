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
  },
  {
    id: 'recent-items',
    category: 'explore',
    title: 'Recently updated items',
    access: 'read',
    prompt: 'Show me the 10 most recently updated items in the "posts" collection with their title, status and updated date.',
    tools: ['list_items'],
  },
  {
    id: 'search',
    category: 'explore',
    title: 'Search across content',
    access: 'read',
    prompt: 'Search LumiBase for content mentioning "pricing" and group the results by collection.',
    tools: ['search'],
  },
  {
    id: 'my-permissions',
    category: 'explore',
    title: 'What can this key do?',
    access: 'read',
    prompt: 'What permissions does this LumiBase MCP key have? List what I can and cannot do.',
    tools: ['get_my_permissions'],
  },
  {
    id: 'create-draft',
    category: 'content',
    title: 'Create a draft',
    access: 'write',
    prompt: 'Create a draft item in the LumiBase "posts" collection titled "Hello from my IDE" with a short intro paragraph. Keep it as draft.',
    tools: ['create_item'],
  },
  {
    id: 'stale-drafts',
    category: 'content',
    title: 'Find stale drafts (preview only)',
    access: 'read',
    prompt: 'Find all draft items in "posts" that have not been updated for more than 30 days and list them. Do not change anything yet.',
    tools: ['list_items'],
  },
  {
    id: 'translate',
    category: 'content',
    title: 'Translate with translation memory',
    access: 'write',
    prompt: 'Translate the LumiBase item <id> in "posts" to Vietnamese, reuse the translation memory where it matches, and save the result as a draft.',
    tools: ['get_item', 'lookup_tm', 'translate_text', 'update_item'],
  },
  {
    id: 'new-collection',
    category: 'schema',
    title: 'Propose a new collection',
    access: 'admin',
    prompt: 'Propose an "events" collection in LumiBase with title, slug, start_date, location and a relation to "authors". Show me the schema diff and wait for my confirmation before applying it.',
    tools: ['diff_schema', 'apply_schema'],
  },
  {
    id: 'diff-schema',
    category: 'schema',
    title: 'Compare schemas',
    access: 'read',
    prompt: 'Compare the current LumiBase schema with this JSON and explain the differences, without applying anything:\n<paste schema JSON>',
    tools: ['diff_schema'],
  },
  {
    id: 'health',
    category: 'ops',
    title: 'Health check',
    access: 'read',
    prompt: 'Check LumiBase health and metrics, and tell me if anything looks wrong.',
    tools: ['get_health', 'get_metrics'],
  },
  {
    id: 'intent-drifts',
    category: 'ops',
    title: 'Triage intent drifts',
    access: 'read',
    prompt: 'List open LumiBase intent drifts and explain which ones need my attention first.',
    tools: ['list_intent_drifts'],
  },
  {
    id: 'deployments',
    category: 'ops',
    title: 'Recent deployments',
    access: 'read',
    prompt: 'Show the last 5 LumiBase deployments, and fetch the logs of any that failed.',
    tools: ['list_deployments', 'get_deployment_logs'],
  },
];

export const MCP_PROMPT_ACCESS_LABEL: Record<McpPromptAccess, string> = {
  read: 'Read-only',
  write: 'Writes data',
  admin: 'Admin role',
};
