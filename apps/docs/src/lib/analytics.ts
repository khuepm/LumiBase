import { resolveMeasurementId } from '@lumibase/analytics-consent';

/**
 * The GA4 property this build reports to, or `null` when analytics is not
 * configured (the default).
 *
 * Vite inlines `VITE_GA_ID` at build time, so rotating the property needs a
 * rebuild — same contract as `NEXT_PUBLIC_GA_ID` on the landing app.
 *
 * Consent is per-origin because `localStorage` is: a visitor who allowed
 * analytics on `lumibase.dev` has not allowed it on `docs.lumibase.dev`, so this
 * site asks for itself and offers its own withdrawal control in the footer.
 */
export const gaMeasurementId = resolveMeasurementId(import.meta.env.VITE_GA_ID);
