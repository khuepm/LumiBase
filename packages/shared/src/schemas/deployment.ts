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
