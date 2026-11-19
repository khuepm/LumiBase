---
sourceLang: en
version: 1
lastUpdated: 2026-11-19T05:06:56.855Z
contentHash: 787a97109444f29a
codeVerified: 2026-11-19T05:06:56.855Z
codeVerifiedHash: 787a97109444f29a
codeVerifiedClaims: 2
---

# Studio home dashboard

The Studio home page at `/dashboard` (also `/<adminPath>/dashboard`) is a grid
of widgets each editor can arrange for themselves. Site admins can set a site
default that everyone without their own layout sees. It is part of epic #668
(#691).

## Which layout you see

The page loads `GET /api/v1/dashboard/layout`, which resolves in this order:

1. **Your layout** — saved with **Save** in edit mode (`source: "user"`).
2. **The site default** — saved by a site admin (`source: "site"`).
3. **The built-in layout** — Collections, Recent activity, Scheduled releases
   and Agent runs (`source: "default"`, `layout: null`).

**Use the default** deletes your layout and shows the next one in that order.

## Editing

**Edit** turns the grid into an editor:

- Drag a widget by its handle to move it; drag its corner to resize it. The
  grid has 12 columns; widgets that would overlap are pushed down and the
  layout is compacted upwards.
- **Add widget** lists every available widget. A new widget lands at the
  bottom with its default size.
- The settings button edits a widget's title and its options (for example the
  text of a Note, or the dashboard and panel of an Insights chart).
- The remove button deletes the widget.
- **Save** stores the layout for you. Site admins also get **Save as site
  default**. **Cancel** discards the changes.

A layout is limited to 40 widgets, each widget's options to 4 KB.

## Widgets

| Type | Shows |
|------|-------|
| `collections` | Links to your visible collections. |
| `recent-activity` | The latest activity entries. |
| `insights-panel` | One panel of an Insights dashboard (`dashboardId`, `panelId`). |
| `releases` | Upcoming scheduled releases. |
| `agent-runs` | Recent agent runs. |
| `note` | A plain-text note (`text`). |
| `extension:<name>` | A `panel` UI extension. |

Each widget loads its own data and has its own loading and error state, so one
failing widget does not blank the page.

### Extension widgets

Every enabled UI extension of the `panel` slot appears in **Add widget** as
`extension:<name>`. It renders through the same `ExtensionComponent` as every
UI extension — error boundary, Suspense, the Studio CSP and the bundle-origin
allowlist — and receives only `config` and `size` (`{ w, h }` in grid units) as
props. An extension that is removed or disabled later shows a placeholder
instead of breaking the page.

`@lumibase/extension-sdk` exports `defineDashboardWidget` to declare the
widget's props and default size:

```ts
import { defineDashboardWidget, type DashboardWidgetProps } from '@lumibase/extension-sdk';

function Uptime({ config, size }: DashboardWidgetProps) {
  return <p>{String(config.service ?? 'all')} · {size.w}×{size.h}</p>;
}

export default defineDashboardWidget({
  id: 'uptime',
  title: 'Uptime',
  defaultSize: { w: 4, h: 2 },
  component: Uptime,
});
```

## Storage and access

Layouts live in `lumibase_dashboard_layouts` (migration `0044`), one row per
user and site plus at most one site default (`user_id` null), scoped by
`site_id` and row-level security. A personal layout needs a signed-in user: an
API key gets `403 USER_REQUIRED` on `PUT`/`DELETE`. The site default routes
need a site admin; setting and clearing it are audited as
`dashboard_default_set` and `dashboard_default_cleared`. See the
[API reference](../api/hono-api-spec.md#studio-home-dashboard-layout).
