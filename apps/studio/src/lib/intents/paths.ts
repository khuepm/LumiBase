/**
 * Path helpers for Studio intent links (issue #759).
 *
 * Every helper here is about one property: an intent can only ever move the
 * user to an INTERNAL Studio location. Return-to values carried across login
 * and paths returned by extension handlers both pass through these checks, so
 * a crafted link cannot turn Studio into an open redirect.
 */
import { STUDIO_INTENT_ACTIONS, STUDIO_INTENT_SEGMENT } from '@lumibase/contracts/intents';
import { getAdminBase } from '@/lib/admin-base';

const INTENT_PATH = new RegExp(`^/${STUDIO_INTENT_SEGMENT}/(${STUDIO_INTENT_ACTIONS.join('|')})/?$`);
/** Anything that could make a browser leave the origin or confuse a parser. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f\\]/;
const DUMMY_ORIGIN = 'https://studio.invalid';
/** Search part of a return-to: plain query, bounded. */
const MAX_RETURN_LENGTH = 2048;

/** Admin-relative pathname (the `/{adminPath}` prefix stripped). */
export function stripAdminBase(pathname: string): { adminBase: string; rest: string } {
  const adminBase = getAdminBase(pathname);
  const rest = adminBase ? pathname.slice(adminBase.length) || '/' : pathname;
  return { adminBase, rest };
}

/** True for `/intent/{open|create|edit}` with or without the admin prefix. */
export function isIntentPathname(pathname: string): boolean {
  return INTENT_PATH.test(stripAdminBase(pathname).rest);
}

/** The action segment of an intent pathname, or null. */
export function intentActionFromPathname(pathname: string): string | null {
  const rest = stripAdminBase(pathname).rest;
  const match = /^\/intent\/([^/]+)\/?$/.exec(rest);
  return match ? decodeURIComponentSafe(match[1] ?? '') : null;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalise an admin-relative path (`/content/posts/p1?locale=vi`) that must
 * stay inside Studio. Returns `null` for absolute URLs, protocol-relative
 * (`//evil`), backslash tricks (`/\evil`), control characters, fragments
 * and anything that resolves off-origin.
 */
export function toSafeInternalPath(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > MAX_RETURN_LENGTH) return null;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (UNSAFE_CHARS.test(candidate) || candidate.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(candidate, DUMMY_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== DUMMY_ORIGIN) return null;
  // Dot segments are resolved by URL; refuse anything that changed shape so
  // `/content/../../x` cannot smuggle a different target past a prefix check.
  const normalized = `${url.pathname}${url.search}`;
  if (normalized !== candidate) return null;
  return normalized;
}

/**
 * Validate the `next` value carried through the login screen. Only intent
 * paths are accepted (that is the only flow that sets it), admin-relative,
 * so the login page re-applies its own admin prefix.
 */
export function sanitizeIntentReturnTo(candidate: unknown): string | null {
  const safe = toSafeInternalPath(candidate);
  if (!safe) return null;
  const pathname = safe.split('?')[0] ?? '';
  return INTENT_PATH.test(pathname) ? safe : null;
}

/** `/{adminPath}/login?next=…` for an intent URL the user could not open yet. */
export function loginUrlForIntent(adminBase: string, pathname: string, search: string): string | null {
  const { rest } = stripAdminBase(pathname);
  const next = sanitizeIntentReturnTo(`${rest}${search}`);
  if (!adminBase) return null;
  return next ? `${adminBase}/login?next=${encodeURIComponent(next)}` : `${adminBase}/login`;
}
