import type { DocNode } from 'virtual:docs-registry';
import { docSlugsByLocale } from 'virtual:docs-registry';
import { useMemo } from 'react';
import { useSidebarState } from '../hooks/useSidebarState';
import { useT } from '../hooks/useT';
import { SidebarNode } from './SidebarNode';

interface SidebarProps {
  tree: DocNode[];
  activeSlug: string;
  onNavigate: (slug: string) => void;
  locale: string;
}

/**
 * Sidebar navigation component.
 * Renders the full Doc Tree as a recursive collapsible tree.
 *
 * - Directories render as collapsible groups
 * - Files render as clickable links
 * - Active doc is highlighted based on current route slug
 * - Expanded/collapsed state is persisted in localStorage
 * - Slugs missing in the active locale are visually marked
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.4, 4.5, 4.6
 */
export function Sidebar({ tree, activeSlug, onNavigate, locale }: SidebarProps) {
  const { isExpanded, toggle } = useSidebarState();
  const t = useT();

  // Build a set of slugs available in the active locale
  const localeSlugs = useMemo(() => {
    const slugs = docSlugsByLocale[locale] ?? [];
    return new Set(slugs);
  }, [locale]);

  // Compute missing slugs: slugs in the tree that are NOT in the active locale
  const missingSlugs = useMemo(() => {
    const missing = new Set<string>();
    function walk(nodes: DocNode[]) {
      for (const node of nodes) {
        if (node.type === 'file' && node.slug && !localeSlugs.has(node.slug)) {
          missing.add(node.slug);
        }
        if (node.type === 'directory' && node.children) {
          walk(node.children);
        }
      }
    }
    walk(tree);
    return missing;
  }, [tree, localeSlugs]);

  if (tree.length === 0) {
    return (
      <div className="p-4">
        <p className="text-sm text-muted-foreground">{t('sidebar.empty')}</p>
      </div>
    );
  }

  return (
    <nav className="flex flex-col gap-0.5 p-2" aria-label="Documentation navigation">
      {tree.map((node) => (
        <SidebarNode
          key={node.type === 'file' ? node.slug : node.name}
          node={node}
          activeSlug={activeSlug}
          onNavigate={onNavigate}
          level={0}
          isExpanded={isExpanded}
          onToggle={toggle}
          parentPath=""
          missingSlugs={missingSlugs}
        />
      ))}
    </nav>
  );
}
