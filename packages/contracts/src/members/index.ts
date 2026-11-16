/**
 * Member Portal contracts (epic #672): the signup-card copy model shared by
 * the CMS (`GET /api/v1/portal/signup-card`), the `signup_card` block
 * template (N05) and the embeddable Portal widget (N02).
 *
 * Copy resolves in this order, field by field, so a card never shows a blank
 * or a hard-coded English placeholder on a localized page:
 *   1. the card instance's override (a string, or a `{ [locale]: string }` map);
 *   2. the site's copy for the exact locale (`pt-BR`), then its base (`pt`);
 *   3. built-in defaults for the locale / base / `en`.
 *
 * Pure: no I/O, no DOM.
 */

export const SIGNUP_CARD_BLOCK = 'signup_card';

export const SIGNUP_COPY_KEYS = ['heading', 'description', 'placeholder', 'nameLabel', 'button', 'success', 'error'] as const;
export type SignupCopyKey = (typeof SIGNUP_COPY_KEYS)[number];
export type SignupCopy = Partial<Record<SignupCopyKey, string>>;
export type ResolvedSignupCopy = Record<SignupCopyKey, string>;

/** Built-in defaults. Sites add or override locales in member settings. */
export const DEFAULT_SIGNUP_COPY: Readonly<Record<string, ResolvedSignupCopy>> = {
  en: {
    heading: 'Subscribe',
    description: 'Get new posts delivered to your inbox.',
    placeholder: 'you@example.com',
    nameLabel: 'Your name',
    button: 'Subscribe',
    success: 'Check your inbox to confirm your subscription.',
    error: 'Something went wrong. Please try again.',
  },
  vi: {
    heading: 'Đăng ký nhận tin',
    description: 'Nhận bài viết mới qua email.',
    placeholder: 'ban@example.com',
    nameLabel: 'Tên của bạn',
    button: 'Đăng ký',
    success: 'Hãy kiểm tra hộp thư để xác nhận đăng ký.',
    error: 'Đã có lỗi xảy ra. Vui lòng thử lại.',
  },
};

/** A per-instance override: plain string or a locale map. */
export type LocalizedOverride = string | Readonly<Record<string, string>> | null | undefined;

function baseLocale(locale: string): string {
  return locale.split('-')[0]!.toLowerCase();
}

function pickLocalized(value: LocalizedOverride, locale: string): string | undefined {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const exact = value[locale];
  if (typeof exact === 'string' && exact.trim()) return exact;
  const base = value[baseLocale(locale)];
  if (typeof base === 'string' && base.trim()) return base;
  return undefined;
}

/** Safe locale tag or `en` — a malformed `?locale=` must never throw. */
export function normalizeLocale(raw: unknown): string {
  if (typeof raw !== 'string') return 'en';
  const v = raw.trim();
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(v) ? v : 'en';
}

export function resolveSignupCopy(
  localeInput: unknown,
  siteCopy: Readonly<Record<string, SignupCopy>> | null | undefined = {},
  overrides: Partial<Record<SignupCopyKey, LocalizedOverride>> | null | undefined = {},
): ResolvedSignupCopy {
  const locale = normalizeLocale(localeInput);
  const base = baseLocale(locale);
  const site = siteCopy ?? {};
  const defaults = DEFAULT_SIGNUP_COPY[locale] ?? DEFAULT_SIGNUP_COPY[base] ?? DEFAULT_SIGNUP_COPY.en!;
  const out = {} as ResolvedSignupCopy;
  for (const key of SIGNUP_COPY_KEYS) {
    out[key] =
      pickLocalized(overrides?.[key], locale) ??
      pickLocalized(site[locale]?.[key], locale) ??
      pickLocalized(site[base]?.[key], locale) ??
      defaults[key];
  }
  return out;
}

/** Field names of the `signup_card` block template → copy key. */
export const SIGNUP_CARD_FIELD_TO_COPY: Readonly<Record<string, SignupCopyKey>> = {
  heading: 'heading',
  description: 'description',
  placeholder: 'placeholder',
  button_label: 'button',
  success_message: 'success',
};

/** Read a `signup_card` block's data into copy overrides. */
export function signupCardOverrides(data: Readonly<Record<string, unknown>> | null | undefined): Partial<Record<SignupCopyKey, LocalizedOverride>> {
  const out: Partial<Record<SignupCopyKey, LocalizedOverride>> = {};
  if (!data) return out;
  for (const [field, key] of Object.entries(SIGNUP_CARD_FIELD_TO_COPY)) {
    const v = data[field];
    if (typeof v === 'string' || (v && typeof v === 'object' && !Array.isArray(v))) out[key] = v as LocalizedOverride;
  }
  return out;
}
