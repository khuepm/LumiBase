/**
 * A refusal a skill handler reports with a machine-readable code.
 *
 * `runSkill` records any other thrown error as a message only. A handler that
 * throws this instead gets `code` on the harness result (and so on the MCP tool
 * decision), letting a client tell `MISSING_INPUT` from `STALE_PLAN` or
 * `FORBIDDEN` without parsing prose.
 */
export class SkillError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SkillError';
  }
}
