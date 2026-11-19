/**
 * Extension authoring SDK. See `docs/features/extensions-system.md` for the
 * capability model. The runtime loader lives in `apps/cms/src/extensions/`.
 */
export type ExtensionType =
  | 'hook'
  | 'endpoint'
  | 'operation'
  | 'interface'
  | 'display'
  | 'layout'
  | 'panel'
  | 'module';

export interface ExtensionManifest {
  name: string;
  version: string;
  type: ExtensionType;
  entry: string;
  /** Declared capabilities (e.g. `items:read:posts`, `http:fetch:api.example.com`). */
  capabilities: string[];
  config?: Array<{ key: string; type: 'string' | 'integer' | 'boolean' | 'json'; default?: unknown }>;
  /** MCP tools, prompts and resources the extension adds (#715); see {@link mcpManifest}. */
  mcp?: ReturnType<typeof mcpManifest>;
  /** Auto-install during setup/reconcile (verified official `lumibase-*` only). */
  autoInstall?: boolean;
  /** Whether an auto-installed extension starts enabled. */
  enabledByDefault?: boolean;
}

export interface HookContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
  /** Sandboxed fetch; only hosts declared in `capabilities` resolve. */
  readonly fetch: typeof fetch;
  readonly errors: { ValidationError: new (msg: string) => Error };
}

export interface HookDefinition<TPayload = unknown> {
  on: string;
  handler: (input: {
    payload: TPayload;
    item?: Record<string, unknown>;
    ctx: HookContext;
  }) => Promise<void> | void;
}

export function defineHook<TPayload = unknown>(def: HookDefinition<TPayload>): HookDefinition<TPayload> {
  return def;
}

export type InterfaceGroup =
  | 'standard'
  | 'selection'
  | 'relational'
  | 'presentation'
  | 'group'
  | 'other';

export type InterfaceOptionType = 'string' | 'text' | 'integer' | 'decimal' | 'boolean' | 'json';

export interface InterfaceOption {
  field: string;
  name: string;
  type?: InterfaceOptionType;
  required?: boolean;
  schema?: Record<string, unknown>;
  meta?: {
    width?: 'half' | 'full' | 'fill';
    interface?: string;
    note?: string;
    options?: Record<string, unknown>;
  };
}

export interface InterfaceProps<TValue = unknown, TOptions = Record<string, unknown>> {
  value: TValue | null | undefined;
  field: unknown;
  disabled?: boolean;
  options?: TOptions;
  onChange: (next: TValue | null) => void;
}

export type InterfaceComponent<TValue = unknown, TOptions = Record<string, unknown>> = (
  props: InterfaceProps<TValue, TOptions>,
) => unknown;

export interface InterfaceDefinition<TValue = unknown, TOptions = Record<string, unknown>> {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  component: InterfaceComponent<TValue, TOptions>;
  types: string[];
  group?: InterfaceGroup;
  relational?: boolean;
  localTypes?: string[];
  options?: InterfaceOption[];
  recommendedDisplays?: string[];
}

export function defineInterface<TValue = unknown, TOptions = Record<string, unknown>>(
  def: InterfaceDefinition<TValue, TOptions>,
): InterfaceDefinition<TValue, TOptions> {
  return def;
}

/* ── Change Feed subscriber (spec cdc-extension-integration, Req 5.1) ────── */

/** One delivered change event; `id` is the idempotency key (at-least-once). */
export interface CdcEvent<TData = Record<string, unknown>> {
  id: string;
  /** `items.<operation>` */
  type: string;
  schemaVersion: number;
  siteId: string;
  collection: string;
  itemId: string;
  operation: 'create' | 'update' | 'delete';
  /** ISO timestamp (Postgres clock). */
  occurredAt: string;
  actor: { type: 'user' | 'api_key' | 'agent' | 'system'; id?: string };
  source: 'api' | 'agent' | 'flow' | 'system';
  changedFields?: string[];
  /** Present only when the subscription uses `payloadMode: 'snapshot'`; pii/phi masked. */
  data?: TData;
  /** Opaque keyset token for this event — resume/ack marker. */
  cursor: string;
}

export interface CdcSubscriberContext {
  readonly siteId: string;
  readonly config: Record<string, unknown>;
  readonly logger: { info(msg: string, meta?: unknown): void; warn(msg: string, meta?: unknown): void };
}

