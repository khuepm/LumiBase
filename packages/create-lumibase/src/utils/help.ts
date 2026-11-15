import { TEMPLATES, TEMPLATE_INFO } from '../templates.js';

/** `create-lumibase --help`. Plain text, so it reads the same piped or in CI. */
export function helpText(): string {
  const width = Math.max(...TEMPLATES.map((name) => name.length));
  const templates = TEMPLATES.map(
    (name) => `  ${name.padEnd(width)}  ${TEMPLATE_INFO[name].title} — ${TEMPLATE_INFO[name].hint}`,
  ).join('\n');

  return [
    'Usage: create-lumibase [project-name] [options]',
    '',
    'Options:',
    `  --template <name>     One of: ${TEMPLATES.join(', ')}`,
    '  --pm <pnpm|npm|yarn|bun>',
    '                        Package manager to install with',
    '  --install, --no-install',
    '                        Install dependencies (or skip it)',
    '  --git, --no-git       Initialise a git repository (or skip it)',
    '  -h, --help            Show this help',
    '',
    'Templates:',
    templates,
    '',
    'Examples:',
    '  npm create lumibase@latest my-site -- --template astro',
    '  pnpm create lumibase my-site --template sveltekit --pm pnpm --no-git',
    '',
  ].join('\n');
}
