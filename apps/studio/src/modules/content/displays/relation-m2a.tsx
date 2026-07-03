import { Layers } from 'lucide-react';
import type { DisplayComponent } from './types';

interface M2ABlock {
  collection: string;
  id: string;
}

/**
 * `relation-m2a` display — summarises a many-to-any value as
 * "n linked across k collections" for list cells.
 */
export const RelationM2ADisplay: DisplayComponent<M2ABlock[]> = ({ value }) => {
  const blocks = Array.isArray(value) ? value : [];
  if (blocks.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const collections = new Set(blocks.map((b) => b.collection));
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Layers className="h-3 w-3" />
      {blocks.length} linked across {collections.size} collection{collections.size === 1 ? '' : 's'}
    </span>
  );
};
