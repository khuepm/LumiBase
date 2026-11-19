import { validateBackendTemplate, type BackendTemplate } from '@lumibase/contracts/backend-templates';
import wordpressAlike from './official/wordpress-alike.template.json';

/**
 * Official backend templates bundled with this build (#902, #907, R3).
 *
 * Read-only application assets: never copied into tenant tables, never
 * editable through the catalog API, identical for every site. Each document
 * is validated when this module loads, so a broken asset fails the build's
 * tests instead of reaching a planner.
 */
function official(document: unknown, name: string): BackendTemplate {
  const result = validateBackendTemplate(document);
  if (!result.ok) {
    throw new Error(`Official template ${name} is invalid: ${JSON.stringify(result.errors.slice(0, 5))}`);
  }
  return result.template;
}

export const OFFICIAL_TEMPLATES: readonly BackendTemplate[] = Object.freeze([
  official(wordpressAlike, 'wordpress-alike'),
]);
