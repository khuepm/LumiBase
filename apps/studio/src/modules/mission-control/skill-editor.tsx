import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  missionControlApi,
  type SiteSkill,
  type SiteSkillContent,
  type SiteSkillRiskClass,
  type SiteSkillSurface,
} from './api';

/**
 * Site Skill editor (#712) — create a draft or edit an existing skill.
 * Every content change the server accepts becomes a new version; the limits
 * below mirror `siteSkillInputSchema` so the obvious mistakes are caught
 * before the round trip. The server stays the authority and its error
 * message is shown verbatim.
 */

/** Equal to the server's per-run injection budget, so any saved skill can be injected. */
export const MAX_SKILL_BODY_CHARS = 12_000;
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RESERVED_SLUGS = ['import', 'export', 'match'];
const SURFACES: readonly SiteSkillSurface[] = ['copilot', 'generation', 'mcp'];
const RISK_CLASSES: readonly SiteSkillRiskClass[] = ['low', 'medium', 'high'];

/** Editor seed: a skill's content plus the slug (editable only on create). */
export type SkillDraft = SiteSkillContent & { slug: string };

export const BLANK_SKILL: SkillDraft = {
  slug: '',
  name: '',
  description: '',
  riskClass: 'low',
  priority: 0,
  triggers: [],
  surfaces: [],
  tools: [],
  collections: [],
  requiredCapabilities: [],
  body: '',
};

export const HOUSE_STYLE_TEMPLATE: SkillDraft = {
  ...BLANK_SKILL,
  slug: 'house-style',
  name: 'House style',
  description: 'Voice, tone and formatting rules every piece of content follows.',
  body: [
    '# House style',
    '',
    '## Voice',
    '- Write in plain, direct language. Prefer short sentences and the active voice.',
    '- Address the reader as "you". Avoid jargon unless the audience expects it.',
    '',
    '## Formatting',
    '- Headlines use sentence case and stay under 70 characters.',
    '- Open with the key point; keep paragraphs to three sentences or fewer.',
    '',
    '## Never',
    '- Never invent quotes, statistics or sources.',
    '- Never make claims about competitors.',
  ].join('\n'),
};

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const inputClass = 'w-full rounded-md border bg-background px-2 py-1.5';