/**
 * Declares an async change-feed consumer. The host delivers batches
 * at-least-once AFTER the mutation commits (unlike sync `hooks`, this can
 * never block or abort a mutation) and only for collections covered by the
 * manifest's `cdc:subscribe:<collection>` capabilities — the host enforces
 * that filter, not the extension. Handlers MUST be idempotent on `event.id`.
 */
export interface CdcSubscriberDefinition<TData = Record<string, unknown>> {
  collections: string[];
  operations?: Array<'create' | 'update' | 'delete'>;
  payloadMode?: 'reference' | 'snapshot';
  handler: (input: { events: CdcEvent<TData>[]; ctx: CdcSubscriberContext }) => Promise<void>;
}

export function defineCdcSubscriber<TData = Record<string, unknown>>(
  def: CdcSubscriberDefinition<TData>,
): CdcSubscriberDefinition<TData> {
  return def;
}

/* ── MCP tools, prompts and resources (#715) ─────────────────────────────── */

/**
 * How bad a wrong call is. The host turns this into governance:
 *
 * | riskClass   | runs without a human when…                         |
 * |-------------|----------------------------------------------------|
 * | `read_only` | the caller holds `capability` (no autonomy check)  |
 * | `low`       | the agent's autonomy grant is L2 or higher          |
 * | `medium`    | the agent's autonomy grant is L4                    |
 * | `high`      | never — a signed-in human approves every call      |
 *
 * A tool whose `capability` is `schema:write`, or whose name starts with
 * `delete`, is always treated as `high`, whatever it declares.
 */
export type ExtensionToolRiskClass = 'read_only' | 'low' | 'medium' | 'high';

/** Context the host hands a tool handler. */
export interface ExtensionToolContext {
  readonly siteId: string;
  /** The governed run this call belongs to. */
  readonly runId: string | null;
}

export interface ExtensionToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** `[a-z][a-zA-Z0-9_]{2,40}`. Advertised as `ext_<extension key>__<name>`. */
  name: string;
  description: string;
  /** The one capability a caller must hold, e.g. `items:write`. */
  capability: string;
  riskClass: ExtensionToolRiskClass;
  /** Whether the effect can be undone. Default true. `false` forces human approval. */
  reversible?: boolean;
  /** JSON Schema of `type: "object"`; arguments are validated before the handler runs. */
  inputSchema: Record<string, unknown> & { type: 'object' };
  /**
   * Runs only after the harness allowed the call (capability, autonomy,
   * approval). Use the sandbox context your module factory received for data
   * access; it is capability-checked against what the admin granted.
   */
  handler: (args: TArgs, ctx: ExtensionToolContext) => Promise<unknown>;
}

export function defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
  def: ExtensionToolDefinition<TArgs>,
): ExtensionToolDefinition<TArgs> {
  return def;
}

/** A static prompt shipped in the manifest (`mcp.prompts`). */
export interface ExtensionPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  /** Capability a caller must hold to see it. Default `items:read`. */
  capability?: string;
  text: string;
}

export function definePrompt(def: ExtensionPromptDefinition): ExtensionPromptDefinition {
  return def;
}

/** A static resource shipped in the manifest (`mcp.resources`). */
export interface ExtensionResourceDefinition {
  name: string;
  title?: string;
  description?: string;
  mimeType?: 'text/plain' | 'text/markdown' | 'application/json';
  /** Capability a caller must hold to see and read it. Default `items:read`. */
  capability?: string;
  text: string;
}

export function defineResource(def: ExtensionResourceDefinition): ExtensionResourceDefinition {
  return def;
}

export interface ExtensionMcpDefinition {
  tools?: ExtensionToolDefinition[];
  prompts?: ExtensionPromptDefinition[];
  resources?: ExtensionResourceDefinition[];
}

/**
 * The `mcp` export of a bundle. The host reads only `tools[].handler` from the
 * bundle; everything that is listed comes from the manifest, so generate the
 * manifest block from the same definitions with {@link mcpManifest}.
 */
export function defineMcp(def: ExtensionMcpDefinition): ExtensionMcpDefinition {
  return def;
}

