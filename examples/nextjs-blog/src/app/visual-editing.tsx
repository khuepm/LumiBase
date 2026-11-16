'use client';

import { enableVisualEditing } from '@lumibase/visual-editing';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Click-to-edit overlay for draft mode. Rendered only when draft mode is on;
 * talks only to the Studio origin you configure (exact match, never `*`).
 */
export function VisualEditing() {
  const router = useRouter();
  useEffect(() => {
    const studio = process.env.NEXT_PUBLIC_LUMIBASE_STUDIO_ORIGIN;
    if (!studio) return;
    const handle = enableVisualEditing({
      studioOrigins: [studio],
      enabled: true,
      // Saved in the Studio → re-render the server components.
      onReload: () => router.refresh(),
    });
    return () => handle.destroy();
  }, [router]);
  return null;
}
