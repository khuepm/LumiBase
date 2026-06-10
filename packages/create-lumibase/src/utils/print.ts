import pc from 'picocolors';
import type { ProjectConfig } from '../index.js';

export function printNextSteps(config: ProjectConfig) {
  const { projectName, packageManager, installDeps, template } = config;
  const isCurrentDir = projectName === '.';
  const devCmd = template === 'cloudflare' ? `${packageManager} run dev` : 'docker compose up -d && pnpm dev';

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

  if (template === 'default') {
    console.log(`  ${step++}. ${pc.cyan('docker compose up -d')}  ${pc.dim('← starts Postgres + Redis')}`);
    console.log(`  ${step++}. ${pc.cyan(`${packageManager} run db:migrate`)}`);
  }

  console.log(`  ${step++}. ${pc.cyan(devCmd)}`);

  console.log();
  console.log(
    pc.dim('  CMS  ') + pc.underline('http://localhost:8787'),
  );
  if (template === 'default') {
    console.log(
      pc.dim('  Studio ') + pc.underline('http://localhost:5173'),
    );
  }
  console.log();
  console.log(pc.dim('  Docs → https://lumibase.dev/docs'));
  console.log();
}
