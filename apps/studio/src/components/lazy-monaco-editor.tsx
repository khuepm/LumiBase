import { lazy, Suspense, type ComponentProps } from 'react';
import type MonacoEditor from '@monaco-editor/react';

/**
 * Monaco behind a component boundary (#757).
 *
 * `@monaco-editor/react` is only a thin wrapper — the editor itself is
 * fetched by its loader at runtime — but importing the wrapper statically
 * from a route component still ships it (and its loader) with every page
 * that *might* show an editor, e.g. the item detail page via the `code` /
 * raw-JSON interfaces. Going through this module defers the wrapper until an
 * editor actually mounts, and gives every editor the same sized placeholder
 * so the layout does not jump while it loads.
 *
 * Drop-in replacement: `import Editor from '@/components/lazy-monaco-editor'`.
 */

const Editor = lazy(() => import('@monaco-editor/react'));

export type LazyMonacoEditorProps = ComponentProps<typeof MonacoEditor>;

export function MonacoEditorFallback({ height }: { height?: LazyMonacoEditorProps['height'] }) {
  return (
    <div
      role="status"
      aria-label="Loading editor"
      data-testid="monaco-editor-fallback"
      style={{ height: height ?? '100%' }}
      className="flex min-h-24 w-full items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-xs text-muted-foreground"
    >
      Loading editor…
    </div>
  );
}

export function LazyMonacoEditor(props: LazyMonacoEditorProps) {
  return (
    <Suspense fallback={<MonacoEditorFallback height={props.height} />}>
      <Editor {...props} />
    </Suspense>
  );
}

export default LazyMonacoEditor;
