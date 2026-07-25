import type { Metadata } from "next";
import PricingCard from "@/components/PricingCard";
import { Reveal, RevealGroup, RevealItem } from "@/components/motion";
import { Zap, Shield, Fingerprint, GitBranch, ScrollText, Headphones } from "lucide-react";

export const metadata: Metadata = {
  title: "Pricing — LumiBase Content OS",
  description:
    "Open-source core, free forever under Apache 2.0. Optional managed hosting and enterprise support for the LumiBase Content Operating System.",
  alternates: {
    canonical: "/pricing/",
  },
};

const faqs = [
  {
    question: "What's the difference between self-hosted and managed?",
    answer:
      "Self-hosted means you deploy LumiBase on your own infrastructure (free, Apache 2.0). Managed means we host the Content OS for you with automatic updates, backups, and support (paid tiers).",
  },
  {
    question: "Is the Content OS core free?",
    answer:
      "Yes. The full Content OS — intents, the reconciliation loop, the trust ledger, the constitution, provenance, and the multi-agent newsroom — is open-source under Apache 2.0. Premium tiers add managed hosting and support, not core capabilities.",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes. Upgrade or downgrade at any time. Changes take effect immediately and we prorate the difference.",
  },
  {
    question: "How does GitHub Sponsors work?",
    answer:
      "When you sponsor us on GitHub, you get access to premium managed features based on your tier. We send you a reward token to unlock them.",
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "GitHub Sponsors (credit card, PayPal), and for Enterprise we also accept wire transfers and invoices.",
  },
];

const faqPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: { "@type": "Answer", text: faq.answer },
  })),
};

const breadcrumbJsonLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: "https://lumibase.dev" },
    { "@type": "ListItem", position: 2, name: "Pricing", item: "https://lumibase.dev/pricing/" },
  ],
};

const comparison = [
  { icon: Zap, name: "Edge-native delivery", community: "✓", hobby: "✓", enterprise: "✓" },
  { icon: GitBranch, name: "Trust ledger (L0–L4)", community: "✓", hobby: "✓", enterprise: "✓" },
  { icon: ScrollText, name: "Tenant constitution", community: "✓", hobby: "✓", enterprise: "✓" },
  { icon: Fingerprint, name: "Provenance on Delivery API", community: "✓", hobby: "✓", enterprise: "✓" },
  { icon: Shield, name: "Per-field encryption", community: "✓", hobby: "✓", enterprise: "✓" },
  { icon: Headphones, name: "Priority support", community: "—", hobby: "✓", enterprise: "✓✓" },
  { icon: Shield, name: "SSO (SAML, LDAP)", community: "—", hobby: "—", enterprise: "✓" },
  { icon: Shield, name: "Custom SLA", community: "—", hobby: "—", enterprise: "✓" },
];

export default function PricingPage() {
  return (
    <div className="flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPageJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="absolute inset-0 -z-10 bg-grid mask-radial opacity-50" />
        <Reveal className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Simple, transparent pricing
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-400">
            The Content OS core is free forever under Apache 2.0. Pay only when you want
            us to run it for you.
          </p>
        </Reveal>
      </section>

      {/* Cards */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <RevealGroup className="mx-auto grid max-w-6xl gap-8 md:grid-cols-3">
          <RevealItem>
            <PricingCard
              name="Community"
              price={0}
              period="forever"
              description="Self-hosted Content OS for builders and small teams"
              features={[
                "Full Content OS core",
                "Intents, reconciliation loop, trust ledger",
                "Constitution + provenance",
                "Full REST/MCP API access",
                "Self-hosted (Workers or Docker)",
                "Apache 2.0 License",
              ]}
              unavailableFeatures={[
                "Managed hosting",
                "Priority support",
                "SSO",
              ]}
              ctaText="Get Started Free"
              ctaLink="https://github.com/khuepm/lumibase"
            />
          </RevealItem>
          <RevealItem>
            <PricingCard
              name="Hobby"
              price={29}
              period="month"
              description="Managed hosting for growing, professional projects"
              popular
              features={[
                "Everything in Community",
                "Managed hosting + backups",
                "Priority email support",
                "Advanced analytics dashboard",
                "Early access to new features",
                "Vote on the roadmap",
              ]}
              unavailableFeatures={["SSO", "Dedicated support", "Custom SLA"]}
              ctaText="Sponsor on GitHub"
              ctaLink="https://github.com/sponsors/khuepm"
            />
          </RevealItem>
          <RevealItem>
            <PricingCard
              name="Enterprise"
              price={99}
              period="month"
              description="For large teams and mission-critical content"
              features={[
                "Everything in Hobby",
                "Dedicated support channel",
                "Custom SLA guarantees",
                "SSO (SAML, LDAP)",
                "On-premise deployment",
                "Training & onboarding",
              ]}
              ctaText="Contact Sales"
              ctaLink="mailto:contact@lumibase.dev"
            />
          </RevealItem>
        </RevealGroup>
      </section>

      {/* Comparison */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
              Feature comparison
            </h2>
          </Reveal>
          <Reveal className="mt-12 overflow-x-auto rounded-xl border border-ink-700">
            <table className="w-full">
              <thead>
                <tr className="border-b border-ink-700 bg-ink-900">
                  <th className="px-6 py-4 text-left font-mono text-xs uppercase tracking-widest text-gray-500">
                    Feature
                  </th>
                  <th className="px-6 py-4 text-center font-mono text-xs uppercase tracking-widest text-gray-500">
                    Community
                  </th>
                  <th className="px-6 py-4 text-center font-mono text-xs uppercase tracking-widest text-signal-400">
                    Hobby
                  </th>
                  <th className="px-6 py-4 text-center font-mono text-xs uppercase tracking-widest text-gray-500">
                    Enterprise
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((row) => (
                  <tr key={row.name} className="border-b border-ink-800 bg-ink-950/40 last:border-0">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <row.icon className="h-4 w-4 flex-shrink-0 text-signal-400" />
                        <span className="text-sm text-gray-300">{row.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-center text-sm text-gray-500">{row.community}</td>
                    <td className="px-6 py-4 text-center text-sm font-semibold text-signal-400">{row.hobby}</td>
                    <td className="px-6 py-4 text-center text-sm text-gray-500">{row.enterprise}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
              Frequently asked questions
            </h2>
          </Reveal>
          <RevealGroup className="mt-12 space-y-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700">
            {faqs.map((faq) => (
              <RevealItem key={faq.question} className="bg-ink-900 p-6">
                <h3 className="text-lg font-semibold text-foreground">{faq.question}</h3>
                <p className="mt-2 leading-7 text-gray-400">{faq.answer}</p>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-20 md:py-28">
        <Reveal className="relative mx-auto max-w-4xl overflow-hidden rounded-2xl border border-signal-500/30 bg-ink-900 px-6 py-16 text-center">
          <div className="absolute inset-0 -z-10 bg-grid mask-radial opacity-50" />
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Ready to get started?</h2>
          <p className="mx-auto mt-4 max-w-xl text-gray-400">
            Start free with the open-source core. Upgrade whenever you need us to
            run it for you.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-signal-500 px-6 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400"
            >
              Start Free
            </a>
            <a
              href="https://github.com/sponsors/khuepm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-ink-600 px-6 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-signal-500/50 hover:text-signal-400"
            >
              View Plans
            </a>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
