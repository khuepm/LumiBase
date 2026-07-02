import Link from "next/link";

const columns = [
  {
    title: "Product",
    links: [
      { label: "AI Harness", href: "/#ai-harness", external: false },
      { label: "Content OS", href: "/#content-os", external: false },
      { label: "Studio", href: "/#studio", external: false },
      { label: "Runtime", href: "/#runtime", external: false },
      { label: "Pricing", href: "/pricing", external: false },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: "https://docs.lumibase.dev", external: true },
      {
        label: "Content OS vision",
        href: "https://docs.lumibase.dev/en/ai-native-vision.md",
        external: true,
      },
      { label: "GitHub", href: "https://github.com/khuepm/lumibase", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy", external: false },
      { label: "Terms", href: "/tos", external: false },
      { label: "License (MIT)", href: "/license", external: false },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="mx-auto w-full max-w-[1200px] px-5 pb-14 pt-[100px] md:pt-[140px]">
      <div className="flex flex-col justify-between gap-12 md:flex-row">
        {/* Brand */}
        <div className="max-w-[280px]">
          <div className="mb-3.5 flex items-center gap-2.5">
            <span className="sphere-logo h-[22px] w-[22px]" />
            <span
              className="text-white"
              style={{ font: "700 18px/1 var(--font-sans, inherit)", letterSpacing: "-0.4px" }}
            >
              LumiBase
            </span>
          </div>
          <p
            className="mb-[18px] mt-0"
            style={{
              font: "500 14px/22px var(--font-sans, inherit)",
              color: "var(--color-text-muted)",
            }}
          >
            The Content Operating System for the AI era. Open source under MIT.
          </p>
          <Link
            href="https://github.com/khuepm/lumibase"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-pill btn-solid h-10 px-[18px] text-[13px]"
          >
            <span>Start building</span>
          </Link>
        </div>

        {/* Link columns */}
        <div className="flex flex-wrap gap-x-16 gap-y-10">
          {columns.map((col) => (
            <div key={col.title}>
              <div
                className="mb-4 text-white"
                style={{ font: "600 13px/1 var(--font-sans, inherit)" }}
              >
                {col.title}
              </div>
              <div className="flex flex-col gap-3">
                {col.links.map((link) => (
                  <Link
                    key={link.label}
                    href={link.href}
                    {...(link.external
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                    className="transition-colors hover:text-white"
                    style={{
                      font: "500 14px/1 var(--font-sans, inherit)",
                      color: "var(--color-text-muted)",
                      textDecoration: "none",
                    }}
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        className="mt-16 flex flex-col items-center justify-between gap-3 pt-6 sm:flex-row"
        style={{
          borderTop: "1px solid var(--color-border)",
          font: "500 13px/1 var(--font-sans, inherit)",
          color: "var(--color-text-muted)",
        }}
      >
        <span>© {new Date().getFullYear()} LumiBase · MIT</span>
        <div className="flex gap-[18px]">
          <Link
            href="https://twitter.com/lumibase"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
            style={{ color: "inherit", textDecoration: "none" }}
          >
            Twitter
          </Link>
          <Link
            href="https://github.com/khuepm/lumibase/discussions"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
            style={{ color: "inherit", textDecoration: "none" }}
          >
            Community
          </Link>
          <Link
            href="https://github.com/khuepm/lumibase"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-white"
            style={{ color: "inherit", textDecoration: "none" }}
          >
            GitHub
          </Link>
        </div>
      </div>
    </footer>
  );
}
