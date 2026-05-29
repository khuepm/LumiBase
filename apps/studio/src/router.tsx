import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { AppShell } from './components/app-shell';
import { BareLayout } from './components/bare-layout';

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
  publicLayoutRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
