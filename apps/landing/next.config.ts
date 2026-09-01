import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'export',
  // Workspace packages publish raw TypeScript (`main: ./src/index.ts`), so Next
  // has to compile this one rather than treat it as pre-built JS.
  transpilePackages: ['@lumibase/analytics-consent'],
  images: {
    unoptimized: true,
  },
  trailingSlash: true,
  // Inline the (~6 KiB) Tailwind bundle into <head> instead of emitting a
  // render-blocking <link rel="stylesheet">. Removes the blocking CSS request
  // PageSpeed flagged (~150ms on mobile) at the cost of a few KB inlined into
  // each statically-exported HTML page.
  experimental: {
    inlineCss: true,
  },
};

export default nextConfig;
