import { useOrganization } from '@/modules/organization/use-organizations';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { getAdminBase } from '@/lib/admin-base';

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
      { id: 'domains', label: 'Domains', to: '/settings/domains' },
      { id: 'uploads', label: 'Uploads', to: '/settings/uploads' },
      { id: 'ai-decisions', label: 'AI decisions', to: '/settings/ai-decisions' },
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
      { id: 'git', label: 'Git repositories', to: '/settings/integrations/git' },
      { id: 'webhooks', label: 'Webhooks', to: '/settings/webhooks' },
      { id: 'change-feed', label: 'Change Feed', to: '/settings/change-feed' },
      { id: 'deployments', label: 'Deployments', to: '/settings/deployments' },
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
      { id: 'security', label: 'Security', to: '/settings/security' },
      { id: 'social-login', label: 'Social login', to: '/settings/social-login' },
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
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const { organization } = useOrganization();
  const showOrganization = organization?.role === 'owner' || organization?.role === 'admin';

  const adminBase = getAdminBase(location.pathname);
  const pathname = adminBase ? location.pathname.slice(adminBase.length) : location.pathname;
  const isActive = (to: string) => pathname === to || pathname.startsWith(to + '/');

  return (
    <div className="-m-4 flex h-full flex-col sm:-m-6 sm:flex-row">
      <aside
        aria-label="Settings navigation"
        className="max-h-64 w-full shrink-0 overflow-y-auto border-b bg-muted/20 px-3 py-3 sm:max-h-none sm:w-52 sm:border-b-0 sm:border-r sm:py-6"
      >
        <button type="button" className="flex w-full items-center justify-between px-2 text-sm font-medium sm:hidden"
          aria-expanded={mobileNavigationOpen} aria-controls="settings-navigation-links"
          onClick={() => setMobileNavigationOpen((open) => !open)}>
          Settings navigation <span>{mobileNavigationOpen ? 'Hide' : 'Show'}</span>
        </button>
        <div id="settings-navigation-links" className={cn('space-y-5', mobileNavigationOpen ? 'block' : 'hidden sm:block')}>
        <p className="hidden px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:block">
          Settings
        </p>
        {NAV_GROUPS.map((group) => (
          <div key={group.id}>
            <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">
              {group.label}
            </p>
            <ul>
              {(group.id === 'configuration' && showOrganization
                ? [{ id: 'organization', label: 'Organization', to: '/settings/organization' }, ...group.items]
                : group.items).map((item) => (
                <li key={item.id}>
                  <Link
                    to={item.to}
                    onClick={() => setMobileNavigationOpen(false)}
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
        </div>
      </aside>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
