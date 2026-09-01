import pc from 'picocolors';

export const log = {
  plain(message = ''): void {
    console.log(message);
  },
  info(message: string): void {
    console.log(`${pc.cyan('•')} ${message}`);
  },
  success(message: string): void {
    console.log(`${pc.green('✔')} ${message}`);
  },
  warn(message: string): void {
    console.warn(`${pc.yellow('!')} ${message}`);
  },
  error(message: string): void {
    console.error(`${pc.red('✖')} ${message}`);
  },
  dim(message: string): void {
    console.log(pc.dim(message));
  },
};

/**
 * Masks a secret for display: keeps a short prefix so an operator can tell
 * *which* token was picked up without the value reaching logs or CI output.
 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  return `${secret.slice(0, 4)}${'•'.repeat(8)}${secret.slice(-2)}`;
}
