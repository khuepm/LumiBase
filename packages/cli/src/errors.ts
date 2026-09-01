/**
 * An error whose message is already written for a human operator. `main()`
 * prints it without a stack trace; anything else is treated as a bug and
 * gets the full trace under `DEBUG=1`.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
