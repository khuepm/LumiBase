import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, LayoutDashboard, Pencil, Plus, RotateCcw, Save, Settings2, Trash2, X } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type DashboardLayout,
  type DashboardLayoutSource,
  type DashboardWidget,
} from '@lumibase/contracts';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { DashboardWidget as WidgetFrame } from '@/components/dashboard-widget';
import { addWidget, cellAt, moveWidget, removeWidget, resizeWidget } from './layout-engine';
import { availableWidgets, widgetDefinition } from './widgets';

/**
 * Studio home dashboard (#691). Shows the caller's layout — their own, else
 * the site default, else the built-in one. "Edit" turns the board into a
 * composer: drag a widget's handle to move it, drag its corner to resize it,
 * add widgets (built-ins and `panel` extensions), configure or remove them,
 * then save for yourself or — for site admins — as the site default.
 */

const ROW_HEIGHT = 80;

interface EffectiveLayout {
  layout: DashboardLayout | null;
  source: DashboardLayoutSource;
}

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? 'Request failed.';
}

const SOURCE_LABEL: Record<DashboardLayoutSource, string> = {
  user: 'Your layout',
  site: 'Site default layout',
  default: 'Built-in layout',
};

export function HomeDashboardPage() {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const effective = useQuery({
    queryKey: ['dashboard-layout'],
    queryFn: async () => (await client.rawRequest<EffectiveLayout>('/api/v1/dashboard/layout')).data,
  });
  const saved = effective.data?.layout ?? DEFAULT_DASHBOARD_LAYOUT;
  const editing = draft !== null;
  const layout = draft ?? saved;

  const done = () => {
    setDraft(null);
    setConfiguring(null);
    setAdding(false);
    void queryClient.invalidateQueries({ queryKey: ['dashboard-layout'] });
  };
  const save = useMutation({
    mutationFn: async (target: 'user' | 'site') =>
      client.rawRequest(target === 'site' ? '/api/v1/dashboard/layout/site-default' : '/api/v1/dashboard/layout', {
        method: 'PUT',
        body: JSON.stringify({ layout: draft }),
      }),
    onSuccess: done,
  });
  const reset = useMutation({
    mutationFn: async () => client.rawRequest('/api/v1/dashboard/layout', { method: 'DELETE' }),
    onSuccess: done,
  });

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <LayoutDashboard className="h-5 w-5" /> Dashboard
          </h1>
          {effective.data && (
            <p className="text-xs text-muted-foreground">{SOURCE_LABEL[effective.data.source]}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!editing ? (
            <>
              {effective.data?.source === 'user' && (
                <button
                  type="button"
                  onClick={() => reset.mutate()}
                  disabled={reset.isPending}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Use the default
                </button>
              )}
              <button
                type="button"
                onClick={() => setDraft(structuredClone(saved))}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setAdding((v) => !v)}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" /> Add widget
              </button>
              <button type="button" onClick={done} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                Cancel
              </button>
              {perms.isAdmin && (
                <button
                  type="button"
                  onClick={() => save.mutate('site')}
                  disabled={save.isPending}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                  title="Everyone without their own layout sees this one"
                >
                  Save as site default
                </button>
              )}
              <button
                type="button"
                onClick={() => save.mutate('user')}
                disabled={save.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                <Save className="h-3.5 w-3.5" /> Save
              </button>
            </>
          )}
        </div>
      </header>

      {(save.error || reset.error) && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(save.error ?? reset.error)}
        </p>
      )}

      {editing && adding && (
        <WidgetPicker
          onPick={(type) => {
            const def = widgetDefinition(type);
            if (!def) return;
            setDraft((d) => addWidget(d ?? saved, { type, w: def.defaultSize.w, h: def.defaultSize.h }));
            setAdding(false);
          }}
        />
      )}

      <Board
        layout={layout}
        editing={editing}
        onChange={setDraft}
        configuring={configuring}
        onConfigure={setConfiguring}
      />
    </div>
  );
}

function WidgetPicker({ onPick }: { onPick: (type: string) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 rounded-lg border bg-background p-3 sm:grid-cols-3" role="menu" aria-label="Add widget">
      {availableWidgets().map((w) => (
        <button
          key={w.type}
          type="button"
          role="menuitem"
          onClick={() => onPick(w.type)}
          className="rounded-md border p-2 text-start text-xs hover:bg-muted"
        >
          <span className="block font-medium">{w.title}</span>
          <span className="block text-muted-foreground">{w.description}</span>
        </button>
      ))}
    </div>
  );
}

type Drag = { id: string; mode: 'move' | 'resize'; startX: number; startY: number; origin: DashboardWidget };

