"use client";

import Script from "next/script";
import { useCallback } from "react";

import {
  buildGtagBootstrap,
  gtagScriptUrl,
  notifyConsentChanged,
  revokeAnalyticsStorage,
  safeLocalStorage,
  shouldAskForConsent,
  shouldLoadAnalytics,
  useConsent,
  writeConsent,
  type ConsentDecision,
} from "@lumibase/analytics-consent/react";

/**
 * Loads GA4 behind an opt-in, and renders the banner that asks for it.
 *
 * Two invariants:
 *
 * 1. **No GA request before a grant.** The `<Script>` elements are not rendered
 *    at all until consent is `granted`, so the tag is never fetched — this is
 *    stricter than Consent Mode alone, which loads the tag and merely withholds
 *    storage.
 * 2. **Nothing renders before hydration.** `useConsent()` reports `'unhydrated'`
 *    on the server and on the first client render, because `output: 'export'`
 *    bakes one HTML file for everyone and a server-rendered banner would flash at
 *    visitors who already answered.
 */
export default function Analytics({ measurementId }: { measurementId: string }) {
  const consent = useConsent();

  const decide = useCallback((decision: ConsentDecision) => {
    writeConsent(safeLocalStorage(), decision);

    if (decision === "denied") {
      // Covers "granted earlier in this session, denied now": the tag is already
      // running, so tell it to stop storing and clear what it wrote.
      revokeAnalyticsStorage();
    }

    notifyConsentChanged();
  }, []);

  if (consent === "unhydrated") return null;

  return (
    <>
      {shouldLoadAnalytics(measurementId, consent) && (
        <>
          <Script id="ga-tag" src={gtagScriptUrl(measurementId)} strategy="afterInteractive" />
          <Script id="ga-bootstrap" strategy="afterInteractive">
            {buildGtagBootstrap(measurementId)}
          </Script>
        </>
      )}

      {shouldAskForConsent(measurementId, consent) && <ConsentBanner onDecide={decide} />}
    </>
  );
}

function ConsentBanner({ onDecide }: { onDecide: (decision: ConsentDecision) => void }) {
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-banner-title"
      className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-4"
    >
      <div
        className="mx-auto flex max-w-[1000px] flex-col gap-4 rounded-xl border px-5 py-4 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between"
        style={{
          borderColor: "var(--color-dashline)",
          background: "color-mix(in oklab, var(--background) 88%, transparent)",
        }}
      >
        <div>
          <p
            id="consent-banner-title"
            className="mb-1 text-white"
            style={{ font: "600 13px/1.4 var(--font-sans, inherit)" }}
          >
            Analytics cookies
          </p>
          <p
            style={{
              font: "400 13px/20px var(--font-serif-stack)",
              color: "var(--color-text-muted)",
            }}
          >
            We measure page traffic without cookies by default. Turning on Google Analytics
            adds cookies so we can see which pages actually help. No ads, no profiling, no
            data sold. See our{" "}
            <a href="/privacy/" className="underline hover:text-white">
              privacy policy
            </a>
            .
          </p>
        </div>

        <div className="flex shrink-0 gap-2.5">
          <button
            type="button"
            onClick={() => onDecide("denied")}
            className="btn-pill h-10 px-[18px] text-[13px]"
            style={{
              border: "1px solid var(--color-dashline)",
              color: "var(--color-text-muted)",
            }}
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => onDecide("granted")}
            className="btn-pill btn-solid h-10 px-[18px] text-[13px]"
          >
            Allow analytics
          </button>
        </div>
      </div>
    </div>
  );
}
