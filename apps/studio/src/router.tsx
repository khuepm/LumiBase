import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { AppShell } from './components/app-shell';
import { BareLayout } from './components/bare-layout';
import { AdminReadyGate } from './modules/setup/admin-ready-gate';
import { shouldAutoRedirectToAdmin } from './modules/setup/setup-environment';
import { SetupLayout } from './modules/setup/setup-layout';
import { SetupStateGate } from './modules/setup/setup-state-gate';
import { useCompleteSetup } from './modules/setup/hooks/use-complete-setup';
import {
  getEarliestUnsatisfiedStep,
  useSetupStore,
} from './modules/setup/setup-store';

// ---------------------------------------------------------------------------
// Lazy-loaded route components — each import() becomes a separate chunk.
// Heavy dependencies (Monaco, WYSIWYG, etc.) are pulled in only when needed.
// ---------------------------------------------------------------------------
const AccessLayout = lazy(() => import('./modules/access/layout').then((m) => ({ default: m.AccessLayout })));
const SettingsLayout = lazy(() => import('./modules/settings/layout').then((m) => ({ default: m.SettingsLayout })));
const ApiKeysPage = lazy(() => import('./modules/access/api-keys-page').then((m) => ({ default: m.ApiKeysPage })));
const AccessImportExportPage = lazy(() => import('./modules/access/import-export-page').then((m) => ({ default: m.AccessImportExportPage })));
const PermissionMatrixPage = lazy(() => import('./modules/access/permission-matrix').then((m) => ({ default: m.PermissionMatrixPage })));
const PoliciesListPage = lazy(() => import('./modules/access/policies-page').then((m) => ({ default: m.PoliciesListPage })));
const PolicyDetailPage = lazy(() => import('./modules/access/policy-detail').then((m) => ({ default: m.PolicyDetailPage })));
const RoleDetailPage = lazy(() => import('./modules/access/role-detail').then((m) => ({ default: m.RoleDetailPage })));
const RolesListPage = lazy(() => import('./modules/access/roles-page').then((m) => ({ default: m.RolesListPage })));
const TestSandboxPage = lazy(() => import('./modules/access/test-sandbox').then((m) => ({ default: m.TestSandboxPage })));
const ContentIndexPage = lazy(() => import('./modules/content/index-page').then((m) => ({ default: m.ContentIndexPage })));
const ItemDetailPage = lazy(() => import('./modules/content/item-detail').then((m) => ({ default: m.ItemDetailPage })));
const ItemsListPage = lazy(() => import('./modules/content/items-list').then((m) => ({ default: m.ItemsListPage })));
const ReviewQueuePage = lazy(() => import('./modules/editorial/review-queue').then((m) => ({ default: m.ReviewQueuePage })));
const CollectionsListPage = lazy(() => import('./modules/data-model/list').then((m) => ({ default: m.CollectionsListPage })));
const CollectionDetailPage = lazy(() => import('./modules/data-model/detail').then((m) => ({ default: m.CollectionDetailPage })));
const CollectionWizardPage = lazy(() => import('./modules/data-model/wizard').then((m) => ({ default: m.CollectionWizardPage })));
const FilesPage = lazy(() => import('./modules/files').then((m) => ({ default: m.FilesPage })));
const DeveloperTypesPage = lazy(() => import('./modules/settings/types-page').then((m) => ({ default: m.DeveloperTypesPage })));
const TranslationsPage = lazy(() => import('./modules/translations').then((m) => ({ default: m.TranslationsPage })));
const WebhooksPage = lazy(() => import('./modules/settings/webhooks-page').then((m) => ({ default: m.WebhooksPage })));
const EmailSettingsPage = lazy(() => import('./modules/settings/email-page').then((m) => ({ default: m.EmailSettingsPage })));
const SiteSettingsPage = lazy(() => import('./modules/settings/site-page').then((m) => ({ default: m.SiteSettingsPage })));
const MaterializePage = lazy(() => import('./modules/settings/materialize-page').then((m) => ({ default: m.MaterializePage })));
const TranslationMemoryPage = lazy(() => import('./modules/translations/tm-page').then((m) => ({ default: m.TranslationMemoryPage })));
const ActivityPage = lazy(() => import('./modules/settings/activity-page').then((m) => ({ default: m.ActivityPage })));
const EncryptionSettingsPage = lazy(() => import('./modules/settings/encryption-page').then((m) => ({ default: m.EncryptionSettingsPage })));
const ExtensionsPage = lazy(() => import('./modules/settings/extensions-page').then((m) => ({ default: m.ExtensionsPage })));
const MarketplacePage = lazy(() => import('./modules/settings/marketplace-page').then((m) => ({ default: m.MarketplacePage })));
const UpdatesPage = lazy(() => import('./modules/settings/updates-page').then((m) => ({ default: m.UpdatesPage })));
const AgentHarnessPage = lazy(() => import('./modules/settings/agent-harness-page').then((m) => ({ default: m.AgentHarnessPage })));
const MissionControlPage = lazy(() => import('./modules/mission-control/index-page').then((m) => ({ default: m.MissionControlPage })));
const MissionControlInboxPage = lazy(() => import('./modules/mission-control/inbox-page').then((m) => ({ default: m.InboxPage })));
const MissionControlIntentsPage = lazy(() => import('./modules/mission-control/intents-page').then((m) => ({ default: m.IntentsPage })));
const MissionControlIntentDetailPage = lazy(() => import('./modules/mission-control/intent-detail').then((m) => ({ default: m.IntentDetailPage })));
const MissionControlGoalsPage = lazy(() => import('./modules/mission-control/goals-page').then((m) => ({ default: m.GoalsPage })));
const MissionControlAgentsPage = lazy(() => import('./modules/mission-control/agents-page').then((m) => ({ default: m.AgentsPage })));
const MissionControlTrustPage = lazy(() => import('./modules/mission-control/trust-page').then((m) => ({ default: m.TrustPage })));
const MissionControlConstitutionPage = lazy(() => import('./modules/mission-control/constitution-page').then((m) => ({ default: m.ConstitutionPage })));
const UsersLayout = lazy(() => import('./modules/users/layout').then((m) => ({ default: m.UsersLayout })));
const TeamsPage = lazy(() => import('./modules/users/teams-page').then((m) => ({ default: m.TeamsPage })));
const UsersPage = lazy(() => import('./modules/users/users-page').then((m) => ({ default: m.UsersPage })));
const FlowsListPage = lazy(() => import('./modules/automation/flows-page').then((m) => ({ default: m.FlowsListPage })));
const FlowEditor = lazy(() => import('./modules/automation/flow-editor').then((m) => ({ default: m.FlowEditor })));
const CdcPipelineListPage = lazy(() => import('./modules/cdc/pipeline-list').then((m) => ({ default: m.CdcPipelineListPage })));
const CdcPipelineWizardPage = lazy(() => import('./modules/cdc/pipeline-wizard').then((m) => ({ default: m.CdcPipelineWizardPage })));
const CdcPipelineDetailPage = lazy(() => import('./modules/cdc/pipeline-detail').then((m) => ({ default: m.CdcPipelineDetailPage })));

