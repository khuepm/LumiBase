import { z } from 'zod';

/**
 * Extension manifest schema (`lumibase-extension.json`).
 *
 * This is the source-of-truth validation for the manifest file that every
 * extension ships in its source directory. It is shared by:
 *  - the discovery util (`@lumibase/extensions`) that scans folders at dev time,
 *  - the CMS install/marketplace routes that ingest a manifest, and
 *  - the Studio loader that decides which slot a UI extension fills.
 *
 * The shape mirrors `ExtensionManifest` in `@lumibase/extension-sdk` but adds
 * the optional descriptive/marketplace metadata that authors put in the JSON
 * file (icon, description, author, compatibility). Keeping the Zod schema here
 * — not in the SDK — preserves the SDK's "types only, no runtime deps" rule.
 */

export const ExtensionTypeSchema = z.enum([
  'hook',
  'endpoint',
  'operation',
  'interface',
  'display',
  'layout',
  'panel',
  'module',
]);

export type ExtensionType = z.infer<typeof ExtensionTypeSchema>;

/** UI extension types render inside Studio; the rest run in the CMS worker. */
export const UI_EXTENSION_TYPES = [
  'interface',
  'display',
  'layout',
  'panel',
  'module',
] as const satisfies readonly ExtensionType[];

export type UiExtensionType = (typeof UI_EXTENSION_TYPES)[number];

export function isUiExtensionType(type: ExtensionType): type is UiExtensionType {
  return (UI_EXTENSION_TYPES as readonly string[]).includes(type);
}

/** A single configurable option an extension exposes to the installing admin. */
export const ExtensionConfigOptionSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'integer', 'boolean', 'json']),
  label: z.string().optional(),
  default: z.unknown().optional(),
});

export type ExtensionConfigOption = z.infer<typeof ExtensionConfigOptionSchema>;

export const ExtensionAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  url: z.string().url().optional(),
});

export type ExtensionAuthor = z.infer<typeof ExtensionAuthorSchema>;

/**
 * The validated manifest. `name` is the stable extension key (also used to
 * match `field.interface` for interface extensions). `entry` is a path,
 * relative to the manifest's directory, to the module's entrypoint — in dev
 * this points at source (e.g. `./src/index.ts`); in a published bundle it
 * points at the built ESM file.
 */
export const ExtensionManifestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^[a-z0-9][a-z0-9-_/]*$/,
      'name must be lowercase kebab/slash form (e.g. "seo-meta" or "lumibase/seo-meta")',
    ),
  version: z.string().min(1),
  type: ExtensionTypeSchema,
  entry: z.string().min(1),
  /** Human-facing label shown in Studio/marketplace; falls back to `name`. */
  displayName: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  author: ExtensionAuthorSchema.optional(),
  /** Declared capabilities, e.g. `items:read:posts`, `http:fetch:api.example.com`. */
  capabilities: z.array(z.string()).default([]),
  config: z.array(ExtensionConfigOptionSchema).default([]),
  /** semver range of LumiBase this extension supports, e.g. `^0.6.0`. */
  compatibleWith: z.string().optional(),
  /** Field types an `interface`/`display` extension binds to (e.g. `["string"]`). */
  fieldTypes: z.array(z.string()).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

/**
 * Parse + validate a raw manifest object, throwing a ZodError on failure.
 * Use `ExtensionManifestSchema.safeParse` directly when you want to collect
 * errors without throwing (the discovery util does this per-folder).
 */
export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  return ExtensionManifestSchema.parse(raw);
}
