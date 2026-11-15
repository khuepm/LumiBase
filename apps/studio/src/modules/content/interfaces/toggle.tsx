import { cn } from '@/lib/cn';
import type { InterfaceComponent } from './types';

/** `toggle` / `boolean` — visual switch. */
export const ToggleInterface: InterfaceComponent<boolean> = ({
  value,
  disabled,
  onChange,
}) => {
  const checked = value === true;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-background transition',
          // The knob slides along the inline axis: mirrored for RTL (#761).
          checked ? 'translate-x-[18px] rtl:-translate-x-[18px]' : 'translate-x-1 rtl:-translate-x-1',
        )}
      />
    </button>
  );
};
