import Link from "next/link";
import { ArrowRight, Zap, Globe, Lock, Code2, Cloud } from "lucide-react";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "LumiBase",
  url: "https://lumibase.dev",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cloudflare Workers, Docker, Node.js",
  description:
    "Edge-native headless CMS built on Cloudflare Workers. Deploy globally, manage content via REST API, multi-tenant by default.",
  softwareVersion: "0.4.5",
  codeRepository: "https://github.com/khuepm/lumibase",
  license: "https://lumibase.dev/license",
  isAccessibleForFree: true,
  offers: [
    {
      "@type": "Offer",
      name: "Community",
      price: "0",
      priceCurrency: "USD",
      description: "Self-hosted, open-source, free forever under MIT license.",
      url: "https://lumibase.dev/pricing/",
    },
    {
      "@type": "Offer",
      name: "Hobby",
      price: "29",
      priceCurrency: "USD",
      description: "Managed hosting with priority support and advanced analytics.",
      url: "https://lumibase.dev/pricing/",
    },
    {
      "@type": "Offer",
      name: "Enterprise",
      price: "99",
      priceCurrency: "USD",
      description: "Dedicated support, custom SLA, SSO, and on-premise deployment.",
      url: "https://lumibase.dev/pricing/",
    },
  ],
  author: {
    "@type": "Person",
    name: "Khuepm",
    url: "https://github.com/khuepm",
  },
};

export default function Home() {
  return (
    <div className="flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />
      {/* Hero Section */}
      <section className="relative px-6 pt-24 pb-16 md:pt-32 md:pb-24 lg:pt-40 lg:pb-32">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl md:text-7xl">
            Build Content Management
            <span className="block text-blue-600">At the Edge</span>
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300 sm:text-xl md:text-2xl">
            Lightning-fast headless CMS built for modern web development.
            Open-source, privacy-focused, and deployed at the edge.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            >
              Get Started
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="https://docs.lumibase.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 text-sm font-semibold text-gray-700 shadow-sm hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              Read Docs
            </Link>
          </div>
        </div>
      </section>

      {/* What is LumiBase — answer-target section for search & AI extraction */}
      <section className="px-6 py-16 md:py-24 bg-gray-50 dark:bg-gray-900">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            What is LumiBase?
          </h2>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300">
            LumiBase is an open-source, edge-native headless CMS that runs on
            Cloudflare Workers. It delivers content through a type-safe REST
            API, supports multi-tenancy out of the box, and can also be
            self-hosted with Docker. The core is free forever under the MIT
            license.
          </p>
          <p className="mt-4 text-lg leading-8 text-gray-600 dark:text-gray-300">
            Unlike traditional CMS platforms that run on a central server,
            LumiBase executes at the edge — close to your users — so content
            APIs respond with minimal latency from anywhere in the world.
          </p>
        </div>
      </section>

      {/* Features Section */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Why LumiBase?
          </h2>
          <div className="mt-12 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={<Zap className="h-8 w-8" />}
              title="Edge-Native Performance"
              description="Deployed on Cloudflare Workers for sub-millisecond response times globally."
            />
            <FeatureCard
              icon={<Globe className="h-8 w-8" />}
              title="Global CDN"
              description="Content served from 300+ edge locations worldwide for instant load times."
            />
            <FeatureCard
              icon={<Lock className="h-8 w-8" />}
              title="Privacy-First"
              description="Your data stays yours. Built with privacy and security as core principles."
            />
            <FeatureCard
              icon={<Code2 className="h-8 w-8" />}
              title="Developer Friendly"
              description="Type-safe APIs, comprehensive documentation, and modern tooling."
            />
            <FeatureCard
              icon={<Cloud className="h-8 w-8" />}
              title="Cloudflare Native"
              description="Built specifically for Cloudflare's edge platform for maximum performance."
            />
            <FeatureCard
              icon={<Code2 className="h-8 w-8" />}
              title="Open Source"
              description="Fully open-source MIT license. Contribute and customize freely."
            />
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl rounded-2xl bg-blue-600 px-6 py-16 text-center text-white">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Ready to Build at the Edge?
          </h2>
          <p className="mt-4 text-lg text-blue-100">
            Start building fast, modern content experiences with an open-source, edge-native CMS.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-blue-600 shadow-sm hover:bg-blue-50"
            >
              View on GitHub
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="https://docs.lumibase.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-blue-400 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700"
            >
              Documentation
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-6 shadow-sm dark:border-gray-800">
      <div className="mb-4 text-blue-600">{icon}</div>
      <h3 className="text-xl font-semibold">{title}</h3>
      <p className="mt-2 text-gray-600 dark:text-gray-300">{description}</p>
    </div>
  );
}
