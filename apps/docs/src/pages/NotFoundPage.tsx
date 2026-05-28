/**
 * NotFoundPage component — displayed when a route doesn't match any known doc.
 * Shows a clear 404 message and provides navigation back to the home page.
 * Uses useT() for translated title and home link label.
 * Home link navigates to /{currentLocale}/docs/README.
 *
 * Requirements: 5.4, 6.4
 */
import { Link } from 'react-router-dom';
import { useT } from '../hooks/useT';
import { useLocale } from '../hooks/useLocale';
import { pathFor } from '../lib/url';

export function NotFoundPage() {
  const t = useT();
  const { locale } = useLocale();

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8 text-center">
      <h1 className="text-4xl font-bold text-foreground">
        404 — {t('notfound.title')}
      </h1>
      <p className="mt-4 text-lg text-muted-foreground max-w-md">
        The document you're looking for doesn't exist or may have been moved.
      </p>
      <Link
        to={pathFor(locale, 'README')}
        className="mt-6 inline-flex items-center gap-1 text-primary underline underline-offset-4 hover:no-underline focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded"
      >
        ← {t('notfound.home')}
      </Link>
    </main>
  );
}
