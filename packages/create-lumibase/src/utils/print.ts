import pc from 'picocolors';
import type { ProjectConfig } from '../index.js';

export function printNextSteps(config: ProjectConfig) {
  const { projectName, packageManager, installDeps, template } = config;
  const isCurrentDir = projectName === '.';
  const run = (script: string) =>
    packageManager === 'npm' ? `npm run ${script}` : `${packageManager} ${script}`;

  console.log();
  console.log(pc.bold(pc.green('✔ Project created!')));
  console.log();
  console.log(pc.bold('  Next steps:'));
  console.log();

  let step = 1;

  if (!isCurrentDir) {
    console.log(`  ${step++}. ${pc.cyan(`cd ${projectName}`)}`);
  }

  console.log(`  ${step++}. ${pc.cyan('cp .env.example .env')}  ${pc.dim('← fill in your secrets')}`);

  if (!installDeps) {
    console.log(`  ${step++}. ${pc.cyan(`${packageManager} install`)}`);
  }

  if (template === 'nextjs') {
    // The CMS image runs its own migrations on boot, so there is no migrate
    // step here.
    console.log(`  ${step++}. ${pc.cyan(run('cms:up'))}  ${pc.dim('← CMS + Studio + Postgres')}`);
    console.log(`  ${step++}. ${pc.cyan(run('cms:bootstrap'))}  ${pc.dim('← admin + publishable key')}`);
    console.log(`  ${step++}. ${pc.cyan(run('cms:seed'))}  ${pc.dim('← sample posts')}`);
    console.log(`  ${step++}. ${pc.cyan(run('dev'))}`);

    console.log();
    console.log(pc.dim('  Website  ') + pc.underline('http://localhost:3000'));
    console.log(pc.dim('  API      ') + pc.underline('http://localhost:1989'));
    console.log(pc.dim('  Studio   ') + pc.underline('http://localhost:1989/<LUMIBASE_ADMIN_PATH>'));
    console.log();
    console.log(pc.dim(`  Check the public client is safe: ${pc.cyan(run('cms:verify'))}`));
    console.log();
    console.log(pc.dim('  Docs → https://docs.lumibase.dev'));
    console.log();
    return;
  }

  if (template === 'default') {
    console.log(`  ${step++}. ${pc.cyan('docker compose up -d')}  ${pc.dim('← starts Postgres + Redis')}`);
    console.log(`  ${step++}. ${pc.cyan(run('db:migrate'))}`);
  }

  console.log(
    `  ${step++}. ${pc.cyan(template === 'cloudflare' ? run('dev') : 'docker compose up -d && pnpm dev')}`,
  );

  console.log();
  console.log(pc.dim('  API  ') + pc.underline('http://localhost:8787'));
  console.log();
  console.log(pc.dim('  Docs → https://lumibase.dev/docs'));
  console.log();
}
