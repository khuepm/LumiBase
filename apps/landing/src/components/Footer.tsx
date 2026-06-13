import Link from "next/link";
import { Github, Twitter, Terminal } from "lucide-react";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Documentation", href: "https://docs.lumibase.dev", external: true },
      { label: "Content OS vision", href: "https://docs.lumibase.dev/en/ai-native-vision.md", external: true },
      { label: "GitHub", href: "https://github.com/khuepm/lumibase", external: true },
      { label: "Pricing", href: "/pricing", external: false },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms of Service", href: "/tos", external: false },
      { label: "Privacy Policy", href: "/privacy", external: false },
      { label: "License (MIT)", href: "/license", external: false },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-ink-700 bg-ink-950">
      <div className="mx-auto max-w-6xl px-6 py-14">
        <div className="grid gap-10 md:grid-cols-4">
          {/* Brand */}
          <div className="md:col-span-2 space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-signal-500/40 bg-signal-500/10 text-signal-400">
                <Terminal className="h-4 w-4" />
              </div>
              <span className="font-mono text-lg font-semibold text-foreground">
                Lumi<span className="text-signal-400">Base</span>
              </span>
            </div>
            <p className="max-w-sm text-sm leading-6 text-gray-500">
              The Content Operating System. Declare intent, let governed agents
              converge your content, keep the veto. Edge-native, AI-native,
              open source under MIT.
            </p>
            <div className="flex gap-3 pt-1">
              <Link
                href="https://github.com/khuepm/lumibase"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 transition-colors hover:text-signal-400"
                aria-label="GitHub"
              >
                <Github className="h-5 w-5" />
              </Link>
              <Link
                href="https://twitter.com/lumibase"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 transition-colors hover:text-signal-400"
                aria-label="Twitter"
              >
                <Twitter className="h-5 w-5" />
              </Link>
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="mb-4 font-mono text-xs font-semibold uppercase tracking-widest text-gray-500">
                {col.title}
              </h3>
              <ul className="space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      {...(link.external
                        ? { target: "_blank", rel: "noopener noreferrer" }
                        : {})}
                      className="text-sm text-gray-400 transition-colors hover:text-signal-400"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-2 border-t border-ink-700 pt-8 text-sm text-gray-500 sm:flex-row">
          <p className="font-mono text-xs">
            © {new Date().getFullYear()} LumiBase · MIT
          </p>
          <p className="font-mono text-xs text-gray-600">
            built at the edge · operated by agents
          </p>
        </div>
      </div>
    </footer>
  );
}
