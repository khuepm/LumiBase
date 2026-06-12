import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { missionControlApi } from './api';

/**
 * Intent composer (content-os task 18.2; Req 16.5) — the primary CTA of
 * Mission Control: describe the desired state in natural language, review
 * the compiled rules, then confirm. Compilation never auto-activates; the
 * human always confirms the compiled form (Req 5.5). Form editing remains
 * available as the secondary path via the JSON review step.
 */
export function IntentComposer({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [compiledJson, setCompiledJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const compileMutation = useMutation({
    mutationFn: () => missionControlApi.compileIntent(text),
    onSuccess: (data) => {
      setCompiledJson(JSON.stringify(data, null, 2));
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () => missionControlApi.createIntent(JSON.parse(compiledJson) as Record<string, unknown>),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-intents'] });
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
      <div className="w-full max-w-2xl rounded-lg border bg-background p-4 shadow-xl">
        <h2 className="mb-3 inline-flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-4 w-4 text-primary" /> Compose a content intent
        </h2>
        {error && (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Describe the desired state of your content
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              placeholder='e.g. "All published articles must have a meta description and be fresher than 90 days."'
              className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
            />
          </label>
          <button
            type="button"
            onClick={() => compileMutation.mutate()}
            disabled={!text.trim() || compileMutation.isPending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {compileMutation.isPending ? 'Compiling…' : 'Compile to rules'}
          </button>

          <label className="block text-xs font-medium text-muted-foreground">
            Review the compiled intent (editable — this is the form path)
            <textarea
              value={compiledJson}
              onChange={(e) => setCompiledJson(e.target.value)}
              rows={10}
              placeholder="Compiled intent JSON appears here for confirmation."
              className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-xs"
            />
          </label>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => createMutation.mutate()}
              disabled={!compiledJson.trim() || createMutation.isPending}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {createMutation.isPending ? 'Creating…' : 'Confirm & create intent'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
