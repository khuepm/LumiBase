/**
 * The template registry: every name `--template` accepts, in prompt order,
 * with the one-line description the prompt and `--help` show.
 *
 * Kept apart from `index.ts` (which runs the CLI on import) so tests and the
 * help text read the same list the CLI validates against. A name here must
 * have a matching directory under `templates/` — `templates.test.ts` checks.
 */

export const TEMPLATES = ['nextjs', 'astro', 'sveltekit', 'default', 'cloudflare'] as const;

export type Template = (typeof TEMPLATES)[number];

export interface TemplateInfo {
  /** Short name shown in bold in the prompt. */
  title: string;
  /** What you get, dimmed after the title. */
  hint: string;
}

export const TEMPLATE_INFO: Record<Template, TemplateInfo> = {
  nextjs: {
    title: 'Next.js website',
    hint: '+ CMS, Studio and seed content (recommended)',
  },
  astro: {
    title: 'Astro static site',
    hint: 'build-time content, static export to Cloudflare Pages',
  },
  sveltekit: {
    title: 'SvelteKit site',
    hint: 'server loads + draft preview on Cloudflare Pages',
  },
  default: {
    title: 'Docker starter',
    hint: 'Hono + Node.js + PostgreSQL (no CMS)',
  },
  cloudflare: {
    title: 'Cloudflare Workers starter',
    hint: 'Hono + Edge + D1 (no CMS)',
  },
};

/** Templates that read content from a LumiBase CMS through the `lumibase` client. */
export const CONTENT_TEMPLATES = ['nextjs', 'astro', 'sveltekit'] as const satisfies readonly Template[];

export function isTemplate(value: unknown): value is Template {
  return typeof value === 'string' && (TEMPLATES as readonly string[]).includes(value);
}
