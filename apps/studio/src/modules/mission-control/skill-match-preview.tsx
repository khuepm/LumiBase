import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { missionControlApi, type SiteSkillMatchInput, type SiteSkillSurface } from './api';

const SURFACES: readonly SiteSkillSurface[] = ['copilot', 'generation', 'mcp'];
const inputClass = 'w-full rounded-md border bg-background px-2 py-1.5';

/**
 * "Test match" (#712): which active skills a run with this context would
 * receive, and the exact instruction block. The server evaluates it with the
 * caller's own capabilities.
 */
export function SkillMatchPreview() {
  const [surface, setSurface] = useState<SiteSkillSurface>('copilot');
  const [tool, setTool] = useState('');
  const [collection, setCollection] = useState('');
  const [text, setText] = useState('');

  const matchMutation = useMutation({
    mutationFn: () => {
      const input: SiteSkillMatchInput = { surface };
      if (tool.trim()) input.tool = tool.trim();
      if (collection.trim()) input.collection = collection.trim();
      if (text.trim()) input.text = text;
      return missionControlApi.matchSkills(input);
    },
  });

  const result = matchMutation.data;

  return (
    <section className="space-y-2" aria-label="Test match">
      <h3 className="text-sm font-semibold">Test match</h3>
      <p className="text-xs text-muted-foreground">
        Preview which active skills a run would receive. Only active skills are injected; the
        preview uses your own capabilities.
      </p>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          matchMutation.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Surface</span>
            <select
              value={surface}
              onChange={(e) => setSurface(e.target.value as SiteSkillSurface)}
              className={inputClass}
            >
              {SURFACES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Tool (optional)</span>
            <input
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              maxLength={120}
              className={`${inputClass} font-mono`}
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block text-muted-foreground">Collection (optional)</span>
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              maxLength={120}
              className={`${inputClass} font-mono`}
            />
          </label>
        </div>
        <label className="block text-xs">
          <span className="mb-1 block text-muted-foreground">Sample request text</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={8000}
            placeholder='e.g. "Write a product announcement for the spring sale"'
            className="w-full rounded-md border bg-background p-2 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={matchMutation.isPending}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {matchMutation.isPending ? 'Matching…' : 'Test match'}
        </button>
      </form>

      {matchMutation.isError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {matchMutation.error.message}
        </p>
      )}

      {result && (
        <div className="space-y-2 text-xs" aria-label="Match result">
          {result.skills.length === 0 ? (
            <p className="text-muted-foreground">No active skill applies to this run.</p>
          ) : (
            <div>
              <p className="mb-1 text-muted-foreground">Would apply, in order:</p>
              <ul className="flex flex-wrap gap-1.5">
                {result.skills.map((skill) => (
                  <li key={skill.slug}>
                    <code className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">
                      {skill.slug}@{skill.version}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.skipped.length > 0 && (
            <div>
              <p className="mb-1 text-muted-foreground">
                Matched but skipped — over the injection budget:
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {result.skipped.map((slug) => (
                  <li key={slug}>
                    <code className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
                      {slug}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.prompt && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-xs">
              {result.prompt}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
