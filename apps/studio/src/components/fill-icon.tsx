import type { LucideIcon, LucideProps } from 'lucide-react';

/**
 * Project icon convention (content-os-ui Req 13.1): lucide rendered in the
 * filled style. One place to tune the look — new surfaces take their main
 * glyphs through this instead of styling each lucide icon ad hoc.
 */
export function FillIcon({
  icon: Icon,
  ...props
}: { icon: LucideIcon } & Omit<LucideProps, 'ref'>) {
  return <Icon fill="currentColor" strokeWidth={1.5} {...props} />;
}