// ---------------------------------------------------------------------------
// Setup Wizard step components — lazy-loaded so the bootstrap chunk stays
// small for the (vastly more common) post-setup case where the operator
// loads the AppShell instead. The wizard is single-shot per instance, so
// shipping its bundle on the critical path would be wasted bytes for
// every authenticated admin page load.
// ---------------------------------------------------------------------------
const StepAccount = lazy(() => import('./modules/setup/steps/step-account').then((m) => ({ default: m.StepAccount })));
const StepPath = lazy(() => import('./modules/setup/steps/step-path').then((m) => ({ default: m.StepPath })));
const StepSecurity = lazy(() => import('./modules/setup/steps/step-security').then((m) => ({ default: m.StepSecurity })));
const StepProject = lazy(() => import('./modules/setup/steps/step-project').then((m) => ({ default: m.StepProject })));
const StepRecovery = lazy(() => import('./modules/setup/steps/step-recovery').then((m) => ({ default: m.StepRecovery })));
const StepDone = lazy(() => import('./modules/setup/steps/step-done').then((m) => ({ default: m.StepDone })));
const SimpleSetupWizard = lazy(() => import('./modules/setup/simple-setup-wizard').then((m) => ({ default: m.SimpleSetupWizard })));
const AdminLoginPage = lazy(() => import('./modules/auth/admin-login-page').then((m) => ({ default: m.AdminLoginPage })));

