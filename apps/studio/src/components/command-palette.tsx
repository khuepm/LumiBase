import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';
import { NAV_COMMANDS, withAdminBase, type NavCommand } from '@/lib/keybindings/commands';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** Active admin-path prefix ('' when served at root) for building targets. */
  adminBase: string;
}

/**
 * VSCode-style quick-open (Cmd/Ctrl+K). A controlled overlay built on `cmdk`
 * (fuzzy filtering, keyboard navigation, a11y) wrapped in the Studio's
 * existing Tailwind modal pattern. Open state is owned by `AppShell`; this
 * component only renders + navigates.
 */
export function CommandPalette({ open, onClose, adminBase }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  // Reset the query each time the palette opens so it never reopens stale.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  // Esc closes. (Cmd+K toggling is handled by the global dispatcher in AppShell.)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, onClose]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, NavCommand[]>();
    for (const cmd of NAV_COMMANDS) {
      const list = byGroup.get(cmd.group) ?? [];
      list.push(cmd);
      byGroup.set(cmd.group, list);
    }
    return [...byGroup.entries()];
  }, []);

  if (!open) return null;

  const run = (to: string) => {
    onClose();
    navigate({ to: withAdminBase(adminBase, to) as never });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <Command label="Command palette" loop>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder="Jump to a screen…"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Esc
            </kbd>
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
              No matching screens.
            </Command.Empty>
            {groups.map(([groupName, items]) => (
              <Command.Group
                key={groupName}
                heading={groupName}
                className="px-1 py-1 text-xs font-medium text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1"
              >
                {items.map((item) => (
                  <Command.Item
                    key={item.id}
                    value={`${item.title} ${(item.keywords ?? []).join(' ')}`}
                    onSelect={() => run(item.to)}
                    className={cn(
                      'flex cursor-pointer items-center rounded-md px-2 py-2 text-sm text-foreground',
                      'aria-selected:bg-accent aria-selected:text-accent-foreground',
                    )}
                  >
                    {item.title}
                  </Command.Item>
                ))}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
