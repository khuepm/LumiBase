/** IPC messages between the extension process host and its child (#990). */

export interface ModuleShape {
  hooks: string[];
  tools: string[];
  handler: boolean;
  cdc: boolean;
}

export interface SerializedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface SerializedResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string | null;
}

export type Invocation =
  | { kind: 'hook'; event: string; arg: unknown }
  | { kind: 'mcp'; tool: string; args: Record<string, unknown>; ctx: { siteId: string; runId: string | null } }
  | { kind: 'http'; request: SerializedRequest }
  | { kind: 'cdc'; events: unknown[]; ctx: { siteId: string; config: Record<string, unknown> } };

export type ParentMessage =
  | { t: 'load'; url: string; name: string }
  | ({ t: 'invoke'; id: string } & Invocation)
  | { t: 'ctx-result'; id: string; ok: true; value: unknown }
  | { t: 'ctx-result'; id: string; ok: false; error: string };

export type ChildMessage =
  | { t: 'loaded'; shape: ModuleShape }
  | { t: 'load-failed'; error: string }
  | { t: 'result'; id: string; ok: true; value: unknown }
  | { t: 'result'; id: string; ok: false; error: string }
  | { t: 'ctx'; id: string; invocation: string; path: string; args: unknown[] };
