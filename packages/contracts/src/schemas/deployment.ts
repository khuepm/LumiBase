import { z } from 'zod';

/**
 * Shared validation schemas for deployment integrations (spec:
 * deployment-integrations). Used by the CMS routes and the Studio/SDK clients
 * so both sides agree on the contract.
 */

export const DeploymentProviderSchema = z.enum(['vercel', 'netlify']);
export type DeploymentProviderKey = z.infer<typeof DeploymentProviderSchema>;

export const DeploymentStatusSchema = z.enum(['queued', 'building', 'ready', 'error', 'canceled']);
export type DeploymentStatusValue = z.infer<typeof DeploymentStatusSchema>;

export const DeploymentTargetCreateSchema = z.object({
  provider: DeploymentProviderSchema,
  name: z.string().min(1).max(255),
  projectId: z.string().min(1).max(255),
  token: z.string().min(1),
  defaultBranch: z.string().max(255).nullable().optional(),
  productionUrl: z.string().url().nullable().optional(),
});
export type DeploymentTargetCreateInput = z.infer<typeof DeploymentTargetCreateSchema>;

export const DeploymentTargetUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  projectId: z.string().min(1).max(255).optional(),
  // Token is only re-encrypted when present (rotation).
  token: z.string().min(1).optional(),
  defaultBranch: z.string().max(255).nullable().optional(),
  productionUrl: z.string().url().nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type DeploymentTargetUpdateInput = z.infer<typeof DeploymentTargetUpdateSchema>;

export const DeployTriggerSchema = z.object({
  branch: z.string().max(255).optional(),
  reason: z.string().max(1000).optional(),
});
export type DeployTriggerInput = z.infer<typeof DeployTriggerSchema>;

// ── Environments, promotion and the approval gate (#743) ────────────────────

/** Environment key: lowercase slug, also the `<scope>` of `deploy:trigger:<scope>`. */
export const DeploymentEnvironmentKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Environment key must be a lowercase slug (a-z, 0-9, _ and -).');

export const DeploymentEnvironmentSchema = z.object({
  key: DeploymentEnvironmentKeySchema,
  name: z.string().min(1).max(64),
  /** Deployment targets this environment deploys to (one or more, or none yet). */
  targetIds: z.array(z.string().min(1).max(64)).max(20).default([]),
  /** Trigger/promote into this environment parks a pending approval first. */
  requiresApproval: z.boolean().default(false),
  /** Environment that `POST /environments/:key/promote` promotes into. */
  promotesTo: DeploymentEnvironmentKeySchema.nullable().default(null),
});
export type DeploymentEnvironment = z.infer<typeof DeploymentEnvironmentSchema>;

export const DeploymentEnvironmentsSchema = z
  .array(DeploymentEnvironmentSchema)
  .max(10)
  .superRefine((envs, ctx) => {
    const keys = new Set<string>();
    for (const [i, env] of envs.entries()) {
      if (keys.has(env.key)) {
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `Duplicate environment key '${env.key}'.` });
      }
      keys.add(env.key);
    }
    for (const [i, env] of envs.entries()) {
      if (env.promotesTo === null) continue;
      if (env.promotesTo === env.key) {
        ctx.addIssue({ code: 'custom', path: [i, 'promotesTo'], message: 'An environment cannot promote into itself.' });
      } else if (!keys.has(env.promotesTo)) {
        ctx.addIssue({ code: 'custom', path: [i, 'promotesTo'], message: `Unknown environment '${env.promotesTo}'.` });
      }
    }
  });

export const DeploymentEnvironmentsUpdateSchema = z.object({
  environments: DeploymentEnvironmentsSchema,
});
export type DeploymentEnvironmentsUpdateInput = z.infer<typeof DeploymentEnvironmentsUpdateSchema>;

export const DeployPromoteSchema = z.object({
  /** Deployment in the source environment to promote; defaults to its latest `ready` one. */
  deploymentId: z.string().min(1).max(64).optional(),
  reason: z.string().max(1000).optional(),
});
export type DeployPromoteInput = z.infer<typeof DeployPromoteSchema>;

export const DeployApprovalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(1000).optional(),
});
export type DeployApprovalDecisionInput = z.infer<typeof DeployApprovalDecisionSchema>;
