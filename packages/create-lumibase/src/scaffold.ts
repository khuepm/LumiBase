import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import pc from 'picocolors';
import { createSpinner } from './utils/spinner.js';
import type { ProjectConfig } from './index.js';

const TEMPLATES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'templates',
);

/**
 * Files that npm renames on publish (strips the dot).
 * We store them with an underscore prefix and rename on copy.
 */
const RENAME_MAP: Record<string, string> = {
  '_gitignore': '.gitignore',
  '_env.example': '.env.example',
  '_npmrc': '.npmrc',
};

export async function scaffold(config: ProjectConfig): Promise<void> {
  const spinner = createSpinner(`Scaffolding ${pc.bold(config.projectName)}`);

  try {
    const templateDir = resolve(TEMPLATES_DIR, config.template);
    const ctx = buildTemplateContext(config);

    copyDir(templateDir, config.targetDir, ctx);
    spinner.succeed(`Scaffolded ${pc.bold(config.projectName)}`);
  } catch (err) {
    spinner.fail('Scaffold failed');
    throw err;
  }
}

function buildTemplateContext(config: ProjectConfig): Record<string, unknown> {
  return {
    projectName: config.projectName,
    packageManager: config.packageManager,
    isCloudflare: config.template === 'cloudflare',
    isDefault: config.template === 'default',
    year: new Date().getFullYear(),
  };
}

function copyDir(
  src: string,
  dest: string,
  ctx: Record<string, unknown>,
): void {
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    const srcPath = resolve(src, entry);
    const destName = RENAME_MAP[entry] ?? entry;
    const destPath = resolve(dest, destName);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      copyDir(srcPath, destPath, ctx);
    } else {
      copyFile(srcPath, destPath, ctx);
    }
  }
}

function copyFile(
  src: string,
  dest: string,
  ctx: Record<string, unknown>,
): void {
  const raw = readFileSync(src, 'utf-8');

  // Only run Handlebars on text template files
  if (src.endsWith('.hbs')) {
    const template = Handlebars.compile(raw, { noEscape: true });
    const rendered = template(ctx);
    // Strip .hbs extension in dest
    const destWithoutHbs = dest.endsWith('.hbs') ? dest.slice(0, -4) : dest;
    mkdirSync(dirname(destWithoutHbs), { recursive: true });
    writeFileSync(destWithoutHbs, rendered, 'utf-8');
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, raw);
  }

  if (process.env['DEBUG']) {
    console.log(pc.dim(`  + ${relative(process.cwd(), dest)}`));
  }
}
