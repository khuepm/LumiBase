import { defaultLocale } from 'virtual:docs-registry';

export const ui = {
  'navbar.docs': { en: 'Docs', vi: 'Tài liệu' },
  'navbar.api': { en: 'API', vi: 'API' },
  'navbar.roadmap': { en: 'Roadmap', vi: 'Lộ trình' },
  'search.placeholder': { en: 'Search documentation…', vi: 'Tìm tài liệu…' },
  'search.no-results': {
    en: 'No results found for "{q}"',
    vi: 'Không có kết quả cho "{q}"',
  },
  'search.min-chars': {
    en: 'Type at least 2 characters to search',
    vi: 'Gõ ít nhất 2 ký tự để tìm',
  },
  'notfound.title': { en: 'Document Not Found', vi: 'Không tìm thấy tài liệu' },
  'notfound.home': { en: 'Back to home', vi: 'Về trang chủ' },
  'banner.translation-pending': {
    en: 'This page has not been translated yet. Showing the {default} version.',
    vi: 'Trang này chưa được dịch. Đang hiển thị bản {default}.',
  },
  'banner.contribute': { en: 'Contribute translation', vi: 'Đóng góp bản dịch' },
  'sidebar.empty': { en: 'No documents found.', vi: 'Chưa có tài liệu.' },
  'locale-switcher.tooltip': { en: 'Switch language', vi: 'Chuyển ngôn ngữ' },
  'version.badge-tooltip': {
    en: 'Current LumiBase version — view release notes',
    vi: 'Phiên bản LumiBase hiện tại — xem ghi chú phát hành',
  },
  'theme.light': { en: 'Light', vi: 'Sáng' },
  'theme.dark': { en: 'Dark', vi: 'Tối' },
  'theme.auto': { en: 'System', vi: 'Hệ thống' },
  'theme.toggle-tooltip': {
    en: 'Theme: {mode} — click to switch',
    vi: 'Giao diện: {mode} — nhấn để chuyển',
  },
} satisfies Record<string, Record<string, string>>;

export type UiKey = keyof typeof ui;

/**
 * Look up a UI string by key and locale, with fallback to defaultLocale.
 * Supports placeholder interpolation via `params`, e.g. `{name}` → params.name.
 */
export function t(key: UiKey, locale: string, params?: Record<string, string>): string {
  const dict: Record<string, string> = ui[key];
  const raw = dict[locale] ?? dict[defaultLocale] ?? key;
  return params
    ? raw.replace(/\{(\w+)\}/g, (_: string, k: string) => params[k] ?? '')
    : raw;
}