let setupBackupCodes: readonly string[] = [];

// ---------------------------------------------------------------------------
// Recovery pages — public, pre-auth UIs that call the CMS recovery endpoints
// (task 10.7). Lazy-loaded like the wizard steps so they stay off the
// critical path for the (far more common) authenticated AppShell load.
//
// Mounted as DIRECT children of `publicLayoutRoute` (siblings of
// `setupShellRoute`), NOT under the setup shell: recovery is for an
// ALREADY-initialized instance, so it must get `<BareLayout>` but must NOT
// run `SetupStateGate` (which 404s an initialized instance). See design §5.1.
// ---------------------------------------------------------------------------
const BackupCodePage = lazy(() => import('./modules/recovery/backup-code-page').then((m) => ({ default: m.BackupCodePage })));
const ForgotPathPage = lazy(() => import('./modules/recovery/forgot-path-page').then((m) => ({ default: m.ForgotPathPage })));

// ---------------------------------------------------------------------------
// Shared suspense boundary — shows a lightweight spinner while chunks load.
// ---------------------------------------------------------------------------
function PageLoader() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="flex h-full items-center justify-center p-12"
    >
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

function withSuspense(Component: React.ComponentType) {
  return function SuspenseWrapper(props: Record<string, unknown>) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Component {...props} />
      </Suspense>
    );
  };
}

function SetupProjectWithComplete() {
  const navigate = useNavigate();
  const completeSetup = useCompleteSetup();

  return (
    <StepProject
      onSubmitted={() => {
        completeSetup.mutate(
          {},
          {
            onSuccess: (data) => {
              setupBackupCodes = data.backupCodes;
              navigate({ to: '/setup/recovery' });
            },
          },
        );
      }}
    />
  );
}

function AdminRootRedirect() {
  const navigate = useNavigate();
  const adminPath = useSetupStore((s) => s.adminPath);

  useEffect(() => {
    if (adminPath && shouldAutoRedirectToAdmin()) {
      navigate({ to: adminPath });
    }
  }, [adminPath, navigate]);

  if (adminPath && shouldAutoRedirectToAdmin()) {
    return <PageLoader />;
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div role="alert" className="w-full max-w-md rounded-md border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Use the admin URL saved at the end of setup.
        </p>
      </div>
    </div>
  );
}

function AdminLoginRouteComponent() {
  const { adminPath } = adminLoginRoute.useParams();
  return (
    <Suspense fallback={<PageLoader />}>
      <AdminLoginPage adminPath={adminPath} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Route tree
//
// The root route renders only an <Outlet /> so the choice of chrome is
// delegated to two pathless layout routes:
//
//   • adminLayoutRoute — wraps children in <AppShell>, used by every existing
//     admin module (content, files, users, access, …).
//   • publicLayoutRoute — wraps children in <BareLayout> (no AppShell), used
//     by the first-time `/setup` wizard and `/recovery` flows. Children for
//     these are wired in subsequent tasks; the layout route is added now so
//     wizard pages can never accidentally inherit AppShell.
//
// See spec admin-setup-wizard, Req 2.5 and design §5.1.
// ---------------------------------------------------------------------------

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const adminLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'admin-layout',
  component: () => (
    <AdminReadyGate>
      <AppShell>
        <Outlet />
      </AppShell>
    </AdminReadyGate>
  ),
});

const publicLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'public-layout',
  component: BareLayout,
});

// ---------------------------------------------------------------------------
// Setup Wizard routes
//
// All four wizard routes live under a pathless parent (`setupShellRoute`)
// whose component wraps children in
//
//   <SetupStateGate>            ← talks to GET /setup/state, renders 404 /
//                                 retry / token prompt outside the chrome
//     <SetupLayout>             ← progress indicator + centered card
//       <Outlet />              ← active step
//     </SetupLayout>
//   </SetupStateGate>
//
// `SetupStateGate` is intentionally OUTSIDE `SetupLayout` so the gate's
// failure screens (already-initialized 404, retry UI, token prompt) never
// inherit the progress chrome — see design.md §5.1 / setup-state-gate.tsx.
//
// Deep-link guards live in each child's `beforeLoad`. They consult the
// Zustand store synchronously via `useSetupStore.getState()` and throw a
// `redirect(...)` to the earliest unsatisfied step — the helper
// `getEarliestUnsatisfiedStep` keeps the redirect target consistent with
// the state machine in design.md §5.4 / §11.2.
//
// Spec refs: Req 3.11; design.md §5.1, §5.4, §11.2.
// ---------------------------------------------------------------------------

const setupShellRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  id: 'setup-shell',
  component: () => (
    <SetupStateGate>
      <SetupLayout>
        <Outlet />
      </SetupLayout>
    </SetupStateGate>
  ),
});

/**
 * Index route for `/setup`. New operators land on the 3-step quick
 * setup by default. The full six-step flow remains available through
 * `/setup/advance` for advanced security/project tuning.
 */
const setupIndexRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup',
  beforeLoad: () => {
    throw redirect({ to: '/setup/account' });
  },
  // Component is unreachable because beforeLoad always redirects; kept
  // as a safety net so a future router quirk that bypasses beforeLoad
  // still renders a well-formed page.
  component: withSuspense(StepAccount),
});

const setupSimpleRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/setup/account',
  component: () => (
    <SetupStateGate>
      <Suspense fallback={<PageLoader />}>
        <SimpleSetupWizard />
      </Suspense>
    </SetupStateGate>
  ),
});

const setupAccountRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/advance',
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepAccount onSubmitted={() => navigate({ to: '/setup/path' })} />
      </Suspense>
    );
  },
});

const setupPathRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/path',
  beforeLoad: () => {
    // Operators must complete the Account step before they can pick
    // an admin path; deep-linking past Account redirects back.
    if (!useSetupStore.getState().accountValid) {
      throw redirect({ to: '/setup/advance' });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepPath onSubmitted={() => navigate({ to: '/setup/security' })} />
      </Suspense>
    );
  },
});

/**
 * Security step — Phase C surface (Failed Attempts + Notifications)
 * lives in `step-security.tsx` (task 6.5). The route is wired here so
 * the Path step can navigate to it after submit, and so a deep-link
 * to `/setup/security` falls back to the earliest unsatisfied step
 * when prior gates (`accountValid`, `pathValid`) aren't met.
 *
 * Spec refs: requirements §3.11; design.md §5.1, §5.4, §11.2.
 */
const setupSecurityRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/security',
  beforeLoad: () => {
    // Earliest-unsatisfied-step guard: a deep-link to Security while
    // either Account or Path is still incomplete redirects back to
    // whichever step is missing. The helper is the single source of
    // truth for the redirect chain (design §5.4 / §11.2).
    const state = useSetupStore.getState();
    if (!state.accountValid || !state.pathValid) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepSecurity onSubmitted={() => navigate({ to: '/setup/project' })} />
      </Suspense>
    );
  },
});

const setupProjectRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/project',
  beforeLoad: () => {
    const state = useSetupStore.getState();
    if (!state.accountValid || !state.pathValid || !state.policyValid) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    return (
      <Suspense fallback={<PageLoader />}>
        <SetupProjectWithComplete />
      </Suspense>
    );
  },
});

const setupRecoveryRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/recovery',
  beforeLoad: () => {
    const state = useSetupStore.getState();
    if (
      !state.accountValid ||
      !state.pathValid ||
      !state.policyValid ||
      !state.projectValid ||
      !state.completed
    ) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: () => {
    const navigate = useNavigate();
    return (
      <Suspense fallback={<PageLoader />}>
        <StepRecovery
          backupCodes={setupBackupCodes}
          onFinish={() => navigate({ to: '/setup/done' })}
        />
      </Suspense>
    );
  },
});

const setupDoneRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/done',
  beforeLoad: () => {
    // The Done step is the wizard's terminal state. If the operator
    // hasn't actually completed the flow yet, send them to whatever
    // step is still outstanding so the URL stays honest.
    const state = useSetupStore.getState();
    if (!state.completed || !state.confirmed) {
      throw redirect({ to: getEarliestUnsatisfiedStep(state) });
    }
  },
  component: withSuspense(StepDone),
});

