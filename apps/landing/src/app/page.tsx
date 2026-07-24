import Link from "next/link";
import { ArrowRight } from "lucide-react";
import Hero from "@/components/Hero";
import ProductSection, { type SectionData } from "@/components/ProductSection";
import {
  CdcViz,
  CodeViz,
  IntentViz,
  McpViz,
  NewsroomViz,
  ProvenanceViz,
  RunsViz,
  SchemaViz,
} from "@/components/SectionVisuals";
import TrustViz from "@/components/TrustViz";
import { EclipsePhase } from "@/components/EclipseMark";
import EclipseStage from "@/components/scroll/EclipseStage";
import Scene from "@/components/scroll/Scene";
import WipeTitle from "@/components/scroll/WipeTitle";
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
  softwareVersion: "0.24.1",
  codeRepository: "https://github.com/khuepm/lumibase",
  license: "https://lumibase.dev/license",
  isAccessibleForFree: true,
  offers: [
    {
      "@type": "Offer",
      name: "Community",
      price: "0",
      priceCurrency: "USD",
      description: "Self-hosted, open-source, free forever under the Apache 2.0 license.",
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
      "Yes. The core LumiBase is free forever under the Apache 2.0 license. It runs edge-native on Cloudflare Workers and can also be self-hosted with Docker via a shared runtime abstraction.",
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

const DOCS = "https://docs.lumibase.dev";

const sections: SectionData[] = [
  {
    id: "ai-harness",
    index: 1,
    phase: 0,
    title: "AI Harness",
    tagline: "Agents operate your content. You set the intent — and hold the veto.",
    cta: "Explore the Harness",
    ctaHref: `${DOCS}/en/docs/features/agent-harness-layer`,
    features: [
      {
        title: "Goals, runs & real skills",
        desc: "The first-class API is a goal, not a click. Agents pursue it through governed skills — every run inspectable, replayable, and attributed.",
        span: 2,
        node: <RunsViz />,
      },
      {
        title: "Trust gradient · L0–L4",
        desc: "Autonomy is earned, not granted. Promotion is data — clean runs and passing evaluations. Demotion on incident is automatic.",
        bg: "var(--color-surface-sunken)",
        node: <TrustViz />,
      },
      {
        title: "Human-in-the-loop",
        desc: "schema:write and delete always route through approval — at every autonomy level, with no exceptions.",
        node: <EclipsePhase phase={1} size={96} />,
      },
      {
        title: "Provenance-first",
        desc: "Every revision records agent, run, model, references, and approver — served on the Delivery API with ?provenance=true.",
        node: <ProvenanceViz />,
      },
    ],
  },
  {
    id: "content-os",
    index: 2,
    phase: 1,
    title: "Content OS",
    tagline: "Declare the desired state. LumiBase reconciles content toward it, continuously.",
    cta: "Read the vision",
    ctaHref: `${DOCS}/en/docs/ai-native-vision`,
    features: [
      {
        title: "Intent-driven, not click-driven",
        desc: "The unit of work is an intent with an SLO. Content that violates its SLO is an incident — detected, raised as a goal, fixed within a write budget.",
        span: 2,
        node: <IntentViz />,
      },
      {
        title: "Reconciliation loop",
        desc: "Content drifts; a control loop pulls it back. Live state, not last-edit state — the Kubernetes idea, applied to content.",
        node: <EclipsePhase phase={2} size={96} />,
      },
      {
        title: "Tenant Constitution",
        desc: "Versioned, hashed publish gates encode your taste and policy. What fails the constitution never ships — at any autonomy level.",
        badge: "Publish gate",
        badgeTone: "accent",
        vh: 170,
      },
      {
        title: "Multi-agent newsroom",
        desc: "Writer, reviewer, translator, SEO — narrow per-role grants, cross-review between agents, and a hard self-review ban.",
        bg: "var(--color-surface-sunken)",
        node: <NewsroomViz />,
      },
    ],
  },
  {
    id: "studio",
    index: 3,
    phase: 2,
    title: "Studio",
    tagline: "Mission control — humans supervise the system instead of hand-editing every item.",
    cta: "Tour the Studio",
    ctaHref: `${DOCS}/en/docs/features/studio`,
    features: [
      {
        title: "No-code Collection Builder",
        desc: "Model any content shape without migrations or code — drag-drop UI and live JSON schema, kept in sync both ways.",
        badge: "Builder",
        badgeTone: "green",
        node: <SchemaViz />,
      },
      {
        title: "Field-level permissions",
        desc: "RBAC down to the individual field via a JSON policy engine — plus per-field AES-GCM encryption for the data that matters.",
        badge: "Security",
        badgeTone: "accent",
        vh: 170,
      },
      {
        title: "Exception inbox & trust ledger",
        desc: "Approvals, veto windows, incidents, and the kill switch in one queue. You review exceptions — not everything.",
        badge: "Mission Control",
        badgeTone: "blue",
        vh: 170,
      },
      {
        title: "Realtime collaboration",
        desc: "Presence, live subscriptions, and per-field pin badges over WebSocket — humans and agents on the same content.",
        node: <EclipsePhase phase={3} size={96} />,
      },
    ],
  },
  {
    id: "runtime",
    index: 4,
    phase: 3,
    title: "Runtime",
    tagline: "Edge-native, never locked in — Cloudflare Workers or self-hosted Docker, one abstraction.",
    cta: "Read the docs",
    ctaHref: DOCS,
    features: [
      {
        title: "Typegen + SDK",
        desc: "Your schema becomes TypeScript types, and a full JS/TS SDK covers auth, items, files, and realtime.",
        span: 2,
        node: <CodeViz />,
      },
      {
        title: "Runtime abstraction",
        desc: "@lumibase/runtime swaps cache, storage, DB, search, and queues per deployment target. Business logic never touches a vendor binding.",
        badge: "CF Workers · Docker",
        badgeTone: "neutral",
        vh: 170,
      },
      {
        title: "MCP server",
        desc: "Your content becomes tools any AI assistant can call — the API and MCP are the front door, the UI is a projection.",
        bg: "var(--color-surface-sunken)",
        node: <McpViz />,
      },
      {
        title: "ClickHouse CDC + materialized reads",
        desc: "Stream every change out; materialize hot read paths for the edge. Analytics without touching the write path.",
        node: <CdcViz />,
      },
    ],
  },
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

      <EclipseStage />

      <Hero />

      {sections.map((s) => (
        <ProductSection key={s.id} {...s} />
      ))}

      {/* ── FAQ ────────────────────────────────────────────── */}
      <Scene className="mx-auto w-full max-w-[760px] px-5 pt-[90px] md:pt-[140px]">
        <WipeTitle label="[ 05 / FIELD MANUAL ]" title="Questions, answered" />
        <RevealGroup className="mt-10 flex flex-col gap-4">
          {faqs.map((faq) => (
            <RevealItem key={faq.question} className="card-cosmic p-6">
              <h3
                className="m-0"
                style={{
                  font: "600 17px/24px var(--font-sans, inherit)",
                  letterSpacing: "-0.1px",
                  color: "var(--foreground)",
                }}
              >
                {faq.question}
              </h3>
              <p
                className="font-serif-body mb-0 mt-2.5"
                style={{
                  font: "400 14px/24px var(--font-serif-stack)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {faq.answer}
              </p>
            </RevealItem>
          ))}
        </RevealGroup>
      </Scene>

      {/* ── CTA — the second totality plays behind this scene ── */}
      <Scene className="mx-auto w-full max-w-[1200px] px-5 pb-[16vh] pt-[24vh]">
        <Reveal
          className="relative flex flex-col items-start justify-between gap-8 overflow-hidden rounded-[24px] p-8 md:flex-row md:items-center md:p-12"
          style={{
            background:
              "linear-gradient(135deg, rgba(230,80,10,0.18), rgba(255,160,0,0.06))",
            boxShadow: "var(--ring-glass-strong)",
          }}
        >
          <div
            className="pointer-events-none absolute -right-10 -top-16 opacity-70"
            aria-hidden
          >
            <EclipsePhase phase={3} size={220} />
          </div>
          <div className="relative max-w-[560px]">
            <p className="label-mono label-mono-accent m-0">
              [ FINAL TRANSMISSION ]
            </p>
            <h2
              className="m-0 mt-3 uppercase"
              style={{
                font: "800 34px/38px var(--font-sans, inherit)",
                letterSpacing: "-0.01em",
                color: "var(--foreground)",
              }}
            >
              Run your content like a system.
            </h2>
            <p
              className="font-serif-body mb-0 mt-3"
              style={{
                font: "400 16px/27px var(--font-serif-stack)",
                color: "var(--color-text-secondary)",
              }}
            >
              Declare the desired state. Let governed agents converge it. Keep
              the veto. Free forever under Apache 2.0.
            </p>
          </div>
          <div className="relative flex flex-wrap gap-3">
            <Link
              href="https://github.com/khuepm/lumibase"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill btn-solid btn-md"
            >
              <span>Start building</span>
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href={DOCS}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-pill btn-glass btn-md"
            >
              <span>Documentation</span>
            </Link>
          </div>
        </Reveal>
      </Scene>
    </div>
  );
}
