/**
 * Stable template error categories (#901, design "API and MCP proposal").
 * Every error carries a JSON path (`$.config.fields[3].collection`) so an
 * author or an agent can fix the exact spot.
 */
export const TEMPLATE_ERROR_CODES = [
  'INVALID_TEMPLATE',
  'UNSUPPORTED_FORMAT',
  'INCOMPATIBLE_RUNTIME',
  'LIMIT_EXCEEDED',
  'AMBIGUOUS_TEMPLATE',
  'SITE_MISMATCH',
  'NAME_CONFLICT',
  'STALE_PLAN',
  'APPROVAL_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
] as const;

export type TemplateErrorCode = (typeof TEMPLATE_ERROR_CODES)[number];

export interface TemplateError {
  code: TemplateErrorCode;
  /** JSON path, `$` = the document root. */
  path: string;
  message: string;
}

export function templateError(code: TemplateErrorCode, path: string, message: string): TemplateError {
  return { code, path, message };
}
