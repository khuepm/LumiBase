"use client";

import {
  clearConsent,
  notifyConsentChanged,
  revokeAnalyticsStorage,
  safeLocalStorage,
  useConsent,
  type ConsentDecision,
} from "@lumibase/analytics-consent/react";

const LABELS: Record<ConsentDecision, string> = {
  granted: "Analytics cookies: allowed",
  denied: "Analytics cookies: declined",
};

/**
 * Lets a visitor see and withdraw their analytics choice from the privacy page.
 *
 * "Opt out of analytics cookies" is a right the policy claims, so there has to be
 * a control that exercises it. Clearing the stored decision re-opens the banner
 * rather than silently flipping to declined, so the visitor makes the call.
 */
export default function CookiePreferences() {
  const consent = useConsent();

  if (consent === "unhydrated") return null;

  const reset = () => {
    clearConsent(safeLocalStorage());
    revokeAnalyticsStorage();
    notifyConsentChanged();
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span
        className="text-gray-400"
        style={{ font: "500 13px/1 var(--font-mono-stack, monospace)" }}
      >
        {consent ? LABELS[consent] : "Analytics cookies: not set (no GA cookies stored)"}
      </span>
      <button
        type="button"
        onClick={reset}
        className="btn-pill h-9 px-4 text-[13px]"
        style={{ border: "1px solid var(--color-dashline)", color: "var(--color-text-muted)" }}
      >
        {consent ? "Change my choice" : "Review choices"}
      </button>
    </div>
  );
}
