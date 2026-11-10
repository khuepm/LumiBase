export const ORGANIZATION_TOKEN_PREFIX = 'lbo_';
export const PUBLISHABLE_TOKEN_PREFIX = 'lbk_pub_';
export const SITE_TOKEN_PREFIX = 'lbk_';
export type TokenKind = 'site' | 'publishable' | 'organization' | 'unknown';
/** Check the narrower publishable prefix before its site-prefix parent. */
export function classifyTokenPrefix(token: string): TokenKind {
  if (token.startsWith(PUBLISHABLE_TOKEN_PREFIX)) return 'publishable';
  if (token.startsWith(SITE_TOKEN_PREFIX)) return 'site';
  if (token.startsWith(ORGANIZATION_TOKEN_PREFIX)) return 'organization';
  return 'unknown';
}
