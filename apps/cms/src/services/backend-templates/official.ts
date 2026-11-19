import type { BackendTemplate } from '@lumibase/contracts/backend-templates';

/**
 * Official backend templates bundled with this build (#902, R3).
 *
 * Read-only application assets: never copied into tenant tables, never
 * editable through the catalog API, identical for every site. The release
 * `wordpress-alike` template is added by #907 (BT07).
 */
export const OFFICIAL_TEMPLATES: readonly BackendTemplate[] = [];
