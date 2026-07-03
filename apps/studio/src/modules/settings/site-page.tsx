import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SiteConfigUpdateSchema, normalizeSiteUrl } from '@lumibase/shared/schemas';
import type { SiteResource } from '@lumibase/sdk';
import { Globe, Palette, Code2, Save, Check, AlertTriangle } from 'lucide-react';
import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { getApiClient } from '@/lib/api';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';

/** The few theme tokens we surface as color pickers in the UI. */
const EDITABLE_TOKENS: { token: string; label: string }[] = [
  { token: '--primary', label: 'Primary' },
  { token: '--accent', label: 'Accent' },
  { token: '--background', label: 'Background' },
  { token: '--foreground', label: 'Foreground' },
];

interface SiteFormValues {
  displayTitle: string;
  siteUrl: string;
  domain: string;
  descriptor: string;
  defaultLanguage: string;
  defaultAppearance: 'auto' | 'light' | 'dark';
  branding: { logoUrl: string; faviconUrl: string; brandColor: string };
  themeOverrides: { light: Record<string, string>; dark: Record<string, string> };
  customCss: string;
}

function toFormValues(site: SiteResource): SiteFormValues {
  return {
    displayTitle: site.displayTitle ?? '',
    siteUrl: site.siteUrl ?? '',
    domain: site.domain ?? '',
    descriptor: site.descriptor ?? '',
    defaultLanguage: site.defaultLanguage ?? 'en',
    defaultAppearance: (site.defaultAppearance as SiteFormValues['defaultAppearance']) ?? 'auto',
    branding: {
      logoUrl: site.branding?.logoUrl ?? '',
      faviconUrl: site.branding?.faviconUrl ?? '',
      brandColor: site.branding?.brandColor ?? '',
    },
    themeOverrides: {
      light: site.themeOverrides?.light ?? {},
      dark: site.themeOverrides?.dark ?? {},
    },
    customCss: site.customCss ?? '',
  };
}

export function SiteSettingsPage() {
  const client = getApiClient();
  const qc = useQueryClient();

  const siteQuery = useQuery({
    queryKey: ['site-config'],
    queryFn: async () => (await client.site.get()).data,
  });

  const mutation = useMutation({
    mutationFn: (patch: Partial<SiteFormValues>) => client.site.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['site-config'] });
    },
  });

  if (siteQuery.isLoading) {
    return <div className="mx-auto max-w-3xl p-6 text-muted-foreground">Loading…</div>;
  }
  if (siteQuery.isError || !siteQuery.data) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-destructive">
        Failed to load site configuration.
      </div>
    );
  }

  return (
    <SiteSettingsForm
      site={siteQuery.data}
      onSave={(patch) => mutation.mutateAsync(patch)}
      saving={mutation.isPending}
      saved={mutation.isSuccess}
      errorCode={extractDomainTaken(mutation.error)}
    />
  );
}

/** Pull a friendly error code out of the SDK error (e.g. DOMAIN_TAKEN). */
function extractDomainTaken(err: unknown): string | null {
  if (!err) return null;
  const message = err instanceof Error ? err.message : String(err);
  return /DOMAIN_TAKEN/i.test(message) ? 'DOMAIN_TAKEN' : 'GENERIC';
}

interface FormProps {
  site: SiteResource;
  onSave: (patch: Partial<SiteFormValues>) => Promise<unknown>;
  saving: boolean;
  saved: boolean;
  errorCode: string | null;
}

