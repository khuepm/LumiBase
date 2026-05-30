import type {
  Extension,
  ExtensionListResponse,
  ListExtensionsParams,
} from "./types";

// ─── Mock data for static export (replace with real CMS API calls) ─────────────

const MOCK_EXTENSIONS: Extension[] = [
  {
    id: "ext-001",
    slug: "seo-toolkit",
    name: "SEO Toolkit",
    description:
      "Comprehensive SEO management with sitemap generation, meta tags, and structured data support.",
    readme: `# SEO Toolkit\n\nThe most complete SEO extension for Lumibase.\n\n## Features\n\n- Auto-generate XML sitemaps\n- Meta tags editor with preview\n- JSON-LD structured data\n- Open Graph & Twitter Cards\n- Canonical URL management\n\n## Installation\n\nSearch for \`seo-toolkit\` in the Studio Marketplace tab and click Install.`,
    category: "seo",
    tags: ["seo", "sitemap", "meta-tags", "structured-data"],
    publisherName: "LumiBase Team",
    iconUrl: "",
    latestVersion: "2.1.0",
    totalDownloads: 12840,
    rating: 4.8,
    ratingCount: 241,
    publishedAt: "2024-03-01T00:00:00Z",
    updatedAt: "2025-05-10T00:00:00Z",
    repositoryUrl: "https://github.com/lumibase/ext-seo-toolkit",
    licenseType: "MIT",
    versions: [
      {
        id: "v-001-3",
        version: "2.1.0",
        publishedAt: "2025-05-10T00:00:00Z",
        sha256: "a1b2c3d4e5f6a7b8",
        changelog: "Added JSON-LD support and canonical URL management.",
      },
      {
        id: "v-001-2",
        version: "2.0.0",
        publishedAt: "2025-01-15T00:00:00Z",
        sha256: "b2c3d4e5f6a7b8c9",
        changelog: "Major rewrite with improved performance.",
      },
      {
        id: "v-001-1",
        version: "1.0.0",
        publishedAt: "2024-03-01T00:00:00Z",
        sha256: "c3d4e5f6a7b8c9d0",
        changelog: "Initial release.",
      },
    ],
  },
  {
    id: "ext-002",
    slug: "media-optimizer",
    name: "Media Optimizer",
    description:
      "Automatic image compression, WebP conversion, and responsive image generation on upload.",
    readme: `# Media Optimizer\n\nOptimize every image automatically.\n\n## Features\n- WebP/AVIF conversion\n- Responsive breakpoints\n- EXIF stripping\n- Lazy-load helpers`,
    category: "media",
    tags: ["images", "webp", "optimization", "cdn"],
    publisherName: "PixelCraft",
    latestVersion: "1.4.2",
    totalDownloads: 9320,
    rating: 4.6,
    ratingCount: 183,
    publishedAt: "2024-06-20T00:00:00Z",
    updatedAt: "2025-04-22T00:00:00Z",
    licenseType: "MIT",
    versions: [
      {
        id: "v-002-2",
        version: "1.4.2",
        publishedAt: "2025-04-22T00:00:00Z",
        sha256: "d4e5f6a7b8c9d0e1",
        changelog: "AVIF support and bug fixes.",
      },
      {
        id: "v-002-1",
        version: "1.0.0",
        publishedAt: "2024-06-20T00:00:00Z",
        sha256: "e5f6a7b8c9d0e1f2",
        changelog: "Initial release.",
      },
    ],
  },
  {
    id: "ext-003",
    slug: "analytics-hub",
    name: "Analytics Hub",
    description:
      "Connect Google Analytics, Plausible, and Fathom to your content with a single extension.",
    readme: `# Analytics Hub\n\nUnified analytics for all your content.\n\n## Supported providers\n- Google Analytics 4\n- Plausible Analytics\n- Fathom Analytics\n- Umami`,
    category: "analytics",
    tags: ["analytics", "google-analytics", "plausible", "tracking"],
    publisherName: "DataFlow Labs",
    latestVersion: "3.0.1",
    totalDownloads: 21450,
    rating: 4.9,
    ratingCount: 512,
    publishedAt: "2023-11-01T00:00:00Z",
    updatedAt: "2025-05-01T00:00:00Z",
    licenseType: "Apache-2.0",
    versions: [
      {
        id: "v-003-2",
        version: "3.0.1",
        publishedAt: "2025-05-01T00:00:00Z",
        sha256: "f6a7b8c9d0e1f2a3",
        changelog: "Improved event tracking reliability.",
      },
      {
        id: "v-003-1",
        version: "3.0.0",
        publishedAt: "2025-03-10T00:00:00Z",
        sha256: "a7b8c9d0e1f2a3b4",
        changelog: "GA4 support, breaking changes from v2.",
      },
    ],
  },
  {
    id: "ext-004",
    slug: "form-builder",
    name: "Form Builder",
    description:
      "Drag-and-drop form creation with validation, file uploads, and webhook integrations.",
    readme: `# Form Builder\n\nBuild powerful forms without code.\n\n## Features\n- Visual drag-and-drop editor\n- 20+ field types\n- Conditional logic\n- Webhook & email notifications`,
    category: "forms",
    tags: ["forms", "drag-drop", "validation", "webhooks"],
    publisherName: "FormCraft",
    latestVersion: "1.2.0",
    totalDownloads: 7890,
    rating: 4.5,
    ratingCount: 98,
    publishedAt: "2024-09-15T00:00:00Z",
    updatedAt: "2025-03-30T00:00:00Z",
    licenseType: "MIT",
    versions: [
      {
        id: "v-004-1",
        version: "1.2.0",
        publishedAt: "2025-03-30T00:00:00Z",
        sha256: "b8c9d0e1f2a3b4c5",
        changelog: "Added file upload support.",
      },
    ],
  },
  {
    id: "ext-005",
    slug: "i18n-manager",
    name: "i18n Manager",
    description:
      "Multi-language content management with translation workflows and locale switching.",
    readme: `# i18n Manager\n\nManage translations at scale.\n\n## Features\n- Side-by-side translation editor\n- Translation memory\n- Import/export XLIFF & JSON\n- Machine translation integration`,
    category: "localization",
    tags: ["i18n", "localization", "translation", "multilang"],
    publisherName: "GlobalContent",
    latestVersion: "4.1.0",
    totalDownloads: 15600,
    rating: 4.7,
    ratingCount: 307,
    publishedAt: "2023-08-01T00:00:00Z",
    updatedAt: "2025-05-20T00:00:00Z",
    licenseType: "MIT",
    versions: [
      {
        id: "v-005-2",
        version: "4.1.0",
        publishedAt: "2025-05-20T00:00:00Z",
        sha256: "c9d0e1f2a3b4c5d6",
        changelog: "Machine translation via DeepL API.",
      },
      {
        id: "v-005-1",
        version: "4.0.0",
        publishedAt: "2025-01-10T00:00:00Z",
        sha256: "d0e1f2a3b4c5d6e7",
        changelog: "Major rewrite with new editor.",
      },
    ],
  },
  {
    id: "ext-006",
    slug: "ecommerce-connect",
    name: "E-Commerce Connect",
    description:
      "Sync products, prices, and inventory from Shopify, WooCommerce, and Stripe to your CMS content.",
    readme: `# E-Commerce Connect\n\nBridge your store and your content.\n\n## Supported Platforms\n- Shopify\n- WooCommerce\n- Stripe Products\n- BigCommerce`,
    category: "e-commerce",
    tags: ["shopify", "woocommerce", "stripe", "products", "inventory"],
    publisherName: "ShopSync",
    latestVersion: "2.3.0",
    totalDownloads: 6540,
    rating: 4.4,
    ratingCount: 72,
    publishedAt: "2024-11-01T00:00:00Z",
    updatedAt: "2025-04-10T00:00:00Z",
    licenseType: "Commercial",
    versions: [
      {
        id: "v-006-1",
        version: "2.3.0",
        publishedAt: "2025-04-10T00:00:00Z",
        sha256: "e1f2a3b4c5d6e7f8",
        changelog: "BigCommerce integration added.",
      },
    ],
  },
];

