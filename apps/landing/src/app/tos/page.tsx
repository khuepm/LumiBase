import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service - LumiBase",
  description: "Terms of Service for LumiBase - Edge-Native Headless CMS",
  alternates: {
    canonical: "/tos/",
  },
};

export default function TermsOfService() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-4xl font-bold">Terms of Service</h1>
      <p className="mt-4 text-gray-600 dark:text-gray-400">Last updated: {new Date().toLocaleDateString()}</p>

      <div className="mt-12 space-y-8 prose dark:prose-invert">
        <section>
          <h2 className="text-2xl font-semibold">1. Acceptance of Terms</h2>
          <p>
            By accessing or using LumiBase (the "Service"), you agree to be bound by these Terms of Service ("Terms").
            If you disagree with any part of these terms, you may not access the Service.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">2. Description of Service</h2>
          <p>
            LumiBase is an open-source, edge-native headless Content Management System designed to help developers
            build fast, modern content experiences. The Service is provided as-is without warranties of any kind.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">3. Open Source License</h2>
          <p>
            LumiBase is released under the MIT License. You are free to use, modify, and distribute the software
            in accordance with the license terms. See our <a href="/license" className="text-blue-600 hover:underline">License page</a> for details.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">4. User Responsibilities</h2>
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
          <h2 className="text-2xl font-semibold">5. Privacy and Data Protection</h2>
          <p>
            Your privacy is important to us. Please review our <a href="/privacy" className="text-blue-600 hover:underline">Privacy Policy</a>
            to understand how we collect, use, and protect your information.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">6. Disclaimer of Warranties</h2>
          <p>
            The Service is provided "as is" without warranty of any kind, express or implied, including but not
            limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">7. Limitation of Liability</h2>
          <p>
            In no event shall LumiBase or its contributors be liable for any indirect, incidental, special,
            consequential, or punitive damages arising out of or in connection with your use of the Service.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">8. Changes to Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. Continued use of the Service after changes
            constitutes acceptance of the new Terms.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">9. Contact Us</h2>
          <p>
            If you have questions about these Terms, please contact us through our
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
