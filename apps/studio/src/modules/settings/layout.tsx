import { Link, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface NavItem {
  id: string;
  label: string;
  to: string;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'configuration',
    label: 'Configuration',
    items: [
      { id: 'site', label: 'Site', to: '/settings/site' },
      { id: 'keyboard', label: 'Keyboard shortcuts', to: '/settings/keyboard' },
    ],
  },
  {
    id: 'localization',
    label: 'Localization',
    items: [
      { id: 'translations', label: 'Translations', to: '/settings/translations' },
      { id: 'translation-memory', label: 'Translation memory', to: '/settings/translation-memory' },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [
      { id: 'webhooks', label: 'Webhooks', to: '/settings/webhooks' },
      { id: 'email', label: 'Email', to: '/settings/email' },
      { id: 'notifications', label: 'Notifications', to: '/settings/notifications' },
      { id: 'extensions', label: 'Extensions', to: '/settings/extensions' },
      { id: 'marketplace', label: 'Marketplace', to: '/settings/marketplace' },
    ],
  },
  {
    id: 'developer',
    label: 'Developer',
    items: [
      { id: 'types', label: 'TypeScript types', to: '/settings/developer/types' },
      { id: 'agent-harness', label: 'Agent harness', to: '/settings/agent-harness' },
      { id: 'materialize', label: 'Materialized views', to: '/settings/materialize' },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'activity', label: 'Activity', to: '/settings/activity' },
      { id: 'encryption', label: 'Encryption', to: '/settings/encryption' },
      { id: 'updates', label: 'Updates', to: '/settings/updates' },
    ],
  },
];

interface SettingsLayoutProps {
  children: ReactNode;
}

export function SettingsLayout({ children }: SettingsLayoutProps) {
  const { location } = useRouterState();

  const isActive = (to: string) => location.pathname === to || location.pathname.startsWith(to + '/');

  return (
    <div className="flex h-full -m-6">
      <aside
        aria-label="Settings navigation"
        className="w-52 shrink-0 border-r bg-muted/20 overflow-y-auto py-6 px-3 space-y-5"
      >
        <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </p>
        {NAV_GROUPS.map((group) => (
          <div key={group.id}>
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              {group.label}
            </p>
            <ul>
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    aria-current={isActive(item.to) ? 'page' : undefined}
                    className={cn(
                      'flex w-full rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive(item.to)
                        ? 'bg-accent font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>

      <div className="flex-1 min-w-0 overflow-auto">
        {children}
      </div>
    </div>
  );
}
