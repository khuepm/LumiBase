import { agentArtifacts, agentEvaluations, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { stableHash } from './agent-artifact-service';
import { agentEvaluationsTotal } from './agent-metrics';

export class AgentEvaluationService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  async evaluateArtifact(input: {
    runId: string;
    artifactId: string;
    kind?: string;
  }) {
    const [artifact] = await this.db
      .select()
      .from(agentArtifacts)
      .where(and(eq(agentArtifacts.id, input.artifactId), eq(agentArtifacts.siteId, this.siteId)));
    if (!artifact) {
      throw new Error('Artifact not found');
    }

    const content = artifact.content as Record<string, unknown>;
    const issues: string[] = [];
    if (!content || typeof content !== 'object') {
      issues.push('Artifact content must be a JSON object.');
    }
    if ((artifact.type === 'schema_diff' || artifact.type === 'migration') && !content['operations'] && !content['diff']) {
      issues.push('Schema and migration artifacts must include operations or diff.');
    }
    if (artifact.type === 'api_spec' && !content['openapi']) {
      issues.push('API spec artifacts must include an openapi field.');
    }

    const status = issues.length === 0 ? 'pass' : 'fail';
    const [evaluation] = await this.db
      .insert(agentEvaluations)
      .values({
        runId: input.runId,
        siteId: this.siteId,
        artifactId: input.artifactId,
        kind: input.kind ?? defaultKindForArtifact(artifact.type),
        status,
        score: status === 'pass' ? 100 : 0,
        summary: status === 'pass' ? 'Evaluation passed.' : issues.join(' '),
        details: { issues },
        artifactHash: stableHash(content),
      })
      .returning();

    agentEvaluationsTotal.inc({ kind: evaluation!.kind, status: evaluation!.status });
    return evaluation!;
  }
}

function defaultKindForArtifact(type: string): string {
  switch (type) {
    case 'schema_diff':
      return 'schema_validation';
    case 'migration':
      return 'migration_dry_run';
    case 'api_spec':
      return 'api_spec_validation';
    case 'prompt':
      return 'prompt_safety';
    default:
      return 'json_schema_validation';
  }
}
