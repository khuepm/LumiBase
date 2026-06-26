import { Link, useRouterState } from '@tanstack/react-router';
import {
  Database,
  FileText,
  Layers,
  Settings,
  ShieldCheck,
  Users,
  Workflow,
  GitBranch,
  LogOut,
  Radar,
  BarChart3,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { NotificationsPanel } from '@/components/notifications-panel';
import { ReleaseUpdateNotice } from '@/components/release-update-notice';
import { logout } from '@/lib/api';
import { VersionInfoFooter } from '@/components/version-info-footer';
import { getAdminBase } from '@/lib/admin-base';
import { useInboxData } from '@/modules/mission-control/use-inbox';

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
  { id: 'mission-control', label: 'Mission Control', icon: Radar, to: '/mission-control' },
  { id: 'insights', label: 'Insights', icon: BarChart3, to: '/insights' },
  { id: 'cdc', label: 'CDC', icon: GitBranch, to: '/cdc' },
  { id: 'settings', label: 'Settings', icon: Settings, to: '/settings' },
];

/**
 * Exception count on the Mission Control icon (content-os-ui task 7; Req
 * 6.1-6.4). Editors working in other modules must not miss a ticking veto
 * window. Shares the inbox query cache with Mission Control, hides itself
 * entirely at zero or when the data is unavailable.
 */
function MissionControlBadge() {
  const { counts } = useInboxData();
  if (counts.total === 0) return null;
  return (
    <span
      aria-label={`${counts.total} exceptions awaiting attention`}
      className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
    >
      {counts.total > 9 ? '9+' : counts.total}
    </span>
  );
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
    : appPath.startsWith('/mission-control')
      ? 'mission-control'
    : appPath.startsWith('/automation')
      ? 'automation'
      : appPath.startsWith('/cdc')
        ? 'cdc'
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
    // Revoke server-side (best-effort), clear local tokens, then redirect.
    void logout().finally(() => {
      window.location.assign(adminBase ? `${adminBase}/login` : '/');
    });
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
                'relative flex h-10 w-10 items-center justify-center rounded-md transition',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {id === 'mission-control' && <MissionControlBadge />}
            </Link>
          );
        })}
        <div className="mt-auto" aria-hidden="true" />
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
            <ReleaseUpdateNotice compact />
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
        <VersionInfoFooter />
      </div>
    </div>
  );
}
