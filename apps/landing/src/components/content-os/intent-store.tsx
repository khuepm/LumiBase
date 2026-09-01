"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useStaticMotion } from "@/components/scroll/useStaticMotion";
import {
  PRESET_COLLECTIONS,
  RUN_BEATS,
  collectionFromText,
  compileIntent,
  describeRun,
  evaluateIntent,
  formatIntentPayload,
  presetFor,
  sampleFor,
  type CompiledIntent,
  type RunPhase,
  type Violation,
} from "@/lib/intent-compile";

/**
 * Shared state for the Content OS split.
 *
 * The composer and the payload card are two separate panels on opposite sides
 * of the layout — one sticky, one scrolling — so the run they both describe
 * cannot live inside either of them. This holds it: the sentence you typed, the
 * compiled intent, the violations found in the sample, and where the
 * reconciliation beats have got to.
 */

interface Committed {
  collection: string;
  compiled: CompiledIntent;
  /** The `POST /api/v1/agent/intents` body, formatted for display. */
  payload: string;
  violations: Violation[];
  total: number;
  /** Increments on every commit, so the payload card can replay its reveal. */
  version: number;
}

interface IntentStore {
  text: string;
  setText: (next: string) => void;
  collection: string;
  presets: readonly string[];
  pickPreset: (next: string) => void;
  submit: () => void;
  committed: Committed;
  /** `idle` until the first submit; then walks the beats. */
  phase: RunPhase;
  status: string;
  converged: number;
  alarm: boolean;
  fixed: boolean;
  failing: number;
  reduced: boolean;
}

const IntentContext = createContext<IntentStore | null>(null);

export function useIntentStore(): IntentStore {
  const store = useContext(IntentContext);
  if (!store) throw new Error("useIntentStore must be used inside <IntentProvider>");
  return store;
}

function commit(text: string, activeCollection: string, version: number): Committed {
  // A sentence that names a collection wins over the chip, so the payload can
  // never contradict the sentence that produced it.
  const collection = collectionFromText(text, activeCollection);
  const compiled = compileIntent(text, collection);
  const items = sampleFor(collection);
  return {
    collection,
    compiled,
    payload: formatIntentPayload(collection, compiled),
    violations: evaluateIntent(compiled.rules, items),
    total: items.length,
    version,
  };
}

export function IntentProvider({ children }: { children: ReactNode }) {
  const reduced = useStaticMotion();
  const first = PRESET_COLLECTIONS[0];
  const [collection, setCollection] = useState<string>(first);
  const [text, setText] = useState(() => presetFor(first).sentence);
  // Compiled up front so the payload card has something to show before the
  // first click — pressing the button then visibly *changes* it, which is the
  // point of having the two panels side by side.
  const [committed, setCommitted] = useState<Committed>(() =>
    commit(presetFor(first).sentence, first, 0),
  );
  const [started, setStarted] = useState(false);
  const [beat, setBeat] = useState(0);

  const phase: RunPhase = started ? (reduced ? "incident" : RUN_BEATS[beat]!.phase) : "idle";

  // Advance the beats. Reduced motion holds on `incident` — the state worth
  // showing without animation is the one that names what fails.
  useEffect(() => {
    if (!started || reduced) return;
    if (beat >= RUN_BEATS.length - 1) return;
    const id = setTimeout(() => setBeat((b) => b + 1), RUN_BEATS[beat]!.ms);
    return () => clearTimeout(id);
  }, [started, beat, reduced]);

  const submit = useCallback(() => {
    setCommitted((prev) => {
      const next = commit(text, collection, prev.version + 1);
      setCollection(next.collection);
      return next;
    });
    setStarted(true);
    setBeat(0);
  }, [text, collection]);

  const pickPreset = useCallback((next: string) => {
    const preset = presetFor(next);
    setCollection(next);
    setText(preset.sentence);
    // Switching collections invalidates the previous run's numbers, so drop
    // back to idle rather than showing one collection's rules over another's
    // violations. The payload follows immediately.
    setCommitted((prev) => commit(preset.sentence, next, prev.version + 1));
    setStarted(false);
    setBeat(0);
  }, []);

  const failing = committed.violations.length;
  const run = useMemo(() => ({ total: committed.total, failing }), [committed.total, failing]);
  const { status, converged, alarm, fixed } = describeRun(phase, run);

  const value = useMemo<IntentStore>(
    () => ({
      text,
      setText,
      collection,
      presets: PRESET_COLLECTIONS,
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
    }),
    [
      text,
      collection,
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
    ],
  );

  return <IntentContext.Provider value={value}>{children}</IntentContext.Provider>;
}
