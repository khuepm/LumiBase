import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ComponentType } from 'react';
import type { DashboardWidget } from '@lumibase/contracts';
import { getApiClient } from '@/lib/api';
import { ExtensionComponent, getExtension, getExtensionsForSlot } from '@/lib/extension-loader';
import { WidgetSkeleton } from '@/components/dashboard-widget';
import { insightsApi } from '@/modules/insights/api';
import { PanelView } from '@/modules/insights/panel-view';
import { missionControlApi } from '@/modules/mission-control/api';

/**
 * Dashboard widget registry (#691). A widget owns its data and renders
 * inside a `DashboardWidget` boundary (own skeleton, contained errors).
 * Built-ins are listed here; UI extensions of the `panel` slot become
 * `extension:<name>` widgets and render through `ExtensionComponent`, the
 * same isolation every UI extension gets (error boundary, Suspense, CSP and
 * the bundle-origin allowlist), with only `config` and `size` as props.
 */

export interface WidgetProps {
  widget: DashboardWidget;
}

export interface WidgetDefinition {
  type: string;
  title: string;
  description: string;
  defaultSize: { w: number; h: number };
  component: ComponentType<WidgetProps>;
  /** Fields editable in the widget's settings (string config values). */
  configFields?: Array<{ key: string; label: string; placeholder?: string; multiline?: boolean }>;
}

