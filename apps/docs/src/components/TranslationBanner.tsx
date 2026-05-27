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

const REPO_URL = 'https://github.com/lumibase/lumibase';

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
      className="mb-6 rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200"
    >
      <p>
        {t('banner.translation-pending', { default: defaultLocaleName })}
        {' '}
        <a
          href={contributeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline hover:text-yellow-700 dark:hover:text-yellow-100"
        >
          {t('banner.contribute')}
        </a>
      </p>
    </div>
  );
}
