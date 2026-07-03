/**
 * Navigation command registry for the command palette (Cmd/Ctrl+K). Static,
 * route-shaped data so the palette stays decoupled from the router internals.
 * Paths are app-relative (no admin-path prefix) — the palette prepends the
 * active `adminBase`, mirroring `AppShell`'s link construction.
 *
 * Keep in rough sync with `MODULES` (app-shell) and `NAV_GROUPS` (settings
 * layout). Adding a destination here makes it reachable from the palette.
 */

export interface NavCommand {
  id: string;
  title: string;
  /** Group heading in the palette. */
  group: string;
  /** App-relative target path (e.g. `/settings/site`). */
  to: string;
  /** Extra search terms beyond the title. */
  keywords?: string[];
}

export const NAV_COMMANDS: readonly NavCommand[] = [
  // Top-level modules
  { id: 'go.content', title: 'Content', group: 'Go to', to: '/', keywords: ['items', 'collections'] },
  { id: 'go.files', title: 'Files', group: 'Go to', to: '/files', keywords: ['media', 'assets', 'uploads'] },
  { id: 'go.users', title: 'Users', group: 'Go to', to: '/users', keywords: ['members', 'people'] },
  { id: 'go.teams', title: 'Teams', group: 'Go to', to: '/users/teams' },
  { id: 'go.access', title: 'Access', group: 'Go to', to: '/access', keywords: ['roles', 'policies', 'permissions'] },
  { id: 'go.roles', title: 'Roles', group: 'Go to', to: '/access/roles' },
  { id: 'go.policies', title: 'Policies', group: 'Go to', to: '/access/policies' },
  { id: 'go.api-keys', title: 'API keys', group: 'Go to', to: '/access/api-keys', keywords: ['tokens'] },
  { id: 'go.data-model', title: 'Data model', group: 'Go to', to: '/data-model', keywords: ['collections', 'schema', 'fields'] },
  { id: 'go.automation', title: 'Automation', group: 'Go to', to: '/automation/flows', keywords: ['flows', 'workflows'] },
  { id: 'go.mission-control', title: 'Mission Control', group: 'Go to', to: '/mission-control', keywords: ['inbox', 'agents', 'intents'] },
  { id: 'go.insights', title: 'Insights', group: 'Go to', to: '/insights', keywords: ['dashboards', 'analytics'] },
  { id: 'go.cdc', title: 'CDC', group: 'Go to', to: '/cdc', keywords: ['change data capture', 'pipelines'] },

  // Settings sub-screens
  { id: 'set.keyboard', title: 'Settings · Keyboard shortcuts', group: 'Settings', to: '/settings/keyboard', keywords: ['keybindings', 'hotkeys'] },
  { id: 'set.site', title: 'Settings · Site', group: 'Settings', to: '/settings/site', keywords: ['branding', 'config'] },
  { id: 'set.translations', title: 'Settings · Translations', group: 'Settings', to: '/settings/translations', keywords: ['i18n', 'localization'] },
  { id: 'set.webhooks', title: 'Settings · Webhooks', group: 'Settings', to: '/settings/webhooks' },
  { id: 'set.email', title: 'Settings · Email', group: 'Settings', to: '/settings/email' },
  { id: 'set.extensions', title: 'Settings · Extensions', group: 'Settings', to: '/settings/extensions' },
  { id: 'set.marketplace', title: 'Settings · Marketplace', group: 'Settings', to: '/settings/marketplace' },
  { id: 'set.activity', title: 'Settings · Activity log', group: 'Settings', to: '/settings/activity' },
  { id: 'set.encryption', title: 'Settings · Encryption', group: 'Settings', to: '/settings/encryption' },
  { id: 'set.updates', title: 'Settings · Updates', group: 'Settings', to: '/settings/updates' },
] as const;

/** Build an absolute path for navigation, honouring the admin-path prefix. */
export function withAdminBase(adminBase: string, to: string): string {
  return `${adminBase}${to === '/' ? '' : to}` || '/';
}
