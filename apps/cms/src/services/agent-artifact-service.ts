import { agentArtifacts, agentEvaluations, type Database } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';

export type AgentArtifactType =
  | 'schema_diff'
  | 'page_spec'
  | 'component_spec'
  | 'seed_data'
  | 'api_spec'
  | 'prompt'
  | 'migration';

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value: unknown): string {
  const input = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class AgentArtifactService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  async createArtifact(input: {
    runId: string;
    type: AgentArtifactType;
    title: string;
    content: Record<string, unknown>;
    target?: string | null;
    contentRef?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  }) {
    const hash = stableHash(input.content);
    const [record] = await this.db
      .insert(agentArtifacts)
      .values({
        runId: input.runId,
        siteId: this.siteId,
        type: input.type,
        title: input.title,
        target: input.target ?? null,
        contentRef: input.contentRef ?? null,
        content: input.content,
        hash,
        status: input.status ?? 'draft',
        metadata: input.metadata ?? {},
      })
      .returning();
    return record!;
  }

  async listArtifacts(runId?: string) {
    const filters = [eq(agentArtifacts.siteId, this.siteId)];
    if (runId) {
      filters.push(eq(agentArtifacts.runId, runId));
    }
    return this.db
      .select()
      .from(agentArtifacts)
      .where(and(...filters))
      .orderBy(desc(agentArtifacts.createdAt))
      .limit(100);
  }

  async publishArtifact(artifactId: string, overrideReason?: string) {
    const [artifact] = await this.db
      .select()
      .from(agentArtifacts)
      .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.siteId, this.siteId)));
    if (!artifact) {
      return { allowed: false, message: 'Artifact not found' };
    }

    const requiresEval = artifact.type === 'schema_diff' || artifact.type === 'migration';
    if (requiresEval && !overrideReason) {
      const [passingEval] = await this.db
        .select()
        .from(agentEvaluations)
        .where(
          and(
            eq(agentEvaluations.siteId, this.siteId),
            eq(agentEvaluations.artifactId, artifactId),
            eq(agentEvaluations.status, 'pass'),
          ),
        )
        .limit(1);
      if (!passingEval) {
        return { allowed: false, message: 'Artifact requires a passing evaluation before publish' };
      }
    }

    const [updated] = await this.db
      .update(agentArtifacts)
      .set({
        status: 'published',
        metadata: {
          ...(artifact.metadata as Record<string, unknown>),
          overrideReason: overrideReason ?? null,
          publishedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.siteId, this.siteId)))
      .returning();

    return { allowed: true, artifact: updated };
  }
}
