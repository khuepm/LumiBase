import { Link } from '@tanstack/react-router';
import type { FileText } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, Ref } from 'react';
import { cn } from '@/lib/cn';
import { useInboxData } from '@/modules/mission-control/use-inbox';

export interface ModuleDef {
  id: string;
  label: string;
  icon: typeof FileText;
  to: string;
}

/**
 * Exception count on the Mission Control icon (content-os-ui task 7; Req
 * 6.1-6.4). Editors working in other modules must not miss a ticking veto
 * window. Shares the inbox query cache with Mission Control, hides itself
 * entirely at zero or when the data is unavailable.
 */
export function MissionControlBadge() {
  const { counts } = useInboxData();
  if (counts.total === 0) return null;
  return (
    <span
      aria-label={`${counts.total} exceptions awaiting attention`}
      className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground"
    >
      {counts.total > 9 ? '9+' : counts.total}
    </span>
  );
}

export interface ModuleNavItemProps {
  module: ModuleDef;
  active: boolean;
  adminBase: string;
  expanded: boolean;
  editing: boolean;
  /** Drag wiring, supplied only by the lazily loaded sortable list. */
  containerRef?: Ref<HTMLDivElement>;
  containerStyle?: CSSProperties;
  dragging?: boolean;
  handleProps?: HTMLAttributes<HTMLButtonElement>;
}

/**
 * One sidebar module entry. Rendered as a plain link on boot; the sortable
 * list (`sortable-module-nav.tsx`, loaded only when an admin starts
 * reordering — #757) reuses it with drag handles so both modes look the same.
 */
export function ModuleNavItem({
  module,
  active,
  adminBase,
  expanded,
  editing,
  containerRef,
  containerStyle,
  dragging = false,
  handleProps,
}: ModuleNavItemProps) {
  const Icon = module.icon;
  const className = cn(
    'relative flex h-10 items-center rounded-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
    expanded ? 'w-full gap-3 px-3' : 'w-10 justify-center',
    active && !editing ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
    editing && 'cursor-grab active:cursor-grabbing',
  );
  const contents = <><Icon className="h-5 w-5 shrink-0" aria-hidden="true" />{expanded && <span className="truncate text-sm">{module.label}</span>}{module.id === 'mission-control' && !editing && <MissionControlBadge />}</>;
  return (
    <div ref={containerRef} style={containerStyle} className={cn('w-full', dragging && 'opacity-70')}>
      {editing ? (
        <button type="button" aria-label={`Move ${module.label}`} className={className} {...handleProps}>
          {contents}
        </button>
      ) : (
        <Link to={`${adminBase}${module.to === '/' ? '' : module.to}` || '/'} aria-label={module.label} aria-current={active ? 'page' : undefined} title={module.label} className={className}>
          {contents}
        </Link>
      )}
    </div>
  );
}
