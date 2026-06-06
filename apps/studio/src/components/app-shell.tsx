import { Link, useRouterState } from '@tanstack/react-router';
import {
  Database,
  FileText,
  Layers,
  Settings,
  ShieldCheck,
  Users,
  Puzzle,
  Workflow,
  GitBranch,
  LogOut,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { NotificationsPanel } from '@/components/notifications-panel';
import { clearActiveToken } from '@/lib/api';
import { studioBuildMetadata } from '@/lib/build-metadata';
import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';

interface ModuleDef {
  id: string;
  label: string;
  icon: typeof FileText;
  to: string;
}

const MODULES: ModuleDef[] = [
  { id: 'content', label: 'Content', icon: FileText, to: '/' },
  { id: 'files', label: 'Files', icon: Layers, to: '/files' },
  { id: 'users', label: 'Users', icon: Users, to: '/users' },
  { id: 'access', label: 'Access', icon: ShieldCheck, to: '/access' },
  { id: 'data-model', label: 'Data model', icon: Database, to: '/data-model' },
  { id: 'automation', label: 'Automation', icon: Workflow, to: '/automation/flows' },
  { id: 'cdc', label: 'CDC', icon: GitBranch, to: '/cdc' },
  { id: 'marketplace', label: 'Marketplace', icon: Puzzle, to: '/settings/marketplace' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/settings/translations' },
];

function getAdminBase(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return '';
  const candidate = `/${first}`;
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : '';
}

interface AppShellProps {
  children: ReactNode;
}

/**
 * Top-level chrome: left module bar + top bar + content slot.
 * Active module is derived from the current router location.
 *
 * A11y improvements (Phase G):
 *  - Skip-to-content link as first focusable element for keyboard users.
 *  - `<nav>` landmark with aria-label for the module sidebar.
 *  - `aria-current="page"` on the active nav link.
 *  - `<main id="main-content">` as skip target.
 *  - `role="banner"` on header is implicit via `<header>` but aria-label added.
 *  - Icon SVGs are aria-hidden (decorative); link text is the accessible label.
 */
export function AppShell({ children }: AppShellProps) {
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const appPath = adminBase && location.pathname.startsWith(adminBase)
    ? location.pathname.slice(adminBase.length) || '/'
    : location.pathname;
  const activeModule = appPath.startsWith('/data-model')
    ? 'data-model'
    : appPath.startsWith('/automation')
      ? 'automation'
      : appPath.startsWith('/cdc')
        ? 'cdc'
        : appPath.startsWith('/settings/marketplace')
          ? 'marketplace'
          : appPath.startsWith('/settings')
            ? 'settings'
            : appPath.startsWith('/access')
              ? 'access'
              : appPath.startsWith('/users')
                ? 'users'
                : appPath.startsWith('/files')
                  ? 'files'
                  : 'content';

  const handleLogout = () => {
    clearActiveToken();
    window.location.assign(adminBase ? `${adminBase}/login` : '/');
  };

  return (
    <div className="flex h-screen w-screen">
      {/* Skip-to-content link — visible on focus, hidden otherwise */}
      <a
        href="#main-content"
        className={cn(
          'absolute left-2 top-2 z-50 rounded bg-primary px-3 py-1.5 text-sm font-medium',
          'text-primary-foreground shadow-md',
          'translate-y-[-200%] transition-transform focus:translate-y-0',
        )}
      >
        Skip to content
      </a>

      {/* Module navigation sidebar */}
      <nav
        aria-label="Module navigation"
        className="flex w-16 flex-col items-center gap-2 border-r bg-muted/30 py-4"
      >
        {MODULES.map(({ id, label, icon: Icon, to }) => {
          const isActive = activeModule === id;
          return (
            <Link
              key={id}
              to={`${adminBase}${to === '/' ? '' : to}` || '/'}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              title={label}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-md transition',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </Link>
          );
        })}
        <div
          className="mt-auto [writing-mode:vertical-rl] rotate-180 px-1 py-2 text-[10px] font-medium text-muted-foreground"
          title={`Git ${studioBuildMetadata.gitSha} • Built ${studioBuildMetadata.buildTime}`}
          aria-label={`LumiBase version ${studioBuildMetadata.version}`}
        >
          v{studioBuildMetadata.version}
        </div>
      </nav>

      <div className="flex flex-1 flex-col">
        <header
          aria-label="LumiBase Studio header"
          className="flex h-14 items-center justify-between border-b px-4"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">LumiBase Studio</span>
            <span
              aria-label="Environment: development"
              className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              dev
            </span>
          </div>
          {/* Right-side topbar actions */}
          <div className="flex items-center gap-2">
            <NotificationsPanel />
            <button
              type="button"
              onClick={handleLogout}
              title="Log out"
              aria-label="Log out"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
