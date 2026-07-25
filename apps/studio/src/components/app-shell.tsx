import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
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
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { NotificationsPanel } from '@/components/notifications-panel';
import { ReleaseUpdateNotice } from '@/components/release-update-notice';
import { ConnectionStatusDot } from '@/components/connection-status-dot';
import { CommandPalette } from '@/components/command-palette';
import { SearchPalette } from '@/components/search-palette';
import { clearActiveToken, getApiClient, hasActiveToken, logout } from '@/lib/api';
import { VersionInfoFooter } from '@/components/version-info-footer';
import { getAdminBase } from '@/lib/admin-base';
import { useInboxData } from '@/modules/mission-control/use-inbox';
import { useGlobalShortcuts } from '@/lib/keybindings/use-keybindings';
import { useKeybindingsStore } from '@/lib/keybindings/store';
import { withAdminBase } from '@/lib/keybindings/commands';

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
 * The modules surfaced directly in the mobile Bottom Nav (app-shell spec
 * §1.2). Everything else lives behind the "More" sheet.
 */
const MOBILE_PRIMARY_IDS = ['content', 'files', 'automation', 'settings'] as const;

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
  const { t } = useTranslation('ui');
  const { location } = useRouterState();
  const navigate = useNavigate();
  const adminBase = getAdminBase(location.pathname);

  // Content search palette (distinct from the nav command palette on ⌘K):
  // opened from the TopBar button or ⌘P / Ctrl+P.
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const resolvedKeymap = useKeybindingsStore((s) => s.resolvedKeymap);
  const runSave = useKeybindingsStore((s) => s.runSave);
  const setOverrides = useKeybindingsStore((s) => s.setOverrides);
  const setLoaded = useKeybindingsStore((s) => s.setLoaded);

  // Load the user's stored keybindings once, then merge over defaults. The
  // dispatcher reads `resolvedKeymap` from the store, so it picks these up.
  const prefsQuery = useQuery({
    queryKey: ['me', 'preferences'],
    queryFn: () => getApiClient().me.getPreferences(),
    enabled: hasActiveToken(),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    if (!prefsQuery.data) return;
    const keybindings = (prefsQuery.data.data?.keybindings ?? {}) as Record<string, string>;
    setOverrides(keybindings);
    setLoaded(true);
  }, [prefsQuery.data, setOverrides, setLoaded]);

  const onAction = useCallback(
    (actionId: string) => {
      switch (actionId) {
        case 'editor.save':
          runSave();
          break;
        case 'palette.open':
        case 'palette.openAlt':
          setPaletteOpen((o) => !o);
          break;
        case 'nav.settings':
          navigate({ to: withAdminBase(adminBase, '/settings') as never });
          break;
        case 'help.shortcuts':
          navigate({ to: withAdminBase(adminBase, '/settings/keyboard') as never });
          break;
      }
    },
    [navigate, adminBase, runSave],
  );

  useGlobalShortcuts(resolvedKeymap, onAction);
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

      {/* Module navigation sidebar (desktop; hidden on mobile in favor of the
          Bottom Nav — app-shell spec §1.2) */}
      <nav
        aria-label="Module navigation"
        className="hidden w-16 flex-col items-center gap-2 border-r bg-muted/30 py-4 md:flex"
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
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t('search_open', 'Search content')}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('search_placeholder', 'Search content…')}</span>
              <kbd className="hidden rounded border border-border bg-muted px-1 text-[10px] font-medium sm:inline">
                ⌘P
              </kbd>
            </button>
            <ConnectionStatusDot />
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

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 overflow-auto p-4 pb-24 sm:p-6 md:pb-6"
        >
          {children}
        </main>
        <VersionInfoFooter />
      </div>

      {/* Mobile Bottom Nav — replaces the sidebar on small screens */}
      <BottomNav activeModule={activeModule} adminBase={adminBase} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        adminBase={adminBase}
      />

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

interface BottomNavProps {
  activeModule: string;
  adminBase: string;
}

/**
 * Fixed bottom navigation for phone-sized viewports (app-shell spec §1.2):
 * the four primary modules plus a "More" sheet holding the rest. Respects the
 * iOS home-indicator safe area so tap targets never sit under the gesture bar.
 */
function BottomNav({ activeModule, adminBase }: BottomNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = MOBILE_PRIMARY_IDS.map((id) => MODULES.find((m) => m.id === id)!).filter(Boolean);
  const overflow = MODULES.filter((m) => !MOBILE_PRIMARY_IDS.includes(m.id as never));
  const moreActive = overflow.some((m) => m.id === activeModule);

  const linkTo = (to: string) => `${adminBase}${to === '/' ? '' : to}` || '/';

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-background/95 backdrop-blur md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {primary.map(({ id, label, icon: Icon, to }) => {
          const isActive = activeModule === id;
          return (
            <Link
              key={id}
              to={linkTo(to)}
              aria-label={label}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              <span>{label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More modules"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          className={cn(
            'relative flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition',
            moreActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Layers className="h-5 w-5" aria-hidden="true" />
          <span>More</span>
          <MissionControlBadge />
        </button>
      </nav>

      {moreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More modules"
          className="fixed inset-0 z-40 flex flex-col justify-end md:hidden"
        >
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-black/40"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="relative max-h-[70vh] overflow-auto rounded-t-2xl border-t bg-background p-4"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted" aria-hidden="true" />
            <div className="grid grid-cols-3 gap-2">
              {overflow.map(({ id, label, icon: Icon, to }) => {
                const isActive = activeModule === id;
                return (
                  <Link
                    key={id}
                    to={linkTo(to)}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      'relative flex flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-xs font-medium transition',
                      isActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                    <span className="text-center leading-tight">{label}</span>
                    {id === 'mission-control' && <MissionControlBadge />}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
