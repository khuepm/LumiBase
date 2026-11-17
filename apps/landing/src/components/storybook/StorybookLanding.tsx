"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ArrowRight,
  Box,
  Check,
  ChevronRight,
  Database,
  FileText,
  Play,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import StoryCanvas from "./StoryCanvas";
import styles from "./StorybookLanding.module.css";

const DOCS = "https://docs.lumibase.dev/en/docs";
const GITHUB = "https://github.com/khuepm/lumibase";

const levels = [
  {
    name: "Shadow",
    short: "Observe only",
    description:
      "Watch agents work before they touch your content. Outputs are recorded for evaluation, with no live changes.",
  },
  {
    name: "Propose",
    short: "Suggest changes",
    description:
      "Agents propose the next step. Every action waits for approval, so you can build confidence one decision at a time.",
  },
  {
    name: "Co-sign",
    short: "Approve risky changes",
    description:
      "Safe actions run automatically. Risky changes wait for approval. You stay involved where your judgment matters.",
  },
  {
    name: "Veto window",
    short: "Review before it goes live",
    description:
      "Eligible changes are staged for a review window. Veto a change before it goes live; otherwise, it commits when the window closes.",
  },
  {
    name: "Autopilot",
    short: "Within your limits",
    description:
      "Agents act within their granted permissions, rules, and budgets. Irreversible actions still require approval, and you can stop agents at any time.",
  },
];

const jobs = [
  {
    title: "Rewrite pricing page",
    subtitle: "Improve clarity and consistency",
    status: "Needs approval",
    tone: "amber",
    icon: FileText,
    before: "A powerful platform for all your content needs.",
    after: "One place to manage content, connect agents, and review every change.",
    next: "Proposed",
    note: "A copy change is ready for human review.",
  },
  {
    title: "Translate product details",
    subtitle: "Vietnamese → English",
    status: "Checks passed",
    tone: "mint",
    icon: Check,
    before: "Nội dung của bạn. Tiêu chuẩn của bạn.",
    after: "Your content. Your standards.",
    next: "Proposed",
    note: "Translation checks passed against the configured glossary.",
  },
  {
    title: "Complete SEO titles",
    subtitle: "Find gaps. Propose updates.",
    status: "In progress",
    tone: "blue",
    icon: Sparkles,
    before: "SEO title is missing on 3 product pages.",
    after: "The SEO agent is preparing title suggestions for review.",
    next: "Next step",
    note: "The run stays within its assigned permissions and budget.",
  },
] as const;

const wishSteps = [
  { icon: FileText, title: "Intent", detail: "You set the goal" },
  { icon: Sparkles, title: "Agents", detail: "Governed execution" },
  { icon: Box, title: "Desired state", detail: "Continuous care" },
];

const lineage = [
  { icon: UserRound, title: "Agent" },
  { icon: Play, title: "Run" },
  { icon: Box, title: "Model" },
  { icon: Database, title: "Sources" },
  { icon: Check, title: "Review" },
];

const connections = [
  { label: "MCP", detail: "Governed HTTP endpoint", href: "https://docs.lumibase.dev/en/mcp/" },
  { label: "Agent API", detail: "The harness, over HTTP", href: `${DOCS}/features/agent-harness-layer` },
  { label: "SDK", detail: "Typed client", href: "https://github.com/khuepm/lumibase/tree/main/packages/sdk" },
];

function Action({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: React.ReactNode;
  secondary?: boolean;
}) {
  return (
    <Link href={href} className={`${styles.button} ${secondary ? styles.secondary : ""}`}>
      {children}
      <ArrowRight size={16} aria-hidden="true" />
    </Link>
  );
}

