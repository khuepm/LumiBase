type BadgeEnv = Pick<ImportMetaEnv, 'DEV' | 'VITE_LUMIBASE_RELEASE_CHANNEL'>;

/** Channels that are the real thing and therefore get no badge. */
const UNBADGED_CHANNELS = new Set(['', 'production', 'prod', 'unknown']);

/**
 * Label for the environment badge next to the Studio title, or `null` when
 * no badge should render.
 *
 * - Vite dev server → `dev`.
 * - Production build → the release channel when it is a non-production one
 *   (`staging`, `preview`, …); nothing on a production channel.
 */
export function getEnvironmentBadge(env: BadgeEnv = import.meta.env): string | null {
  if (env.DEV) return 'dev';
  const channel = env.VITE_LUMIBASE_RELEASE_CHANNEL?.trim().toLowerCase() ?? '';
  if (UNBADGED_CHANNELS.has(channel)) return null;
  return channel === 'development' ? 'dev' : channel;
}
