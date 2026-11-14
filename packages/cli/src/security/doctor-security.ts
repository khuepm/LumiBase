import pc from 'picocolors';
import { CliError } from '../errors.js';
import { boolFlag, stringFlag, type ParsedArgs } from '../utils/args.js';
import { runSecurityChecks, type Finding, type SecurityReport } from './checks.js';
import { loadProjectEnv } from './env-sources.js';

export interface SecurityDoctorOptions {
  cwd: string;
  /** Process environment overlay; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Output sink; defaults to `console.log`. */
  write?: (line: string) => void;
}

/** Build the report without printing — the programmatic entry point. */
export function buildSecurityReport(args: ParsedArgs, options: SecurityDoctorOptions): SecurityReport {
  const envFileFlag = stringFlag(args, 'env-file');
  const envFiles = envFileFlag
    ? envFileFlag
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : undefined;
  let projectEnv;
  try {
    projectEnv = loadProjectEnv(options.cwd, { envFiles, processEnv: options.env });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), 'Check the --env-file path.');
  }
  return runSecurityChecks(projectEnv, { production: boolFlag(args, 'production') });
}

function mark(f: Finding): string {
  return f.severity === 'critical' ? pc.red('✖') : f.severity === 'warning' ? pc.yellow('!') : pc.cyan('i');
}

/**
 * `lumibase doctor --security`: audits the project's configuration against
 * the production checklist. Exit code 1 when any finding is critical.
 */
export function securityDoctorCommand(args: ParsedArgs, options: SecurityDoctorOptions): number {
  const write = options.write ?? ((line: string) => console.log(line));
  const report = buildSecurityReport(args, options);

  if (boolFlag(args, 'json')) {
    write(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  write('');
  write(
    `${pc.bold('Security check')} ${pc.dim(
      `— ${report.mode} rules, ${report.runtime} runtime, read: ${report.sources.join(', ') || 'process environment only'}`,
    )}`,
  );
  write('');
  for (const f of report.findings) {
    write(`${mark(f)} ${pc.bold(f.severity.padEnd(8))} ${f.message}`);
    write(`  ${pc.dim('rule:')} ${f.rule}`);
    write(`  ${pc.dim('fix: ')} ${f.fix}`);
  }
  write('');
  const { critical, warning, info } = report.summary;
  const line = `${critical} critical, ${warning} warning${warning === 1 ? '' : 's'}, ${info} info`;
  write(report.ok ? `${pc.green('✔')} ${line}` : `${pc.red('✖')} ${line}`);
  return report.ok ? 0 : 1;
}
