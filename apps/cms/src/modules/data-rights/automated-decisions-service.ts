/**
 * Automated-decision transparency (GDPR Art. 22 / Art. 13(2)(f)).
 *
 * Surfaces agent-authored revisions made to the user's own content, with their
 * provenance (model, sources, confidence), so a data subject can see where
 * automated processing affected their data and ask for human review.
 */

import type { Database } from '@lumibase/database';
import { items, revisions } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';

const LIMIT = 500;

export interface AutomatedDecision {
  revisionId: string;
  itemId: string;
  collectionId: string;
  model: string | null;
  sources: unknown;
  confidence: number | null;
  createdAt: string;
}

export interface AutomatedDecisionsServiceDeps {
  db: Database;
}

export class AutomatedDecisionsService {
  private readonly db: Database;

  constructor(deps: AutomatedDecisionsServiceDeps) {
    this.db = deps.db;
  }

  /** Agent-authored revisions on items created by the user. */
  async list(params: { siteId: string; userId: string }): Promise<AutomatedDecision[]> {
    const rows = await this.db
      .select({
        revisionId: revisions.id,
        itemId: revisions.itemId,
        collectionId: revisions.collectionId,
        model: revisions.model,
        sources: revisions.sources,
        confidence: revisions.confidence,
        createdAt: revisions.createdAt,
      })
      .from(revisions)
      .innerJoin(items, eq(revisions.itemId, items.id))
      .where(
        and(
          eq(revisions.siteId, params.siteId),
          eq(revisions.authorType, 'agent'),
          eq(items.userCreated, params.userId),
        ),
      )
      .orderBy(desc(revisions.createdAt))
      .limit(LIMIT);

    return rows.map((r) => ({
      revisionId: r.revisionId,
      itemId: r.itemId,
      collectionId: r.collectionId,
      model: r.model ?? null,
      sources: r.sources ?? null,
      confidence: r.confidence ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
