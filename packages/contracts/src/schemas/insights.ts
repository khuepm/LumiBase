/**
 * Insights / Dashboard shared contract.
 *
 * `PanelQuery` is the single source of truth for a panel's query, shared by
 * the Studio panel editor (which produces it) and the CMS insights service
 * (which executes it). See `.kiro/specs/insights-dashboard`.
 *
 * The `filter` is a Directus-style condition rule (same shape as
 * `apps/cms/src/services/conditions.ts`). It is intentionally typed loosely
 * here (a recursive record) — the authoritative evaluation lives in
 * `evaluateRule`, so re-deriving the operator union in Zod would risk drift.
 */

import { z } from 'zod';

export const PANEL_TYPES = ['metric', 'timeSeries', 'bar', 'pie', 'list', 'table'] as const;
export type PanelType = (typeof PANEL_TYPES)[number];

export const AGGREGATES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type Aggregate = (typeof AGGREGATES)[number];

/** Default and ceiling for the number of grouped rows a panel returns. */
export const PANEL_DEFAULT_LIMIT = 50;
export const PANEL_MAX_LIMIT = 1000;

/** A condition rule object — validated structurally, evaluated by `evaluateRule`. */
export const conditionRuleSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string(), z.unknown())
  .refine((v) => v !== null && typeof v === 'object', { message: 'filter must be an object' });

export const gridPositionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type GridPosition = z.infer<typeof gridPositionSchema>;

export const dateRangeSchema = z.object({
  field: z.string().min(1),
  gte: z.string().optional(),
  lte: z.string().optional(),
  preset: z.string().optional(),
});

export const panelQuerySchema = z
  .object({
    collection: z.string().min(1),
    aggregate: z.enum(AGGREGATES),
    field: z.string().min(1).optional(),
    groupBy: z.string().min(1).optional(),
    filter: conditionRuleSchema.optional(),
    dateRange: dateRangeSchema.optional(),
    limit: z.number().int().min(1).max(PANEL_MAX_LIMIT).optional(),
  })
  .refine((q) => q.aggregate === 'count' || !!q.field, {
    message: 'field is required for non-count aggregates',
    path: ['field'],
  });
export type PanelQuery = z.infer<typeof panelQuerySchema>;

export const panelCreateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(PANEL_TYPES),
  position: gridPositionSchema,
  query: panelQuerySchema,
  options: z.record(z.string(), z.unknown()).optional(),
});
export type PanelCreateInput = z.infer<typeof panelCreateSchema>;

export const dashboardCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  note: z.string().optional(),
});
export type DashboardCreateInput = z.infer<typeof dashboardCreateSchema>;

/** Shape of a computed panel result, by panel type. */
export interface PanelResult {
  data: {
    value?: number;
    series?: { label: string; value: number }[];
    rows?: Record<string, unknown>[];
  };
  meta: { executedAt: string; rowCount: number; durationMs: number };
}
