import pc from "picocolors";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { migrateCommand } from "./commands/migrate.js";
import { DEFAULT_SKILLS_DIR, skillsCommand } from "./commands/skills.js";
import { typesCommand, DEFAULT_OUT } from "./commands/types.js";
import { CliError } from "./errors.js";
import { argvAfterCommand, boolFlag, parseArgs } from "./utils/args.js";
import { log } from "./utils/log.js";
import { readVersion } from "./version.js";

export { readVersion };

const HELP = `
${pc.bold(pc.cyan("lumibase"))} ${pc.dim("— the LumiBase CLI")}

${pc.bold("Usage")}
  lumibase <command> [options]

${pc.bold("Commands")}
  init [name]     Scaffold a new LumiBase project
  types           Generate TypeScript types from a live schema
  skills          Sync Site Skills (AI agent playbooks) with a site
  doctor          Check configuration and connectivity
  migrate <source>  Migrate content from another CMS ${pc.dim("(contentful)")}

${pc.bold("Connection")}
  Resolved with precedence flag > environment > ${pc.cyan("lumibase.config.json")}.
  The token is never read from the config file.

  --url <url>     CMS base URL          ${pc.dim("(LUMIBASE_URL)")}
  --site <id>     Site / tenant id      ${pc.dim("(LUMIBASE_SITE_ID)")}
  --token <tok>   Bearer token          ${pc.dim("(LUMIBASE_TOKEN)")}

${pc.bold("lumibase types")}
  --out <path>    Output file           ${pc.dim(`(default: ${DEFAULT_OUT})`)}
  --include <a,b> Only these collections
  --exclude <a,b> Skip these collections
  --no-branded    Emit plain string ids instead of branded ones
  --import-from <pkg>  Module the generated file imports from ${pc.dim('(default: lumibase)')}
  --check         Fail if the file is missing or stale ${pc.dim("(use in CI)")}
  --stdout        Print to stdout instead of writing a file

${pc.bold("lumibase skills")} ${pc.dim("— Markdown playbooks (skills/*.skill.md) kept in git; needs an admin token")}
  list            Show the skills on the site
    --status <s>  Only draft | active | archived
    --json        Print the raw JSON instead of a table
  pull            Write every skill on the site to <dir>/<slug>.skill.md
    --dir <dir>   Target directory      ${pc.dim(`(default: ${DEFAULT_SKILLS_DIR})`)}
    --status <s>  Only draft | active | archived
  push            Create or update skills from the *.md files in <dir> ${pc.dim("(updates active skills live)")}
    --dir <dir>   Source directory      ${pc.dim(`(default: ${DEFAULT_SKILLS_DIR}; README.md is skipped)`)}
    --activate    Activate the skills instead of leaving new ones as drafts
    --dry-run     Show what would change without writing
    --check       Dry run that fails if anything would change ${pc.dim("(use in CI)")}
  install <src>   Add skills from a directory, a .md file, or an installed npm package
                  ${pc.dim("(never changes a skill that is already active)")}
                  ${pc.dim('(package dir: package.json "lumibase.skills", else skills/)')}
    --activate    Activate on install ${pc.dim("(default: drafts, to review in Studio)")}
    --dry-run     Show what would change without writing

${pc.bold("lumibase migrate contentful")}
  --file <path>   Output of ${pc.cyan("contentful space export --include-drafts")}
  --apply         Write the schema and content ${pc.dim("(default: dry run)")}
  --yes           Skip the confirmation prompt ${pc.dim("(required without a TTY)")}
  --prefix <p>    Prefix for new collection names, e.g. cf_
  --locale-map <a=b,…>  Map source locales, e.g. en-US=en
  --skip-assets   Do not download/upload assets
  --state <path>  Resume file ${pc.dim("(default: .lumibase/migrate-contentful-<space>-<site>-<hash>.json)")}
  --json          Print the plan as JSON

${pc.bold("Examples")}
  ${pc.dim("$")} lumibase init my-site
  ${pc.dim("$")} lumibase types --out src/lumibase-types.d.ts
  ${pc.dim("$")} lumibase types --check
  ${pc.dim("$")} lumibase skills pull
  ${pc.dim("$")} lumibase skills push --check
  ${pc.dim("$")} lumibase skills install @acme/lumibase-skills
  ${pc.dim("$")} lumibase doctor

  Docs: ${pc.cyan("https://docs.lumibase.dev")}
`;

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const command = args._[0];

  if (boolFlag(args, "version") && !command) {
    log.plain(readVersion());
    return 0;
  }

  if (!command || boolFlag(args, "help")) {
    // `lumibase --help` is a successful request for help; `lumibase` with no
    // command at all is a usage error, so the exit code differs.
    log.plain(HELP);
    return boolFlag(args, "help") ? 0 : 1;
  }

  switch (command) {
    case "init":
      return initCommand(argvAfterCommand(argv));
    case "types":
      return typesCommand(args);
    case "skills":
      return skillsCommand(args);
    case "doctor":
      return doctorCommand(args);
    case "migrate":
      return migrateCommand(args);
    case "help":
      log.plain(HELP);
      return 0;
    case "version":
      log.plain(readVersion());
      return 0;
    default:
      throw new CliError(
        `Unknown command: ${command}`,
        "Run `lumibase --help` to see the available commands.",
      );
  }
}
