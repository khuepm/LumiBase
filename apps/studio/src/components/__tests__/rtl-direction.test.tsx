// @vitest-environment jsdom
/**
 * RTL layout support (#761): the UI direction follows the UI language and is
 * written to `<html dir>`; content fields follow the CONTENT locale's
 * direction independently of the UI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { FieldResource } from '@lumibase/sdk';

let preferences: { language?: string | null } = {};
let siteDefault = 'en';
let locales: string[] = ['en', 'ar'];
const updatePreferences = vi.fn(async (patch: { language?: string }) => {
  preferences = { ...preferences, ...patch };
  return { data: preferences };
});

const client = {
  site: { get: async () => ({ data: { defaultLanguage: siteDefault } }) },
  rawRequest: async (path: string) => {
    if (path === '/api/v1/me/preferences') return { data: preferences };
    throw new Error(`unexpected ${path}`);
  },
  settings: { get: async () => ({ data: { value: { supported: locales } } }) },
  me: { updatePreferences },
};

vi.mock('@/lib/api', () => ({ getApiClient: () => client, hasActiveToken: () => true }));

import { SiteLanguageSync } from '../site-language';
import { UiLanguagePicker } from '../ui-language-picker';
import { TranslatableText } from '@/modules/content/interfaces/translatable-text';
import { TextInterface, TextMultilineInterface } from '@/modules/content/interfaces/text';
import { TranslationMode } from '@/modules/content/translation-mode';
import { UI_LANGUAGE_STORAGE_KEY } from '@/lib/ui-language';

async function i18nInstance(lng = 'en') {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({ lng, fallbackLng: 'en', resources: {}, interpolation: { escapeValue: false } });
  return i18n;
}

function wrap(ui: ReactNode, i18n: typeof i18next) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
    </QueryClientProvider>
  );
}

const field = (over: Partial<FieldResource>): FieldResource =>
  ({ id: 'f1', name: 'title', collection: 'posts', type: 'string', interface: 'input', ...over }) as FieldResource;

beforeEach(() => {
  preferences = {};
  siteDefault = 'en';
  locales = ['en', 'ar'];
  updatePreferences.mockClear();
  localStorage.clear();
  document.documentElement.setAttribute('lang', 'en');
  document.documentElement.setAttribute('dir', 'ltr');
});
afterEach(cleanup);

describe('UI direction follows the UI language', () => {
  it("sets <html dir=\"rtl\"> from the user's Arabic preference and remembers it", async () => {
    preferences = { language: 'ar' };
    const i18n = await i18nInstance();
    render(wrap(<SiteLanguageSync />, i18n));

    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));
    expect(document.documentElement.getAttribute('lang')).toBe('ar');
    expect(i18n.language).toBe('ar');
    expect(localStorage.getItem(UI_LANGUAGE_STORAGE_KEY)).toBe('ar');
  });

  it('uses the site default (Hebrew) when the user has no preference', async () => {
    siteDefault = 'he';
    const i18n = await i18nInstance();
    render(wrap(<SiteLanguageSync />, i18n));
    await waitFor(() => expect(document.documentElement.getAttribute('dir')).toBe('rtl'));
    expect(document.documentElement.getAttribute('lang')).toBe('he');
  });

  it('keeps an LTR UI for an LTR preference even when the site default is RTL', async () => {
    siteDefault = 'fa';
    preferences = { language: 'vi' };
    const i18n = await i18nInstance();
    render(wrap(<SiteLanguageSync />, i18n));
    await waitFor(() => expect(i18n.language).toBe('vi'));
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('the interface language picker saves the preference through /me/preferences', async () => {
    const i18n = await i18nInstance();
    render(wrap(<UiLanguagePicker />, i18n));
    const select = screen.getByRole('combobox', { name: 'Interface language' });
    expect(select).toHaveValue('en');
    // Endonyms, each option in its own direction.
    expect(screen.getByRole('option', { name: 'العربية' })).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('option', { name: 'English' })).toHaveAttribute('dir', 'ltr');

    fireEvent.change(select, { target: { value: 'ar' } });
    await waitFor(() => expect(updatePreferences).toHaveBeenCalledWith({ language: 'ar' }));
  });
});

describe('content fields follow the CONTENT locale, not the UI', () => {
  it('an Arabic translation input is RTL inside an English UI', async () => {
    const i18n = await i18nInstance('en');
    render(
      wrap(
        <TranslatableText field={field({ interface: 'translatable-text' })} value={{ en: 'Hello', ar: 'مرحبا' }} onChange={vi.fn()} />,
        i18n,
      ),
    );
    const ar = await screen.findByDisplayValue('مرحبا');
    expect(ar).toHaveAttribute('dir', 'rtl');
    expect(ar).toHaveAttribute('lang', 'ar');
    const en = screen.getByDisplayValue('Hello');
    expect(en).toHaveAttribute('dir', 'ltr');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
  });

  it('an English translation input stays LTR inside an Arabic UI', async () => {
    document.documentElement.setAttribute('dir', 'rtl');
    const i18n = await i18nInstance('ar');
    render(
      wrap(
        <TranslatableText field={field({ interface: 'translatable-text' })} value={{ en: 'Hello', ar: 'مرحبا' }} onChange={vi.fn()} />,
        i18n,
      ),
    );
    expect(await screen.findByDisplayValue('Hello')).toHaveAttribute('dir', 'ltr');
  });

  it('side-by-side translation mode sets each pane to its locale direction', async () => {
    const f = field({ interface: 'translatable-text' });
    render(
      wrap(
        <TranslationMode fields={[f]} draft={{ title: { en: 'Hello', ar: 'مرحبا' } }} onChange={vi.fn()} sourceLocale="en" targetLocale="ar" readOnly />,
        await i18nInstance(),
      ),
    );
    expect(screen.getByLabelText('title source (en)')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByLabelText('title target (ar)')).toHaveAttribute('dir', 'rtl');
  });

  it('plain text fields auto-detect direction, or use the locale when given', async () => {
    const i18n = await i18nInstance();
    const { rerender } = render(wrap(<TextInterface field={field({})} value="مرحبا" onChange={vi.fn()} />, i18n));
    expect(screen.getByDisplayValue('مرحبا')).toHaveAttribute('dir', 'auto');
    rerender(wrap(<TextInterface field={field({})} value="שלום" locale="he" onChange={vi.fn()} />, i18n));
    expect(screen.getByDisplayValue('שלום')).toHaveAttribute('dir', 'rtl');
    rerender(wrap(<TextMultilineInterface field={field({})} value="notes" onChange={vi.fn()} />, i18n));
    expect(screen.getByDisplayValue('notes')).toHaveAttribute('dir', 'auto');
  });
});
