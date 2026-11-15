import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';

/**
 * Progressive dashboard building blocks (#757).
 *
 * A dashboard widget owns its data (its own React Query hook), its own
 * loading skeleton, and its own failure. `DashboardWidget` adds the two
 * boundaries that make that hold even when a widget suspends (lazy chunk,
 * `useSuspenseQuery`) or throws while rendering: the rest of the board keeps
 * rendering, nothing waits for the slowest widget, and a broken widget shows
 * a contained error card instead of blanking the page.
 */

export function WidgetSkeleton({ lines = 3, label = 'Loading' }: { lines?: number; label?: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="space-y-2">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

interface BoundaryState {
  error: Error | null;
}

class WidgetErrorBoundary extends Component<{ title: string; children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Contained by design; keep a trace for debugging without rethrowing.
    console.error(`[dashboard] widget "${this.props.title}" failed`, error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm text-destructive">
          <span>{this.props.title} is unavailable.</span>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded border border-border px-2 py-0.5 text-xs text-foreground hover:bg-muted"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface DashboardWidgetProps {
  title: string;
  /** Optional right-aligned header content (e.g. a "see all" link). */
  action?: ReactNode;
  /** Skeleton shown while the widget's code or suspense data loads. */
  fallback?: ReactNode;
  children: ReactNode;
}

export function DashboardWidget({ title, action, fallback, children }: DashboardWidgetProps) {
  return (
    <section aria-label={title} className="rounded-lg border bg-background p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      <WidgetErrorBoundary title={title}>
        <Suspense fallback={fallback ?? <WidgetSkeleton label={`Loading ${title}`} />}>{children}</Suspense>
      </WidgetErrorBoundary>
    </section>
  );
}
