import { z } from 'zod';

/**
 * Per-user preferences — shared by CMS (validation on `PATCH /me/preferences`)
 * and Studio (form + keybinding store). Persisted in the `users.preferences`
 * JSONB column (identity-global, not per-site). The site holds defaults
 * (appearance/language); these override them at render time.
 *
 * Keybindings model
 * -----------------
 * A *chord* is a canonical, platform-agnostic string built from
 * `event.code`-based key tokens (so it is keyboard-layout independent) plus
 * modifier tokens in a FIXED order: `mod` → `alt` → `shift` → `<key>`,
 * joined by `+`. `mod` resolves to Cmd on macOS and Ctrl elsewhere.
 *
 *   - `mod+s`        → Cmd/Ctrl + S
 *   - `mod+alt+s`    → Cmd/Ctrl + Opt/Alt + S
 *   - `mod+k`        → Cmd/Ctrl + K
 *   - `?`            → single key (Shift+Slash on most layouts)
 *
 * A *sequence* is two chords separated by a single space (GitHub-style
 * `g c`), reserved for future navigation shortcuts. Both forms validate here.
 *
 * The map is keyed by action id (e.g. `editor.save`) → chord. Only overridden
 * actions appear; everything else falls back to the Studio default keymap.
 */

/** Modifier tokens allowed in a chord, in canonical order. */
export const CHORD_MODIFIERS = ['mod', 'alt', 'shift'] as const;
export type ChordModifier = (typeof CHORD_MODIFIERS)[number];

/**
 * A single chord segment: zero or more modifiers (`mod`/`alt`/`shift`) followed
 * by exactly one key token. Key tokens are normalized from `event.code`:
 * a single letter (`a`…`z`), a single digit (`0`…`9`), a function key
 * (`f1`…`f12`), a named key (`enter`, `escape`, `slash`, `comma`, `period`,
 * `space`, `arrowup`…), or the literal `?`.
 */
const KEY_TOKEN = '(?:f1[0-2]|f[1-9]|[a-z]+|[0-9]|\\?)';
const CHORD_SEGMENT = `(?:mod\\+)?(?:alt\\+)?(?:shift\\+)?${KEY_TOKEN}`;
/** Single chord, or a two-chord sequence separated by one space. */
const CHORD_RE = new RegExp(`^${CHORD_SEGMENT}( ${CHORD_SEGMENT})?$`);

export const ChordSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(CHORD_RE, 'Invalid keyboard chord');

/** `{ [actionId]: chord }`. Action ids are validated loosely (dotted slugs). */
export const KeybindingMapSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/i, 'Invalid action id'),
  ChordSchema,
);
export type KeybindingMap = z.infer<typeof KeybindingMapSchema>;

/**
 * Full preferences blob. `.passthrough()` so writing one section (e.g.
 * keybindings) never drops keys this version doesn't know about (language,
 * theme, defaultPresets, future additions). The CMS PATCH handler merges the
 * validated patch into the existing blob rather than replacing it.
 */
export const UserPreferencesSchema = z
  .object({
    language: z.string().optional(),
    theme: z.enum(['auto', 'light', 'dark']).optional(),
    timezone: z.string().optional(),
    keybindings: KeybindingMapSchema.optional(),
  })
  .passthrough();
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/** Patch shape for `PATCH /me/preferences` — every top-level key optional. */
export const UserPreferencesUpdateSchema = UserPreferencesSchema.partial();
export type UserPreferencesUpdate = z.infer<typeof UserPreferencesUpdateSchema>;