// ─── Categories derived from mock data ────────────────────────────────────────

export const CATEGORIES = [
  { slug: "analytics", label: "Analytics" },
  { slug: "e-commerce", label: "E-Commerce" },
  { slug: "forms", label: "Forms" },
  { slug: "localization", label: "Localization" },
  { slug: "media", label: "Media" },
  { slug: "seo", label: "SEO" },
];

// ─── API functions (static — swap with real fetch for ISR) ───────────────────

const CMS_BASE_URL =
  process.env.NEXT_PUBLIC_CMS_API_URL ?? "https://api.lumibase.dev";

function buildQuery(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  return q.toString();
}

/**
 * List extensions with optional filters.
 * In static export mode: filters applied client-side from mock data.
 */
export async function listExtensions(
  params: ListExtensionsParams = {}
): Promise<ExtensionListResponse> {
  // In production: fetch from CMS API
  if (process.env.NEXT_PUBLIC_USE_REAL_API === "true") {
    const qs = buildQuery({
      q: params.q,
      category: params.category,
      tags: params.tags,
      page: params.page ?? 1,
      perPage: params.perPage ?? 12,
      sort: params.sort ?? "popular",
    });
    const res = await fetch(`${CMS_BASE_URL}/api/v1/marketplace/extensions?${qs}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`CMS API error: ${res.status}`);
    return res.json() as Promise<ExtensionListResponse>;
  }

  // Static: filter mock data
  let data = [...MOCK_EXTENSIONS];

  if (params.q) {
    const q = params.q.toLowerCase();
    data = data.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.tags.some((t) => t.includes(q))
    );
  }

  if (params.category) {
    data = data.filter((e) => e.category === params.category);
  }

  if (params.tags) {
    const filterTags = params.tags.split(",").map((t) => t.trim());
    data = data.filter((e) => filterTags.some((t) => e.tags.includes(t)));
  }

  if (params.sort === "latest") {
    data.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } else if (params.sort === "name") {
    data.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    data.sort((a, b) => b.totalDownloads - a.totalDownloads);
  }

  const page = params.page ?? 1;
  const perPage = params.perPage ?? 12;
  const total = data.length;
  const start = (page - 1) * perPage;

  return {
    data: data.slice(start, start + perPage),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

/**
 * Get a single extension by slug.
 */
export async function getExtension(slug: string): Promise<Extension | null> {
  if (process.env.NEXT_PUBLIC_USE_REAL_API === "true") {
    const res = await fetch(
      `${CMS_BASE_URL}/api/v1/marketplace/extensions/${slug}`,
      { next: { revalidate: 60 } }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CMS API error: ${res.status}`);
    return res.json() as Promise<Extension>;
  }

  return MOCK_EXTENSIONS.find((e) => e.slug === slug) ?? null;
}

/**
 * Get all slugs (for generateStaticParams).
 */
export async function getAllSlugs(): Promise<string[]> {
  return MOCK_EXTENSIONS.map((e) => e.slug);
}

/**
 * Get featured extensions (top 3 by downloads).
 */
export async function getFeaturedExtensions(): Promise<Extension[]> {
  const result = await listExtensions({ sort: "popular", perPage: 3 });
  return result.data;
}
