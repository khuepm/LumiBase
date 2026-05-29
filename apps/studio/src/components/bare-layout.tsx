import { Outlet } from '@tanstack/react-router';

/**
 * Public layout used by routes that must NOT render the admin AppShell —
 * e.g. the first-time `/setup` wizard and the `/recovery` flow.
 *
 * Keeps the page chrome minimal so the Studio admin surface (sidebar,
 * notifications, etc.) is never leaked before the instance is initialized
 * or while the user is on a public, unauthenticated flow.
 *
 * Child routes register under `publicLayoutRoute` in `router.tsx` and are
 * rendered into the `<Outlet />` below.
 */
export function BareLayout() {
  return <Outlet />;
}
