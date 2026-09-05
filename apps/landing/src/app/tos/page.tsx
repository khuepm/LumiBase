import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service - LumiBase",
  description: "Terms of Service for LumiBase — the Content Operating System.",
  alternates: {
    canonical: "/tos/",
  },
};

export default function TermsOfService() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="font-display text-4xl">Terms of Service</h1>
      <p className="mt-4 text-gray-400">Last updated: June 7, 2026</p>

      <div className="mt-12 space-y-8 [&_h2]:text-2xl [&_h2]:text-foreground [&_p]:mt-2 [&_p]:leading-7 [&_p]:text-gray-400 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_li]:text-gray-400">
        <section>
          <h2 className="font-display text-2xl">1. Acceptance of Terms</h2>
          <p>
            By accessing or using LumiBase (the "Service"), you agree to be bound by these Terms of Service ("Terms").
            If you disagree with any part of these terms, you may not access the Service.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">2. Description of Service</h2>
          <p>
            LumiBase is an open-source, edge-native, AI-native Content Operating System designed to help teams
            build fast, modern content experiences. The Service is provided as-is without warranties of any kind.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">3. Open Source License</h2>
          <p>
            LumiBase is released under the Apache License, Version 2.0. You are free to use, modify, and distribute the software
            in accordance with the license terms. See our <a href="/license" className="text-signal-400 hover:underline">License page</a> for details.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">4. User Responsibilities</h2>
          <p>
            Users are responsible for:
          </p>
          <ul>
            <li>Maintaining the security of their accounts and credentials</li>
            <li>All activities that occur under their account</li>
            <li>Complying with all applicable laws and regulations</li>
            <li>Not using the Service for any illegal or unauthorized purpose</li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-2xl">5. Privacy and Data Protection</h2>
          <p>
            Your privacy is important to us. Please review our <a href="/privacy" className="text-signal-400 hover:underline">Privacy Policy</a>
            to understand how we collect, use, and protect your information.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">6. Disclaimer of Warranties</h2>
          <p>
            The Service is provided "as is" without warranty of any kind, express or implied, including but not
            limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">7. Limitation of Liability</h2>
          <p>
            In no event shall LumiBase or its contributors be liable for any indirect, incidental, special,
            consequential, or punitive damages arising out of or in connection with your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">8. Changes to Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. Continued use of the Service after changes
            constitutes acceptance of the new Terms.
          </p>
        </section>

        <section>
          <h2 className="font-display text-2xl">9. Contact Us</h2>
          <p>
            If you have questions about these Terms, please contact us through our
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className="text-signal-400 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
