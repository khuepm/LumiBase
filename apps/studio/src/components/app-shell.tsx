import { OrganizationSwitcher } from '@/modules/organization/switcher';
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
  PanelLeftClose,
  PanelLeftOpen,
  GripVertical,
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { NotificationsPanel } from '@/components/notifications-panel';
import { AIAssistant } from '@/components/ai-assistant';
import { ReleaseUpdateNotice } from '@/components/release-update-notice';
import { ConnectionStatusDot } from '@/components/connection-status-dot';
import { MissionControlBadge, ModuleNavItem, type ModuleDef } from '@/components/module-nav-item';
import { SearchPalette } from '@/components/search-palette';
import { clearActiveToken, getApiClient, hasActiveToken, logout } from '@/lib/api';
import { VersionInfoFooter } from '@/components/version-info-footer';
import { SiteLanguageSync } from '@/components/site-language';
import { UiLanguagePicker } from '@/components/ui-language-picker';
import { getAdminBase } from '@/lib/admin-base';
import { getEnvironmentBadge } from '@/lib/environment-badge';
import { useGlobalShortcuts } from '@/lib/keybindings/use-keybindings';
import { useKeybindingsStore } from '@/lib/keybindings/store';
import { useDisplayTimezoneStore } from '@/lib/display-timezone';
import { withAdminBase } from '@/lib/keybindings/commands';
import { mePreferencesQueryOptions, permissionsQueryOptions } from '@/lib/me-queries';

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

const DEFAULT_MODULE_ORDER = MODULES.map((module) => module.id);

function orderedModules(order: string[]): ModuleDef[] {
  const byId = new Map(MODULES.map((module) => [module.id, module]));
  const seen = new Set<string>();
  const result: ModuleDef[] = [];
  for (const id of order) {
    const module = byId.get(id);
    if (module && !seen.has(id)) {
      result.push(module);
      seen.add(id);
    }
  }
  return [...result, ...MODULES.filter((module) => !seen.has(module.id))];
}

// Heavy, interaction-only chrome is split out of the boot chunk (#757):
// `@dnd-kit/*` loads only while an admin reorders the sidebar, `cmdk` only
// once the command palette is opened. The read-only sidebar renders plain
// links (`ModuleNavItem`), which is also the Suspense fallback while the
// sortable list loads, so the sidebar never blanks.
const SortableModuleNav = lazy(() => import('@/components/sortable-module-nav').then((m) => ({ default: m.SortableModuleNav })));
const CommandPalette = lazy(() => import('@/components/command-palette').then((m) => ({ default: m.CommandPalette })));

/**
 * The modules surfaced directly in the mobile Bottom Nav (app-shell spec
 * §1.2). Everything else lives behind the "More" sheet.
 */
/** Resolved once per bundle: the build mode/channel cannot change at runtime. */
const environmentBadge = getEnvironmentBadge();

