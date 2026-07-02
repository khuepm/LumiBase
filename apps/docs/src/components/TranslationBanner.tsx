import { localeNames, defaultLocale } from 'virtual:docs-registry';
import { useT } from '../hooks/useT';

/**
 * Translation Banner — displayed below the H1 header when content is
 * falling back to the default locale because a translation doesn't exist yet.
 *
 * Shows a message indicating the page hasn't been translated and provides
 * a "Contribute translation" link pointing to the source file in the repo.
 *
 * Requirements: 4.2
 */

const REPO_URL = 'https://github.com/khuepm/lumibase';

export interface TranslationBannerProps {
  /** The file path relative to the docs root, e.g. "en/features/ai-copilot.md" */
  filePath: string;
}

export function TranslationBanner({ filePath }: TranslationBannerProps) {
  const t = useT();

  const defaultLocaleName = localeNames[defaultLocale] ?? defaultLocale;
  const contributeUrl = `${REPO_URL}/tree/main/docs/${filePath}`;

  return (
    <div
      role="status"
      className="mb-6 rounded-2xl bg-[rgba(123,97,255,0.10)] px-5 py-3.5 text-sm font-medium text-[#d6ccff] shadow-[inset_0_0_0_1px_rgba(123,97,255,0.30)]"
    >
      <p>
        {t('banner.translation-pending', { default: defaultLocaleName })}
        {' '}
        <a
          href={contributeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-white underline underline-offset-2 transition-colors hover:text-[#c9bcff]"
        >
          {t('banner.contribute')}
        </a>
      </p>
    </div>
  );
}
