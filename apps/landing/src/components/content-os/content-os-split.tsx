"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GateArt, LoopArt, RelayArt } from "@/components/content-os/concept-art";
import { IntentProvider, useIntentStore } from "@/components/content-os/intent-store";
import { tokenizePayload, type JsonTokenKind } from "@/lib/intent-compile";

/**
 * Content OS editorial split.
 *
 * The large, operable intent card is the story's lead and stays pinned on the
 * left. The narrow rail on the right scrolls: first the payload produced by the
 * left card, then three illustrated concepts. This is deliberately asymmetric,
 * like an editorial lead image with related stories — not another dashboard
 * grid where every idea receives equal weight.
 */

const sans = "var(--font-sans, inherit)";
const mono = "var(--font-mono-stack, monospace)";

// ---------------------------------------------------------------------------
// Left: large sticky intent card
// ---------------------------------------------------------------------------

function IntentLead() {
  const store = useIntentStore();
  const {
    text,
    setText,
    collection,
    presets,
    pickPreset,
    submit,
    committed,
    phase,
    status,
    converged,
    alarm,
    fixed,
    failing,
    reduced,
  } = store;

  const idle = phase === "idle";
  const shown = committed.violations.slice(0, 3);
  const hidden = failing - shown.length;
  const current = idle ? committed.total - failing : converged;

  return (
    <article
      className="card-cosmic flex min-h-[520px] flex-col p-6 md:min-h-[620px] md:p-9"
      style={{
        background:
          "radial-gradient(100% 90% at 100% 0%,rgba(176,107,255,.14),transparent 55%),rgba(12,11,18,.78)",
      }}
    >
      <div className="max-w-[560px]">
        <div className="label-mono" style={{ color: "var(--color-text-muted)" }}>
          [ DECLARE ]
        </div>
        <h3
          className="mt-3"
          style={{
            font: "600 clamp(25px,3vw,38px)/1.12 var(--font-sans, inherit)",
            letterSpacing: "-0.035em",
            color: "var(--foreground)",
          }}
        >
          Intent-driven,
          <br />
          not click-driven
        </h3>
        <p
          className="mt-3 max-w-[420px]"
          style={{ font: `500 14px/22px ${sans}`, color: "var(--color-text-secondary)" }}
        >
          Declare the state you want. Watch it reconcile.
        </p>
      </div>

      <div className="my-auto py-8">
        <form
          aria-label="Declare a content intent"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="ring-glass flex items-center gap-2 rounded-xl px-2 pl-3.5"
          style={{ height: 50, background: "var(--color-surface-sunken)" }}
        >
          <label className="sr-only" htmlFor="intent-sentence">
            Intent for the {collection} collection
          </label>
          <input
            id="intent-sentence"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            autoComplete="off"
            placeholder={`Every ${collection.replace(/s$/, "")} must…`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:opacity-45"
            style={{ font: `500 14px ${sans}`, color: "var(--foreground)" }}
          />
          <button type="submit" className="btn-pill btn-solid btn-sm shrink-0">
            <span>Set intent</span>
          </button>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {presets.map((name) => {
            const active = name === collection;
            return (
              <button
                key={name}
                type="button"
                aria-pressed={active}
                onClick={() => pickPreset(name)}
                className="ring-glass rounded-full px-2.5 py-1 transition-[filter,background] hover:brightness-125"
                style={{
                  font: `600 11px ${mono}`,
                  background: active ? "var(--color-surface-4)" : "transparent",
                  color: active ? "var(--foreground)" : "var(--color-text-muted)",
                }}
              >
                {name}
              </button>
            );
          })}
          <span
            className="ml-auto hidden sm:inline"
            style={{ font: `500 10px ${mono}`, color: "var(--color-text-muted)" }}
          >
            local compiler
          </span>
        </div>
      </div>

      <div>
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2"
          style={{
            font: `600 11px ${mono}`,
            letterSpacing: ".04em",
            textTransform: "uppercase",
            color: alarm ? "var(--hue-gold)" : "var(--color-text-muted)",
          }}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{
              background: idle
                ? "var(--color-surface-4)"
                : alarm
                  ? "var(--hue-gold)"
                  : "var(--hue-teal)",
              boxShadow: idle
                ? "none"
                : `0 0 8px ${alarm ? "var(--hue-gold)" : "var(--hue-teal)"}`,
            }}
          />
          <span>{status}</span>
        </div>

        {/* Fixed footprint: reconciliation must not resize the sticky lead. */}
        <div className="mt-3 h-[68px]">
          <AnimatePresence initial={false} mode="wait">
            <motion.div
              key={`${phase}-${fixed}-${committed.version}`}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              transition={{ duration: reduced ? 0 : 0.18 }}
              className="flex flex-col gap-1"
            >
              {idle && (
                <span style={{ font: `400 11px ${mono}`, color: "var(--color-text-muted)" }}>
                  {failing} of {committed.total} sampled items drift from this intent
                </span>
              )}
              {!idle && phase !== "compiling" && shown.length === 0 && (
                <span style={{ font: `500 11px ${mono}`, color: "var(--hue-teal)" }}>
                  ✓ no drift in the sample
                </span>
              )}
              {!idle &&
                phase !== "compiling" &&
                shown.map((violation) => (
                  <span key={violation.slug} className="flex min-w-0 items-baseline gap-2">
                    <code
                      className="shrink-0 truncate"
                      style={{ font: `500 11px ${mono}`, color: "var(--foreground)", maxWidth: "45%" }}
                    >
                      {violation.slug}
                    </code>
                    <span
                      className="truncate"
                      style={{
                        font: `400 11px ${mono}`,
                        color: fixed ? "var(--hue-teal)" : "var(--hue-gold)",
                      }}
                    >
                      {fixed ? `✓ ${violation.fix}` : `✕ ${violation.reason}`}
                    </span>
                  </span>
                ))}
              {!idle && phase !== "compiling" && hidden > 0 && (
                <span style={{ font: `400 11px ${mono}`, color: "var(--color-text-muted)" }}>
                  +{hidden} more
                </span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center gap-2.5">
          <span style={{ font: `500 11px ${mono}`, color: "var(--color-text-muted)" }}>
            desired
          </span>
          <div
            className="relative h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: "var(--color-surface-4)" }}
          >
            <motion.div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: fixed ? "var(--hue-teal)" : "var(--color-blue)" }}
              animate={{ width: `${(current / committed.total) * 100}%` }}
              transition={{ duration: reduced ? 0 : 0.7, ease: "easeOut" }}
            />
          </div>
          <span className="shrink-0 text-cream" style={{ font: `600 11px ${mono}` }}>
            {current}/{committed.total}
          </span>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Right: black JSON card
// ---------------------------------------------------------------------------

const TOKEN_COLOR: Record<JsonTokenKind, string> = {
  key: "#c4a8ff",
  string: "#29d8e6",
  number: "#ffb020",
  keyword: "#ff4d8d",
  punct: "rgba(244,242,255,.34)",
  plain: "rgba(244,242,255,.72)",
};

function PayloadCard() {
  const { committed, reduced } = useIntentStore();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = tokenizePayload(committed.payload);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(committed.payload);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // The code remains selectable if clipboard permission is denied.
    }
  }

  return (
    <article
      className="relative overflow-hidden rounded-[18px]"
      style={{
        background: "#030207",
        boxShadow:
          "inset 0 0 0 1px rgba(196,168,255,.15),0 24px 60px -28px rgba(0,0,0,.95),0 0 70px -42px rgba(176,107,255,.8)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{
          background:
            "linear-gradient(180deg,rgba(176,107,255,.14),rgba(214,31,159,.04) 55%,transparent)",
        }}
      />
      <div className="relative flex items-center justify-between px-4 pt-4">
        <span
          style={{
            font: `600 9px ${mono}`,
            letterSpacing: ".14em",
            textTransform: "uppercase",
            color: "rgba(196,168,255,.7)",
          }}
        >
          intent-rule.v1
        </span>
        <button
          type="button"
          onClick={copy}
          className="ring-glass rounded-full px-2 py-0.5 hover:brightness-125"
          style={{
            font: `600 9px ${mono}`,
            background: "rgba(244,242,255,.05)",
            color: copied ? "var(--hue-teal)" : "rgba(244,242,255,.6)",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>

      {/* Remount/reveal on every commit so the button visibly rewrites this
          card rather than silently swapping text. */}
      <div
        key={committed.version}
        className="relative overflow-x-auto px-4 pb-5 pt-3"
        aria-label="Compiled intent payload"
      >
        {lines.map((tokens, row) => (
          <motion.div
            key={row}
            className="flex whitespace-pre"
            initial={reduced ? false : { opacity: 0, y: 5, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: reduced ? 0 : 0.32, delay: reduced ? 0 : row * 0.04 }}
            style={{ font: `500 10.5px/1.8 ${mono}` }}
          >
            <span
              aria-hidden
              className="mr-3 w-[1.4em] shrink-0 select-none text-right tabular-nums"
              style={{ color: "rgba(244,242,255,.15)" }}
            >
              {row + 1}
            </span>
            <code>
              {tokens.map((token, index) => (
                <span key={index} style={{ color: TOKEN_COLOR[token.kind] }}>
                  {token.text}
                </span>
              ))}
            </code>
          </motion.div>
        ))}

        {committed.compiled.warnings.length > 0 && (
          <div
            className="mt-3 border-t pt-3"
            style={{
              borderColor: "rgba(244,242,255,.07)",
              font: `400 9px/1.5 ${mono}`,
              color: "rgba(255,176,32,.72)",
            }}
          >
            ⚠ {committed.compiled.warnings[0]}
          </div>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Right: three small illustrated cards
// ---------------------------------------------------------------------------

const VISION_DOC = "https://docs.lumibase.dev/en/docs/ai-native-vision";

const CONCEPTS = [
  {
    title: "Reconciliation loop",
    desc: "Content drifts. The loop pulls it back.",
    art: <LoopArt />,
    href: `${VISION_DOC}#p2-desired-state--reconciliation-learned-from-kubernetes-applied-to-content`,
  },
  {
    title: "Tenant Constitution",
    desc: "Versioned publish gates. What fails never ships.",
    art: <GateArt />,
    href: `${VISION_DOC}#p4-content-constitution-tenant-constitution--editorial-taste-becomes-machine-checkable`,
  },
  {
    title: "Multi-agent newsroom",
    desc: "Separate roles, cross-review, no self-approval.",
    art: <RelayArt />,
    href: `${VISION_DOC}#p6-an-agent-newsroom-multi-agent-organization-not-one-big-agent`,
  },
];

function ConceptCard({
  title,
  desc,
  art,
  href,
}: {
  title: string;
  desc: string;
  art: React.ReactNode;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block no-underline"
      style={{ color: "inherit" }}
    >
      <article>
        <div
          className="overflow-hidden rounded-[14px]"
          style={{ aspectRatio: "16 / 9", boxShadow: "var(--ring-glass)" }}
        >
          {art}
        </div>
        <h4
          className="mt-2.5"
          style={{ font: `600 14px/20px ${sans}`, color: "var(--foreground)" }}
        >
          {title}
        </h4>
        <p
          className="mt-1"
          style={{ font: `500 12px/18px ${sans}`, color: "var(--color-text-muted)" }}
        >
          {desc}
        </p>
      </article>
    </a>
  );
}

export default function ContentOsSplit() {
  return (
    <IntentProvider>
      <div className="mt-10 grid grid-cols-1 items-start gap-7 md:mt-16 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* Sticky only where the layout is side-by-side. On narrow screens it is
            normal flow: pinning a 620px card in an 800px viewport would hide the
            rail behind it. */}
        <div className="lg:sticky lg:top-[10vh]">
          <IntentLead />
        </div>
        <aside className="flex min-w-0 flex-col gap-8" aria-label="Intent output and Content OS concepts">
          <PayloadCard />
          {CONCEPTS.map((concept) => (
            <ConceptCard key={concept.title} {...concept} />
          ))}
        </aside>
      </div>
    </IntentProvider>
  );
}