/**
 * The manifest `mcp` block for a definition — tool handlers stripped. Write it
 * into `lumibase-extension.json` at build time so the declaration an admin
 * reviews is exactly the one the bundle implements.
 */
export function mcpManifest(def: ExtensionMcpDefinition): {
  tools: Array<Omit<ExtensionToolDefinition, 'handler'>>;
  prompts: ExtensionPromptDefinition[];
  resources: ExtensionResourceDefinition[];
} {
  return {
    tools: (def.tools ?? []).map(({ handler: _handler, ...declaration }) => declaration),
    prompts: [...(def.prompts ?? [])],
    resources: [...(def.resources ?? [])],
  };
}

/* ── Studio host services (media picker, #708) ─────────────────────────────── */

/** An asset returned by the media picker — the `lumibase_files` row shape. */
export interface PickedAsset {
  id: string;
  filenameDisk: string;
  filenameDownload: string;
  mime: string;
  filesize: number;
  width: number | null;
  height: number | null;
  folder: string | null;
  version?: number;
  metadata: Record<string, unknown>;
}

export interface MediaPickerOptions {
  /**
   * Assets shown as already selected when the picker opens. Accepts file ids
   * or storage keys (`filenameDisk`), since the built-in `file` interface
   * stores the key.
   */
  initiallySelected?: string[];
  /** Allow choosing more than one asset (default false). */
  multiple?: boolean;
  /** Exact MIME types or `type/*` prefixes, e.g. `['image/*', 'application/pdf']`. */
  allowedMimeTypes?: string[];
  /** Start in (and limit to) this folder; `null` = library root. */
  folder?: string | null;
  /** With `folder`, also show files in its sub-folders (default true). */
  includeSubfolders?: boolean;
  /** Upper bound on the selection when `multiple` (default unlimited). */
  max?: number;
  /** Dialog title override. */
  title?: string;
}

/**
 * Services the Studio exposes to UI extensions (interfaces, panels, modules).
 * The same picker the built-in file fields use — one picker everywhere.
 */
export interface StudioHost {
  /** Resolves to the chosen assets, or `null` when the editor cancels. */
  openMediaPicker(options?: MediaPickerOptions): Promise<PickedAsset[] | null>;
}

const STUDIO_HOST_KEY = '__lumibaseStudioHost__';

/**
 * The running Studio's host services, or `null` outside the Studio (tests,
 * SSR, a server-side extension). Read it at call time, not module load: the
 * Studio registers it when its shell mounts.
 */
export function getStudioHost(): StudioHost | null {
  const host = (globalThis as Record<string, unknown>)[STUDIO_HOST_KEY];
  return host && typeof (host as StudioHost).openMediaPicker === 'function' ? (host as StudioHost) : null;
}

/** Studio-internal: install (or clear with `null`) the host services. */
export function registerStudioHost(host: StudioHost | null): void {
  const g = globalThis as Record<string, unknown>;
  if (host) g[STUDIO_HOST_KEY] = host;
  else delete g[STUDIO_HOST_KEY];
}

/* ── Studio intents (issue #759) ─────────────────────────────────────────── */

/**
 * A parsed Studio intent link (`/intent/{action}?collection&id&locale&field&site`).
 * Structurally identical to `StudioIntent` in `@lumibase/contracts/intents`
 * (the SDK stays dependency-free); build links with `buildStudioIntentPath`
 * from that package.
 */
export interface StudioIntent {
  v: 1;
  action: 'open' | 'create' | 'edit';
  collection: string;
  id?: string;
  locale?: string;
  field?: string;
  site?: string;
}

export interface IntentHandleContext {
  /** Site the intent is being resolved in (already switched if the link asked). */
  readonly siteId: string;
  /** Admin-relative route of the built-in handler, for "wrap and forward" handlers. */
  readonly builtInPath: string;
}

/**
 * What a handler does with a claimed intent. `navigate` must be an
 * admin-relative Studio path (`/content/...`, `/settings/...`); absolute URLs,
 * protocol-relative paths and anything outside Studio are refused and the
 * built-in handler runs instead. `fallback` hands the intent back.
 */
export type IntentHandleResult = { navigate: string } | { fallback: true };

