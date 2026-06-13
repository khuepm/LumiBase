import process from 'node:process';
import pc from 'picocolors';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL = 80;

export interface Spinner {
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

export function createSpinner(text: string): Spinner {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${text}...\n`);
    return {
      succeed(t) { process.stdout.write(`  ${pc.green('✔')} ${t ?? text}\n`); },
      fail(t) { process.stdout.write(`  ${pc.red('✖')} ${t ?? text}\n`); },
      stop() {},
    };
  }

  let frame = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${pc.cyan(FRAMES[frame % FRAMES.length] ?? '⠋')} ${text}`);
    frame++;
  }, INTERVAL);

  const clear = () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[K');
  };

  return {
    succeed(t?: string) {
      clear();
      process.stdout.write(`  ${pc.green('✔')} ${t ?? text}\n`);
    },
    fail(t?: string) {
      clear();
      process.stdout.write(`  ${pc.red('✖')} ${t ?? text}\n`);
    },
    stop: clear,
  };
}
