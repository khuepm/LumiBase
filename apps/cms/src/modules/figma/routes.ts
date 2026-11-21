/**
 * Figma import (#758), mounted at `/api/v1/integrations/figma`. Site admins
 * only: an import creates a collection (a block template).
 *
 * - The personal access token is stored as the site's encrypted tool secret
 *   `FIGMA_TOKEN` (the same vault agent tools use); it is never returned.
 * - `POST /preview` reads a frame and returns the block draft and the theme
 *   suggestion without writing anything.
 * - `POST /import` creates the block template collection (hidden, with the
 *   mapped fields and display template) in one transaction, and can add it to
 *   an existing `blocks` field's `allowedBlocks` so it is usable at once.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { SchemaService, SchemaServiceError, type FieldInput } from '../../services/schema-service';
import { ToolSecretError, ToolSecretService } from '../../services/tool-secret-service';
import { FigmaClient, FigmaError, parseFigmaUrl, type FetchLike } from './client';
import { mapFrame, type BlockDraft } from './mapper';
import { suggestTheme } from './theme';

export const FIGMA_TOKEN_SECRET = 'FIGMA_TOKEN';

/** Seam for tests (fixture fetch). */
export const figmaDeps: { fetch: FetchLike | undefined } = { fetch: undefined };

export const figmaRouter = new Hono<AppEnv>();
figmaRouter.use('*', requireSiteAdmin());

type ErrStatus = 400 | 404 | 409 | 422 | 429 | 502 | 503;
const fail = (c: Context<AppEnv>, status: ErrStatus, code: string, message: string) => c.json({ errors: [{ code, message }] }, status);

const secrets = (c: Context<AppEnv>) => new ToolSecretService({ db: c.get('db'), siteId: c.get('siteId'), keys: c.get('runtime')?.keys });

async function hasToken(c: Context<AppEnv>): Promise<boolean> {
  return (await secrets(c).list().catch(() => [])).some((s) => s.name === FIGMA_TOKEN_SECRET);
}

async function readFrame(c: Context<AppEnv>, url: string) {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  let token: string;
  try {
    token = (await secrets(c).resolve([FIGMA_TOKEN_SECRET])).get(FIGMA_TOKEN_SECRET)!;
  } catch (err) {
    if (err instanceof ToolSecretError) throw new FigmaError('FIGMA_TOKEN_REJECTED', 'No Figma token is configured for this site: PUT /api/v1/integrations/figma/token first.', 422);
    throw err;
  }
  const frame = await new FigmaClient({ token, fetch: figmaDeps.fetch }).getNode(fileKey, nodeId);
  return { fileKey, nodeId, frame };
}

function handle(c: Context<AppEnv>, err: unknown) {
  if (err instanceof FigmaError) return fail(c, err.status, err.code, err.message);
  if (err instanceof SchemaServiceError) return fail(c, (err.status as ErrStatus) ?? 400, err.code, err.message);
  if (err instanceof ToolSecretError) return fail(c, 503, err.code, err.message);
  if (err instanceof z.ZodError) {
    return c.json({ errors: err.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.') || 'body'}: ${i.message}` })) }, 400);
  }
  throw err;
}

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

const schemaService = (c: Context<AppEnv>) =>
  new SchemaService({ db: c.get('db') as never, siteId: c.get('siteId'), cache: c.get('runtime')?.cache, queue: c.get('runtime')?.queue });

figmaRouter.get('/', async (c) => c.json({ data: { hasToken: await hasToken(c) } }));

const tokenSchema = z.object({ token: z.string().trim().min(20).max(512) }).strict();

figmaRouter.put('/token', async (c) => {
  try {
    const { token } = tokenSchema.parse(await json(c));
    await secrets(c).set(FIGMA_TOKEN_SECRET, token, c.get('auth')?.userId ?? null);
    return c.json({ data: { hasToken: true } });
  } catch (err) {
    return handle(c, err);
  }
});

figmaRouter.delete('/token', async (c) => {
  await secrets(c).delete(FIGMA_TOKEN_SECRET).catch(() => false);
  return c.json({ data: { hasToken: false } });
});

const previewSchema = z
  .object({
    url: z.string().url().max(2048),
    collection: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const present = (draft: BlockDraft, source: { fileKey: string; nodeId: string }) => ({
  ...draft,
  theme: suggestTheme(draft.tokens),
  source,
});

figmaRouter.post('/preview', async (c) => {
  try {
    const input = previewSchema.parse(await json(c));
    const { fileKey, nodeId, frame } = await readFrame(c, input.url);
    return c.json({ data: present(mapFrame(frame, input), { fileKey, nodeId }) });
  } catch (err) {
    return handle(c, err);
  }
});

const importSchema = previewSchema.extend({
  /** Also allow the new block in this `blocks` field. */
  addToBlocksField: z.object({ collection: z.string().min(1), field: z.string().min(1) }).strict().optional(),
});

figmaRouter.post('/import', async (c) => {
  try {
    const input = importSchema.parse(await json(c));
    const { fileKey, nodeId, frame } = await readFrame(c, input.url);
    const draft = mapFrame(frame, input);
    if (draft.fields.length === 0) return fail(c, 422, 'FIGMA_NO_FIELDS', 'The frame has no text or image layers to map.');
    const schema = schemaService(c);
    if (await schema.getCollection(draft.collection)) {
      return fail(c, 409, 'COLLECTION_EXISTS', `Collection "${draft.collection}" already exists; pass another \`collection\` name.`);
    }
    let blocksTarget: { collection: string; field: string; allowed: string[] } | null = null;
    if (input.addToBlocksField) {
      const fields = await schema.listFields(input.addToBlocksField.collection).catch(() => []);
      const target = fields.find((f) => f.name === input.addToBlocksField!.field);
      if (!target || target.interface !== 'blocks') {
        return fail(c, 404, 'BLOCKS_FIELD_NOT_FOUND', 'addToBlocksField must name an existing field with the `blocks` interface.');
      }
      const allowed = ((target.options as { allowedBlocks?: unknown } | null)?.allowedBlocks ?? []) as unknown[];
      blocksTarget = { ...input.addToBlocksField, allowed: allowed.filter((x): x is string => typeof x === 'string') };
    }
    const fields: FieldInput[] = draft.fields.map((f, i) => ({
      name: f.name,
      type: f.type,
      interface: f.interface,
      label: f.label,
      note: f.note,
      nullable: true,
      sortOrder: i + 1,
    }));
    await schema.updateSchema(draft.collection, {
      label: draft.label,
      hidden: true,
      icon: 'widgets',
      note: `Block imported from Figma (${fileKey}, node ${nodeId}).`,
      displayTemplate: draft.displayTemplate,
      meta: { figma: { fileKey, nodeId, frame: frame.name, importedAt: new Date().toISOString() } },
      fields,
    });
    if (blocksTarget && !blocksTarget.allowed.includes(draft.collection)) {
      const fieldsNow = await schema.listFields(blocksTarget.collection);
      const target = fieldsNow.find((f) => f.name === blocksTarget!.field)!;
      await schema.updateField(blocksTarget.collection, blocksTarget.field, {
        options: { ...((target.options as Record<string, unknown> | null) ?? {}), allowedBlocks: [...blocksTarget.allowed, draft.collection] },
      });
    }
    return c.json({ data: { ...present(draft, { fileKey, nodeId }), addedToBlocksField: blocksTarget ? `${blocksTarget.collection}.${blocksTarget.field}` : null } }, 201);
  } catch (err) {
    return handle(c, err);
  }
});
