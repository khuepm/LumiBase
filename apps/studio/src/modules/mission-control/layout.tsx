import { Link, useRouterState } from '@tanstack/react-router';
import { OctagonX, Sparkles, X } from 'lucide-react';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { ADMIN_PATH_REGEX } from '@/modules/setup/schemas/admin-path';
import { IntentComposer } from './intent-composer';
import { KillSwitchPanel } from './kill-switch';

/**
 * Mission Control chrome (content-os-ui task 2.1; Req 1.2, 1.3).
 *
 * Every sub-route renders inside this layout: URL-driven sub-navigation
 * plus the two controls that must never be more than one click away —
 * the kill switch (emergency stop, opens as a modal so the operator never
 * has to navigate to stop the system) and the intent composer (the primary
 * verb of the Content OS).
 */

const SECTIONS = [
  { id: 'overview', label: 'Overview', path: '' },
  { id: 'inbox', label: 'Inbox', path: '/inbox' },
  { id: 'intents', label: 'Intents', path: '/intents' },
  { id: 'trust', label: 'Trust ledger', path: '/trust' },
  { id: 'constitution', label: 'Constitution', path: '/constitution' },
] as const;

function getAdminBase(pathname: string): string {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first) return '';
  const candidate = `/${first}`;
  return ADMIN_PATH_REGEX.test(candidate) ? candidate : '';
}

/** Optional `/$adminPath` prefix of the current location ('' when absent). */
export function useAdminBase(): string {
  const { location } = useRouterState();
  return getAdminBase(location.pathname);
}

export function useMissionControlBase(): string {
  return `${useAdminBase()}/mission-control`;
}

interface MissionControlActions {
  openKillSwitch: () => void;
  openComposer: () => void;
}

const ActionsContext = createContext<MissionControlActions | null>(null);

/** Layout-provided actions (Req 2.2: dashboard cards can open the kill switch modal). */
export function useMissionControlActions(): MissionControlActions {
  const ctx = useContext(ActionsContext);
  if (!ctx) throw new Error('useMissionControlActions must be used inside MissionControlLayout');
  return ctx;
}

export function MissionControlLayout({ children }: { children: ReactNode }) {
  const { location } = useRouterState();
  const [composerOpen, setComposerOpen] = useState(false);
  const [killSwitchOpen, setKillSwitchOpen] = useState(false);

  const base = `${getAdminBase(location.pathname)}/mission-control`;
  const subPath = location.pathname.startsWith(base)
    ? location.pathname.slice(base.length)
    : '';
  const activeSection =
    SECTIONS.find((s) => s.path !== '' && subPath.startsWith(s.path))?.id ?? 'overview';

  const actions = useMemo<MissionControlActions>(
    () => ({
      openKillSwitch: () => setKillSwitchOpen(true),
      openComposer: () => setComposerOpen(true),
    }),
    [],
  );

  return (
    <ActionsContext.Provider value={actions}>
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mission Control</h1>
          <p className="text-sm text-muted-foreground">
            Exceptions, trust and the stop button — everything agents need a human for.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Emergency stop is reachable from every sub-route (Req 1.3). */}
          <button
            type="button"
            onClick={() => setKillSwitchOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
          >
            <OctagonX className="h-4 w-4" /> Kill switch
          </button>
          {/* Primary CTA (content-os Req 16.5): declare desired state. */}
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" /> Compose intent
          </button>
        </div>
      </header>

      <nav className="flex gap-1 border-b" aria-label="Mission Control sections">
        {SECTIONS.map((s) => (
          <Link
            key={s.id}
            to={`${base}${s.path}` as never}
            aria-current={activeSection === s.id ? 'page' : undefined}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm',
              activeSection === s.id
                ? 'border border-b-0 bg-background font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      <section>{children}</section>

      {composerOpen && <IntentComposer onClose={() => setComposerOpen(false)} />}

      {killSwitchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          role="dialog"
          aria-label="Kill switch"
        >
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg border bg-background p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-base font-semibold text-destructive">
                <OctagonX className="h-4 w-4" /> Kill switch
              </h2>
              <button
                type="button"
                onClick={() => setKillSwitchOpen(false)}
                aria-label="Close kill switch"
                className="rounded-md border p-1 hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <KillSwitchPanel />
          </div>
        </div>
      )}
    </div>
    </ActionsContext.Provider>
  );
}
