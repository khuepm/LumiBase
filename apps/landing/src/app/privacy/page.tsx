import type { Metadata } from "next";

import CookiePreferences from "@/components/analytics/CookiePreferences";
import { resolveMeasurementId } from "@lumibase/analytics-consent";

const gaMeasurementId = resolveMeasurementId(process.env.NEXT_PUBLIC_GA_ID);

export const metadata: Metadata = {
  title: "Privacy Policy - LumiBase",
  description: "Privacy Policy for LumiBase — the Content Operating System.",
  alternates: {
    canonical: "/privacy/",
  },
};

export default function PrivacyPolicy() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="font-display text-4xl">Privacy Policy</h1>
      <p className="mt-4 text-gray-400">Last updated: August 24, 2026</p>

      <div className="mt-12 space-y-8 [&_h2]:text-2xl [&_h2]:text-foreground [&_p]:mt-2 [&_p]:leading-7 [&_p]:text-gray-400 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_li]:text-gray-400">
        <section>
          <h2 className="font-display text-2xl">1. Introduction</h2>
          <p>
            LumiBase ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains
            how we collect, use, and protect your information when you use our Service.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">2. Information We Collect</h2>
          <p>
            As an open-source project, LumiBase is designed to be self-hosted. When you deploy LumiBase on your
            own infrastructure, you have full control over your data. We do not collect or store any data from
            self-hosted instances.
          </p>
          <p>
            On our public websites (lumibase.dev and docs.lumibase.dev), we collect two separate
            things:
          </p>
          <ul>
            <li>
              <strong className="text-foreground">Aggregate traffic measurement, always on.</strong>{" "}
              Cloudflare Web Analytics counts page views and page-load timings. It sets no
              cookies, stores no identifier in your browser, and does not fingerprint you, so
              it needs no consent and cannot follow you between sites.
            </li>
            <li>
              <strong className="text-foreground">Google Analytics 4, only if you allow it.</strong>{" "}
              If you accept analytics cookies, Google Analytics records which pages you visit
              and how you reached them. This is off until you opt in, and you can withdraw at
              any time in section 6.
            </li>
          </ul>
          <p>
            Neither collects your name, email, or account data — we have no accounts on this
            website. We do not sell data, run advertising, or share it with ad networks.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">3. How We Use Your Information</h2>
          <p>
            We use the information we collect to:
          </p>
          <ul>
            <li>Improve and maintain our Service</li>
            <li>Analyze usage patterns to enhance user experience</li>
            <li>Monitor performance and fix bugs</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-2xl">4. Data Storage and Security</h2>
          <p>
            For self-hosted instances, all data is stored on your own infrastructure. We have no access to your
            content, user data, or any other information stored in your LumiBase instance.
          </p>
          <p>
            For our public website, we implement appropriate security measures to protect your information from
            unauthorized access, alteration, or destruction.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">5. Third-Party Services</h2>
          <p>
            Our website may use third-party services such as:
          </p>
          <ul>
            <li>
              <strong className="text-foreground">Cloudflare</strong> — content delivery, DDoS
              protection, and cookieless Web Analytics
            </li>
            <li>
              <strong className="text-foreground">Google Analytics 4</strong> — page analytics,
              loaded only after you opt in. Google acts as a data processor and may process
              data outside your country. Google Signals and ad personalisation are disabled on
              our property.
            </li>
            <li>
              <strong className="text-foreground">GitHub</strong> — code hosting and issue
              tracking
            </li>
          </ul>
          <p>
            These services have their own privacy policies. We encourage you to review them.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">6. Cookies and your choice</h2>
          <p>
            This website sets no cookies until you allow analytics. If you do, Google Analytics
            stores <code>_ga</code> and <code>_ga_&lt;id&gt;</code> cookies to tell repeat visits
            apart. Declining keeps the site fully functional — nothing here depends on cookies.
          </p>
          <p>
            Your choice is stored locally in your browser, not on our servers, so it does not
            identify you. Withdrawing removes the analytics cookies we set and stops further
            collection.
          </p>
          <p>
            Because that choice lives in your browser&apos;s per-site storage, it applies to one
            site at a time. Our documentation site (
            <a
              href="https://docs.lumibase.dev"
              className="underline transition-colors hover:text-foreground"
            >
              docs.lumibase.dev
            </a>
            ) asks separately and carries its own control in the page footer — allowing analytics
            here does not allow it there, and neither does declining.
          </p>
          {gaMeasurementId ? (
            <CookiePreferences />
          ) : (
            <p>
              Analytics cookies are not configured on this deployment, so none are set at all.
            </p>
          )}
        </section>

        <section>
          <h2 className="font-display text-2xl">7. Data Retention</h2>
          <p>
            For self-hosted instances, data retention is entirely under your control. For our public website,
            we retain data only as long as necessary for the purposes outlined in this policy.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">8. Your Rights</h2>
          <p>
            You have the right to:
          </p>
          <ul>
            <li>Access information we hold about you (for our public services)</li>
            <li>Request deletion of your data (for our public services)</li>
            <li>Opt out of analytics cookies at any time (see section 6)</li>
            <li>Self-host your own instance with complete data control</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-2xl">9. Children's Privacy</h2>
          <p>
            Our Service is not intended for children under 13. We do not knowingly collect personal information
            from children under 13.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">10. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify you of any changes by posting the
            new policy on this page.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">11. Contact Us</h2>
          <p>
            If you have questions about this Privacy Policy, please contact us through our
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className="text-signal-400 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
