import { Map as MapIcon, Table2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export type ListLayout = 'table' | 'map';

/** Table / Map switch for the items list (#746). */
export function ListLayoutToggle({ value, onChange }: { value: ListLayout; onChange: (next: ListLayout) => void }) {
  const option = (id: ListLayout, label: string, Icon: typeof Table2) => (
    <button
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs', value === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted')}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Layout" className="inline-flex overflow-hidden rounded-md border">
      {option('table', 'Table', Table2)}
      {option('map', 'Map', MapIcon)}
    </div>
  );
}
