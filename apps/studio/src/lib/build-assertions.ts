/**
 * Build-time assertions for the Studio Vite bundle.
 *
 * These helpers run while Vite is loading the config file (i.e. before any
 * application code is bundled) so that misconfigured environments fail the
 * build loudly instead of silently leaking secrets into the client bundle.
 *
 * Spec refs: admin-setup-wizard requirements §4.7; design.md §7.3 (Secret
 * handling). The custom Admin Path is server-side state and MUST NEVER be
 * embedded in the Studio bundle. Vite, by design, inlines every env var that
 * starts with `VITE_` directly into the compiled JS — so any env var named
 * `VITE_ADMIN_PATH` (or anything beginning with that prefix) would defeat the
 * "Hide Login" guarantee. We refuse to even start the build when such a var
 * is present, regardless of casing.
 *
 * NOTE: This module is intentionally NOT imported by any runtime code in the
 * Studio app — it exists purely for the build pipeline and its tests.
 */

/** The forbidden prefix. Compared case-insensitively to be conservative. */
export const FORBIDDEN_ENV_PREFIX = 'VITE_ADMIN_PATH';

/**
 * Pure check used by both `vite.config.ts` and unit tests.
 *
 * Returns the list of offending env var names (preserving the original
 * casing) so callers can build a useful error message. An empty array means
 * the environment is clean.
 */
export function findForbiddenAdminPathEnvVars(
  env: Record<string, string | undefined>,
): string[] {
  const needle = FORBIDDEN_ENV_PREFIX.toLowerCase();
  const offenders: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith(needle)) {
      offenders.push(key);
    }
  }
  return offenders;
}

/**
 * Throws if any env var with the forbidden prefix is present. Intended to be
 * called from `vite.config.ts` so the build aborts before bundling.
 */
export function assertNoAdminPathEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const offenders = findForbiddenAdminPathEnvVars(env);
  if (offenders.length === 0) return;

  const list = offenders.map((name) => `  - ${name}`).join('\n');
  throw new Error(
    `[lumibase-studio] Refusing to build: forbidden env var(s) detected.\n` +
      `Vite inlines any env var starting with "VITE_" into the client bundle, ` +
      `so a "${FORBIDDEN_ENV_PREFIX}" var would leak the custom Admin Path ` +
      `to every browser that downloads the SPA.\n` +
      `Offending var(s):\n${list}\n` +
      `Fix: unset these env var(s). The Admin Path lives server-side in ` +
      `system_state.admin_path and is fetched at runtime via the authenticated ` +
      `endpoint GET /api/v1/me/admin-path.\n` +
      `(See admin-setup-wizard requirements §4.7 / design.md §7.3.)`,
  );
}
