/**
 * Content/schema validation for a pull request, posted back to the provider as
 * a `lumibase/content-validation` check. Currently validates the optional GitOps
 * config file (`lumibase/intents.json`) at the PR head — absent config passes,
 * malformed config fails. Designed to grow more rules over time.
 */
import { intentInputSchema } from '../../services/intent-service';
import { GITOPS_INTENTS_PATH } from './constants';
import type { GitProvider, RepoRef } from './providers/types';

export interface ValidationResult {
  state: 'success' | 'failure';
  summary: string;
}

export async function validatePullRequest(
  provider: GitProvider,
  repo: RepoRef,
  headSha: string,
): Promise<ValidationResult> {
  let raw: string | null;
  try {
    raw = await provider.getFileContents(repo, GITOPS_INTENTS_PATH, headSha);
  } catch {
    // Treat read failure as "nothing to validate" rather than a hard failure.
    return { state: 'success', summary: 'No LumiBase config found to validate.' };
  }
  if (!raw) {
    return { state: 'success', summary: 'No LumiBase config found to validate.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: 'failure',
      summary: `${GITOPS_INTENTS_PATH} is not valid JSON.`,
    };
  }

  const intents = Array.isArray(parsed) ? parsed : [parsed];
  const errors: string[] = [];
  intents.forEach((intent, i) => {
    const res = intentInputSchema.safeParse(intent);
    if (!res.success) {
      errors.push(
        `intent[${i}]: ${res.error.issues.map((x) => x.message).join('; ')}`,
      );
    }
  });

  if (errors.length > 0) {
    return {
      state: 'failure',
      summary: `Invalid intent config: ${errors.slice(0, 3).join(' | ')}`,
    };
  }
  return {
    state: 'success',
    summary: `${intents.length} intent(s) validated.`,
  };
}