function CollectionsWidget() {
  const client = getApiClient();
  const q = useQuery({ queryKey: ['collections'], queryFn: async () => (await client.schema.listCollections()).data });
  if (q.isLoading) return <WidgetSkeleton />;
  const visible = (q.data ?? []).filter((c) => !c.hidden && !c.system);
  if (visible.length === 0) return <p className="text-sm text-muted-foreground">No collections yet.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {visible.slice(0, 12).map((c) => (
        <li key={c.name}>
          <Link to="/content/$collection" params={{ collection: c.name }} className="hover:underline">
            {c.label || c.name}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RecentActivityWidget() {
  const client = getApiClient();
  const q = useQuery({ queryKey: ['dashboard-activity'], queryFn: async () => (await client.activity.list({ limit: 10 })).data });
  if (q.isLoading) return <WidgetSkeleton />;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No recent activity.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((a) => (
        <li key={a.id} className="flex justify-between gap-2">
          <span className="truncate">
            <span className="font-medium">{a.action}</span> {a.collection ?? ''}
            {a.itemId ? ` · ${a.itemId.slice(0, 8)}` : ''}
          </span>
          <span className="shrink-0 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function ReleasesWidget() {
  const client = getApiClient();
  const q = useQuery({
    queryKey: ['dashboard-releases'],
    queryFn: async () =>
      (
        await client.rawRequest<Array<{ id: string; name: string; status: string; publishAt: string | null }>>(
          '/api/v1/releases?status=scheduled&limit=10',
        )
      ).data,
  });
  if (q.isLoading) return <WidgetSkeleton />;
  const rows = [...(q.data ?? [])].sort((a, b) => (a.publishAt ?? '').localeCompare(b.publishAt ?? ''));
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No scheduled releases.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {rows.map((r) => (
        <li key={r.id} className="flex justify-between gap-2">
          <Link to="/releases" className="truncate hover:underline">
            {r.name}
          </Link>
          <span className="shrink-0 text-xs text-muted-foreground">
            {r.publishAt ? new Date(r.publishAt).toLocaleString() : '—'}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AgentRunsWidget() {
  const q = useQuery({ queryKey: ['dashboard-agent-runs'], queryFn: () => missionControlApi.runs() });
  if (q.isLoading) return <WidgetSkeleton />;
  const rows = (q.data ?? []).slice(0, 8);
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No agent runs yet.</p>;
  return (
    <ul className="space-y-1 text-xs">
      {rows.map((r) => (
        <li key={r.id} className="flex justify-between gap-2">
          <span className="truncate">
            {r.agentName} <span className="text-muted-foreground">· {r.status}</span>
          </span>
          <span className="shrink-0 text-muted-foreground">{new Date(r.startedAt).toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function InsightsPanelWidget({ widget }: WidgetProps) {
  const dashboardId = typeof widget.config?.dashboardId === 'string' ? widget.config.dashboardId : '';
  const panelId = typeof widget.config?.panelId === 'string' ? widget.config.panelId : '';
  const q = useQuery({
    queryKey: ['insights-panels', dashboardId],
    queryFn: () => insightsApi.listPanels(dashboardId),
    enabled: Boolean(dashboardId),
  });
  if (!dashboardId || !panelId) {
    return <p className="text-sm text-muted-foreground">Edit this widget to pick an Insights dashboard and panel.</p>;
  }
  if (q.isLoading) return <WidgetSkeleton />;
  const panel = (q.data ?? []).find((p) => p.id === panelId);
  if (!panel) return <p className="text-sm text-muted-foreground">That Insights panel no longer exists.</p>;
  return <PanelView panel={panel} />;
}

function NoteWidget({ widget }: WidgetProps) {
  const text = typeof widget.config?.text === 'string' ? widget.config.text : '';
  return text ? (
    <p className="whitespace-pre-wrap text-sm">{text}</p>
  ) : (
    <p className="text-sm text-muted-foreground">Edit this widget to write a note.</p>
  );
}

/** An extension `panel` rendered as a widget; isolated like every UI extension. */
export function ExtensionWidget({ widget }: WidgetProps) {
  const name = widget.type.slice('extension:'.length);
  if (!getExtension(name)) {
    return <p className="text-sm text-muted-foreground">Extension “{name}” is not installed or not enabled.</p>;
  }
  return <ExtensionComponent name={name} config={widget.config ?? {}} size={{ w: widget.w, h: widget.h }} />;
}

export const BUILT_IN_WIDGETS: WidgetDefinition[] = [
  { type: 'collections', title: 'Collections', description: 'Your content collections.', defaultSize: { w: 6, h: 4 }, component: CollectionsWidget },
  { type: 'recent-activity', title: 'Recent activity', description: 'Latest changes on the site.', defaultSize: { w: 6, h: 4 }, component: RecentActivityWidget },
  {
    type: 'insights-panel',
    title: 'Insights chart',
    description: 'One panel from an Insights dashboard.',
    defaultSize: { w: 6, h: 4 },
    component: InsightsPanelWidget,
    configFields: [
      { key: 'dashboardId', label: 'Insights dashboard id' },
      { key: 'panelId', label: 'Panel id' },
    ],
  },
  { type: 'releases', title: 'Scheduled releases', description: 'Upcoming release publishes.', defaultSize: { w: 6, h: 3 }, component: ReleasesWidget },
  { type: 'agent-runs', title: 'Agent runs', description: 'Recent agent runs.', defaultSize: { w: 6, h: 3 }, component: AgentRunsWidget },
  {
    type: 'note',
    title: 'Note',
    description: 'A plain-text note.',
    defaultSize: { w: 4, h: 2 },
    component: NoteWidget,
    configFields: [{ key: 'text', label: 'Text', multiline: true }],
  },
];

/** Built-ins plus every enabled `panel` extension. */
export function availableWidgets(): WidgetDefinition[] {
  const extensions = getExtensionsForSlot('panel').map(
    (e): WidgetDefinition => ({
      type: `extension:${e.name}`,
      title: e.manifest?.title || e.name,
      description: e.manifest?.description || 'Extension widget.',
      defaultSize: { w: 6, h: 3 },
      component: ExtensionWidget,
    }),
  );
  return [...BUILT_IN_WIDGETS, ...extensions];
}

export function widgetDefinition(type: string): WidgetDefinition | undefined {
  if (type.startsWith('extension:')) {
    const name = type.slice('extension:'.length);
    const ext = getExtension(name);
    return {
      type,
      title: ext?.manifest?.title || name,
      description: 'Extension widget.',
      defaultSize: { w: 6, h: 3 },
      component: ExtensionWidget,
    };
  }
  return BUILT_IN_WIDGETS.find((w) => w.type === type);
}
