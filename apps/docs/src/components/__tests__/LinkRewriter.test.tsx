import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { resolveRelativeSlug, classifyLink, LinkRewriter } from '../LinkRewriter';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('resolveRelativeSlug', () => {
  it('resolves a sibling .md file from a nested slug', () => {
    expect(resolveRelativeSlug('features/auth', './overview.md')).toBe('features/overview');
  });

  it('resolves a parent-relative path', () => {
    expect(resolveRelativeSlug('features/auth', '../README.md')).toBe('README');
  });

  it('resolves a plain filename from root-level slug', () => {
    expect(resolveRelativeSlug('README', 'features/auth.md')).toBe('features/auth');
  });

  it('resolves a sibling without ./ prefix from nested slug', () => {
    expect(resolveRelativeSlug('features/auth', 'overview.md')).toBe('features/overview');
  });

  it('resolves deeply nested relative paths', () => {
    expect(resolveRelativeSlug('a/b/c', '../../d.md')).toBe('d');
  });

  it('handles multiple .. segments', () => {
    expect(resolveRelativeSlug('a/b/c', '../../../root.md')).toBe('root');
  });
});

describe('classifyLink', () => {
  // knownSlugs is the UNION of all locales (as per updated design)
  const knownSlugs = new Set(['README', 'features/auth', 'features/overview', 'deployment/overview']);

  it('classifies absolute http URLs as external', () => {
    expect(classifyLink('https://example.com', 'README', knownSlugs)).toEqual({
      type: 'external',
    });
  });

  it('classifies absolute http (non-https) URLs as external', () => {
    expect(classifyLink('http://example.com/page', 'README', knownSlugs)).toEqual({
      type: 'external',
    });
  });

  it('classifies relative .md link to known slug as internal', () => {
    expect(classifyLink('./auth.md', 'features/overview', knownSlugs)).toEqual({
      type: 'internal',
      slug: 'features/auth',
    });
  });

  it('classifies relative .md link to unknown slug as broken', () => {
    expect(classifyLink('./nonexistent.md', 'features/auth', knownSlugs)).toEqual({
      type: 'broken',
    });
  });

  it('classifies .md link with fragment to known slug as internal', () => {
    expect(classifyLink('./auth.md#section', 'features/overview', knownSlugs)).toEqual({
      type: 'internal',
      slug: 'features/auth',
    });
  });

  it('classifies anchor-only links as passthrough', () => {
    expect(classifyLink('#section-id', 'README', knownSlugs)).toEqual({
      type: 'passthrough',
    });
  });

  it('classifies non-.md relative links as passthrough', () => {
    expect(classifyLink('./image.png', 'README', knownSlugs)).toEqual({
      type: 'passthrough',
    });
  });

  it('classifies slug that exists only in default locale as internal (fallback handles it)', () => {
    // 'deployment/overview' is in knownSlugs (union of all locales)
    // Even if it only exists in 'en', classifyLink uses the union set so it's internal
    expect(classifyLink('./overview.md', 'deployment/something', knownSlugs)).toEqual({
      type: 'internal',
      slug: 'deployment/overview',
    });
    // Also works from a different directory via parent-relative path
    expect(classifyLink('../deployment/overview.md', 'features/auth', knownSlugs)).toEqual({
      type: 'internal',
      slug: 'deployment/overview',
    });
  });
});

describe('LinkRewriter — multi-locale rendering', () => {
  // Union of all slugs across all locales
  const knownSlugs = new Set(['README', 'features/auth', 'features/overview', 'deployment/overview']);

  beforeEach(() => {
    mockNavigate.mockClear();
  });

  function renderLink(
    href: string,
    opts: { currentSlug?: string; currentLocale?: string } = {},
  ) {
    const { currentSlug = 'README', currentLocale = 'en' } = opts;
    return render(
      <MemoryRouter>
        <LinkRewriter
          currentSlug={currentSlug}
          knownSlugs={knownSlugs}
          currentLocale={currentLocale}
          href={href}
        >
          Link Text
        </LinkRewriter>
      </MemoryRouter>,
    );
  }

  describe('locale prefix in href (Requirement 8.1)', () => {
    it('rewrites relative .md link with locale prefix for default locale (en)', () => {
      renderLink('./auth.md', { currentSlug: 'features/overview', currentLocale: 'en' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '/en/docs/features/auth');
    });

    it('rewrites relative .md link with locale prefix for non-default locale (vi)', () => {
      renderLink('./auth.md', { currentSlug: 'features/overview', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '/vi/docs/features/auth');
    });

    it('rewrites parent-relative .md link with locale prefix', () => {
      renderLink('../README.md', { currentSlug: 'features/auth', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '/vi/docs/README');
    });

    it('preserves fragment in rewritten link with locale prefix', () => {
      renderLink('./auth.md#installation', { currentSlug: 'features/overview', currentLocale: 'en' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '/en/docs/features/auth#installation');
    });
  });

  describe('locale preservation on navigation (Requirement 8.2)', () => {
    it('navigates to locale-prefixed path when clicking internal link (en)', () => {
      renderLink('./auth.md', { currentSlug: 'features/overview', currentLocale: 'en' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/en/docs/features/auth');
    });

    it('navigates to locale-prefixed path when clicking internal link (vi)', () => {
      renderLink('./auth.md', { currentSlug: 'features/overview', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/features/auth');
    });

    it('preserves locale when navigating to parent-relative link', () => {
      renderLink('../README.md', { currentSlug: 'features/auth', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/README');
    });

    it('preserves fragment in navigation path', () => {
      renderLink('./auth.md#section', { currentSlug: 'features/overview', currentLocale: 'en' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/en/docs/features/auth#section');
    });
  });

  describe('broken links — slug not in ANY locale (Requirement 8.4)', () => {
    it('renders broken link with strikethrough for unknown slug', () => {
      renderLink('./nonexistent.md', { currentSlug: 'features/auth', currentLocale: 'en' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveClass('line-through');
      expect(link).toHaveClass('cursor-not-allowed');
      expect(link).toHaveAttribute('aria-disabled', 'true');
    });

    it('prevents navigation on broken link click', () => {
      renderLink('./nonexistent.md', { currentSlug: 'features/auth', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('slugs only in default locale still rewrite (Requirement 8.3)', () => {
    it('rewrites link to slug that exists only in default locale with active locale prefix', () => {
      // 'deployment/overview' is in knownSlugs (exists in at least one locale)
      // Even when currentLocale is 'vi' (and slug may only exist in 'en'),
      // the link should still be rewritten with 'vi' prefix — fallback handles it at runtime
      renderLink('../deployment/overview.md', { currentSlug: 'features/auth', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '/vi/docs/deployment/overview');
    });

    it('navigates to active locale path for slug only in default locale', () => {
      renderLink('../deployment/overview.md', { currentSlug: 'features/auth', currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      fireEvent.click(link);
      expect(mockNavigate).toHaveBeenCalledWith('/vi/docs/deployment/overview');
    });
  });

  describe('external and passthrough links are unaffected by locale', () => {
    it('renders external link with target=_blank', () => {
      renderLink('https://example.com', { currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', 'https://example.com');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('renders passthrough link as-is', () => {
      renderLink('#section-id', { currentLocale: 'vi' });
      const link = screen.getByText('Link Text');
      expect(link).toHaveAttribute('href', '#section-id');
    });
  });
});
