"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
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
import styles from "./IridescentLanding.module.css";

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
    after:
      "One place to manage content, connect agents, and review every change.",
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
    note: "The run stays within its assigned permissions and budget.",
  },
];

function Art({
  name,
  className,
  width,
  height,
  eager = false,
}: {
  name: string;
  className: string | undefined;
  width: number;
  height: number;
  eager?: boolean;
}) {
  return (
    <Image
      src={`/assets/iridescent/${name}.webp`}
      width={width}
      height={height}
      alt=""
      aria-hidden="true"
      className={`${styles.art} ${className}`}
      loading={eager ? "eager" : "lazy"}
      sizes="(max-width: 600px) 65vw, 45vw"
    />
  );
}
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
    <Link
      href={href}
      className={`${styles.button} ${secondary ? styles.secondary : ""}`}
    >
      {children}
      <ArrowRight size={16} aria-hidden="true" />
    </Link>
  );
}
function Orb({ icon: Icon }: { icon: typeof FileText }) {
  return (
    <span className={styles.iconOrb}>
      <Icon size={29} strokeWidth={1.3} aria-hidden="true" />
    </span>
  );
}

export default function IridescentLanding() {
  const [level, setLevel] = useState(3);
  const [expandedJob, setExpandedJob] = useState<number | null>(null);
  return (
    <div className={styles.landing}>
      <section id="top" className={styles.hero} aria-labelledby="hero-title">
        <div className={styles.stars} aria-hidden="true" />
        <div className={styles.heroAurora} aria-hidden="true" />
        <div className={styles.lightTrail} aria-hidden="true" />
        <Art
          name="garden-orb"
          className={styles.heroOrb}
          width={820}
          height={801}
          eager
        />
        <Art
          name="butterfly"
          className={styles.butterfly}
          width={680}
          height={641}
          eager
        />
        <Art name="fish" className={styles.fish} width={850} height={398} />
        <span
          className={`${styles.bubble} ${styles.bubbleOne}`}
          aria-hidden="true"
        />
        <span
          className={`${styles.bubble} ${styles.bubbleTwo}`}
          aria-hidden="true"
        />
        <span
          className={`${styles.bubble} ${styles.bubbleThree}`}
          aria-hidden="true"
        />
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>A living world for your content</p>
          <Image
            src="/assets/iridescent/wordmark.webp"
            alt="LumiBase"
            width={1500}
            height={297}
            loading="eager"
            fetchPriority="high"
            sizes="(max-width: 700px) 86vw, 680px"
            className={styles.heroWordmark}
          />
          <h1 id="hero-title">
            Your content, <span>operated by AI.</span>
          </h1>
          <p className={styles.heroDescription}>
            The open-source Content Operating System.
            <br />
            Agents draft, translate, and maintain your content.
            <br className={styles.mobileBreak} /> You set the standards and stay
            in control.
          </p>
          <div className={styles.actions}>
            <Action href={GITHUB}>Start building</Action>
            <Action href={DOCS} secondary>
              Read the docs
            </Action>
          </div>
          <p className={styles.heroFootnote}>
            Your intent. Your standards. Your final say.
          </p>
        </div>
        <p className={styles.marginNote}>
          A more
          <br />
          open internet
          <br />
          for content.
        </p>
        <a href="#content-os" className={styles.scrollHint}>
          Discover a different way to work <span>↓</span>
        </a>
      </section>

      <section
        id="content-os"
        className={`${styles.section} ${styles.intent}`}
        aria-labelledby="intent-title"
      >
        <div className={styles.sectionInner}>
          <div className={styles.sectionCopy}>
            <p className={styles.eyebrow}>01 / From intent to outcome</p>
            <h2 id="intent-title">
              Declare intent.
              <br />
              <span>Keep content on track.</span>
            </h2>
            <p>
              Define the fields, freshness, and languages your content needs.
              LumiBase detects gaps and routes work to agents within your rules.
            </p>
          </div>
          <div className={styles.intentVisual}>
            <div className={styles.nodeRow}>
              {[
                { icon: FileText, title: "Intent", detail: "You set the goal" },
                {
                  icon: Sparkles,
                  title: "Agents",
                  detail: "Governed execution",
                },
                {
                  icon: Box,
                  title: "Desired state",
                  detail: "Continuous care",
                },
              ].map(({ icon, title, detail }) => (
                <div className={styles.node} key={title}>
                  <Orb icon={icon} />
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </div>
              ))}
            </div>
            <div className={styles.intentExample}>
              <span className={styles.liveDot} />
              <span>
                “Keep every product translated into Vietnamese and English.”
              </span>
            </div>
          </div>
        </div>
      </section>

      <section
        id="ai-harness"
        className={`${styles.section} ${styles.trust}`}
        aria-labelledby="trust-title"
      >
        <Art
          name="ribbon"
          className={styles.trustRibbon}
          width={800}
          height={646}
        />
        <div className={`${styles.sectionInner} ${styles.trustInner}`}>
          <div className={styles.trustHeading}>
            <div>
              <p className={styles.eyebrow}>02 / Trust, built over time</p>
              <h2 id="trust-title">
                Agents earn autonomy.
                <br />
                <span>You set the limits.</span>
              </h2>
            </div>
            <p>
              Promotion needs evidence and your approval. Incidents lower trust
              automatically.
            </p>
          </div>
          <div
            className={styles.trustSteps}
            aria-label="Explore autonomy levels"
          >
            {levels.map((item, index) => (
              <button
                key={item.name}
                type="button"
                aria-pressed={level === index}
                aria-controls="autonomy-description"
                onClick={() => setLevel(index)}
                className={level === index ? styles.activeStep : ""}
              >
                <span className={styles.level}>L{index}</span>
                <span className={styles.stepDot} />
                <strong>{item.name}</strong>
                <small>{item.short}</small>
              </button>
            ))}
          </div>
          <p
            id="autonomy-description"
            className={styles.levelDescription}
            aria-live="polite"
          >
            {levels[level]?.description}
          </p>
          <div className={styles.standards}>
            <ShieldCheck size={22} aria-hidden="true" />
            <p>
              <strong>Your standards guide every agent.</strong> Set brand voice
              and publishing rules. Evaluate agent output before it goes live.
            </p>
          </div>
        </div>
      </section>

      <section
        id="studio"
        className={`${styles.section} ${styles.studio}`}
        aria-labelledby="studio-title"
      >
        <Art
          name="world-orb"
          className={styles.studioOrb}
          width={650}
          height={640}
        />
        <div className={styles.sectionInner}>
          <div className={styles.sectionCopy}>
            <p className={styles.eyebrow}>03 / Your mission control</p>
            <h2 id="studio-title">
              Review the exceptions,
              <br />
              <span>not every item.</span>
            </h2>
            <p>
              Inspect changes, decide what needs approval, and resolve incidents
              in one place. Step in or stop agents whenever you need.
            </p>
            <Action href={`${DOCS}/features/studio`} secondary>
              Explore the Studio
            </Action>
          </div>
          <div className={styles.consoleWrap}>
            <div className={styles.console}>
              <div className={styles.consoleHeader}>
                <strong>
                  <span className={styles.liveDot} />
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
                      onClick={() =>
                        setExpandedJob(expandedJob === index ? null : index)
                      }
                    >
                      <span className={styles.jobIcon}>
                        <job.icon
                          size={22}
                          strokeWidth={1.3}
                          aria-hidden="true"
                        />
                      </span>
                      <span className={styles.jobText}>
                        <strong>{job.title}</strong>
                        <small>{job.subtitle}</small>
                      </span>
                      <span className={`${styles.status} ${styles[job.tone]}`}>
                        {job.status}
                      </span>
                      <ChevronRight
                        size={17}
                        aria-hidden="true"
                        className={
                          expandedJob === index ? styles.chevronOpen : ""
                        }
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
                        <span>{index === 2 ? "Next step" : "Proposed"}</span>
                        {job.after}
                      </p>
                      <small>{job.note}</small>
                    </div>
                  </div>
                ))}
              </div>
              <div className={styles.consoleBottom}>
                <ShieldCheck size={14} aria-hidden="true" /> Governed by your
                workspace rules <span>All activity is recorded</span>
              </div>
            </div>
            <p className={styles.demoNote}>
              Illustrative workflow · select an update to inspect it
            </p>
          </div>
        </div>
      </section>

      <section
        id="mcp"
        className={`${styles.section} ${styles.mcp}`}
        aria-labelledby="mcp-title"
      >
        <div className={styles.sectionInner}>
          <div className={styles.sectionCopy}>
            <p className={styles.eyebrow}>04 / Connected by design</p>
            <h2 id="mcp-title">
              Bring your agents.
              <br />
              <span>Keep your rules.</span>
            </h2>
            <p>
              Connect compatible AI clients through LumiBase’s governed MCP
              endpoint. Content tools, permissions, and approvals in one
              operating system.
            </p>
            <Action href="https://docs.lumibase.dev/en/mcp/" secondary>
              Explore MCP
            </Action>
          </div>
          <div className={styles.connections}>
            <svg
              className={styles.connectionLines}
              viewBox="0 0 600 240"
              fill="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="connection-color">
                  <stop stopColor="#71e5ff" />
                  <stop offset=".5" stopColor="#c08bff" />
                  <stop offset="1" stopColor="#ffbde1" />
                </linearGradient>
              </defs>
              <path
                d="M140 110 C250 110 200 230 380 120 S470 20 545 110 M140 130 C290 240 300 130 380 120 S450 235 545 130"
                stroke="url(#connection-color)"
                strokeWidth="2"
              />
            </svg>
            <Link
              href="https://docs.lumibase.dev/en/mcp/"
              className={styles.mcpTile}
            >
              <Image
                src="/assets/iridescent/mcp.webp"
                width={480}
                height={471}
                alt="MCP"
                sizes="(max-width: 600px) 35vw, 200px"
              />
            </Link>
            <Link
              href={`${DOCS}/features/agent-harness-layer`}
              className={styles.apiTile}
            >
              <Image
                src="/assets/iridescent/agent-api.webp"
                width={420}
                height={223}
                alt="Agent API"
                sizes="(max-width: 600px) 24vw, 145px"
              />
            </Link>
            <Link
              href="https://github.com/khuepm/lumibase/tree/main/packages/sdk"
              className={styles.sdkTile}
            >
              <Image
                src="/assets/iridescent/sdk.webp"
                width={360}
                height={179}
                alt="SDK"
                sizes="(max-width: 600px) 20vw, 125px"
              />
            </Link>
          </div>
        </div>
      </section>

      <section
        id="provenance"
        className={`${styles.section} ${styles.lineage}`}
        aria-labelledby="lineage-title"
      >
        <Art
          name="flower"
          className={styles.lineageFlower}
          width={680}
          height={547}
        />
        <div className={`${styles.sectionInner} ${styles.lineageInner}`}>
          <p className={styles.eyebrow}>05 / A story behind every change</p>
          <h2 id="lineage-title">Every change has a lineage.</h2>
          <p>
            Trace agent-generated revisions back to their run, model, sources,
            and review history.
          </p>
          <div className={`${styles.nodeRow} ${styles.lineageNodes}`}>
            {[
              { icon: UserRound, title: "Agent" },
              { icon: Play, title: "Run" },
              { icon: Box, title: "Model" },
              { icon: Database, title: "Sources" },
              { icon: Check, title: "Review" },
            ].map(({ icon, title }) => (
              <div className={styles.node} key={title}>
                <Orb icon={icon} />
                <strong>{title}</strong>
              </div>
            ))}
          </div>
          <Link
            href={`${DOCS}/features/agent-harness-layer`}
            className={styles.textLink}
          >
            Follow the trail <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section
        id="runtime"
        className={`${styles.section} ${styles.runtime}`}
        aria-labelledby="runtime-title"
      >
        <Art
          name="crystal"
          className={styles.runtimeCrystal}
          width={600}
          height={565}
        />
        <Art
          name="bird"
          className={styles.runtimeBird}
          width={600}
          height={527}
        />
        <div className={styles.runtimeCopy}>
          <p className={styles.eyebrow}>06 / Open possibilities</p>
          <h2 id="runtime-title">
            Open source. Edge-native.
            <br />
            <span>Yours to build on.</span>
          </h2>
          <p>
            Cloudflare Workers or self-hosted Docker. Apache 2.0.
            <br />
            Your content, your infrastructure, your next chapter.
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
