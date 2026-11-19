import { z } from 'zod';

/**
 * Studio home dashboard layout (#691): a list of widgets on a 12-column grid.
 * Stored per user and as a per-site default; validated on both ends.
 */
export const DASHBOARD_GRID_COLUMNS = 12;
export const DASHBOARD_MAX_WIDGETS = 40;
export const DASHBOARD_MAX_ROWS = 200;
/** Largest serialized `config` a widget may carry. */
export const DASHBOARD_WIDGET_CONFIG_MAX_BYTES = 4096;

/**
 * Widget type: a built-in (`collections`, `recent-activity`, `insights-panel`,
 * `releases`, `agent-runs`, `note`) or `extension:<name>` for a UI extension
 * of the `panel` slot.
 */
export const dashboardWidgetTypeSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^(?:[a-z][a-z0-9-]*|extension:[A-Za-z0-9_@/.-]+)$/);

export const dashboardWidgetSchema = z
  .object({
    id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
    type: dashboardWidgetTypeSchema,
    x: z.number().int().min(0).max(DASHBOARD_GRID_COLUMNS - 1),
    y: z.number().int().min(0).max(DASHBOARD_MAX_ROWS),
    w: z.number().int().min(1).max(DASHBOARD_GRID_COLUMNS),
    h: z.number().int().min(1).max(12),
    title: z.string().max(120).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((w) => w.x + w.w <= DASHBOARD_GRID_COLUMNS, { message: 'Widget extends past the grid.' })
  .refine(
    (w) => !w.config || new TextEncoder().encode(JSON.stringify(w.config)).length <= DASHBOARD_WIDGET_CONFIG_MAX_BYTES,
    { message: 'Widget config is too large.' },
  );

export const dashboardLayoutSchema = z
  .object({
    version: z.literal(1),
    widgets: z.array(dashboardWidgetSchema).max(DASHBOARD_MAX_WIDGETS),
  })
  .refine((l) => new Set(l.widgets.map((w) => w.id)).size === l.widgets.length, {
    message: 'Widget ids must be unique.',
  });

export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** Where an effective layout came from. */
export type DashboardLayoutSource = 'user' | 'site' | 'default';

/** Built-in layout used until the user or a site admin saves one. */
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    { id: 'collections', type: 'collections', x: 0, y: 0, w: 6, h: 4 },
    { id: 'recent-activity', type: 'recent-activity', x: 6, y: 0, w: 6, h: 4 },
    { id: 'releases', type: 'releases', x: 0, y: 4, w: 6, h: 3 },
    { id: 'agent-runs', type: 'agent-runs', x: 6, y: 4, w: 6, h: 3 },
  ],
};
