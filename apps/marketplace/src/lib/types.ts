// ─── Extension types for Marketplace ──────────────────────────────────────────

export interface ExtensionVersion {
  id: string;
  version: string;
  publishedAt: string | null;
  sha256: string | null;
  changelog?: string;
}

export interface Extension {
  id: string;
  slug: string;
  name: string;
  description: string;
  readme: string;
  category: string;
  tags: string[];
  publisherName: string;
  publisherAvatar?: string;
  iconUrl?: string;
  bannerUrl?: string;
  latestVersion: string;
  totalDownloads?: number;
  rating?: number | null;
  ratingCount?: number | null;
  versions: ExtensionVersion[];
  publishedAt: string;
  updatedAt: string;
  repositoryUrl?: string;
  documentationUrl?: string;
  licenseType?: string;
}

export interface ExtensionListResponse {
  data: Extension[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export interface ListExtensionsParams {
  q?: string;
  category?: string;
  tags?: string;
  page?: number;
  perPage?: number;
  sort?: "latest" | "popular" | "name";
}
