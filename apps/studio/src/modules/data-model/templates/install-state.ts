import type { PlanRequest } from './api';

/**
 * Install review rules (#908, BT08), kept pure so they are tested on their own.
 *
 * A preview is a plan for exactly one set of choices: template, revision,
 * target site, namespace and seed choice. Changing any of them makes the
 * preview stale: Install is disabled until a new plan is made, and the old
 * plan id is never submitted for the new choices.
 */

export interface InstallChoices {
  source: 'official' | 'site';
  /** Catalog site of a private template (the active site when it was chosen). */
  sourceSiteId: string | null;
  slug: string;
  version: string;
  /** Empty until the admin picks one: there is no default target site. */
  targetSiteId: string;
  prefix: string;
  /** Empty = schema only (the default). */
  seedPack: string;
}

export const EMPTY_CHOICES: InstallChoices = {
  source: 'official',
  sourceSiteId: null,
  slug: '',
  version: '',
  targetSiteId: '',
  prefix: '',
  seedPack: '',
};

/** Missing choices, in the order the form shows them; empty when a plan can be requested. */
export function missingChoices(choices: InstallChoices): Array<'template' | 'version' | 'targetSiteId'> {
  const missing: Array<'template' | 'version' | 'targetSiteId'> = [];
  if (!choices.slug) missing.push('template');
  if (!choices.version) missing.push('version');
  if (!choices.targetSiteId) missing.push('targetSiteId');
  return missing;
}

/** The plan request for these choices. Seed is opt-in: no pack means `seedMode: 'none'`. */
export function planRequest(choices: InstallChoices): PlanRequest {
  return {
    template: {
      source: choices.source,
      ...(choices.source === 'site' && choices.sourceSiteId ? { sourceSiteId: choices.sourceSiteId } : {}),
      slug: choices.slug,
      version: choices.version,
    },
    targetSiteId: choices.targetSiteId,
    ...(choices.prefix ? { namespace: { prefix: choices.prefix } } : {}),
    seedMode: choices.seedPack ? 'pack' : 'none',
    ...(choices.seedPack ? { seedPack: choices.seedPack } : {}),
  };
}

/** Identity of a set of choices: two previews are interchangeable only when these match. */
export function choicesKey(choices: InstallChoices): string {
  return JSON.stringify(planRequest(choices));
}

/** Is the preview made for `previewKey` still the one for the current choices? */
export function isPreviewCurrent(previewKey: string | null, choices: InstallChoices): boolean {
  return previewKey !== null && previewKey === choicesKey(choices);
}

/**
 * Idempotency key of an install. Derived from the plan, so a double click, a
 * reload of the review or a network retry of the same plan sends the same key
 * and the server returns the same installation instead of a second one.
 */
export function installKey(planId: string): string {
  return `studio:${planId}`;
}

/** An actionable message for each server refusal the install review can meet. */
export function describeTemplateError(code: string, fallback: string): string {
  switch (code) {
    case 'NAME_CONFLICT':
      return 'The target site already has collections with these names. Choose a namespace prefix, or pick another site.';
    case 'INVALID_TEMPLATE':
    case 'UNSUPPORTED_FORMAT':
      return 'The template is not valid. Fix the listed paths and try again.';
    case 'STALE_PLAN':
      return 'This preview is no longer valid (it expired or the target schema changed). Preview again.';
    case 'FORBIDDEN':
    case 'HTTP_403':
      return 'You are not an admin of this site, so you cannot install templates into it.';
    case 'INCOMPATIBLE_RUNTIME':
      return 'This server cannot install a template in one transaction (or the template needs another CMS version). Nothing was installed.';
    case 'SITE_MISMATCH':
      return 'The plan was sent to a different site than the one selected. Preview again.';
    case 'NOT_FOUND':
      return 'The template or revision no longer exists. Pick another one.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'This install request was already used for another plan. Preview again.';
    case 'NETWORK':
      return 'The server could not be reached. Retrying is safe: the same install is resumed, not repeated.';
    default:
      return fallback;
  }
}
