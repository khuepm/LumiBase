import { useConnectionStatus } from '@/hooks/use-realtime';

/**
 * Realtime connection indicator for the app-shell header
 * (realtime-subscriptions Req 5.3). A small dot: green when connected, amber
 * while connecting, grey when disconnected.
 */

const META = {
  connected: { color: 'bg-green-500', label: 'Realtime connected' },
  connecting: { color: 'bg-amber-500', label: 'Realtime connecting' },
  disconnected: { color: 'bg-muted-foreground', label: 'Realtime disconnected' },
} as const;

export function ConnectionStatusDot() {
  const status = useConnectionStatus();
  const meta = META[status];
  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      role="status"
      className="inline-flex h-9 w-6 items-center justify-center"
    >
      <span className={`h-2 w-2 rounded-full ${meta.color}`} />
    </span>
  );
}