// ---------------------------------------------------------------------------
// Recovery routes
//
// `/recovery/backup-code` and `/recovery/forgot-path` are the public,
// pre-auth recovery UIs (task 10.8; Req 14.4, 14.5). They mount as DIRECT
// children of `publicLayoutRoute` — siblings of `setupShellRoute`, NOT
// children of it — for two reasons (design §5.1):
//
//   1. They need `<BareLayout>` (no AppShell), which `publicLayoutRoute`
//      provides.
//   2. They must NOT run `SetupStateGate`. The gate renders a hard 404 on an
//      `initialized` instance, but recovery is specifically FOR an already-
//      initialized instance whose operator is locked out. Nesting under
//      `setupShellRoute` would make recovery permanently unreachable.
//
// No `beforeLoad` guard: recovery is reachable at any time (the operator is
// locked out, by definition) and the pages own their own state.
// ---------------------------------------------------------------------------

const recoveryBackupCodeRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/recovery/backup-code',
  component: withSuspense(BackupCodePage),
});

const recoveryForgotPathRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/recovery/forgot-path',
  component: withSuspense(ForgotPathPage),
});

const adminPathRecoveryBackupCodeRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/recovery/backup-code',
  component: withSuspense(BackupCodePage),
});

const adminPathRecoveryForgotPathRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/recovery/forgot-path',
  component: withSuspense(ForgotPathPage),
});

const adminLoginRoute = createRoute({
  getParentRoute: () => publicLayoutRoute,
  path: '/$adminPath/login',
  component: AdminLoginRouteComponent,
});

const indexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/',
  component: AdminRootRedirect,
});

const adminPathIndexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath',
  component: withSuspense(ContentIndexPage),
});

const contentCollectionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/content/$collection',
  component: withSuspense(ItemsListPage),
});

// Static `reviews` segment is matched before the `$id` param route.
const contentReviewsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/content/$collection/reviews',
  component: withSuspense(ReviewQueuePage),
});

const contentItemRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/content/$collection/$id',
  component: withSuspense(ItemDetailPage),
});

const adminPathContentCollectionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/content/$collection',
  component: withSuspense(ItemsListPage),
});

const adminPathContentReviewsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/content/$collection/reviews',
  component: withSuspense(ReviewQueuePage),
});

const adminPathContentItemRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/content/$collection/$id',
  component: withSuspense(ItemDetailPage),
});

const dataModelRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/data-model',
  component: withSuspense(CollectionsListPage),
});

const dataModelNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/data-model/new',
  component: withSuspense(CollectionWizardPage),
});

const dataModelDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/data-model/$name',
  component: withSuspense(CollectionDetailPage),
});

const adminPathDataModelRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/data-model',
  component: withSuspense(CollectionsListPage),
});

const adminPathDataModelNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/data-model/new',
  component: withSuspense(CollectionWizardPage),
});

const adminPathDataModelDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/data-model/$name',
  component: withSuspense(CollectionDetailPage),
});

const filesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/files',
  component: withSuspense(() => (
    <div className="p-6">
      <FilesPage />
    </div>
  )),
});

const adminPathFilesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/files',
  component: withSuspense(() => (
    <div className="p-6">
      <FilesPage />
    </div>
  )),
});

const settingsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings',
  component: withSuspense(() => (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  )),
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/settings/translations' });
  },
});

const settingsTypesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'developer/types',
  component: withSuspense(DeveloperTypesPage),
});

const translationsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'translations',
  component: withSuspense(TranslationsPage),
});

const webhooksRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'webhooks',
  component: withSuspense(WebhooksPage),
});

const emailSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'email',
  component: withSuspense(EmailSettingsPage),
});

const siteSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'site',
  component: withSuspense(SiteSettingsPage),
});

const materializeSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'materialize',
  component: withSuspense(MaterializePage),
});

const translationMemoryRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'translation-memory',
  component: withSuspense(TranslationMemoryPage),
});

const activityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'activity',
  component: withSuspense(ActivityPage),
});

const encryptionSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'encryption',
  component: withSuspense(EncryptionSettingsPage),
});

const extensionsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'extensions',
  component: withSuspense(ExtensionsPage),
});

const marketplaceRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'marketplace',
  component: withSuspense(MarketplacePage),
});

const updatesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'updates',
  component: withSuspense(UpdatesPage),
});

const agentHarnessRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: 'agent-harness',
  component: withSuspense(AgentHarnessPage),
});

const adminPathSettingsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/settings',
  component: withSuspense(() => (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  )),
});

const adminPathSettingsIndexRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/$adminPath/settings/translations',
      params: { adminPath: params.adminPath },
    });
  },
});

const adminPathSettingsTypesRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'developer/types',
  component: withSuspense(DeveloperTypesPage),
});

const adminPathTranslationsRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'translations',
  component: withSuspense(TranslationsPage),
});

const adminPathWebhooksRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'webhooks',
  component: withSuspense(WebhooksPage),
});

const adminPathEmailSettingsRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'email',
  component: withSuspense(EmailSettingsPage),
});

const adminPathSiteSettingsRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'site',
  component: withSuspense(SiteSettingsPage),
});

const adminPathMaterializeSettingsRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'materialize',
  component: withSuspense(MaterializePage),
});

const adminPathTranslationMemoryRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'translation-memory',
  component: withSuspense(TranslationMemoryPage),
});

const adminPathActivityRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'activity',
  component: withSuspense(ActivityPage),
});

const adminPathExtensionsRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'extensions',
  component: withSuspense(ExtensionsPage),
});

const adminPathMarketplaceRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'marketplace',
  component: withSuspense(MarketplacePage),
});

const adminPathUpdatesRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'updates',
  component: withSuspense(UpdatesPage),
});

const adminPathAgentHarnessRoute = createRoute({
  getParentRoute: () => adminPathSettingsRoute,
  path: 'agent-harness',
  component: withSuspense(AgentHarnessPage),
});

const automationFlowsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/automation/flows',
  component: withSuspense(FlowsListPage),
});

const automationFlowNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/automation/flows/new',
  component: withSuspense(FlowEditor),
});

const automationFlowEditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/automation/flows/$id',
  component: withSuspense(FlowEditor),
});

const adminPathAutomationFlowsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/automation/flows',
  component: withSuspense(FlowsListPage),
});

const adminPathAutomationFlowNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/automation/flows/new',
  component: withSuspense(FlowEditor),
});

const adminPathAutomationFlowEditRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/automation/flows/$id',
  component: withSuspense(FlowEditor),
});

// Mission Control (content-os tasks 17-18; content-os-ui Req 1.1) — the
// Content OS operator console. URL-driven sub-routes so every section is
// bookmarkable and notifications can deep-link (?entry= on the inbox).
const inboxSearch = (search: Record<string, unknown>) => ({
  entry: typeof search.entry === 'string' ? search.entry : undefined,
});

const missionControlRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control',
  component: withSuspense(MissionControlPage),
});

const missionControlInboxRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/inbox',
  validateSearch: inboxSearch,
  component: withSuspense(MissionControlInboxPage),
});

const missionControlIntentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/intents',
  component: withSuspense(MissionControlIntentsPage),
});

const missionControlIntentDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/intents/$intentId',
  component: withSuspense(MissionControlIntentDetailPage),
});

const missionControlGoalsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/goals',
  component: withSuspense(MissionControlGoalsPage),
});

const missionControlAgentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/agents',
  component: withSuspense(MissionControlAgentsPage),
});

const missionControlTrustRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/trust',
  component: withSuspense(MissionControlTrustPage),
});

const missionControlConstitutionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/mission-control/constitution',
  component: withSuspense(MissionControlConstitutionPage),
});

const adminPathMissionControlRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control',
  component: withSuspense(MissionControlPage),
});

const adminPathMissionControlInboxRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/inbox',
  validateSearch: inboxSearch,
  component: withSuspense(MissionControlInboxPage),
});

const adminPathMissionControlIntentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/intents',
  component: withSuspense(MissionControlIntentsPage),
});

const adminPathMissionControlIntentDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/intents/$intentId',
  component: withSuspense(MissionControlIntentDetailPage),
});

const adminPathMissionControlGoalsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/goals',
  component: withSuspense(MissionControlGoalsPage),
});

const adminPathMissionControlAgentsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/agents',
  component: withSuspense(MissionControlAgentsPage),
});

const adminPathMissionControlTrustRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/trust',
  component: withSuspense(MissionControlTrustPage),
});

const adminPathMissionControlConstitutionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/mission-control/constitution',
  component: withSuspense(MissionControlConstitutionPage),
});

const cdcRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/cdc',
  component: withSuspense(CdcPipelineListPage),
});

const cdcNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/cdc/new',
  component: withSuspense(CdcPipelineWizardPage),
});

const cdcDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/cdc/$id',
  component: withSuspense(() => {
    const { id } = cdcDetailRoute.useParams();
    return <CdcPipelineDetailPage pipelineId={id} />;
  }),
});

const adminPathCdcRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/cdc',
  component: withSuspense(CdcPipelineListPage),
});

const adminPathCdcNewRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/cdc/new',
  component: withSuspense(CdcPipelineWizardPage),
});

const adminPathCdcDetailRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/cdc/$id',
  component: withSuspense(() => {
    const { id } = adminPathCdcDetailRoute.useParams();
    return <CdcPipelineDetailPage pipelineId={id} />;
  }),
});

const usersRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/users',
  component: withSuspense(() => (
    <UsersLayout>
      <Outlet />
    </UsersLayout>
  )),
});

const usersIndexRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/',
  component: withSuspense(UsersPage),
});

const usersTeamsRoute = createRoute({
  getParentRoute: () => usersRoute,
  path: '/teams',
  component: withSuspense(TeamsPage),
});

const adminPathUsersRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/users',
  component: withSuspense(() => (
    <UsersLayout>
      <Outlet />
    </UsersLayout>
  )),
});

const adminPathUsersIndexRoute = createRoute({
  getParentRoute: () => adminPathUsersRoute,
  path: '/',
  component: withSuspense(UsersPage),
});

const adminPathUsersTeamsRoute = createRoute({
  getParentRoute: () => adminPathUsersRoute,
  path: '/teams',
  component: withSuspense(TeamsPage),
});

const accessRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/access',
  component: withSuspense(() => (
    <AccessLayout>
      <Outlet />
    </AccessLayout>
  )),
});

const accessIndexRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: '/',
  component: withSuspense(RolesListPage),
});

const accessRolesRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'roles',
  component: withSuspense(RolesListPage),
});

const accessRoleDetailRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'roles/$id',
  component: withSuspense(RoleDetailPage),
});

const accessPoliciesRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'policies',
  component: withSuspense(PoliciesListPage),
});

const accessPolicyDetailRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'policies/$id',
  component: withSuspense(PolicyDetailPage),
});

const accessApiKeysRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'api-keys',
  component: withSuspense(ApiKeysPage),
});

const accessImportExportRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'import-export',
  component: withSuspense(AccessImportExportPage),
});

const accessMatrixRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'matrix',
  component: withSuspense(PermissionMatrixPage),
});

const accessSandboxRoute = createRoute({
  getParentRoute: () => accessRoute,
  path: 'sandbox',
  component: withSuspense(TestSandboxPage),
});

const adminPathAccessRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/$adminPath/access',
  component: withSuspense(() => (
    <AccessLayout>
      <Outlet />
    </AccessLayout>
  )),
});

const adminPathAccessIndexRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: '/',
  component: withSuspense(RolesListPage),
});

const adminPathAccessRolesRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'roles',
  component: withSuspense(RolesListPage),
});

const adminPathAccessRoleDetailRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'roles/$id',
  component: withSuspense(RoleDetailPage),
});

const adminPathAccessPoliciesRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'policies',
  component: withSuspense(PoliciesListPage),
});

const adminPathAccessPolicyDetailRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'policies/$id',
  component: withSuspense(PolicyDetailPage),
});

const adminPathAccessApiKeysRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'api-keys',
  component: withSuspense(ApiKeysPage),
});

const adminPathAccessImportExportRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'import-export',
  component: withSuspense(AccessImportExportPage),
});

const adminPathAccessMatrixRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'matrix',
  component: withSuspense(PermissionMatrixPage),
});

const adminPathAccessSandboxRoute = createRoute({
  getParentRoute: () => adminPathAccessRoute,
  path: 'sandbox',
  component: withSuspense(TestSandboxPage),
});

