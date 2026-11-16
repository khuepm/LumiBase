import {
  acceptPreviewMessage,
  decodeFieldRef,
  encodeFieldRef,
  previewMessage,
  type FrontendToStudioMessage,
  type PreviewFieldRef,
  type RejectReason,
  type StudioToFrontendMessage,
} from './protocol';

/**
 * `@lumibase/visual-editing` — the frontend half of the LumiBase live preview
 * (epic #667, V03 #681).
 *
 * Mark editable elements with {@link fieldAttributes} (`data-lumibase-field`).
 * When the page runs inside the Studio preview pane, {@link enableVisualEditing}
 * draws a click-to-edit outline over them; a click focuses that field in the
 * Studio. Field-level patches from the Studio are coalesced per animation
 * frame and handed to `onPatch` (or written as text — never HTML — into
 * elements that opt in with `data-lumibase-live="text"`).
 *
 * Security: every inbound message must come from `window.parent`, from an
 * origin on the exact `studioOrigins` allowlist, fit the size budget, and match
 * the strict schema; anything else is dropped and reported to `onReject`.
 * Outbound messages are posted to an explicit origin, never `*`. Nothing is
 * evaluated. Outside an iframe, or when `enabled` is false, the call is a no-op.
 */

export * from './protocol';

export const FIELD_ATTRIBUTE = 'data-lumibase-field';
export const LIVE_ATTRIBUTE = 'data-lumibase-live';

/** Spread onto an element to make it click-to-edit: `<h1 {...fieldAttributes(ref)}>`. */
export function fieldAttributes(ref: PreviewFieldRef): Record<typeof FIELD_ATTRIBUTE, string> {
  return { [FIELD_ATTRIBUTE]: encodeFieldRef(ref) };
}

export interface PatchEvent {
  collection: string;
  itemId: string;
  /** Latest value per changed field since the last flush. */
  fields: Record<string, unknown>;
}

export interface VisualEditingOptions {
  /** Exact Studio origins allowed to drive this page, e.g. `https://studio.example.com`. */
  studioOrigins: readonly string[];
  /**
   * Whether preview mode is on. Pass your framework's draft-mode flag (e.g.
   * Next.js `draftMode().isEnabled`). Defaults to "framed AND the URL carries
   * `__preview`". When false the call returns an inert handle.
   */
  enabled?: boolean;
  /** Called (once per animation frame) with coalesced field patches. */
  onPatch?: (patch: PatchEvent) => void;
  /** Called when the Studio asks for a full reload (after save). Default: `location.reload()`. */
  onReload?: () => void;
  /** Called for every dropped message — log it. Default: `console.warn`. */
  onReject?: (reason: RejectReason, origin: string) => void;
  /** Max coalesced fields buffered before older patches are dropped and a reload is requested. */
  maxPendingFields?: number;
  /** Root to search for stencils. Default: `document`. */
  root?: ParentNode;
  /** Override the window (tests). */
  window?: Window;
}

export interface VisualEditingHandle {
  readonly active: boolean;
  /** The Studio origin that completed the handshake, if any. */
  readonly studioOrigin: string | null;
  /** Ask the Studio to focus a field (what an outline click does). */
  focus(ref: PreviewFieldRef): void;
  destroy(): void;
}

const INERT: VisualEditingHandle = {
  active: false,
  studioOrigin: null,
  focus: () => undefined,
  destroy: () => undefined,
};

function defaultEnabled(win: Window): boolean {
  try {
    if (win.self === win.top) return false;
  } catch {
    // Cross-origin top: we are framed.
  }
  try {
    return new URL(win.location.href).searchParams.has('__preview');
  } catch {
    return false;
  }
}

function closestStencil(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target : null;
  return el?.closest(`[${FIELD_ATTRIBUTE}]`) ?? null;
}

/**
 * Turn on the overlay + bridge. Returns a handle; call `destroy()` on unmount.
 */
