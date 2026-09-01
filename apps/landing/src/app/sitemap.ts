import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

// Update these dates when the corresponding page content actually changes —
// identical auto-generated timestamps reduce crawl-scheduling value.
const LAST_MODIFIED = {
  home: new Date('2026-06-10'),
  tos: new Date('2026-06-07'),
  privacy: new Date('2026-06-07'),
  license: new Date('2026-06-07'),
};

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://lumibase.dev';

  return [
    {
      url: baseUrl,
      lastModified: LAST_MODIFIED.home,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${baseUrl}/tos/`,
      lastModified: LAST_MODIFIED.tos,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/privacy/`,
      lastModified: LAST_MODIFIED.privacy,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
    {
      url: `${baseUrl}/license/`,
      lastModified: LAST_MODIFIED.license,
      changeFrequency: 'monthly',
      priority: 0.5,
    },
  ];
}