export function SkillEditor({
  skill,
  initial,
  onSaved,
  onCancel,
}: {
  /** The skill being edited; omit to create a new draft. */
  skill?: SiteSkill;
  /** Seed values for a new skill (e.g. the house-style template). */
  initial?: SkillDraft;
  onSaved: (skill: SiteSkill) => void;
  onCancel?: () => void;
}) {
  const seed: SkillDraft = skill ?? initial ?? BLANK_SKILL;
  const [name, setName] = useState(seed.name);
  const [slug, setSlug] = useState(seed.slug);
  const [description, setDescription] = useState(seed.description);
  const [riskClass, setRiskClass] = useState<SiteSkillRiskClass>(seed.riskClass);
  const [priority, setPriority] = useState(String(seed.priority));
  const [surfaces, setSurfaces] = useState<SiteSkillSurface[]>(seed.surfaces);
  const [tools, setTools] = useState(seed.tools.join(', '));
  const [collections, setCollections] = useState(seed.collections.join(', '));
  const [triggers, setTriggers] = useState(seed.triggers.join(', '));
  const [capabilities, setCapabilities] = useState(seed.requiredCapabilities.join(', '));
  const [body, setBody] = useState(seed.body);
  const [changeNote, setChangeNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The server drops leading blank lines and trailing whitespace before the cap applies.
  const storedLength = body.replace(/^\n+/, '').replace(/\s+$/, '').length;

  const saveMutation = useMutation({
    mutationFn: () => {
      const content: SiteSkillContent = {
        name: name.trim(),
        description: description.trim(),
        riskClass,
        priority: Number(priority),
        triggers: splitList(triggers),
        surfaces,
        tools: splitList(tools),
        collections: splitList(collections),
        requiredCapabilities: splitList(capabilities),
        body,
      };
      const note = changeNote.trim();
      const meta = note ? { changeNote: note } : {};
      return skill
        ? missionControlApi.updateSkill(skill.id, {
            ...content,
            ...meta,
            // The version this form was seeded from: a save over someone
            // else's newer edit is refused instead of silently replacing it.
            expectedVersion: skill.version,
          })
        : missionControlApi.createSkill({ slug: slug.trim(), ...content, ...meta });
    },
    onSuccess: (saved) => {
      setError(null);
      setChangeNote('');
      onSaved(saved);
    },
    onError: (err: Error) => setError(err.message),
  });

  function validate(): string | null {
    if (!name.trim()) return 'Name is required.';
    if (!skill) {
      const candidate = slug.trim();
      if (!SLUG_PATTERN.test(candidate) || candidate.length > 64) {
        return 'Slug must be lowercase letters, digits and single hyphens (max 64 characters).';
      }
      if (RESERVED_SLUGS.includes(candidate)) return `Slug "${candidate}" is reserved.`;
    }
    const numericPriority = Number(priority);
    if (
      priority.trim() === '' ||
      !Number.isInteger(numericPriority) ||
      numericPriority < -100 ||
      numericPriority > 100
    ) {
      return 'Priority must be a whole number between -100 and 100.';
    }
    if (body.trim().length === 0) return 'Body is required.';
    if (storedLength > MAX_SKILL_BODY_CHARS) {
      return `Body is over the ${MAX_SKILL_BODY_CHARS.toLocaleString('en-US')} character limit.`;
    }
    return null;
  }

  function submit() {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    saveMutation.mutate();
  }

  function toggleSurface(surface: SiteSkillSurface) {
    setSurfaces((current) =>
      current.includes(surface) ? current.filter((s) => s !== surface) : [...current, surface],
    );
  }

  const overLimit = storedLength > MAX_SKILL_BODY_CHARS;

  return (
    <form
      className="space-y-3"
      aria-label={skill ? `Edit skill ${skill.slug}` : 'New skill'}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-xs text-muted-foreground">
        A skill is instruction text for agents. It never grants permissions.
      </p>

      {skill?.status === 'active' && (
        <p
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
        >
          This skill is active — saving changes agent behaviour immediately.
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Name *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className={inputClass}
          />
        </label>
        <div className="text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Slug *</span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={Boolean(skill)}
              maxLength={64}
              placeholder="house-style"
              className={`${inputClass} font-mono disabled:opacity-60`}
            />
          </label>
          {skill && (
            <span className="mt-1 block text-muted-foreground">The slug cannot change.</span>
          )}
        </div>
        <label className="text-xs sm:col-span-2">
          <span className="mb-1 block text-muted-foreground">Description</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            className={inputClass}
          />
        </label>
        <div className="text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Risk class</span>
            <select
              value={riskClass}
              onChange={(e) => setRiskClass(e.target.value as SiteSkillRiskClass)}
              className={inputClass}
            >
              {RISK_CLASSES.map((risk) => (
                <option key={risk} value={risk}>
                  {risk}
                </option>
              ))}
            </select>
          </label>
          <span className="mt-1 block text-muted-foreground">
            A label for review priority. It does not change who can edit or activate.
          </span>
        </div>
        <div className="text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Priority</span>
            <input
              type="number"
              min={-100}
              max={100}
              step={1}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className={inputClass}
            />
          </label>
          <span className="mt-1 block text-muted-foreground">
            -100 to 100. Higher goes first when several skills match.
          </span>
        </div>
      </div>

      <fieldset className="text-xs">
        <legend className="mb-1 text-muted-foreground">Surfaces</legend>
        <div className="flex flex-wrap gap-3">
          {SURFACES.map((surface) => (
            <label key={surface} className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={surfaces.includes(surface)}
                onChange={() => toggleSurface(surface)}
              />
              {surface}
            </label>
          ))}
        </div>
        <p className="mt-1 text-muted-foreground">
          Leave surfaces, tools and collections empty to apply everywhere.
        </p>
      </fieldset>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Tools</span>
          <input
            value={tools}
            onChange={(e) => setTools(e.target.value)}
            placeholder="comma-separated"
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">Collections</span>
          <input
            value={collections}
            onChange={(e) => setCollections(e.target.value)}
            placeholder="comma-separated"
            className={`${inputClass} font-mono`}
          />
        </label>
        <div className="text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Triggers</span>
            <input
              value={triggers}
              onChange={(e) => setTriggers(e.target.value)}
              placeholder="comma-separated keywords"
              className={inputClass}
            />
          </label>
          <span className="mt-1 block text-muted-foreground">
            Keywords matched against the request text. Empty = always applies within scope.
          </span>
        </div>
        <div className="text-xs">
          <label className="block">
            <span className="mb-1 block text-muted-foreground">Required capabilities</span>
            <input
              value={capabilities}
              onChange={(e) => setCapabilities(e.target.value)}
              placeholder="comma-separated"
              className={`${inputClass} font-mono`}
            />
          </label>
          <span className="mt-1 block text-muted-foreground">
            Only runs that already hold these receive the skill.
          </span>
        </div>
      </div>

      <div className="block text-xs">
        <label className="block">
          <span className="mb-1 block text-muted-foreground">Body (Markdown) *</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          />
        </label>
        <span
          className={`mt-1 block ${overLimit ? 'text-destructive' : 'text-muted-foreground'}`}
          data-testid="skill-body-count"
        >
          {storedLength.toLocaleString('en-US')} / {MAX_SKILL_BODY_CHARS.toLocaleString('en-US')}{' '}
          characters
        </span>
      </div>

      <label className="block text-xs">
        <span className="mb-1 block text-muted-foreground">Change note (optional)</span>
        <input
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          maxLength={500}
          placeholder="What changed and why"
          className={inputClass}
        />
      </label>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saveMutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {saveMutation.isPending ? 'Saving…' : skill ? 'Save changes' : 'Create draft'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
