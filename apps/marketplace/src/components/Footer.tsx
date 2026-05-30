import Link from "next/link";
import { Layers } from "lucide-react";
import { CATEGORIES } from "@/lib/api";

export default function Footer() {
  return (
    <footer className="border-t border-surface-700/60 bg-surface-950 mt-24">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* Brand */}
          <div className="col-span-full lg:col-span-1">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700">
                <Layers className="h-4 w-4 text-white" />
              </div>
              <span className="text-sm font-bold text-gray-100">
                LumiBase <span className="text-brand-400">Marketplace</span>
              </span>
            </div>
            <p className="mt-3 text-xs text-gray-500 leading-relaxed max-w-xs">
              Discover and install extensions to supercharge your Lumibase
              headless CMS experience.
            </p>
          </div>

          {/* Extensions */}
          <div>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Extensions
            </h4>
            <ul className="space-y-2">
              <li>
                <Link
                  href="/extensions/"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  All Extensions
                </Link>
              </li>
              {CATEGORIES.slice(0, 4).map((cat) => (
                <li key={cat.slug}>
                  <Link
                    href={`/categories/${cat.slug}/`}
                    className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                  >
                    {cat.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources */}
          <div>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Resources
            </h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://docs.lumibase.dev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Documentation
                </a>
              </li>
              <li>
                <a
                  href="https://docs.lumibase.dev/extensions/create"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Build an Extension
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/khuepm/lumibase/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Report an Issue
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
              Legal
            </h4>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://lumibase.dev/privacy"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Privacy Policy
                </a>
              </li>
              <li>
                <a
                  href="https://lumibase.dev/tos"
                  className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Terms of Service
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 border-t border-surface-700/50 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-gray-600">
            © {new Date().getFullYear()} LumiBase. All rights reserved.
          </p>
          <p className="text-xs text-gray-600">
            Open-source under the{" "}
            <a
              href="https://github.com/khuepm/lumibase/blob/main/LICENSE"
              className="text-gray-500 hover:text-gray-300 underline underline-offset-2 transition-colors"
            >
              MIT License
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
