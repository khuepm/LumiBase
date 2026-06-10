import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy - LumiBase",
  description: "Privacy Policy for LumiBase - Edge-Native Headless CMS",
  alternates: {
    canonical: "/privacy/",
  },
};

export default function PrivacyPolicy() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-4xl font-bold">Privacy Policy</h1>
      <p className="mt-4 text-gray-600 dark:text-gray-400">Last updated: {new Date().toLocaleDateString()}</p>

      <div className="mt-12 space-y-8 prose dark:prose-invert">
        <section>
          <h2 className="text-2xl font-semibold">1. Introduction</h2>
          <p>
            LumiBase ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains
            how we collect, use, and protect your information when you use our Service.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">2. Information We Collect</h2>
          <p>
            As an open-source project, LumiBase is designed to be self-hosted. When you deploy LumiBase on your
            own infrastructure, you have full control over your data. We do not collect or store any data from
            self-hosted instances.
          </p>
          <p>
            For our public website (lumibase.dev), we may collect:
          </p>
          <ul>
            <li>Anonymous analytics data to improve our service</li>
            <li>Basic telemetry for performance monitoring</li>
            <li>Cookie preferences and browser information</li>
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">3. How We Use Your Information</h2>
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
          <h2 className="text-2xl font-semibold">4. Data Storage and Security</h2>
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
          <h2 className="text-2xl font-semibold">5. Third-Party Services</h2>
          <p>
            Our website may use third-party services such as:
          </p>
          <ul>
            <li>Cloudflare for content delivery and DDoS protection</li>
            <li>GitHub for code hosting and issue tracking</li>
            <li>Analytics services (if enabled)</li>
          </ul>
          <p>
            These services have their own privacy policies. We encourage you to review them.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">6. Cookies</h2>
          <p>
            We use cookies to enhance your browsing experience. You can control cookie settings through your
            browser preferences. Disabling cookies may affect some features of our website.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">7. Data Retention</h2>
          <p>
            For self-hosted instances, data retention is entirely under your control. For our public website,
            we retain data only as long as necessary for the purposes outlined in this policy.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">8. Your Rights</h2>
          <p>
            You have the right to:
          </p>
          <ul>
            <li>Access information we hold about you (for our public services)</li>
            <li>Request deletion of your data (for our public services)</li>
            <li>Opt-out of analytics tracking</li>
            <li>Self-host your own instance with complete data control</li>
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">9. Children's Privacy</h2>
          <p>
            Our Service is not intended for children under 13. We do not knowingly collect personal information
            from children under 13.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">10. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy from time to time. We will notify you of any changes by posting the
            new policy on this page.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">11. Contact Us</h2>
          <p>
            If you have questions about this Privacy Policy, please contact us through our
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
