import { z } from 'zod';

/**
 * Git integration (GitHub / GitLab) Zod validation schemas.
 *
 * Shared by the CMS (request validation) and Studio (form validation). See
 * `.kiro/specs/git-integration/design.md` §4 for the API contracts.
 */

export const GIT_PROVIDERS = ['github', 'gitlab'] as const;
export const GitProviderSchema = z.enum(GIT_PROVIDERS);
export type GitProviderName = z.infer<typeof GitProviderSchema>;

export const GIT_AUTH_METHODS = ['app', 'pat'] as const;
export const GitAuthMethodSchema = z.enum(GIT_AUTH_METHODS);
export type GitAuthMethod = z.infer<typeof GitAuthMethodSchema>;

/** `org/repo` (GitHub) or `group/subgroup/repo` (GitLab). */
const repoFullName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s]+\/[^\s]+$/, 'Expected "owner/repo" form');

/** Create a new integration. Token is required for PAT auth, installationId for app auth. */
export const GitIntegrationCreateSchema = z
  .object({
    provider: GitProviderSchema,
    repoFullName,
    displayName: z.string().min(1).max(128),
    authMethod: GitAuthMethodSchema,
    /** Plaintext PAT / OAuth token (encrypted server-side; never stored raw). */
    token: z.string().min(1).max(4096).optional(),
    installationId: z.string().min(1).max(128).optional(),
    scopes: z.array(z.string()).max(64).optional(),
    syncConfig: z.record(z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.authMethod === 'pat' && !val.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['token'],
        message: 'token is required when authMethod is "pat".',
      });
    }
    if (val.authMethod === 'app' && !val.installationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['installationId'],
        message: 'installationId is required when authMethod is "app".',
      });
    }
  });
export type GitIntegrationCreateInput = z.infer<typeof GitIntegrationCreateSchema>;

/** Update mutable fields of an integration. */
export const GitIntegrationUpdateSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  token: z.string().min(1).max(4096).optional(),
  installationId: z.string().min(1).max(128).optional(),
  status: z.enum(['connected', 'error', 'disconnected']).optional(),
  scopes: z.array(z.string()).max(64).optional(),
  syncConfig: z.record(z.unknown()).optional(),
});
export type GitIntegrationUpdateInput = z.infer<typeof GitIntegrationUpdateSchema>;

/** Public (non-secret) representation returned by the API. */
export interface GitIntegrationResource {
  id: string;
  provider: GitProviderName;
  repoFullName: string;
  displayName: string;
  authMethod: GitAuthMethod;
  status: 'connected' | 'error' | 'disconnected';
  statusReason: string | null;
  scopes: string[];
  /** True when a token / installation is on file (never the value itself). */
  hasToken: boolean;
  /** Public webhook URL the operator registers at the provider. */
  webhookUrl: string;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestResource {
  id: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  ciStatus: 'unknown' | 'pending' | 'success' | 'failure';
  mergeable: boolean | null;
  headSha: string;
  author: string | null;
  previewUrl: string | null;
  updatedAt: string;
}

export interface CiJob {
  name: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface CiRunResource {
  id: string;
  providerRunId: string;
  status: 'queued' | 'in_progress' | 'success' | 'failure' | 'cancelled';
  jobs: CiJob[];
  durationMs: number | null;
  hasStoredLog: boolean;
}
