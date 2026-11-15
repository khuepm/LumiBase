import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  FormVisibility,
  LayoutGroupNode,
  LayoutNode,
  LayoutTabNode,
} from '@lumibase/contracts/form-layout';
import { cn } from '@/lib/cn';

/**
 * Form layout renderer (#750): walks a collection's layout tree and renders
 * tabs, groups and dividers around the field cells FieldsTab already knows how
 * to draw. Visibility comes from `resolveFormVisibility` — the same condition
 * engine the CMS uses for required validation — so a field the server treats
 * as hidden is exactly the field the form hides.
 */

export interface LayoutRenderContext {
  visibility: FormVisibility;
  /** Draws one field cell; returns null when the field is not renderable (unknown / no read access). */
  renderField: (fieldKey: string) => ReactNode | null;
  /** Field key → error message, for inline errors and tab badges. */
  errors: Readonly<Record<string, string>>;
}

/** Group consecutive `tab` siblings into one strip; other nodes pass through. */
type Segment = { kind: 'tabs'; tabs: LayoutTabNode[] } | { kind: 'node'; node: Exclude<LayoutNode, LayoutTabNode> };

function segment(nodes: LayoutNode[]): Segment[] {
  const out: Segment[] = [];
  for (const node of nodes) {
    if (node.type === 'tab') {
      const last = out[out.length - 1];
      if (last?.kind === 'tabs') last.tabs.push(node);
      else out.push({ kind: 'tabs', tabs: [node] });
    } else {
      out.push({ kind: 'node', node });
    }
  }
  return out;
}

/** Visible field keys under a node that currently carry an error. */
export function errorFieldsUnder(node: LayoutNode, ctx: Pick<LayoutRenderContext, 'visibility' | 'errors'>): string[] {
  if (node.type === 'divider') return [];
  if (node.type === 'field') {
    const hidden = ctx.visibility.fields.get(node.field)?.hidden ?? false;
    return !hidden && ctx.errors[node.field] ? [node.field] : [];
  }
  if (ctx.visibility.hiddenNodes.has(node.id)) return [];
  return node.children.flatMap((child) => errorFieldsUnder(child, ctx));
}

export function LayoutNodes({ nodes, ctx }: { nodes: LayoutNode[]; ctx: LayoutRenderContext }) {
  return (
    <>
      {segment(nodes).map((seg, index) => {
        if (seg.kind === 'tabs') {
          const visible = seg.tabs.filter((t) => !ctx.visibility.hiddenNodes.has(t.id));
          if (visible.length === 0) return null;
          return (
            <div key={`tabs-${seg.tabs[0]?.id ?? index}`} className="col-span-1 sm:col-span-2">
              <LayoutTabs tabs={visible} ctx={ctx} />
            </div>
          );
        }
        const node = seg.node;
        if (node.type === 'field') {
          if (ctx.visibility.fields.get(node.field)?.hidden) return null;
          const cell = ctx.renderField(node.field);
          return cell ? <FragmentKey key={`f-${node.field}`}>{cell}</FragmentKey> : null;
        }
        if (ctx.visibility.hiddenNodes.has(node.id)) return null;
        if (node.type === 'divider') {
          return (
            <div
              key={`d-${node.id}`}
              role="separator"
              aria-label={node.label}
              className="col-span-1 flex items-center gap-2 py-1 text-muted-foreground sm:col-span-2"
            >
              {node.label && <span className="text-xs font-semibold uppercase">{node.label}</span>}
              <div className="h-px flex-1 bg-border" />
            </div>
          );
        }
        return (
          <div key={`g-${node.id}`} className="col-span-1 sm:col-span-2">
            <LayoutGroup node={node} ctx={ctx} />
          </div>
        );
      })}
    </>
  );
}

function FragmentKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function NodeGrid({ nodes, ctx }: { nodes: LayoutNode[]; ctx: LayoutRenderContext }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <LayoutNodes nodes={nodes} ctx={ctx} />
    </div>
  );
}

export function LayoutGroup({ node, ctx }: { node: LayoutGroupNode; ctx: LayoutRenderContext }) {
  const baseId = useId();
  const [open, setOpen] = useState(!(node.collapsible && node.collapsed));
  const title = node.label ?? '';
  const errorCount = errorFieldsUnder(node, ctx).length;

  if (node.collapsible) {
    const regionId = `${baseId}-region`;
    const buttonId = `${baseId}-button`;
    return (
      <div className="rounded-lg border" data-layout-group={node.id}>
        <button
          id={buttonId}
          type="button"
          aria-expanded={open}
          aria-controls={regionId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
        >
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          <span>{title || node.id}</span>
          {errorCount > 0 && <ErrorBadge count={errorCount} />}
        </button>
        <div id={regionId} role="region" aria-labelledby={buttonId} hidden={!open} className="border-t p-3">
          {open && <NodeGrid nodes={node.children} ctx={ctx} />}
        </div>
      </div>
    );
  }

  const labelId = `${baseId}-label`;
  return (
    <div
      role="group"
      aria-labelledby={title ? labelId : undefined}
      className="rounded-lg border p-3"
      data-layout-group={node.id}
    >
      {title && (
        <p id={labelId} className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          {title}
        </p>
      )}
      <NodeGrid nodes={node.children} ctx={ctx} />
    </div>
  );
}

function ErrorBadge({ count }: { count: number }) {
  return (
    <span
      className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground"
      aria-label={`${count} ${count === 1 ? 'error' : 'errors'}`}
      data-testid="tab-error-badge"
    >
      {count}
    </span>
  );
}

/**
 * WAI-ARIA tabs with automatic activation: one tab stop (roving tabindex),
 * Arrow Left/Right wrap, Home/End jump; each tab controls its panel.
 */
export function LayoutTabs({ tabs, ctx }: { tabs: LayoutTabNode[]; ctx: LayoutRenderContext }) {
  const baseId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map());
  // A selected tab that a condition just hid falls back to the first visible one.
  const active = tabs.find((t) => t.id === selected) ?? tabs[0]!;

  const select = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length]!;
    setSelected(tab.id);
    refs.current.get(tab.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((t) => t.id === active.id);
    switch (event.key) {
      case 'ArrowRight':
        select(current + 1);
        break;
      case 'ArrowLeft':
        select(current - 1);
        break;
      case 'Home':
        select(0);
        break;
      case 'End':
        select(tabs.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-orientation="horizontal" onKeyDown={onKeyDown} className="flex flex-wrap gap-0.5 border-b">
        {tabs.map((tab) => {
          const isActive = tab.id === active.id;
          const errorCount = errorFieldsUnder(tab, ctx).length;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              id={`${baseId}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setSelected(tab.id)}
              className={cn(
                '-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm',
                isActive ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground',
                errorCount > 0 && !isActive && 'text-destructive',
              )}
            >
              {tab.label}
              {errorCount > 0 && <ErrorBadge count={errorCount} />}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${baseId}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          tabIndex={0}
          hidden={tab.id !== active.id}
        >
          {tab.id === active.id && <NodeGrid nodes={tab.children} ctx={ctx} />}
        </div>
      ))}
    </div>
  );
}
