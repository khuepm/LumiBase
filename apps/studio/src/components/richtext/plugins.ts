import { useSyncExternalStore } from 'react';
import { getRichTextPlugins, subscribeRichTextPlugins, type RichTextPluginDefinition } from '@lumibase/extension-sdk';
import { collectRichTextBlocks, type RichTextBlock, type RichTextPlugin } from '@lumibase/contracts/richtext';

/**
 * Bridges plugins registered by UI extensions (`registerRichTextPlugin` in
 * `@lumibase/extension-sdk`, #698) to the contracts serialisers and the
 * editor's slash menu.
 */

export function toContractPlugin(p: RichTextPluginDefinition): RichTextPlugin {
  const hook = p.transformMarkdownImport;
  return {
    name: p.name,
    blocks: p.blocks,
    // The SDK types blocks loosely (it is dependency-free); the importer
    // validates whatever a hook returns before using it.
    ...(hook ? { transformMarkdownImport: (blocks: RichTextBlock[]) => hook(blocks as unknown as Array<Record<string, unknown>>) as unknown as RichTextBlock[] } : {}),
  };
}

let cache: { source: RichTextPluginDefinition[]; plugins: RichTextPlugin[] } | null = null;

function snapshot(): RichTextPlugin[] {
  const source = getRichTextPlugins();
  if (cache && cache.source.length === source.length && cache.source.every((p, i) => p === source[i])) return cache.plugins;
  cache = { source, plugins: source.map(toContractPlugin) };
  return cache.plugins;
}

/** Registered rich-text plugins; re-renders when an extension (un)registers one. */
export function useRichTextPlugins(): RichTextPlugin[] {
  return useSyncExternalStore(subscribeRichTextPlugins, snapshot, snapshot);
}

/**
 * Custom blocks offered for a field: plugin blocks, narrowed to
 * `options.customBlocks` when the field sets it (names there without a
 * plugin still get a plain entry, e.g. a block template).
 */
export function customBlocksFor(plugins: readonly RichTextPlugin[], allowed: readonly string[] | undefined) {
  const all = collectRichTextBlocks(plugins);
  if (!allowed) return all;
  return new Map(allowed.map((name) => [name, all.get(name) ?? { label: name }]));
}
