import { agentArtifacts, agentMemory, agentRuns, type Database } from '@lumibase/database';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { maskSecrets } from './agent-run-service';

export class AgentMemoryService {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  async writeMemory(input: {
    scope: string;
    content: string;
    sourceType: string;
    scopeId?: string | null;
    sourceId?: string | null;
    confidence?: number;
    metadata?: Record<string, unknown>;
    expiresAt?: Date | null;
  }) {
    const [record] = await this.db
      .insert(agentMemory)
      .values({
        siteId: this.siteId,
        scope: input.scope,
        scopeId: input.scopeId ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        content: redact(input.content),
        confidence: input.confidence ?? 100,
        metadata: maskSecrets(input.metadata ?? {}) as Record<string, unknown>,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    return record!;
  }

  async buildContext(input: { scope?: string; scopeId?: string | null; limit?: number } = {}) {
    const now = new Date();
    const filters = [
      eq(agentMemory.siteId, this.siteId),
      or(isNull(agentMemory.expiresAt), gt(agentMemory.expiresAt, now)),
    ];
    if (input.scope) {
      filters.push(eq(agentMemory.scope, input.scope));
    }
    if (input.scopeId) {
      filters.push(eq(agentMemory.scopeId, input.scopeId));
    }

    const [memories, runs, artifacts] = await Promise.all([
      this.db.select().from(agentMemory).where(and(...filters)).orderBy(desc(agentMemory.createdAt)).limit(input.limit ?? 20),
      this.db.select().from(agentRuns).where(eq(agentRuns.siteId, this.siteId)).orderBy(desc(agentRuns.createdAt)).limit(10),
      this.db.select().from(agentArtifacts).where(eq(agentArtifacts.siteId, this.siteId)).orderBy(desc(agentArtifacts.createdAt)).limit(10),
    ]);

    return {
      siteId: this.siteId,
      memories: memories.map((memory) => ({ ...memory, content: redact(memory.content) })),
      recentRuns: runs,
      approvedArtifacts: artifacts.filter((artifact) => artifact.status === 'approved' || artifact.status === 'published'),
    };
  }
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [masked]')
    .replace(/(api[_-]?key|token|secret|password)=([^\s&]+)/gi, '$1=[masked]');
}
