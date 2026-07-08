import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { buildQs, confirmDescription, okText, run } from './_shared.js';
import { encodePathSegment, idPathSegmentSchema } from './path.js';

export interface CrudModuleOptions {
  /** REST base path under `/api/v1`, e.g. `/roles`. */
  basePath: string;
  /** Singular resource label used in descriptions, e.g. `role`. */
  resource: string;
  /**
   * Tool-name prefix in snake_case, e.g. `role` → `list_roles`, `get_role`.
   * The list tool pluralizes by appending `s`; override with `listName` when
   * that is wrong (e.g. `policy` → `policies`).
   */
  namePrefix: string;
  /** Override the auto-pluralized `list_<prefix>s` tool name. */
  listName?: string;
  /** Zod shape for create (POST body). Omit to skip the create tool. */
  createSchema?: ZodRawShape;
  /** Zod shape for update (PATCH body). Omit to skip the update tool. */
  updateSchema?: ZodRawShape;
  /** Zod shape for list query params. */
  listQuery?: ZodRawShape;
  /** Enable the delete tool (always guarded by `confirm`). Default true. */
  enableDelete?: boolean;
  /** Enable the get-by-id tool. Default true. */
  enableGet?: boolean;
  /** Path-param name for single-resource routes. Default `id`. */
  idParam?: string;
}

/**
 * Registers the standard list/get/create/update/delete tools for a resource that
 * follows the conventional REST shape (`GET /x`, `GET /x/:id`, `POST /x`,
 * `PATCH /x/:id`, `DELETE /x/:id`). Destructive deletes require `confirm: true`.
 *
 * Resources with non-standard endpoints register those tools directly instead.
 */
export function registerCrud(
  server: McpServer,
  client: LumiBaseClient,
  opts: CrudModuleOptions,
): void {
  const {
    basePath,
    resource,
    namePrefix,
    listName = `list_${namePrefix}s`,
    createSchema,
    updateSchema,
    listQuery,
    enableDelete = true,
    enableGet = true,
    idParam = 'id',
  } = opts;

  server.registerTool(
    listName,
    {
      description: `List ${resource}s for the current site.`,
      inputSchema: listQuery ?? {},
    },
    async (args: Record<string, unknown>) =>
      run(() => {
        const qs = buildQs(args as Record<string, string | number | boolean | undefined>);
        return client.get<unknown>(`${basePath}${qs}`);
      }),
  );

  if (enableGet) {
    server.registerTool(
      `get_${namePrefix}`,
      {
        description: `Get a single ${resource} by ${idParam}.`,
        inputSchema: { [idParam]: idPathSegmentSchema },
      },
      async (args: Record<string, unknown>) =>
        run(() => client.get<unknown>(`${basePath}/${encodePathSegment(String(args[idParam]))}`)),
    );
  }

  if (createSchema) {
    server.registerTool(
      `create_${namePrefix}`,
      {
        description: `Create a new ${resource}.`,
        inputSchema: createSchema,
      },
      async (args: Record<string, unknown>) =>
        run(() => client.post<unknown>(basePath, args)),
    );
  }

  if (updateSchema) {
    server.registerTool(
      `update_${namePrefix}`,
      {
        description: `Update an existing ${resource} (partial PATCH).`,
        inputSchema: { [idParam]: idPathSegmentSchema, ...updateSchema },
      },
      async (args: Record<string, unknown>) => {
        const { [idParam]: id, ...patch } = args;
        return run(() => client.patch<unknown>(`${basePath}/${encodePathSegment(String(id))}`, patch));
      },
    );
  }

  if (enableDelete) {
    server.registerTool(
      `delete_${namePrefix}`,
      {
        description: `Delete a ${resource}. DESTRUCTIVE — warn the user first and pass confirm=true.`,
        inputSchema: {
          [idParam]: idPathSegmentSchema,
          confirm: z.literal(true).describe(confirmDescription),
        },
      },
      async (args: Record<string, unknown>) => {
        const id = String(args[idParam]);
        return run(async () => {
          await client.delete(`${basePath}/${encodePathSegment(id)}`);
          return okText(`${resource} "${id}" deleted.`);
        });
      },
    );
  }
}
