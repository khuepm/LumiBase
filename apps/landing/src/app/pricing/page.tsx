import type { Metadata } from "next";
import PricingCard from "@/components/PricingCard";
import { Zap, Shield, Users, Code2, Globe, Headphones } from "lucide-react";

export const metadata: Metadata = {
  title: "Pricing - LumiBase",
  description: "Choose the perfect plan for your needs. Open-source with optional premium features.",
  alternates: {
    canonical: "/pricing/",
  },
};

const faqs = [
  {
    question: "What's the difference between self-hosted and managed?",
    answer:
      "Self-hosted means you deploy LumiBase on your own infrastructure (free). Managed means we host it for you with automatic updates, backups, and support (paid tiers).",
  },
  {
    question: "Can I switch plans anytime?",
    answer:
      "Yes! You can upgrade or downgrade your plan at any time. Changes take effect immediately and we'll prorate the difference.",
  },
  {
    question: "Do I need to pay for the open-source version?",
    answer:
      "No! The core LumiBase is and will always be free and open-source under MIT license. Premium features are optional.",
  },
  {
    question: "How does GitHub Sponsors work?",
    answer:
      "When you sponsor us on GitHub, you'll get access to premium features based on your sponsorship tier. We'll send you a reward token to unlock features.",
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "We accept GitHub Sponsors (credit card, PayPal), and for Enterprise plans we also accept wire transfers and invoices.",
  },
];

const faqPageJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.answer,
    },
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
      {/* Hero Section */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Simple, Transparent Pricing
          </h1>
          <p className="mt-6 text-lg leading-8 text-gray-600 dark:text-gray-300 sm:text-xl">
            Start for free, upgrade when you need more. Open-source core with optional premium features.
          </p>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="px-6 pb-16 md:pb-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-8 md:grid-cols-3">
            {/* Free Tier */}
            <PricingCard
              name="Community"
              price={0}
              period="forever"
              description="Perfect for personal projects and small teams"
              features={[
                "Unlimited content items",
                "Full API access",
                "Community support",
                "Basic analytics",
                "Self-hosted",
                "MIT License",
              ]}
              unavailableFeatures={[
                "Priority support",
                "Advanced analytics",
                "Custom integrations",
                "SSO",
              ]}
              ctaText="Get Started Free"
              ctaLink="https://github.com/khuepm/lumibase"
            />

            {/* Hobby Tier - Popular */}
            <PricingCard
              name="Hobby"
              price={29}
              period="month"
              description="For growing projects and professional use"
              popular={true}
              features={[
                "Everything in Community",
                "Priority email support",
                "Advanced analytics dashboard",
                "Custom integrations",
                "Early access to new features",
                "GitHub Sponsors badge",
                "Vote on feature roadmap",
              ]}
              unavailableFeatures={[
                "SSO",
                "Dedicated support",
                "Custom SLA",
              ]}
              ctaText="Sponsor on GitHub"
              ctaLink="https://github.com/sponsors/khuepm"
            />

            {/* Enterprise Tier */}
            <PricingCard
              name="Enterprise"
              price={99}
              period="month"
              description="For large teams and mission-critical projects"
              features={[
                "Everything in Hobby",
                "Dedicated support channel",
                "Custom SLA guarantees",
                "SSO (SAML, LDAP)",
                "Custom contracts",
                "On-premise deployment",
                "Training & onboarding",
              ]}
              ctaText="Contact Sales"
              ctaLink="mailto:contact@lumibase.dev"
            />
          </div>
        </div>
      </section>

      {/* Features Comparison */}
      <section className="px-6 py-16 md:py-24 bg-gray-50 dark:bg-gray-900">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Feature Comparison
          </h2>
          
          <div className="mt-12 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800">
                  <th className="px-6 py-4 text-left text-sm font-semibold">Feature</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold">Community</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold text-blue-600">Hobby</th>
                  <th className="px-6 py-4 text-center text-sm font-semibold">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                <FeatureRow
                  icon={<Zap className="h-5 w-5" />}
                  name="Edge Performance"
                  community="✓"
                  hobby="✓"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Shield className="h-5 w-5" />}
                  name="Per-field Encryption"
                  community="✓"
                  hobby="✓"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Users className="h-5 w-5" />}
                  name="Team Collaboration"
                  community="✓"
                  hobby="✓"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Code2 className="h-5 w-5" />}
                  name="API Access"
                  community="✓"
                  hobby="✓"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Globe className="h-5 w-5" />}
                  name="Custom Domain"
                  community="✓"
                  hobby="✓"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Headphones className="h-5 w-5" />}
                  name="Priority Support"
                  community="—"
                  hobby="✓"
                  enterprise="✓✓"
                />
                <FeatureRow
                  icon={<Shield className="h-5 w-5" />}
                  name="SSO"
                  community="—"
                  hobby="—"
                  enterprise="✓"
                />
                <FeatureRow
                  icon={<Users className="h-5 w-5" />}
                  name="Custom SLA"
                  community="—"
                  hobby="—"
                  enterprise="✓"
                />
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Frequently Asked Questions
          </h2>
          
          <div className="mt-12 space-y-8">
            {faqs.map((faq) => (
              <FAQItem key={faq.question} question={faq.question} answer={faq.answer} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="px-6 py-16 md:py-24">
        <div className="mx-auto max-w-4xl rounded-2xl bg-blue-600 px-6 py-16 text-center text-white">
          <h2 className="text-3xl font-bold sm:text-4xl">
            Ready to Get Started?
          </h2>
          <p className="mt-4 text-lg text-blue-100">
            Start free with the open-source core. Upgrade whenever you need more.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <a
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-sm font-semibold text-blue-600 shadow-sm hover:bg-blue-50"
            >
              Start Free
            </a>
            <a
              href="https://github.com/sponsors/khuepm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-blue-400 px-6 py-3 text-sm font-semibold text-white hover:bg-blue-700"
            >
              View Plans
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

function FeatureRow({
  icon,
  name,
  community,
  hobby,
  enterprise,
}: {
  icon: React.ReactNode;
  name: string;
  community: string;
  hobby: string;
  enterprise: string;
}) {
  return (
    <tr className="border-b border-gray-200 dark:border-gray-800">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="text-blue-600">{icon}</div>
          <span className="text-gray-700 dark:text-gray-300">{name}</span>
        </div>
      </td>
      <td className="px-6 py-4 text-center text-gray-600 dark:text-gray-400">{community}</td>
      <td className="px-6 py-4 text-center font-semibold text-blue-600">{hobby}</td>
      <td className="px-6 py-4 text-center text-gray-600 dark:text-gray-400">{enterprise}</td>
    </tr>
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  return (
    <div>
      <h3 className="text-lg font-semibold">{question}</h3>
      <p className="mt-2 text-gray-600 dark:text-gray-400">{answer}</p>
    </div>
  );
}
