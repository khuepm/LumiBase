import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { ConstitutionEditor } from './constitution-editor';
import { ExceptionInbox } from './inbox';
import { IntentComposer } from './intent-composer';
import { KillSwitchPanel } from './kill-switch';
import { SloHealth } from './slo-health';
import { TrustLedger } from './trust-ledger';

/**
 * Mission Control (content-os tasks 17-18; Req 16.1-16.6).
 *
 * The operator console for the Content OS: exception inbox, SLO health,
 * trust ledger, constitution editor and kill switch. The Intent Composer
 * is the page's primary CTA — declaring desired state is the main verb of
 * this UI; form editing stays available inside the composer as the
 * secondary path.
 */

type Tab = 'inbox' | 'slo' | 'trust' | 'constitution' | 'kill-switch';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'slo', label: 'SLO health' },
  { id: 'trust', label: 'Trust ledger' },
  { id: 'constitution', label: 'Constitution' },
  { id: 'kill-switch', label: 'Kill switch' },
];

export function MissionControlPage() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [composerOpen, setComposerOpen] = useState(false);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Mission Control</h1>
          <p className="text-sm text-muted-foreground">
            Exceptions, trust and the stop button — everything agents need a human for.
          </p>
        </div>
        {/* Primary CTA (Req 16.5): declare desired state. */}
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Sparkles className="h-4 w-4" /> Compose intent
        </button>
      </header>

      <nav className="flex gap-1 border-b" aria-label="Mission Control sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm',
              tab === t.id
                ? 'border border-b-0 bg-background font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section className="rounded-lg border bg-background p-4">
        {tab === 'inbox' && <ExceptionInbox />}
        {tab === 'slo' && <SloHealth />}
        {tab === 'trust' && <TrustLedger />}
        {tab === 'constitution' && <ConstitutionEditor />}
        {tab === 'kill-switch' && <KillSwitchPanel />}
      </section>

      {composerOpen && <IntentComposer onClose={() => setComposerOpen(false)} />}
    </div>
  );
}
