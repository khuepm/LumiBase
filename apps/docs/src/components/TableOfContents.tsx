import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * TableOfContents — generates and renders a Table of Contents from
 * H2 and H3 headings in the rendered document content.
 *
 * Features:
 * - Extracts H2/H3 headings from the DOM using rehype-slug IDs
 * - Sticky positioning on right side (screens > 1024px)
 * - Intersection Observer for active heading tracking
 * - Smooth scroll on click
 * - Hidden when fewer than 2 headings exist
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

export interface TocEntry {
  id: string; // heading element ID (from rehype-slug)
  text: string; // heading text content
  level: 2 | 3; // H2 or H3
}

export interface TocProps {
  entries: TocEntry[];
  activeId: string | null;
}

/**
 * Extracts H2 and H3 headings from a container element.
 * Relies on rehype-slug having added `id` attributes to headings.
 */
export function extractHeadings(container: Element): TocEntry[] {
  const headings = container.querySelectorAll('h2[id], h3[id]');
  const entries: TocEntry[] = [];

  headings.forEach((heading) => {
    const id = heading.getAttribute('id');
    const text = heading.textContent?.trim();
    if (id && text) {
      const level = heading.tagName === 'H2' ? 2 : 3;
      entries.push({ id, text, level: level as 2 | 3 });
    }
  });

  return entries;
}

/**
 * Presentational ToC list component.
 * Renders the list of entries with active highlighting.
 */
export function TocList({ entries, activeId }: TocProps) {
  if (entries.length < 2) {
    return null;
  }

  return (
    <nav aria-label="Table of Contents">
      <h2 className="mb-3.5 text-[12px] font-semibold uppercase tracking-[0.6px] text-muted-foreground">
        On this page
      </h2>
      <ul className="flex flex-col gap-2.5 border-l border-border pl-3.5">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a
              href={`#${entry.id}`}
              onClick={(e) => {
                e.preventDefault();
                const el = document.getElementById(entry.id);
                if (el) {
                  el.scrollIntoView({ behavior: 'smooth' });
                }
              }}
              className={`
                block text-[13px] font-medium leading-5 transition-colors
                ${entry.level === 3 ? 'pl-3' : ''}
                ${activeId === entry.id
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
                }
              `}
            >
              {entry.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * Full TableOfContents component with heading extraction and
 * Intersection Observer-based active heading tracking.
 *
 * Pass a ref to the content container so the component can
 * observe heading elements for scroll-based highlighting.
 */
export interface TableOfContentsProps {
  /** Ref to the scrollable content container holding the rendered markdown */
  contentRef: React.RefObject<Element | null>;
}

export function TableOfContents({ contentRef }: TableOfContentsProps) {
  const [entries, setEntries] = useState<TocEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Extract headings whenever the content changes
  useEffect(() => {
    const container = contentRef.current;
    if (!container) {
      setEntries([]);
      return;
    }

    // Use MutationObserver to detect when content is rendered/updated
    const updateHeadings = () => {
      const extracted = extractHeadings(container);
      setEntries(extracted);
    };

    // Initial extraction
    updateHeadings();

    // Watch for DOM changes (e.g., markdown re-render)
    const mutationObserver = new MutationObserver(updateHeadings);
    mutationObserver.observe(container, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
    };
  }, [contentRef]);

  // Set up Intersection Observer for active heading tracking
  const setupObserver = useCallback(() => {
    const container = contentRef.current;
    if (!container || entries.length < 2) return;

    // Clean up previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    // Track which headings are currently visible
    const visibleHeadings = new Set<string>();

    const observer = new IntersectionObserver(
      (intersectionEntries) => {
        intersectionEntries.forEach((intersectionEntry) => {
          const id = intersectionEntry.target.getAttribute('id');
          if (!id) return;

          if (intersectionEntry.isIntersecting) {
            visibleHeadings.add(id);
          } else {
            visibleHeadings.delete(id);
          }
        });

        // Highlight the first visible heading (topmost in document order)
        if (visibleHeadings.size > 0) {
          const firstVisible = entries.find((entry) =>
            visibleHeadings.has(entry.id),
          );
          if (firstVisible) {
            setActiveId(firstVisible.id);
          }
        }
      },
      {
        // Use a rootMargin that triggers when headings are near the top of the viewport
        rootMargin: '0px 0px -80% 0px',
        threshold: 0,
      },
    );

    // Observe all heading elements
    entries.forEach((entry) => {
      const el = document.getElementById(entry.id);
      if (el) {
        observer.observe(el);
      }
    });

    observerRef.current = observer;

    return () => {
      observer.disconnect();
    };
  }, [contentRef, entries]);

  useEffect(() => {
    const cleanup = setupObserver();
    return cleanup;
  }, [setupObserver]);

  // Don't render if fewer than 2 headings
  if (entries.length < 2) {
    return null;
  }

  return <TocList entries={entries} activeId={activeId} />;
}
