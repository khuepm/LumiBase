import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ChevronLeft, Copy, Eye, GripVertical, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PageSection } from '@lumibase/contracts';
import type { FieldResource } from '@lumibase/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { resolveInterface } from '@/modules/content/interfaces/registry';
import { PreviewSplit } from '@/modules/content/preview-pane';
import { useSiteLocales } from '@/modules/content/use-site-locales';
import {
  addRegion,
  addSection,
  duplicateSection,
  issuesBySection,
  moveToRegion,
  regionOf,
  removeRegion,
  removeSection,
  reorderWithinRegion,
  sectionsIn,
  setLocales,
  stepSection,
  toComposerLayout,
  updateSection,
  type ComposerLayout,
  type ServerIssue,
} from './composer-state';
import { PagePreview } from './page-preview';

/**
 * Visual page composer (epic #667, V06 #684).
 *
 * Composes `lumibase_pages.layoutConfig` (v1) from registered page blocks
 * (`GET /pages/blocks`): regions hold ordered sections (drag to reorder, or
 * the keyboard via the handle / the arrow buttons), each section's fields
 * are edited with the same interfaces as item forms (nested `blocks` fields
 * included), per-section locale visibility, an optional published-only data
 * source, and a preview of the real page beside the editor. The server
 * validates on save and its per-field errors are shown on the right card.
 */

interface PageRow {
  id: string;
  slug: string;
  title: string;
  layoutConfig: unknown;
  updatedAt: string;
}

interface PageBlock {
  name: string;
  label: string | null;
  note: string | null;
}

const humanize = (name: string) => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function errorIssues(err: unknown): ServerIssue[] {
  const body = (err as { body?: { errors?: ServerIssue[] } })?.body;
  if (Array.isArray(body?.errors) && body.errors.length > 0) return body.errors;
  return [{ code: 'ERROR', message: (err as { message?: string })?.message ?? 'Save failed.' }];
}

export function PageComposerPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  return <PageComposer key={id} id={id} />;
}

