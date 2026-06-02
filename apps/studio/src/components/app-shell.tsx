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
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { NotificationsPanel } from '@/components/notifications-panel';

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
  const activeModule = location.pathname.startsWith('/data-model')
    ? 'data-model'
    : location.pathname.startsWith('/automation')
      ? 'automation'
      : location.pathname.startsWith('/cdc')
        ? 'cdc'
        : location.pathname.startsWith('/settings/marketplace')
          ? 'marketplace'
          : location.pathname.startsWith('/settings')
            ? 'settings'
            : location.pathname.startsWith('/access')
              ? 'access'
              : location.pathname.startsWith('/users')
                ? 'users'
                : location.pathname.startsWith('/files')
                  ? 'files'
                  : 'content';

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
              to={to}
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
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
