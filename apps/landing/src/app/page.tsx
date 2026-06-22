import Link from "next/link";
import {
  ArrowRight,
  Target,
  RefreshCw,
  GitBranch,
  ScrollText,
  Fingerprint,
  Users,
  MonitorCheck,
} from "lucide-react";
import ControlLoop from "@/components/ControlLoop";
import { Reveal, RevealGroup, RevealItem } from "@/components/motion";

const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "LumiBase",
  url: "https://lumibase.dev",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Cloudflare Workers, Docker, Node.js",
  description:
    "LumiBase is a Content Operating System: an edge-native, AI-native headless CMS where governed agents operate content against declarative SLOs while humans set intent, taste, and accountability.",
  softwareVersion: "0.10.0",
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

const faqs = [
  {
    question: "What is a Content Operating System?",
    answer:
      "A traditional CMS is a tool humans use to manipulate content one operation at a time. A Content Operating System inverts that: you declare the desired state of your content (its SLOs), and a control loop of governed AI agents continuously reconciles content toward that state — with full provenance and human veto. LumiBase is that runtime.",
  },
  {
    question: "How is this different from an AI plugin bolted onto a CMS?",
    answer:
      "Autonomy in LumiBase is earned, not granted. Every (site, agent, capability) sits on a trust ladder from L0 (shadow) to L4 (autopilot). Agents are promoted by passing evaluations and auto-demoted on incidents. Every action is gated by a versioned tenant constitution and recorded with provenance.",
  },
  {
    question: "Do humans lose control?",
    answer:
      "No. Humans set intent, taste, and policy, and hold the veto. The L3 veto window stages dangerous changes and commits them only if no human objects within a time budget. A four-scope kill switch can halt agents instantly. Nothing publishes that fails the constitution.",
  },
  {
    question: "Is it open source?",
    answer:
      "Yes. The core LumiBase is free forever under the MIT license. It runs edge-native on Cloudflare Workers and can also be self-hosted with Docker via a shared runtime abstraction.",
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

const principles = [
  {
    icon: Target,
    title: "Intent, not operations",
    body: "Declare content SLOs — “every published product has ≥1 image, a 50–200 word description, and vi+en translations.” Agents converge content toward them.",
  },
  {
    icon: RefreshCw,
    title: "Reconciliation loop",
    body: "Continuous drift detection plus a reconciler that raises goals on drift and fixes them inside a write budget. Content is live, not static.",
  },
  {
    icon: GitBranch,
    title: "Earned autonomy (L0–L4)",
    body: "Per (site, agent, capability) trust from shadow to autopilot, with data-driven promotion, auto-demotion on incidents, and a four-scope kill switch.",
  },
  {
    icon: ScrollText,
    title: "Tenant constitution",
    body: "Versioned, hashed publish-gate evaluators. Artifacts that fail the constitution never publish — at any autonomy level.",
  },
  {
    icon: Fingerprint,
    title: "Provenance-first",
    body: "Every revision records the agent, run, model, references, constitution hash, evaluation, and approver — exposed on the Delivery API.",
  },
  {
    icon: Users,
    title: "Multi-agent newsroom",
    body: "A role library with planner delegation, narrow per-role grants, and agent-as-reviewer gated approvals with a self-review ban.",
  },
];

const trustLevels = [
  { level: "L0", name: "Shadow", desc: "Runs, writes nothing. Pure evaluation." },
  { level: "L1", name: "Propose", desc: "Every action waits for human approval." },
  { level: "L2", name: "Co-sign", desc: "Safe actions run; dangerous ones wait." },
  { level: "L3", name: "Veto window", desc: "Stages, commits unless a human vetoes." },
  { level: "L4", name: "Autopilot", desc: "Runs within budget. Kill switch armed." },
];

export default function Home() {
  return (
    <div className="flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPageJsonLd) }}
      />

      {/* ── Hero ───────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-ink-700 px-6 pt-20 pb-16 md:pt-28 md:pb-24">
        <div className="absolute inset-0 -z-10 bg-grid mask-radial opacity-60" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
          <Reveal>
            <div className="inline-flex items-center gap-2 rounded-full border border-signal-500/30 bg-signal-500/10 px-3 py-1 font-mono text-xs text-signal-400">
              <span className="h-1.5 w-1.5 animate-pulse-loop rounded-full bg-signal-400" />
              v0.5.0 · Content OS
            </div>
            <h1 className="mt-5 text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl md:text-6xl">
              The operating system
              <span className="block text-signal-400 text-signal-glow">
                for content
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-gray-400">
              Stop operating content by hand. Declare its desired state, let
              governed AI agents reconcile it continuously, and keep the veto.
              Edge-native, AI-native, open source.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="https://github.com/khuepm/lumibase"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md bg-signal-500 px-6 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400"
              >
                Start at the edge
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="https://docs.lumibase.dev/en/ai-native-vision.md"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-ink-600 px-6 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-signal-500/50 hover:text-signal-400"
              >
                Read the vision
              </Link>
            </div>
            <p className="mt-6 font-mono text-xs text-gray-600">
              $ npm create lumibase@latest my-content-os
            </p>
          </Reveal>

          <Reveal delay={0.15} className="flex justify-center lg:justify-end">
            <ControlLoop />
          </Reveal>
        </div>
      </section>

      {/* ── What is LumiBase (answer-target) ───────────────── */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-20">
        <Reveal className="mx-auto max-w-3xl">
          <h2 className="font-mono text-xs uppercase tracking-widest text-signal-400">
            {"// what is lumibase"}
          </h2>
          <p className="mt-5 text-xl leading-9 text-gray-300 md:text-2xl md:leading-10">
            LumiBase is a{" "}
            <span className="text-foreground">Content Operating System</span> — a
            runtime where AI agents <span className="text-foreground">operate</span>{" "}
            content while humans set intent, taste, and accountability. You declare
            the desired state of your content; a control loop of governed agents
            converges toward it, continuously, with full provenance and a human-held
            veto.
          </p>
        </Reveal>
      </section>

      {/* ── Trust ladder ───────────────────────────────────── */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Autonomy is earned, not granted
            </h2>
            <p className="mt-4 max-w-2xl text-gray-400">
              Every agent climbs a trust ladder per site and capability. Promotion
              is data — N clean runs, passing evaluations, zero incidents. One
              failure and it auto-demotes.
            </p>
          </Reveal>
          <RevealGroup className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {trustLevels.map((t) => (
              <RevealItem
                key={t.level}
                className="rounded-lg border border-ink-700 bg-ink-900 p-5 transition-colors hover:border-signal-500/40"
              >
                <div className="font-mono text-sm font-semibold text-signal-400">
                  {t.level}
                </div>
                <div className="mt-1 font-semibold text-foreground">{t.name}</div>
                <p className="mt-2 text-sm leading-6 text-gray-500">{t.desc}</p>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* ── Principles / features ──────────────────────────── */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Seven principles, one control plane
            </h2>
            <p className="mt-4 max-w-2xl text-gray-400">
              The shifts that turn a CMS into a Content OS — each one a real
              subsystem shipping in v0.5.0.
            </p>
          </Reveal>
          <RevealGroup className="mt-12 grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700 sm:grid-cols-2 lg:grid-cols-3">
            {principles.map((p) => (
              <RevealItem
                key={p.title}
                className="group bg-ink-900 p-6 transition-colors hover:bg-ink-800"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-signal-500/30 bg-signal-500/10 text-signal-400">
                  <p.icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-foreground">
                  {p.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-gray-500">{p.body}</p>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* ── Two planes ─────────────────────────────────────── */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-2">
          <Reveal className="rounded-xl border border-ink-700 bg-ink-900 p-8">
            <MonitorCheck className="h-7 w-7 text-signal-400" />
            <h3 className="mt-4 text-xl font-semibold text-foreground">
              Studio is Mission Control
            </h3>
            <p className="mt-3 leading-7 text-gray-400">
              An exception inbox, the live trust ledger, a kill switch, and
              per-field pin badges. Humans supervise the system — they don&apos;t
              hand-edit every item.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="rounded-xl border border-ink-700 bg-ink-900 p-8">
            <div className="font-mono text-2xl text-signal-400">/</div>
            <h3 className="mt-4 text-xl font-semibold text-foreground">
              The API &amp; MCP are the front door
            </h3>
            <p className="mt-3 leading-7 text-gray-400">
              Every capability is agent-callable first: goals, runs, tools,
              approvals, evaluations, and a public llms.txt per site. The UI is a
              projection of the agent surface.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── FAQ ────────────────────────────────────────────── */}
      <section className="border-b border-ink-700 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-3xl">
          <Reveal>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Questions, answered
            </h2>
          </Reveal>
          <RevealGroup className="mt-10 space-y-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700">
            {faqs.map((faq) => (
              <RevealItem key={faq.question} className="bg-ink-900 p-6">
                <h3 className="text-lg font-semibold text-foreground">
                  {faq.question}
                </h3>
                <p className="mt-2 leading-7 text-gray-400">{faq.answer}</p>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────── */}
      <section className="px-6 py-20 md:py-28">
        <Reveal className="relative mx-auto max-w-4xl overflow-hidden rounded-2xl border border-signal-500/30 bg-ink-900 px-6 py-16 text-center">
          <div className="absolute inset-0 -z-10 bg-grid mask-radial opacity-50" />
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Run your content like a system
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-gray-400">
            Declare the desired state. Let governed agents converge it. Keep the
            veto. Free forever under MIT.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-signal-500 px-6 py-3 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal-400"
            >
              View on GitHub
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="https://docs.lumibase.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-ink-600 px-6 py-3 text-sm font-semibold text-gray-200 transition-colors hover:border-signal-500/50 hover:text-signal-400"
            >
              Documentation
            </Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
