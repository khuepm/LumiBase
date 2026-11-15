/**
 * `/intent/{open|create|edit}` — resolves a Studio intent link (issue #759).
 *
 * Flow: parse (contract v1) → site check → extension claims → navigate.
 *
 *  - Invalid links render a friendly explanation, never a crash.
 *  - `site=` different from the active site: the CMS is asked whether the
 *    user may access it. Allowed → an explicit "switch site?" confirmation
 *    (Studio never silently acts on another site). Denied → an error page.
 *  - Navigation targets are always internal (built-in route, or an
 *    extension path that passed the open-redirect check).
 *
 * The auth gate (`AdminReadyGate`) runs before this page; a signed-out user is
 * sent to `{adminPath}/login?next=…` and comes back here after sign-in.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  parseStudioIntent,
  type StudioIntent,
  type StudioIntentError,
} from '@lumibase/contracts/intents';
import { getActiveSite, setActiveSite } from '@/lib/api';
import { getAdminBase, withAdminPrefix } from '@/lib/admin-base';
import { loadExtensionIntentHandlers } from '@/lib/extension-loader';
import { resolveIntent } from '@/lib/intents/registry';
import { probeSiteAccess, type SiteAccess } from '@/lib/intents/site-access';

type Phase =
  | { kind: 'checking-site' }
  | { kind: 'confirm-switch'; site: string }
  | { kind: 'site-denied'; site: string }
  | { kind: 'site-error'; site: string }
  | { kind: 'resolving' };

export function IntentPage() {
  const { action } = useParams({ strict: false }) as { action?: string };
  // Raw query string: TanStack JSON-parses search values (`id=123` → number),
  // which must not leak into an id/field.
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const parsed = useMemo(
    () => parseStudioIntent(action ?? '', new URLSearchParams(searchStr)),
    [action, searchStr],
  );

  if (!parsed.ok) return <IntentErrorPage errors={parsed.errors} />;
  return <IntentResolver key={`${action}${searchStr}`} intent={parsed.intent} />;
}

export function IntentResolver({
  intent,
  probe = probeSiteAccess,
}: {
  intent: StudioIntent;
  probe?: (siteId: string) => Promise<SiteAccess>;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const activeSite = getActiveSite();
  const needsSwitch = Boolean(intent.site && intent.site !== activeSite);
  const [phase, setPhase] = useState<Phase>(needsSwitch ? { kind: 'checking-site' } : { kind: 'resolving' });

  useEffect(() => {
    if (!needsSwitch || !intent.site) return;
    let cancelled = false;
    const site = intent.site;
    void probe(site).then((access) => {
      if (cancelled) return;
      if (access === 'allowed') setPhase({ kind: 'confirm-switch', site });
      else if (access === 'denied') setPhase({ kind: 'site-denied', site });
      else setPhase({ kind: 'site-error', site });
    });
    return () => {
      cancelled = true;
    };
  }, [needsSwitch, intent.site, probe]);

  useEffect(() => {
    if (phase.kind !== 'resolving') return;
    let cancelled = false;
    void (async () => {
      await loadExtensionIntentHandlers().catch(() => undefined);
      const resolution = await resolveIntent(intent, getActiveSite());
      if (cancelled) return;
      const adminBase = getAdminBase(window.location.pathname);
      const [pathname = '/', query = ''] = resolution.path.split('?');
      void navigate({
        href: `${withAdminPrefix(pathname, adminBase)}${query ? `?${query}` : ''}`,
        replace: true,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [phase.kind, intent, navigate]);

  if (phase.kind === 'confirm-switch') {
    return (
      <IntentFrame title="Switch site to open this link?">
        <p className="text-sm text-muted-foreground">
          This link opens content in site <code className="rounded bg-muted px-1">{phase.site}</code>.
          You are currently working in <code className="rounded bg-muted px-1">{activeSite}</code>.
          Switching reloads Studio in the other site.
        </p>
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={async () => {
              await queryClient.cancelQueries();
              queryClient.clear();
              setActiveSite(phase.site);
              // Reload on the same intent URL: the site now matches, so the
              // intent resolves normally with a fresh, site-scoped shell.
              window.location.reload();
            }}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            <ArrowRightLeft className="h-4 w-4" /> Switch to {phase.site}
          </button>
          <Link to="/" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
            Stay in {activeSite}
          </Link>
        </div>
      </IntentFrame>
    );
  }

  if (phase.kind === 'site-denied') {
    return (
      <IntentFrame title="You don’t have access to that site" tone="error">
        <p className="text-sm text-muted-foreground">
          This link points to content in site <code className="rounded bg-muted px-1">{phase.site}</code>,
          which your account cannot open. Nothing was opened in your current site. Ask an
          administrator of that site for access.
        </p>
        <HomeLink />
      </IntentFrame>
    );
  }

  if (phase.kind === 'site-error') {
    return (
      <IntentFrame title="Couldn’t check access to that site" tone="error">
        <p className="text-sm text-muted-foreground">
          Studio could not confirm whether you can open site{' '}
          <code className="rounded bg-muted px-1">{phase.site}</code>. Check your connection and
          open the link again.
        </p>
        <HomeLink />
      </IntentFrame>
    );
  }

  return (
    <div role="status" aria-label="Opening link" className="flex h-full items-center justify-center p-12">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

export function IntentErrorPage({ errors }: { errors: StudioIntentError[] }) {
  return (
    <IntentFrame title="This link can’t be opened" tone="error">
      <p className="text-sm text-muted-foreground">
        The Studio link is incomplete or malformed, so nothing was opened.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {errors.map((e, i) => (
          <li key={`${e.code}-${e.param ?? ''}-${i}`}>
            {e.param ? <code className="rounded bg-muted px-1">{e.param}</code> : null} {e.message}
          </li>
        ))}
      </ul>
      <HomeLink />
    </IntentFrame>
  );
}

function HomeLink() {
  return (
    <div className="pt-2">
      <Link to="/" className="text-sm text-primary hover:underline">
        Go to Studio home
      </Link>
    </div>
  );
}

function IntentFrame({
  title,
  tone = 'info',
  children,
}: {
  title: string;
  tone?: 'info' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div role={tone === 'error' ? 'alert' : 'dialog'} aria-label={title} className="w-full max-w-lg space-y-3 rounded-md border bg-background p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          {tone === 'error' && <AlertTriangle className="h-5 w-5 text-amber-600" />}
          {title}
        </h1>
        {children}
      </div>
    </div>
  );
}
