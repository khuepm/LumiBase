// @vitest-environment jsdom
import { LumiError } from '@lumibase/sdk';
import i18next from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ translations: { list } }) }));

const { loadUiTranslations } = await import('@/lib/i18n');

function instance() {
  const i18n = i18next.createInstance();
  void i18n.init({ lng: 'en', resources: {} });
  return i18n;
}

/** #1044: the UI translations are optional; failing to load them is not an error. */
describe('loadUiTranslations', () => {
  afterEach(() => {
    list.mockReset();
    vi.restoreAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('adds the CMS translations to the ui namespace', async () => {
    list.mockResolvedValue({ data: [{ language: 'vi', key: 'save', value: 'Lưu' }] });
    const i18n = instance();
    await loadUiTranslations(i18n);
    expect(i18n.getResource('vi', 'ui', 'save')).toBe('Lưu');
  });

  it('degrades quietly on an expected 401 or 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const status of [401, 404]) {
      list.mockRejectedValueOnce(new LumiError(status, { errors: [{ code: 'X', message: 'x' }] }));
      await expect(loadUiTranslations(instance())).resolves.toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('still reports an unexpected failure as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    list.mockRejectedValueOnce(new LumiError(500, { errors: [] }));
    await loadUiTranslations(instance());
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('does not call the tenant endpoint on the setup wizard', async () => {
    window.history.replaceState(null, '', '/setup/account');
    await loadUiTranslations(instance());
    expect(list).not.toHaveBeenCalled();
  });
});
