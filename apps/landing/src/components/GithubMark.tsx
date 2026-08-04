/**
 * GitHub mark as a local inline SVG.
 *
 * lucide-react dropped brand icons in v1, so `Github` is no longer importable
 * from the icon set. Keeping the mark local also keeps the header/footer links
 * visually unchanged across icon-library upgrades.
 */
export default function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .5C5.73.5.5 5.73.5 12.02c0 5.03 3.29 9.29 7.85 10.78.57.1.78-.25.78-.55v-2.1c-3.19.69-3.86-1.36-3.86-1.36-.52-1.32-1.28-1.67-1.28-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.68 1.25 3.33.96.1-.75.4-1.25.73-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.29 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.14 1.18a10.9 10.9 0 0 1 5.72 0c2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.76.11 3.05.73.8 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.2.66.79.55 4.56-1.5 7.84-5.75 7.84-10.78C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}