export default function StorybookLanding() {
  const storyRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState(3);
  const [expandedJob, setExpandedJob] = useState<number | null>(null);

  return (
    <div ref={storyRef} className={styles.story}>
      <StoryCanvas storyRef={storyRef} level={level} />

      {/* ── Prologue ─────────────────────────────────────────────────── */}
      <section
        id="top"
        data-chapter="prologue"
        className={`${styles.chapter} ${styles.prologue}`}
        aria-labelledby="hero-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Once upon an idea</p>
          <h1 id="hero-title" className={styles.title}>
            Imagine it. <em>Lumi brings it to life.</em>
          </h1>
          <p className={styles.lede}>
            LumiBase is the open-source Content Operating System. Say what your content should be,
            and governed AI agents draft, translate, and maintain it — while you keep the final say.
          </p>
          <div className={styles.actions}>
            <Action href={GITHUB}>Start building</Action>
            <Action href={DOCS} secondary>
              Read the docs
            </Action>
          </div>
          <p className={styles.footnote}>Your intent. Your standards. Your final say.</p>
        </div>
        <a href="#content-os" className={styles.scrollHint}>
          Begin the story <span aria-hidden="true">↓</span>
        </a>
      </section>

      {/* ── Chapter one ──────────────────────────────────────────────── */}
      <section
        id="content-os"
        data-chapter="intent"
        className={styles.chapter}
        aria-labelledby="intent-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Chapter one · The wish</p>
          <h2 id="intent-title" className={styles.heading}>
            Declare intent. <em>Keep content on track.</em>
          </h2>
          <p>
            Define the fields, freshness, and languages your content needs. LumiBase detects gaps
            and routes work to agents within your rules.
          </p>
          <blockquote className={styles.wish}>
            <span className={styles.liveDot} aria-hidden="true" />
            “Keep every product translated into Vietnamese and English.”
          </blockquote>
          <ol className={styles.steps}>
            {wishSteps.map(({ icon: Icon, title, detail }) => (
              <li key={title}>
                <span className={styles.stepIcon}>
                  <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Chapter two ──────────────────────────────────────────────── */}
      <section
        id="ai-harness"
        data-chapter="trust"
        className={styles.chapter}
        aria-labelledby="trust-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Chapter two · The apprentice</p>
          <h2 id="trust-title" className={styles.heading}>
            Agents earn autonomy. <em>You set the limits.</em>
          </h2>
          <p>Promotion needs evidence and your approval. Incidents lower trust automatically.</p>
          <div className={styles.levels} role="group" aria-label="Explore autonomy levels">
            {levels.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={level === index}
                aria-controls="autonomy-description"
                onClick={() => setLevel(index)}
                className={level === index ? styles.activeLevel : undefined}
              >
                <span className={styles.levelTag}>L{index}</span>
                <strong>{item.name}</strong>
                <small>{item.short}</small>
              </button>
            ))}
          </div>
          <p id="autonomy-description" className={styles.levelDescription} aria-live="polite">
            {levels[level]?.description}
          </p>
          <p className={styles.standards}>
            <ShieldCheck size={20} aria-hidden="true" />
            <span>
              <strong>Your standards guide every agent.</strong> Set brand voice and publishing
              rules. Evaluate agent output before it goes live.
            </span>
          </p>
        </div>
      </section>

      {/* ── Chapter three ────────────────────────────────────────────── */}
      <section
        id="studio"
        data-chapter="studio"
        className={`${styles.chapter} ${styles.split}`}
        aria-labelledby="studio-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Chapter three · The looking glass</p>
          <h2 id="studio-title" className={styles.heading}>
            Review the exceptions, <em>not every item.</em>
          </h2>
          <p>
            Inspect changes, decide what needs approval, and resolve incidents in one place. Step in
            or stop agents whenever you need.
          </p>
          <Action href={`${DOCS}/features/studio`} secondary>
            Explore the Studio
          </Action>
        </div>
        <div className={styles.consoleWrap}>
          <div className={styles.console}>
            <div className={styles.consoleHeader}>
              <strong>
                <span className={styles.liveDot} aria-hidden="true" />
                Mission Control
              </strong>
              <span>Workspace preview</span>
            </div>
            <div className={styles.consoleSummary}>
              <span>
                <b>12</b> agents at work
              </span>
              <span>
                <b>3</b> updates to explore
              </span>
              <span className={styles.healthy}>System healthy</span>
            </div>
            <div className={styles.jobs}>
              {jobs.map((job, index) => (
                <div key={job.title} className={styles.job}>
                  <button
                    type="button"
                    aria-expanded={expandedJob === index}
                    aria-controls={`job-detail-${index}`}
                    onClick={() => setExpandedJob(expandedJob === index ? null : index)}
                  >
                    <span className={styles.jobIcon}>
                      <job.icon size={20} strokeWidth={1.4} aria-hidden="true" />
                    </span>
                    <span className={styles.jobText}>
                      <strong>{job.title}</strong>
                      <small>{job.subtitle}</small>
                    </span>
                    <span className={`${styles.status} ${styles[job.tone]}`}>{job.status}</span>
                    <ChevronRight
                      size={17}
                      aria-hidden="true"
                      className={expandedJob === index ? styles.chevronOpen : undefined}
                    />
                  </button>
                  <div
                    id={`job-detail-${index}`}
                    hidden={expandedJob !== index}
                    className={styles.jobDetail}
                  >
                    <p>
                      <span>Before</span>
                      {job.before}
                    </p>
                    <p>
                      <span>{job.next}</span>
                      {job.after}
                    </p>
                    <small>{job.note}</small>
                  </div>
                </div>
              ))}
            </div>
            <div className={styles.consoleBottom}>
              <ShieldCheck size={14} aria-hidden="true" /> Governed by your workspace rules
              <span>All activity is recorded</span>
            </div>
          </div>
          <p className={styles.demoNote}>Illustrative workflow · select an update to inspect it</p>
        </div>
      </section>

      {/* ── Chapter four ─────────────────────────────────────────────── */}
      <section id="mcp" data-chapter="mcp" className={styles.chapter} aria-labelledby="mcp-title">
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Chapter four · The gathering</p>
          <h2 id="mcp-title" className={styles.heading}>
            Bring your agents. <em>Keep your rules.</em>
          </h2>
          <p>
            Connect compatible AI clients through LumiBase’s governed MCP endpoint. Content tools,
            permissions, and approvals in one operating system.
          </p>
          <ul className={styles.connections}>
            {connections.map((item) => (
              <li key={item.label}>
                <Link href={item.href}>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Chapter five ─────────────────────────────────────────────── */}
      <section
        id="provenance"
        data-chapter="provenance"
        className={styles.chapter}
        aria-labelledby="lineage-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Chapter five · The trail of crumbs</p>
          <h2 id="lineage-title" className={styles.heading}>
            Every change <em>has a lineage.</em>
          </h2>
          <p>
            Trace agent-generated revisions back to their run, model, sources, and review history.
          </p>
          <ol className={styles.lineage}>
            {lineage.map(({ icon: Icon, title }) => (
              <li key={title}>
                <span className={styles.stepIcon}>
                  <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <span>{title}</span>
              </li>
            ))}
          </ol>
          <Link href={`${DOCS}/features/agent-harness-layer`} className={styles.textLink}>
            Follow the trail <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </section>

      {/* ── Epilogue ─────────────────────────────────────────────────── */}
      <section
        id="runtime"
        data-chapter="epilogue"
        className={`${styles.chapter} ${styles.epilogue}`}
        aria-labelledby="runtime-title"
      >
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Epilogue · Happily ever after</p>
          <h2 id="runtime-title" className={styles.heading}>
            Open source. Edge-native. <em>Yours to build on.</em>
          </h2>
          <p>
            Cloudflare Workers or self-hosted Docker. Apache 2.0. Your content, your infrastructure,
            your next chapter.
          </p>
          <div className={styles.actions}>
            <Action href={GITHUB}>Start building</Action>
            <Link href="/license" className={styles.textLink}>
              Explore the license <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
