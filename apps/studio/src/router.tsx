import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { AppShell } from './components/app-shell';
import { BareLayout } from './components/bare-layout';
import { SetupLayout } from './modules/setup/setup-layout';
import { SetupStateGate } from './modules/setup/setup-state-gate';
import {
  getEarliestUnsatisfiedStep,
  useSetupStore,
} from './modules/setup/setup-store';

// ---------------------------------------------------------------------------
// Lazy-loaded route components — each import() becomes a separate chunk.
// Heavy dependencies (Monaco, WYSIWYG, etc.) are pulled in only when needed.
// ---------------------------------------------------------------------------
const AccessLayout = lazy(() => import('./modules/access/layout').then((m) => ({ default: m.AccessLayout })));
const PermissionMatrixPage = lazy(() => import('./modules/access/permission-matrix').then((m) => ({ default: m.PermissionMatrixPage })));
const PoliciesListPage = lazy(() => import('./modules/access/policies-page').then((m) => ({ default: m.PoliciesListPage })));
const PolicyDetailPage = lazy(() => import('./modules/access/policy-detail').then((m) => ({ default: m.PolicyDetailPage })));
const RoleDetailPage = lazy(() => import('./modules/access/role-detail').then((m) => ({ default: m.RoleDetailPage })));
const RolesListPage = lazy(() => import('./modules/access/roles-page').then((m) => ({ default: m.RolesListPage })));
const TestSandboxPage = lazy(() => import('./modules/access/test-sandbox').then((m) => ({ default: m.TestSandboxPage })));
const ContentIndexPage = lazy(() => import('./modules/content/index-page').then((m) => ({ default: m.ContentIndexPage })));
const ItemDetailPage = lazy(() => import('./modules/content/item-detail').then((m) => ({ default: m.ItemDetailPage })));
const ItemsListPage = lazy(() => import('./modules/content/items-list').then((m) => ({ default: m.ItemsListPage })));
const CollectionsListPage = lazy(() => import('./modules/data-model/list').then((m) => ({ default: m.CollectionsListPage })));
const CollectionDetailPage = lazy(() => import('./modules/data-model/detail').then((m) => ({ default: m.CollectionDetailPage })));
const CollectionWizardPage = lazy(() => import('./modules/data-model/wizard').then((m) => ({ default: m.CollectionWizardPage })));
const FilesPage = lazy(() => import('./modules/files').then((m) => ({ default: m.FilesPage })));
const DeveloperTypesPage = lazy(() => import('./modules/settings/types-page').then((m) => ({ default: m.DeveloperTypesPage })));
const TranslationsPage = lazy(() => import('./modules/translations').then((m) => ({ default: m.TranslationsPage })));
const WebhooksPage = lazy(() => import('./modules/settings/webhooks-page').then((m) => ({ default: m.WebhooksPage })));
const ActivityPage = lazy(() => import('./modules/settings/activity-page').then((m) => ({ default: m.ActivityPage })));
const ExtensionsPage = lazy(() => import('./modules/settings/extensions-page').then((m) => ({ default: m.ExtensionsPage })));
const MarketplacePage = lazy(() => import('./modules/settings/marketplace-page').then((m) => ({ default: m.MarketplacePage })));
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
const StepDone = lazy(() => import('./modules/setup/steps/step-done').then((m) => ({ default: m.StepDone })));

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
    <AppShell>
      <Outlet />
    </AppShell>
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
 * Index route for `/setup`. The wizard has no body of its own at this
 * URL — it always forwards to the earliest unsatisfied step so a fresh
 * visit lands on Account, a refresh mid-flow lands back on the right
 * step, and a post-completion deep-link drops onto Done.
 */
const setupIndexRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup',
  beforeLoad: () => {
    const state = useSetupStore.getState();
    throw redirect({ to: getEarliestUnsatisfiedStep(state) });
  },
  // Component is unreachable because beforeLoad always redirects; kept
  // as a safety net so a future router quirk that bypasses beforeLoad
  // still renders a well-formed page.
  component: withSuspense(StepAccount),
});

const setupAccountRoute = createRoute({
  getParentRoute: () => setupShellRoute,
  path: '/setup/account',
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
      throw redirect({ to: '/setup/account' });
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
 * The Recovery step (task 10.3) is not wired yet, so on submit we
 * forward straight to `/setup/done`. When the recovery route lands,
 * change `onSubmitted` here to navigate to `/setup/recovery` per
 * design.md §5.4.
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
        {/*
          PLACEHOLDER: routing Security → Done directly until the
          Recovery step (task 10.3) lands. Once that route registers,
          this navigation chain becomes Security → Recovery → Done
          per design.md §5.4.
        */}
        <StepSecurity onSubmitted={() => navigate({ to: '/setup/done' })} />
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
    if (!state.completed) {
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

const indexRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/',
  component: withSuspense(ContentIndexPage),
});

const contentCollectionRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/content/$collection',
  component: withSuspense(ItemsListPage),
});

const contentItemRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/content/$collection/$id',
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

const filesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/files',
  component: withSuspense(() => (
    <div className="p-6">
      <FilesPage />
    </div>
  )),
});

const settingsTypesRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/developer/types',
  component: withSuspense(DeveloperTypesPage),
});

const translationsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/translations',
  component: withSuspense(TranslationsPage),
});

const webhooksRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/webhooks',
  component: withSuspense(WebhooksPage),
});

const activityRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/activity',
  component: withSuspense(ActivityPage),
});

const extensionsRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/extensions',
  component: withSuspense(ExtensionsPage),
});

const marketplaceRoute = createRoute({
  getParentRoute: () => adminLayoutRoute,
  path: '/settings/marketplace',
  component: withSuspense(MarketplacePage),
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

const routeTree = rootRoute.addChildren([
  adminLayoutRoute.addChildren([
    indexRoute,
    contentCollectionRoute,
    contentItemRoute,
    dataModelRoute,
    dataModelNewRoute,
    dataModelDetailRoute,
    filesRoute,
    settingsTypesRoute,
    translationsRoute,
    webhooksRoute,
    activityRoute,
    extensionsRoute,
    marketplaceRoute,
    automationFlowsRoute,
    automationFlowNewRoute,
    automationFlowEditRoute,
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
      accessMatrixRoute,
      accessSandboxRoute,
    ]),
  ]),
  // Children of publicLayoutRoute (e.g. /setup, /recovery) are added in
  // subsequent tasks for the admin-setup-wizard spec.
  publicLayoutRoute.addChildren([
    setupShellRoute.addChildren([
      setupIndexRoute,
      setupAccountRoute,
      setupPathRoute,
      setupSecurityRoute,
      setupDoneRoute,
    ]),
    recoveryBackupCodeRoute,
    recoveryForgotPathRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