export function enableVisualEditing(options: VisualEditingOptions): VisualEditingHandle {
  const win = options.window ?? (typeof window === 'undefined' ? undefined : window);
  if (!win) return INERT;
  const enabled = options.enabled ?? defaultEnabled(win);
  if (!enabled || win.parent === win) return INERT;
  const allowed = options.studioOrigins.filter((o) => o && o !== '*');
  if (allowed.length === 0) return INERT;

  const doc = win.document;
  const root = options.root ?? doc;
  const maxPending = options.maxPendingFields ?? 200;
  const onReject =
    options.onReject ??
    ((reason: RejectReason, origin: string) => console.warn(`[lumibase/visual-editing] dropped message (${reason}) from ${origin}`));
  let studioOrigin: string | null = null;
  let destroyed = false;

  const post = (message: FrontendToStudioMessage) => {
    // Before the handshake we do not know which allowed origin hosts us, so
    // address each explicitly; the browser delivers only to the real one.
    const targets = studioOrigin ? [studioOrigin] : allowed;
    for (const origin of targets) win.parent.postMessage(message, origin);
  };

  // ── outline ──────────────────────────────────────────────────────────────
  const outline = doc.createElement('div');
  outline.setAttribute('aria-hidden', 'true');
  outline.dataset.lumibaseOverlay = '';
  Object.assign(outline.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    border: '2px solid #2563eb',
    borderRadius: '4px',
    display: 'none',
    boxSizing: 'border-box',
  } satisfies Partial<CSSStyleDeclaration>);
  doc.body.appendChild(outline);

  const showOutline = (el: Element | null) => {
    if (!el) {
      outline.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    Object.assign(outline.style, {
      display: 'block',
      top: `${rect.top - 2}px`,
      left: `${rect.left - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
  };

  const onMouseOver = (event: Event) => showOutline(closestStencil(event.target));
  const onClick = (event: Event) => {
    const el = closestStencil(event.target);
    const ref = decodeFieldRef(el?.getAttribute(FIELD_ATTRIBUTE));
    if (!ref) return;
    event.preventDefault();
    event.stopPropagation();
    post(previewMessage({ type: 'focus' as const, target: ref }));
  };

  // ── patches: coalesce per frame, bounded ─────────────────────────────────
  const pending = new Map<string, { collection: string; itemId: string; fields: Map<string, unknown> }>();
  let pendingCount = 0;
  let scheduled = false;
  const raf: (cb: () => void) => void =
    typeof win.requestAnimationFrame === 'function' ? (cb) => win.requestAnimationFrame(cb) : (cb) => win.setTimeout(cb, 16);

  const applyText = (collection: string, itemId: string, fields: Record<string, unknown>) => {
    for (const [field, value] of Object.entries(fields)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const selector = `[${FIELD_ATTRIBUTE}="${encodeFieldRef({ collection, itemId, field })}"][${LIVE_ATTRIBUTE}="text"]`;
      root.querySelectorAll(selector).forEach((el) => {
        // textContent only: a patch is data, never markup.
        el.textContent = String(value);
      });
    }
  };

  const flush = () => {
    scheduled = false;
    if (destroyed) return;
    const batches = [...pending.values()];
    pending.clear();
    pendingCount = 0;
    for (const batch of batches) {
      const fields = Object.fromEntries(batch.fields);
      applyText(batch.collection, batch.itemId, fields);
      options.onPatch?.({ collection: batch.collection, itemId: batch.itemId, fields });
    }
  };

  const enqueue = (message: Extract<StudioToFrontendMessage, { type: 'patch' }>) => {
    const key = `${message.collection}/${message.itemId}`;
    let batch = pending.get(key);
    if (!batch) {
      batch = { collection: message.collection, itemId: message.itemId, fields: new Map() };
      pending.set(key, batch);
    }
    for (const [field, value] of Object.entries(message.fields)) {
      if (!batch.fields.has(field)) pendingCount += 1;
      batch.fields.set(field, value);
    }
    if (pendingCount > maxPending) {
      // Backpressure: the consumer is not keeping up. Drop the backlog and
      // fall back to one reload instead of growing without bound.
      pending.clear();
      pendingCount = 0;
      (options.onReload ?? (() => win.location.reload()))();
      return;
    }
    if (!scheduled) {
      scheduled = true;
      raf(flush);
    }
  };

  const onMessage = (event: MessageEvent) => {
    const result = acceptPreviewMessage('to-frontend', event, { allowedOrigins: allowed, expectedSource: win.parent });
    if (!result.ok) {
      // Unrelated same-window traffic (devtools, extensions) is not "from the
      // Studio": only report what claimed to be ours or came from the parent.
      if (result.reason !== 'source' || event.source === win.parent) onReject(result.reason, event.origin);
      return;
    }
    if (studioOrigin && event.origin !== studioOrigin) {
      onReject('origin', event.origin);
      return;
    }
    const message = result.message;
    switch (message.type) {
      case 'hello':
        studioOrigin = event.origin;
        post(previewMessage({ type: 'ready' as const, path: `${win.location.pathname}${win.location.search}`.slice(0, 2048) }));
        break;
      case 'patch':
        enqueue(message);
        break;
      case 'highlight': {
        const el = message.target
          ? root.querySelector(`[${FIELD_ATTRIBUTE}="${encodeFieldRef(message.target)}"]`)
          : null;
        showOutline(el);
        break;
      }
      case 'reload':
        (options.onReload ?? (() => win.location.reload()))();
        break;
    }
  };

  doc.addEventListener('mouseover', onMouseOver, true);
  doc.addEventListener('click', onClick, true);
  win.addEventListener('message', onMessage);
  // Announce ourselves; the Studio answers with `hello` from its origin.
  post(previewMessage({ type: 'ready' as const, path: `${win.location.pathname}${win.location.search}`.slice(0, 2048) }));

  return {
    active: true,
    get studioOrigin() {
      return studioOrigin;
    },
    focus(ref: PreviewFieldRef) {
      if (!destroyed) post(previewMessage({ type: 'focus' as const, target: ref }));
    },
    destroy() {
      destroyed = true;
      doc.removeEventListener('mouseover', onMouseOver, true);
      doc.removeEventListener('click', onClick, true);
      win.removeEventListener('message', onMessage);
      outline.remove();
      pending.clear();
    },
  };
}
