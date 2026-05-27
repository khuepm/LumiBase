import { ChevronRight, FileText, Folder, Languages } from 'lucide-react';
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

    return (
      <div>
        <button
          type="button"
          onClick={() => onToggle(dirPath)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ${expanded ? 'rotate-90' : ''
              }`}
          />
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>

        {expanded && node.children && (
          <div>
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
      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors ${isActive
        ? 'bg-accent font-medium text-accent-foreground'
        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        } ${isMissing ? 'opacity-50' : ''}`}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      aria-current={isActive ? 'page' : undefined}
      title={isMissing ? 'Translation pending' : undefined}
    >
      {isMissing ? (
        <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileText className="h-4 w-4 shrink-0" />
      )}
      <span className="truncate">{node.name}</span>
    </button>
  );
}