// The PATCH schema is lenient on shape; we validate the editable identity
// fields with the shared rules so Studio and the CMS agree on what's valid.
function SiteSettingsForm({ site, onSave, saving, saved, errorCode }: FormProps) {
  const titleId = useId();
  const urlId = useId();
  const domainId = useId();
  const descId = useId();
  const langId = useId();
  const appearanceId = useId();

  const form = useForm<SiteFormValues>({
    resolver: zodResolver(SiteConfigUpdateSchema),
    mode: 'onBlur',
    defaultValues: toFormValues(site),
  });

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty },
  } = form;

  useEffect(() => {
    reset(toFormValues(site));
  }, [site, reset]);

  const watched = watch();
  const urlPreview = useMemo(() => {
    if (!watched.siteUrl?.trim()) return null;
    try {
      return normalizeSiteUrl(watched.siteUrl);
    } catch {
      return null;
    }
  }, [watched.siteUrl]);

  const onSubmit: SubmitHandler<SiteFormValues> = async (values) => {
    // Send only changed top-level keys; empty strings clear nullable fields.
    await onSave({
      displayTitle: values.displayTitle,
      siteUrl: values.siteUrl,
      domain: values.domain,
      descriptor: values.descriptor,
      defaultLanguage: values.defaultLanguage,
      defaultAppearance: values.defaultAppearance,
      branding: values.branding,
      themeOverrides: values.themeOverrides,
      customCss: values.customCss,
    });
  };

  // Cmd/Ctrl+S → submit the form in place (save and stay).
  useSaveHandler(() => void handleSubmit(onSubmit)(), isDirty && !saving);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="mx-auto max-w-3xl space-y-8 p-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Site</h1>
        <p className="text-sm text-muted-foreground">
          Identity, branding and theme for this site. Per-user appearance and
          language preferences override these defaults.
        </p>
      </header>

      {/* ── Identity ───────────────────────────────────────────── */}
      <Section icon={<Globe className="h-4 w-4" />} title="Identity">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={titleId} label="Display title" error={errors.displayTitle?.message}>
            <input id={titleId} className={inputClass(!!errors.displayTitle)} placeholder="Lumibase" {...register('displayTitle')} />
          </Field>
          <Field id={langId} label="Default language" error={errors.defaultLanguage?.message}>
            <select id={langId} className={inputClass(!!errors.defaultLanguage)} {...register('defaultLanguage')}>
              <option value="en">English (en)</option>
              <option value="vi">Vietnamese (vi)</option>
              <option value="ja">Japanese (ja)</option>
              <option value="fr">French (fr)</option>
              <option value="en-US">English, US (en-US)</option>
            </select>
          </Field>
        </div>
        <Field
          id={urlId}
          label="Site URL"
          error={errors.siteUrl?.message}
          help="Canonical public URL used for metadata."
        >
          <input id={urlId} type="url" className={inputClass(!!errors.siteUrl)} placeholder="https://example.com" {...register('siteUrl')} />
          {urlPreview ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Preview: <code className="font-mono text-foreground">{urlPreview}</code>
            </p>
          ) : null}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id={domainId}
            label="Custom domain"
            error={errors.domain?.message ?? (errorCode === 'DOMAIN_TAKEN' ? 'That domain is already in use.' : undefined)}
            help="Maps requests to this site via subdomain routing."
          >
            <input id={domainId} className={inputClass(!!errors.domain || errorCode === 'DOMAIN_TAKEN')} placeholder="cms.example.com" {...register('domain')} />
          </Field>
          <Field id={descId} label="Descriptor" error={errors.descriptor?.message} help="Short description shown in Studio.">
            <input id={descId} className={inputClass(!!errors.descriptor)} {...register('descriptor')} />
          </Field>
        </div>
      </Section>

      {/* ── Branding ───────────────────────────────────────────── */}
      <Section icon={<Palette className="h-4 w-4" />} title="Branding">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${titleId}-logo`} label="Logo URL">
            <input id={`${titleId}-logo`} type="url" className={inputClass(false)} placeholder="https://…/logo.svg" {...register('branding.logoUrl')} />
          </Field>
          <Field id={`${titleId}-favicon`} label="Favicon URL">
            <input id={`${titleId}-favicon`} type="url" className={inputClass(false)} placeholder="https://…/favicon.ico" {...register('branding.faviconUrl')} />
          </Field>
        </div>
        <Field id={`${titleId}-brand`} label="Brand color" error={errors.branding?.brandColor?.message} help="Applied to the primary action color.">
          <ColorInput
            value={watched.branding?.brandColor ?? ''}
            onChange={(hsl) => setValue('branding.brandColor', hsl, { shouldDirty: true })}
          />
        </Field>
      </Section>

      {/* ── Theme ──────────────────────────────────────────────── */}
      <Section icon={<Palette className="h-4 w-4" />} title="Theme">
        <Field id={appearanceId} label="Default appearance" help="Per-user setting overrides this.">
          <select id={appearanceId} className={inputClass(false)} {...register('defaultAppearance')}>
            <option value="auto">Auto (system)</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <div className="grid gap-6 sm:grid-cols-2">
          <ThemeModeEditor
            mode="light"
            values={watched.themeOverrides?.light ?? {}}
            onChange={(token, hsl) => setValue(`themeOverrides.light.${token}`, hsl, { shouldDirty: true })}
          />
          <ThemeModeEditor
            mode="dark"
            values={watched.themeOverrides?.dark ?? {}}
            onChange={(token, hsl) => setValue(`themeOverrides.dark.${token}`, hsl, { shouldDirty: true })}
          />
        </div>
      </Section>

      {/* ── Custom CSS ─────────────────────────────────────────── */}
      <Section icon={<Code2 className="h-4 w-4" />} title="Custom CSS">
        <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Advanced. Injected after theme tokens — selectors may change between releases.</span>
        </div>
        <textarea
          className={`${inputClass(!!errors.customCss)} h-40 font-mono text-xs`}
          placeholder={':root { /* … */ }'}
          {...register('customCss')}
        />
        {errors.customCss?.message ? (
          <p className="mt-1 text-xs text-destructive">{errors.customCss.message}</p>
        ) : null}
      </Section>

      <div className="flex items-center justify-end gap-3 border-t pt-4">
        {saved && !isDirty ? (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        ) : null}
        {errorCode === 'GENERIC' ? (
          <span className="text-sm text-destructive">Save failed.</span>
        ) : null}
        <button
          type="submit"
          disabled={saving || !isDirty}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Save className="h-4 w-4" />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function ThemeModeEditor({
  mode,
  values,
  onChange,
}: {
  mode: 'light' | 'dark';
  values: Record<string, string>;
  onChange: (token: string, hsl: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{mode} mode</p>
      {EDITABLE_TOKENS.map(({ token, label }) => (
        <div key={token} className="flex items-center justify-between gap-3">
          <span className="text-sm">{label}</span>
          <ColorInput value={values[token] ?? ''} onChange={(hsl) => onChange(token, hsl)} />
        </div>
      ))}
    </div>
  );
}

/**
 * A color input that round-trips between a `<input type=color>` (#rrggbb) and
 * the `H S% L%` triple Tailwind tokens expect. Empty value = "use default".
 */
function ColorInput({ value, onChange }: { value: string; onChange: (hsl: string) => void }) {
  const hex = hslTripleToHex(value);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={hex}
        onChange={(e) => onChange(hexToHslTriple(e.target.value))}
        className="h-7 w-9 cursor-pointer rounded border bg-background"
        aria-label="Pick color"
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="240 5.9% 10%"
        className="w-32 rounded-md border bg-background px-2 py-1 font-mono text-xs"
      />
    </div>
  );
}

// ── Color helpers (hex ⇄ HSL triple) ──────────────────────────────
function hslTripleToHex(triple: string): string {
  const m = triple.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
  if (!m) return '#000000';
  const h = parseFloat(m[1] ?? '0');
  const s = parseFloat(m[2] ?? '0') / 100;
  const l = parseFloat(m[3] ?? '0') / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const mm = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (n: number) =>
    Math.round((n + mm) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hexToHslTriple(hex: string): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return `${Math.round(h)} ${round1(s * 100)}% ${round1(l * 100)}%`;
}

// ── Layout primitives ─────────────────────────────────────────────
function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function inputClass(hasError: boolean): string {
  const base =
    'block w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-primary/30';
  return `${base} ${hasError ? 'border-destructive focus:border-destructive focus:ring-destructive/30' : 'border-input focus:border-primary'}`;
}

export default SiteSettingsPage;
