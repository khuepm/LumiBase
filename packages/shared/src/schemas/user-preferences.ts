import { z } from 'zod';

/**
 * Save-action preference (spec: .kiro/specs/save-default-preference).
 *
 * Controls where the Studio content editor goes after a successful save:
 *  - `stay`        — remain on the edit form (current Studio behavior)
 *  - `return`      — go back to the collection list (Directus default)
 *  - `create_new`  — open a fresh create form
 *
 * Resolution precedence (see `resolveSaveAction`): per-user
 * `users.preferences.saveAction` → site `sites.default_save_action` →
 * {@link DEFAULT_SAVE_ACTION}. The hardcoded fallback is `stay`, matching the
 * Studio editor's existing no-navigate-on-save behavior so upgrading instances
 * see no change until an operator/user opts into another action.
 */
export const SAVE_ACTIONS = ['stay', 'return', 'create_new'] as const;
export type SaveAction = (typeof SAVE_ACTIONS)[number];
export const SaveActionSchema = z.enum(SAVE_ACTIONS);

/** Global fallback when neither the user nor the site has configured one. */
export const DEFAULT_SAVE_ACTION: SaveAction = 'stay';

/** Narrowing guard — any non-enum value is treated as "not configured". */
export function isSaveAction(value: unknown): value is SaveAction {
  return typeof value === 'string' && (SAVE_ACTIONS as readonly string[]).includes(value);
}

/**
 * Resolve the effective save action from the user preference and the site
 * default. Pure: invalid/absent values fall through rather than throw.
 */
export function resolveSaveAction(userPref: unknown, siteDefault: unknown): SaveAction {
  if (isSaveAction(userPref)) return userPref;
  if (isSaveAction(siteDefault)) return siteDefault;
  return DEFAULT_SAVE_ACTION;
}

/**
 * Full preferences blob stored in `users.preferences`. `.passthrough()` keeps
 * forward-compatible keys (a future client may add fields this version doesn't
 * know) instead of stripping them.
 */
export const UserPreferencesSchema = z
  .object({
    language: z.string().optional(),
    theme: z.string().optional(),
    timezone: z.string().optional(),
    defaultPresets: z.unknown().optional(),
    saveAction: SaveActionSchema.optional(),
  })
  .passthrough();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/**
 * PATCH body for self-service preference updates. `saveAction: null` clears the
 * override so the user falls back to the site default. `.passthrough()` lets a
 * client update other known preference keys in the same call.
 */
export const PreferencesUpdateSchema = z
  .object({
    saveAction: SaveActionSchema.nullable().optional(),
    language: z.string().optional(),
    theme: z.string().optional(),
    timezone: z.string().optional(),
  })
  .passthrough();
export type PreferencesUpdate = z.infer<typeof PreferencesUpdateSchema>;