/**
 * An intent claim. The host only offers an intent to a handler when the
 * extension's GRANTED capabilities cover it — `intents:claim:<action>:<collection>`,
 * where either part may be `*` (e.g. `intents:claim:edit:posts`).
 *
 * Resolution is deterministic: among covered handlers whose `canHandle`
 * returns a finite number > 0, the highest priority wins; ties break on
 * extension name, then handler `id` (both ascending). The built-in handler has
 * priority 0, so returning 0 / false / null declines. A `canHandle` or
 * `handle` that throws, or a refused `navigate`, falls back to the built-in.
 */
export interface IntentHandlerDefinition {
  /** Stable id, unique within the extension. */
  id: string;
  canHandle: (intent: StudioIntent) => number | false | null | undefined;
  handle: (intent: StudioIntent, ctx: IntentHandleContext) => IntentHandleResult | Promise<IntentHandleResult>;
}

export function defineIntentHandler(def: IntentHandlerDefinition): IntentHandlerDefinition {
  return def;
}

/* ── Rich-text plugins (epic #669, #698) ─────────────────────────────────── */

/**
 * A custom block an extension adds to the rich-text editor. Structurally the
 * same as `RichTextBlockDefinition` in `@lumibase/contracts/richtext` (the
 * SDK stays dependency-free), so a plugin object can be passed to the
 * server-side serialisers unchanged.
 *
 * `toHtml` output is untrusted: the renderer passes it through the allowlist
 * sanitiser, so scripts, styles and event handlers are dropped.
 */
export interface RichTextBlockDefinition {
  label?: string;
  description?: string;
  icon?: string;
  defaultData?: Record<string, unknown>;
  toHtml?: (data: Record<string, unknown>, ctx: { escape: (text: string) => string; resolveRef: (ref: { kind: 'item' | 'file'; collection?: string; id: string }) => string | null }) => string;
  toMarkdown?: (data: Record<string, unknown>) => string;
  toText?: (data: Record<string, unknown>) => string;
}

export interface RichTextPluginDefinition {
  /** Unique id, e.g. the extension name. A second registration with the same name replaces the first. */
  name: string;
  /** Custom blocks keyed by block name (`[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`). */
  blocks?: Record<string, RichTextBlockDefinition>;
  /** Markdown import hook: rewrite parsed blocks (remark-style). */
  transformMarkdownImport?: (blocks: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
}

export function defineRichTextPlugin(def: RichTextPluginDefinition): RichTextPluginDefinition {
  return def;
}

const RICHTEXT_PLUGINS_KEY = '__lumibaseRichTextPlugins__';
const RICHTEXT_LISTENERS_KEY = '__lumibaseRichTextPluginListeners__';

function pluginStore(): Map<string, RichTextPluginDefinition> {
  const g = globalThis as Record<string, unknown>;
  if (!(g[RICHTEXT_PLUGINS_KEY] instanceof Map)) g[RICHTEXT_PLUGINS_KEY] = new Map<string, RichTextPluginDefinition>();
  return g[RICHTEXT_PLUGINS_KEY] as Map<string, RichTextPluginDefinition>;
}

function pluginListeners(): Set<() => void> {
  const g = globalThis as Record<string, unknown>;
  if (!(g[RICHTEXT_LISTENERS_KEY] instanceof Set)) g[RICHTEXT_LISTENERS_KEY] = new Set<() => void>();
  return g[RICHTEXT_LISTENERS_KEY] as Set<() => void>;
}

/**
 * Register a rich-text plugin from a UI extension. Its blocks appear in the
 * editor's slash menu (for fields that allow custom blocks) and its Markdown
 * hook runs on Markdown import. Returns an unregister function.
 */
export function registerRichTextPlugin(def: RichTextPluginDefinition): () => void {
  pluginStore().set(def.name, def);
  for (const l of pluginListeners()) l();
  return () => {
    if (pluginStore().get(def.name) === def) {
      pluginStore().delete(def.name);
      for (const l of pluginListeners()) l();
    }
  };
}

/** Every registered rich-text plugin, in registration order. */
export function getRichTextPlugins(): RichTextPluginDefinition[] {
  return [...pluginStore().values()];
}

/** Subscribe to plugin (un)registration; returns an unsubscribe function. */
export function subscribeRichTextPlugins(listener: () => void): () => void {
  pluginListeners().add(listener);
  return () => pluginListeners().delete(listener);
}
