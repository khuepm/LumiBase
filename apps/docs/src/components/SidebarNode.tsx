import { ChevronRight, Languages } from 'lucide-react';
import type { DocNode } from 'virtual:docs-registry';

interface SidebarNodeProps {
  node: DocNode;
  activeSlug: string;
  onNavigate: (slug: string) => void;
  level: number;
  isExpanded: (path: string) => boolean;
  onToggle: (path: string) => void;
  parentPath: string;
  missingSlugs: Set<string>;
}

/**
 * Recursive tree node for the sidebar navigation.
 * Renders directories as collapsible groups and files as clickable links.
 * Expanded/collapsed state is managed externally via props (backed by localStorage).
 * Slugs missing in the active locale are rendered with reduced opacity and a
 * translate-pending icon.
 *
 * Styling follows the LumiBase "dark cosmic" design system:
 * - Top-level directories render as uppercase section headers
 * - Links: 500 14px muted, hover white; active: white on violet glass + inset ring
 *
 * Requirements: 3.1, 3.4, 3.5, 4.4, 4.5, 4.6
 */
export function SidebarNode({
  node,
  activeSlug,
  onNavigate,
  level,
  isExpanded,
  onToggle,
  parentPath,
  missingSlugs,
}: SidebarNodeProps) {
  if (node.type === 'directory') {
    // Build a unique path for this directory node for state persistence
    const dirPath = parentPath ? `${parentPath}/${node.name}` : node.name;
    const expanded = isExpanded(dirPath);
    const isSection = level === 0;

    return (
      <div className={isSection ? 'mb-3' : undefined}>
        <button
          type="button"
          onClick={() => onToggle(dirPath)}
          className={`flex w-full items-center gap-1.5 rounded-[10px] px-3 py-[7px] text-left transition-colors ${
            isSection
              ? 'text-[12px] font-semibold uppercase tracking-[0.6px] text-[rgb(130,130,138)] hover:text-white'
              : 'text-[14px] font-medium text-[rgb(170,170,176)] hover:text-white'
          }`}
          style={{ paddingLeft: `${level * 12 + 12}px` }}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-[rgb(130,130,138)] transition-transform duration-150 ${
              expanded ? 'rotate-90' : ''
            }`}
          />
          <span className="truncate">{node.name}</span>
        </button>

        {expanded && node.children && (
          <div className="flex flex-col gap-0.5">
            {node.children.map((child) => (
              <SidebarNode
                key={child.type === 'file' ? child.slug : child.name}
                node={child}
                activeSlug={activeSlug}
                onNavigate={onNavigate}
                level={level + 1}
                isExpanded={isExpanded}
                onToggle={onToggle}
                parentPath={dirPath}
                missingSlugs={missingSlugs}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File node
  const isActive = node.slug === activeSlug;
  const isMissing = node.slug ? missingSlugs.has(node.slug) : false;

  return (
    <button
      type="button"
      onClick={() => node.slug && onNavigate(node.slug)}
      className={`flex w-full items-center gap-1.5 rounded-[10px] px-3 py-[7px] text-left text-[14px] transition-colors ${
        isActive
          ? 'bg-[rgba(123,97,255,0.16)] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(123,97,255,0.30)]'
          : 'font-medium text-[rgb(170,170,176)] hover:text-white'
      } ${isMissing ? 'opacity-50' : ''}`}
      style={{ paddingLeft: `${level * 12 + 12}px` }}
      aria-current={isActive ? 'page' : undefined}
      title={isMissing ? 'Translation pending' : undefined}
    >
      {isMissing && (
        <Languages className="h-4 w-4 shrink-0 text-[rgb(130,130,138)]" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
}