export function Board({
  layout,
  editing,
  onChange,
  configuring,
  onConfigure,
}: {
  layout: DashboardLayout;
  editing: boolean;
  onChange: (next: DashboardLayout) => void;
  configuring: string | null;
  onConfigure: (id: string | null) => void;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const rows = layout.widgets.reduce((m, w) => Math.max(m, w.y + w.h), 1);

  const begin = (e: ReactPointerEvent, widget: DashboardWidget, mode: Drag['mode']) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: widget.id, mode, startX: e.clientX, startY: e.clientY, origin: widget };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    const board = boardRef.current;
    if (!d || !board) return;
    const rect = board.getBoundingClientRect();
    if (rect.width <= 0) return;
    const colWidth = rect.width / 12;
    const dx = Math.round((e.clientX - d.startX) / colWidth);
    const dy = Math.round((e.clientY - d.startY) / ROW_HEIGHT);
    if (d.mode === 'move') {
      const cell = cellAt(e.clientX - rect.left, e.clientY - rect.top, rect.width, ROW_HEIGHT);
      const x = dx === 0 && dy === 0 ? d.origin.x : Math.min(cell.x, 12 - d.origin.w);
      const y = dx === 0 && dy === 0 ? d.origin.y : cell.y;
      const current = layout.widgets.find((w) => w.id === d.id);
      if (current && (current.x !== x || current.y !== y)) onChange(moveWidget(layout, d.id, x, y));
    } else {
      const w = d.origin.w + dx;
      const h = d.origin.h + dy;
      const current = layout.widgets.find((wg) => wg.id === d.id);
      if (current && (current.w !== w || current.h !== h)) onChange(resizeWidget(layout, d.id, w, h));
    }
  };
  const end = () => {
    drag.current = null;
  };

  return (
    <div
      ref={boardRef}
      data-testid="dashboard-board"
      className={cn('relative grid grid-cols-12 gap-3', editing && 'rounded-lg bg-muted/20 p-1 outline-dashed outline-1 outline-border')}
      style={{ gridAutoRows: `${ROW_HEIGHT}px`, gridTemplateRows: `repeat(${rows}, ${ROW_HEIGHT}px)` }}
      onPointerMove={editing ? onPointerMove : undefined}
      onPointerUp={editing ? end : undefined}
      onPointerCancel={editing ? end : undefined}
    >
      {layout.widgets.map((w) => {
        const def = widgetDefinition(w.type);
        const title = w.title || def?.title || w.type;
        const Body = def?.component;
        return (
          <section
            key={w.id}
            data-widget={w.id}
            className="relative flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background p-3"
            style={{ gridColumn: `${w.x + 1} / span ${w.w}`, gridRow: `${w.y + 1} / span ${w.h}` }}
          >
            <header className="mb-2 flex items-center gap-1">
              {editing && (
                <button
                  type="button"
                  aria-label={`Move ${title}`}
                  onPointerDown={(e) => begin(e, w, 'move')}
                  className="cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-muted"
                >
                  <GripVertical className="h-4 w-4" />
                </button>
              )}
              <h2 className="flex-1 truncate text-sm font-medium">{title}</h2>
              {editing && (
                <>
                  {def?.configFields && (
                    <button
                      type="button"
                      aria-label={`Configure ${title}`}
                      onClick={() => onConfigure(configuring === w.id ? null : w.id)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                    >
                      <Settings2 className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${title}`}
                    onClick={() => onChange(removeWidget(layout, w.id))}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
            </header>
            {editing && configuring === w.id && def?.configFields ? (
              <WidgetSettings
                widget={w}
                fields={def.configFields}
                onClose={() => onConfigure(null)}
                onSave={(patch) =>
                  onChange({ ...layout, widgets: layout.widgets.map((x) => (x.id === w.id ? { ...x, ...patch } : x)) })
                }
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                {Body ? (
                  <WidgetFrame title={title}>
                    <Body widget={w} />
                  </WidgetFrame>
                ) : (
                  <p className="text-sm text-muted-foreground">Unknown widget “{w.type}”.</p>
                )}
              </div>
            )}
            {editing && (
              <span
                role="separator"
                aria-label={`Resize ${title}`}
                onPointerDown={(e) => begin(e, w, 'resize')}
                className="absolute bottom-0 end-0 h-4 w-4 cursor-se-resize touch-none rounded-ss bg-muted-foreground/30"
              />
            )}
          </section>
        );
      })}
    </div>
  );
}

function WidgetSettings({
  widget,
  fields,
  onSave,
  onClose,
}: {
  widget: DashboardWidget;
  fields: NonNullable<ReturnType<typeof widgetDefinition>>['configFields'];
  onSave: (patch: Partial<DashboardWidget>) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(widget.title ?? '');
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries((fields ?? []).map((f) => [f.key, String(widget.config?.[f.key] ?? '')])),
  );
  return (
    <form
      className="space-y-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ title: title.trim() || undefined, config: { ...(widget.config ?? {}), ...values } });
        onClose();
      }}
    >
      <label className="block">
        <span className="text-muted-foreground">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="mt-0.5 w-full rounded border px-2 py-1" />
      </label>
      {(fields ?? []).map((f) => (
        <label key={f.key} className="block">
          <span className="text-muted-foreground">{f.label}</span>
          {f.multiline ? (
            <textarea
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              rows={3}
              className="mt-0.5 w-full rounded border px-2 py-1"
            />
          ) : (
            <input
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="mt-0.5 w-full rounded border px-2 py-1"
            />
          )}
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1 rounded border px-2 py-1">
          <X className="h-3 w-3" /> Close
        </button>
        <button type="submit" className="rounded bg-primary px-2 py-1 text-primary-foreground">
          Apply
        </button>
      </div>
    </form>
  );
}