const routeTree = rootRoute.addChildren([
  adminLayoutRoute.addChildren([
    indexRoute,
    contentCollectionRoute,
    contentReviewsRoute,
    contentItemRoute,
    dataModelRoute,
    dataModelNewRoute,
    dataModelDetailRoute,
    filesRoute,
    settingsRoute.addChildren([
      settingsIndexRoute,
      settingsTypesRoute,
      translationsRoute,
      siteSettingsRoute,
      webhooksRoute,
      emailSettingsRoute,
      materializeSettingsRoute,
      translationMemoryRoute,
      activityRoute,
      encryptionSettingsRoute,
      extensionsRoute,
      marketplaceRoute,
      updatesRoute,
      agentHarnessRoute,
    ]),
    automationFlowsRoute,
    automationFlowNewRoute,
    automationFlowEditRoute,
    missionControlRoute,
    missionControlInboxRoute,
    missionControlIntentsRoute,
    missionControlIntentDetailRoute,
    missionControlGoalsRoute,
    missionControlAgentsRoute,
    missionControlTrustRoute,
    missionControlConstitutionRoute,
    adminPathMissionControlRoute,
    adminPathMissionControlInboxRoute,
    adminPathMissionControlIntentsRoute,
    adminPathMissionControlIntentDetailRoute,
    adminPathMissionControlGoalsRoute,
    adminPathMissionControlAgentsRoute,
    adminPathMissionControlTrustRoute,
    adminPathMissionControlConstitutionRoute,
    cdcRoute,
    cdcNewRoute,
    cdcDetailRoute,
    usersRoute.addChildren([usersIndexRoute, usersTeamsRoute]),
    accessRoute.addChildren([
      accessIndexRoute,
      accessRolesRoute,
      accessRoleDetailRoute,
      accessPoliciesRoute,
      accessPolicyDetailRoute,
      accessApiKeysRoute,
      accessImportExportRoute,
      accessMatrixRoute,
      accessSandboxRoute,
    ]),
    adminPathIndexRoute,
    adminPathContentCollectionRoute,
    adminPathContentReviewsRoute,
    adminPathContentItemRoute,
    adminPathDataModelRoute,
    adminPathDataModelNewRoute,
    adminPathDataModelDetailRoute,
    adminPathFilesRoute,
    adminPathSettingsRoute.addChildren([
      adminPathSettingsIndexRoute,
      adminPathSettingsTypesRoute,
      adminPathTranslationsRoute,
      adminPathSiteSettingsRoute,
      adminPathWebhooksRoute,
      adminPathEmailSettingsRoute,
      adminPathMaterializeSettingsRoute,
      adminPathTranslationMemoryRoute,
      adminPathActivityRoute,
      adminPathExtensionsRoute,
      adminPathMarketplaceRoute,
      adminPathUpdatesRoute,
      adminPathAgentHarnessRoute,
    ]),
    adminPathAutomationFlowsRoute,
    adminPathAutomationFlowNewRoute,
    adminPathAutomationFlowEditRoute,
    adminPathCdcRoute,
    adminPathCdcNewRoute,
    adminPathCdcDetailRoute,
    adminPathUsersRoute.addChildren([adminPathUsersIndexRoute, adminPathUsersTeamsRoute]),
    adminPathAccessRoute.addChildren([
      adminPathAccessIndexRoute,
      adminPathAccessRolesRoute,
      adminPathAccessRoleDetailRoute,
      adminPathAccessPoliciesRoute,
      adminPathAccessPolicyDetailRoute,
      adminPathAccessApiKeysRoute,
      adminPathAccessImportExportRoute,
      adminPathAccessMatrixRoute,
      adminPathAccessSandboxRoute,
    ]),
  ]),
  // Children of publicLayoutRoute (e.g. /setup, /recovery) are added in
  // subsequent tasks for the admin-setup-wizard spec.
  publicLayoutRoute.addChildren([
    setupSimpleRoute,
    setupShellRoute.addChildren([
      setupIndexRoute,
      setupAccountRoute,
      setupPathRoute,
      setupSecurityRoute,
      setupProjectRoute,
      setupRecoveryRoute,
      setupDoneRoute,
    ]),
    recoveryBackupCodeRoute,
    recoveryForgotPathRoute,
    adminPathRecoveryBackupCodeRoute,
    adminPathRecoveryForgotPathRoute,
    adminLoginRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
