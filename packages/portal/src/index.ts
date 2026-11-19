/**
 * @lumibase/portal — embeddable member Portal (epic #672 N02).
 *
 * - `mountPortal(element, options)` — framework-agnostic.
 * - `definePortalElement()` — registers `<lumi-portal>`.
 * - `@lumibase/portal/react` — `<LumiPortal />`.
 * - `dist/portal.min.js` — script tag that mounts `[data-lumi-portal]`.
 */

export { mountPortal, type PortalOptions, type PortalHandle } from './mount';
export { definePortalElement, optionsFromAttributes, PORTAL_TAG } from './element';
export { PortalApi, normalizeBaseUrl, type PortalConfig, type PortalMember, type PortalNewsletter, type PortalTier, type ApiResult } from './api';
export { takeTokenFromUrl, loadSession, saveSession, TOKEN_PARAM } from './session';
export { resolveSignupCopy, DEFAULT_SIGNUP_COPY, SIGNUP_CARD_BLOCK, signupCardOverrides } from '@lumibase/contracts/members';