const MOBILE_PRIMARY_IDS = ['content', 'files', 'automation', 'settings'] as const;

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
  // Shared keys (lib/me-queries): the language sync, `usePermissions` and
  // the save-action hook read the same cache entries, so boot makes one
  // request per endpoint (#757).
  const prefsQuery = useQuery({ ...mePreferencesQueryOptions(), enabled: hasActiveToken() });
  const permissionsQuery = useQuery({ ...permissionsQueryOptions(), enabled: hasActiveToken() });
  const [moduleOrder, setModuleOrder] = useState(DEFAULT_MODULE_ORDER);
  const [expandedNav, setExpandedNav] = useState(false);
  const [editingNav, setEditingNav] = useState(false);
  const [navigationError, setNavigationError] = useState('');
  const navigationSave = useRef(Promise.resolve());
  useEffect(() => {
    if (!prefsQuery.data) return;
    const keybindings = (prefsQuery.data.keybindings ?? {}) as Record<string, string>;
    setOverrides(keybindings);
    setLoaded(true);
    const order = prefsQuery.data.navigationOrder;
    if (Array.isArray(order)) setModuleOrder(order.filter((id): id is string => typeof id === 'string'));
    setExpandedNav(prefsQuery.data.navigationExpanded === true);
    const tz = prefsQuery.data.timezone;
    useDisplayTimezoneStore.getState().setPreference(typeof tz === 'string' ? tz : null);
  }, [prefsQuery.data, setOverrides, setLoaded]);

  function saveNavigation(patch: { navigationOrder?: string[]; navigationExpanded?: boolean }) {
    setNavigationError('');
    navigationSave.current = navigationSave.current.then(async () => {
      try {
        await getApiClient().me.updatePreferences(patch);
      } catch {
        setNavigationError('Could not save navigation preferences.');
      }
    });
  }

  function onModuleReorder(next: string[]) {
    setModuleOrder(next);
    saveNavigation({ navigationOrder: next });
  }

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
  const isAdmin = permissionsQuery.data?.admin === true;
  const sidebarModules = orderedModules(moduleOrder);
  const staticSidebar = sidebarModules.map((module) => (
    <ModuleNavItem key={module.id} module={module} active={activeModule === module.id} adminBase={adminBase} expanded={expandedNav} editing={false} />
  ));

  return (
    <div className="flex h-screen w-screen">
      <SiteLanguageSync />
      {/* Skip-to-content link — visible on focus, hidden otherwise */}
      <a
        href="#main-content"
        className={cn(
          'absolute start-2 top-2 z-50 rounded bg-primary px-3 py-1.5 text-sm font-medium',
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
        className={cn('hidden shrink-0 flex-col border-e bg-muted/30 py-4 md:flex', expandedNav ? 'w-56' : 'w-16')}
      >
        <div className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3', !expandedNav && 'items-center')}>
          {editingNav ? (
            <Suspense fallback={staticSidebar}>
              <SortableModuleNav modules={sidebarModules} activeModule={activeModule} adminBase={adminBase} expanded={expandedNav} onReorder={onModuleReorder} />
            </Suspense>
          ) : staticSidebar}
        </div>
        {navigationError && <p role="alert" className="px-2 text-xs text-destructive">{navigationError}</p>}
        <div className={cn('mt-2 flex flex-col gap-1 border-t px-3 pt-2', !expandedNav && 'items-center')}>
          {isAdmin && (
            <button type="button" onClick={() => setEditingNav((value) => !value)} aria-label={editingNav ? 'Finish reordering modules' : 'Reorder modules'} aria-pressed={editingNav} className={cn('flex h-9 items-center rounded-md text-muted-foreground hover:bg-accent', expandedNav ? 'gap-3 px-2' : 'w-9 justify-center')}>
              <GripVertical className="h-4 w-4" />{expandedNav && <span className="text-xs">{editingNav ? 'Done reordering' : 'Reorder modules'}</span>}
            </button>
          )}
          <button type="button" onClick={() => { const next = !expandedNav; setExpandedNav(next); saveNavigation({ navigationExpanded: next }); }} disabled={prefsQuery.isLoading} aria-label={expandedNav ? 'Collapse module navigation' : 'Expand module navigation'} aria-expanded={expandedNav} className={cn('flex h-9 items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-50', expandedNav ? 'gap-3 px-2' : 'w-9 justify-center')}>
            {expandedNav ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}{expandedNav && <span className="text-xs">Collapse menu</span>}
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          aria-label="LumiBase Studio header"
          className="flex min-h-14 flex-wrap items-center justify-between gap-y-2 border-b px-4 py-2 sm:h-14 sm:flex-nowrap sm:py-0"
        >
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">LumiBase Studio</span>
            {environmentBadge && (
              <span
                aria-label={`Environment: ${environmentBadge}`}
                className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {environmentBadge}
              </span>
            )}
          </div>
          <OrganizationSwitcher />
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
            <UiLanguagePicker />
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

      {/* Copilot chat (floating). Images / PDFs can be attached to a turn (#709). */}
      <AIAssistant />

      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            open
            onClose={() => setPaletteOpen(false)}
            adminBase={adminBase}
          />
        </Suspense>
      )}

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