export function PageComposer({ id }: { id: string }) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const locales = useSiteLocales();

  const page = useQuery({
    queryKey: ['page', id],
    queryFn: async () => (await client.rawRequest<PageRow>(`/api/v1/pages/${encodeURIComponent(id)}`)).data,
  });
  const blocks = useQuery({
    queryKey: ['page-blocks'],
    queryFn: async () => (await client.rawRequest<PageBlock[]>('/api/v1/pages/blocks')).data,
  });

  const [layout, setLayout] = useState<ComposerLayout | null>(null);
  const [converted, setConverted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [targetRegion, setTargetRegion] = useState('main');
  const [newRegion, setNewRegion] = useState('');
  const [regionError, setRegionError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ServerIssue[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!page.data || layout) return;
    const next = toComposerLayout(page.data.layoutConfig);
    setLayout(next.layout);
    setConverted(next.converted);
  }, [page.data, layout]);

  const change = (next: ComposerLayout) => {
    setLayout(next);
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async (next: ComposerLayout) =>
      (
        await client.rawRequest<PageRow>(`/api/v1/pages/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ layoutConfig: next }),
        })
      ).data,
    onSuccess: (row) => {
      setIssues([]);
      setDirty(false);
      setConverted(false);
      queryClient.setQueryData(['page', id], row);
      setAnnouncement('Page saved.');
    },
    onError: (err) => setIssues(errorIssues(err)),
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const mapped = useMemo(() => (layout ? issuesBySection(layout, issues) : null), [layout, issues]);

  if (page.isLoading || !layout) {
    return <p className="text-sm text-muted-foreground">{page.error ? 'Failed to load the page.' : 'Loading page…'}</p>;
  }
  if (!page.data) return <p className="text-sm text-destructive">Page not found.</p>;

  const regions = layout.regions ?? [{ key: 'main' }];
  const blockLabel = (name: string) => {
    const b = blocks.data?.find((x) => x.name === name);
    return b?.label ?? humanize(name || 'unknown');
  };
  const selectedSection = layout.sections.find((s) => s.id === selected) ?? null;

  const onDragEnd = (event: DragEndEvent) => {
    const over = event.over?.id;
    if (!over || over === event.active.id) return;
    change(reorderWithinRegion(layout, String(event.active.id), String(over)));
    setAnnouncement('Section moved.');
  };

  const composer = (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[14rem_1fr_22rem]">
      <aside className="space-y-2 rounded-lg border bg-muted/20 p-3" aria-label="Blocks">
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Blocks</h2>
        <label className="block text-xs text-muted-foreground">
          Add to region
          <select
            value={targetRegion}
            onChange={(e) => setTargetRegion(e.target.value)}
            className="mt-1 w-full rounded-md border bg-background px-1.5 py-1 text-xs"
          >
            {regions.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label ?? r.key}
              </option>
            ))}
          </select>
        </label>
        {blocks.isLoading && <p className="text-xs text-muted-foreground">Loading blocks…</p>}
        {blocks.data?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No page blocks yet. Mark a collection as a page block in Data model → Display.
          </p>
        )}
        <ul className="space-y-1">
          {blocks.data?.map((b) => (
            <li key={b.name}>
              <button
                type="button"
                onClick={() => {
                  const added = addSection(layout, b.name, targetRegion);
                  change(added.layout);
                  setSelected(added.id);
                  setAnnouncement(`Added ${b.label ?? humanize(b.name)} to ${targetRegion}.`);
                }}
                title={b.note ?? undefined}
                className="flex w-full items-center gap-1 rounded-md border bg-background px-2 py-1.5 text-start text-xs hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" /> {b.label ?? humanize(b.name)}
              </button>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t pt-2">
          <label className="block text-xs text-muted-foreground" htmlFor="new-region">
            New region
          </label>
          <div className="flex gap-1">
            <input
              id="new-region"
              value={newRegion}
              onChange={(e) => setNewRegion(e.target.value)}
              placeholder="sidebar"
              className="min-w-0 flex-1 rounded-md border bg-background px-1.5 py-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={() => {
                const next = addRegion(layout, newRegion.trim());
                if (typeof next === 'string') {
                  setRegionError(
                    next === 'invalid'
                      ? 'Use lowercase letters, digits, - or _ (start with a letter).'
                      : next === 'duplicate'
                        ? 'That region already exists.'
                        : 'Too many regions.',
                  );
                  return;
                }
                setRegionError(null);
                setNewRegion('');
                change(next);
              }}
              className="rounded-md border px-2 text-xs hover:bg-muted"
            >
              Add
            </button>
          </div>
          {regionError && (
            <p role="alert" className="text-xs text-destructive">
              {regionError}
            </p>
          )}
        </div>
      </aside>

      <section className="space-y-4" aria-label="Page layout">
        {regions.map((region) => {
          const list = sectionsIn(layout, region.key);
          return (
            <div key={region.key} className="rounded-lg border bg-background p-3" data-region={region.key}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium">
                  {region.label ?? region.key}
                  <span className="ms-2 font-mono text-xs text-muted-foreground">{region.key}</span>
                </h3>
                {region.key !== 'main' && list.length === 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = removeRegion(layout, region.key);
                      if (next) change(next);
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    Remove region
                  </button>
                )}
              </div>
              {list.length === 0 && <p className="text-xs text-muted-foreground">Empty. Add a block from the list.</p>}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={list.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-2">
                    {list.map((section, index) => (
                      <SectionCard
                        key={section.id}
                        section={section}
                        label={blockLabel(section.component)}
                        selected={selected === section.id}
                        issueCount={mapped?.bySection.get(section.id)?.length ?? 0}
                        regions={regions.map((r) => r.key)}
                        isFirst={index === 0}
                        isLast={index === list.length - 1}
                        onSelect={() => setSelected(section.id)}
                        onStep={(delta) => change(stepSection(layout, section.id, delta))}
                        onMove={(target) => change(moveToRegion(layout, section.id, target))}
                        onDuplicate={() => {
                          const copy = duplicateSection(layout, section.id);
                          change(copy.layout);
                          setSelected(copy.id);
                        }}
                        onRemove={() => {
                          change(removeSection(layout, section.id));
                          if (selected === section.id) setSelected(null);
                        }}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            </div>
          );
        })}
      </section>

      <aside className="rounded-lg border bg-muted/20 p-3" aria-label="Section settings">
        {selectedSection ? (
          <SectionInspector
            key={selectedSection.id}
            section={selectedSection}
            label={blockLabel(selectedSection.component)}
            locales={locales}
            issues={mapped?.bySection.get(selectedSection.id) ?? []}
            onChange={(patch) => change(updateSection(layout, selectedSection.id, patch))}
            onLocales={(next) => change(setLocales(layout, selectedSection.id, next))}
          />
        ) : (
          <p className="text-xs text-muted-foreground">Select a section to edit its fields.</p>
        )}
      </aside>
    </div>
  );

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase text-muted-foreground">
            <Link to="/pages" className="hover:underline">
              Pages
            </Link>
            <span className="mx-1">/</span>
            <span className="font-mono">{page.data.slug}</span>
          </p>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Link to="/pages" aria-label="Back to pages" className="text-muted-foreground hover:text-foreground">
              <ChevronLeft className="h-5 w-5" />
            </Link>
            {page.data.title}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen((v) => !v)}
            aria-pressed={previewOpen}
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
          >
            <Eye className="h-3.5 w-3.5" /> Preview
          </button>
          <button
            type="button"
            onClick={() => save.mutate(layout)}
            disabled={(!dirty && !converted) || save.isPending}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {save.isPending ? 'Saving…' : dirty || converted ? 'Save' : 'Saved'}
          </button>
        </div>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {converted && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          This page was built without the composer. Its sections are loaded as-is; saving stores them as a composer layout,
          which the server validates against your registered blocks.
        </p>
      )}
      {mapped && (mapped.general.length > 0 || mapped.bySection.size > 0) && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <p className="font-medium">The page was not saved.</p>
          <ul className="mt-1 list-disc ps-4">
            {mapped.general.map((i, n) => (
              <li key={`g${n}`}>{i.message}</li>
            ))}
            {[...mapped.bySection.entries()].map(([sectionId, list]) => {
              const section = layout.sections.find((s) => s.id === sectionId);
              return (
                <li key={sectionId}>
                  {blockLabel(section?.component ?? '')}: {list.map((i) => (i.field ? `${i.field} — ${i.message}` : i.message)).join('; ')}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {previewOpen ? (
        <PreviewSplit
          editor={composer}
          preview={
            <PagePreview slug={page.data.slug} savedMarker={String(page.data.updatedAt)} onClose={() => setPreviewOpen(false)} />
          }
        />
      ) : (
        composer
      )}
    </div>
  );
}

function SectionCard(props: {
  section: PageSection;
  label: string;
  selected: boolean;
  issueCount: number;
  regions: string[];
  isFirst: boolean;
  isLast: boolean;
  onSelect: () => void;
  onStep: (delta: -1 | 1) => void;
  onMove: (region: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { section, label } = props;
  const sortable = useSortable({ id: section.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const locales = Array.isArray(section.styleConfig.locales) ? section.styleConfig.locales : null;
  return (
    <li
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        'flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm',
        props.selected && 'border-primary ring-1 ring-primary',
        props.issueCount > 0 && 'border-destructive',
      )}
      data-section={section.id}
    >
      <button
        type="button"
        aria-label={`Drag ${label}`}
        className="cursor-grab text-muted-foreground"
        {...sortable.attributes}
        {...sortable.listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <button type="button" onClick={props.onSelect} className="min-w-0 flex-1 truncate text-start" aria-pressed={props.selected}>
        {label}
        {section.source && <span className="ms-2 text-xs text-muted-foreground">← {section.source.collection}</span>}
        {locales && <span className="ms-2 text-xs text-muted-foreground">({locales.join(', ')})</span>}
        {props.issueCount > 0 && <span className="ms-2 text-xs text-destructive">{props.issueCount} problem(s)</span>}
      </button>
      <button type="button" aria-label={`Move ${label} up`} disabled={props.isFirst} onClick={() => props.onStep(-1)} className="rounded p-0.5 hover:bg-muted disabled:opacity-30">
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label={`Move ${label} down`} disabled={props.isLast} onClick={() => props.onStep(1)} className="rounded p-0.5 hover:bg-muted disabled:opacity-30">
        <ArrowDown className="h-3.5 w-3.5" />
      </button>
      {props.regions.length > 1 && (
        <select
          aria-label={`Region of ${label}`}
          value={regionOf(section)}
          onChange={(e) => props.onMove(e.target.value)}
          className="rounded border bg-background px-1 py-0.5 text-xs"
        >
          {props.regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      )}
      <button type="button" aria-label={`Duplicate ${label}`} onClick={props.onDuplicate} className="rounded p-0.5 hover:bg-muted">
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label={`Remove ${label}`} onClick={props.onRemove} className="rounded p-0.5 text-destructive hover:bg-destructive/10">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function SectionInspector(props: {
  section: PageSection;
  label: string;
  locales: string[];
  issues: ServerIssue[];
  onChange: (patch: Partial<PageSection>) => void;
  onLocales: (locales: string[] | null) => void;
}) {
  const { section } = props;
  const client = getApiClient();
  const fields = useQuery({
    queryKey: ['fields', section.component],
    queryFn: async () => (await client.schema.listFields(section.component)).data as FieldResource[],
    enabled: section.component.length > 0,
  });
  const collections = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data as Array<{ name: string }>,
  });
  const editable = (fields.data ?? [])
    .filter((f) => !f.hidden && !f.system && f.type !== 'alias' && !f.encrypted)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const issueFor = (name: string) => props.issues.find((i) => i.field === `data.${name}` || i.field?.startsWith(`data.${name}.`));
  const visible = Array.isArray(section.styleConfig.locales) ? section.styleConfig.locales : [];

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{props.label}</h2>
      {fields.isLoading && <p className="text-xs text-muted-foreground">Loading fields…</p>}
      {editable.map((f) => {
        const Interface = resolveInterface(f);
        const issue = issueFor(f.name);
        return (
          <div key={f.id} data-field={f.name} aria-invalid={issue ? true : undefined}>
            <label className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              {f.label ?? f.name}
              {f.required && <span className="text-destructive">*</span>}
            </label>
            <Interface
              value={section.data[f.name]}
              field={f}
              onChange={(next) => props.onChange({ data: { ...section.data, [f.name]: next } })}
            />
            {issue && <p className="mt-1 text-xs text-destructive">{issue.message}</p>}
          </div>
        );
      })}

      {props.locales.length > 1 && (
        <fieldset className="space-y-1 border-t pt-2">
          <legend className="text-xs font-medium text-muted-foreground">Visible in</legend>
          <p className="text-xs text-muted-foreground">None checked: every locale.</p>
          {props.locales.map((locale) => (
            <label key={locale} className="me-3 inline-flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={visible.includes(locale)}
                onChange={(e) =>
                  props.onLocales(e.target.checked ? [...visible, locale] : visible.filter((l) => l !== locale))
                }
              />
              {locale}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="space-y-1 border-t pt-2">
        <legend className="text-xs font-medium text-muted-foreground">Data source</legend>
        <p className="text-xs text-muted-foreground">Optional. Delivery adds the latest published items as data.items.</p>
        <select
          aria-label="Source collection"
          value={section.source?.collection ?? ''}
          onChange={(e) =>
            props.onChange({
              source: e.target.value ? { ...(section.source ?? {}), collection: e.target.value } : undefined,
            })
          }
          className="w-full rounded-md border bg-background px-1.5 py-1 text-xs"
        >
          <option value="">None</option>
          {collections.data
            ?.filter((c) => !c.name.startsWith('lumibase_'))
            .map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
        </select>
        {section.source && (
          <label className="block text-xs text-muted-foreground">
            Items
            <input
              type="number"
              min={1}
              max={50}
              value={section.source.limit ?? 10}
              onChange={(e) =>
                props.onChange({
                  source: { ...section.source!, limit: Math.min(50, Math.max(1, Number(e.target.value) || 1)) },
                })
              }
              className="ms-2 w-20 rounded-md border bg-background px-1.5 py-1 text-xs"
            />
          </label>
        )}
      </fieldset>
    </div>
  );
}
