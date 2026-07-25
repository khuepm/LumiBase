import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "License - LumiBase",
  description: "License information for LumiBase — the Content Operating System.",
  alternates: {
    canonical: "/license/",
  },
};

export default function License() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-4xl font-bold">Apache License 2.0</h1>
      <p className="mt-4 text-gray-400">
        LumiBase is open-source software released under the Apache License,
        Version 2.0. The relicense from MIT took effect in <code className="rounded bg-ink-800 px-2 py-1 text-signal-400">v0.23.0</code>;{" "}
        <code className="rounded bg-ink-800 px-2 py-1 text-signal-400">v0.22.0</code> was the final MIT-licensed release.
      </p>

      <div className="mt-12 rounded-xl border border-ink-700 bg-ink-900 p-8">
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-300">
          {`Copyright (c) 2026 LumiBase Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`}
        </pre>
      </div>

      <div className="mt-12 space-y-8 [&_p]:mt-2 [&_p]:leading-7 [&_p]:text-gray-400 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1 [&_li]:text-gray-400">
        <section>
          <h2 className="text-2xl font-semibold">What This Means</h2>
          <p>
            The Apache License 2.0 is a permissive license that allows you to:
          </p>
          <ul>
            <li>Use LumiBase for personal and commercial projects</li>
            <li>Modify the source code to fit your needs</li>
            <li>Distribute the original or modified code</li>
            <li>Sublicense the code under different terms</li>
            <li>Use the code in proprietary software</li>
          </ul>
          <p>
            It also grants an express patent license from contributors, and lets
            you place your own copyright statement on your modifications.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Requirements</h2>
          <p>
            When you distribute the Software (original or modified), you must
            include a copy of the license, retain existing copyright, patent,
            trademark, and attribution notices, and state any significant changes
            you made to the files.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">No Warranty</h2>
          <p>
            The software is provided "as is" without warranties or conditions of
            any kind. The authors and copyright holders are not liable for any
            damages arising from the use of this software.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Third-Party Licenses</h2>
          <p>
            LumiBase uses various open-source libraries with their own licenses. Please check the
            <code className="rounded bg-ink-800 px-2 py-1 text-signal-400">package.json</code> file and each
            library's license information for details.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Contributing</h2>
          <p>
            By contributing to LumiBase, you agree that your contributions will be licensed under the Apache License 2.0.
            See our contributing guidelines for more information.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Questions?</h2>
          <p>
            If you have questions about licensing or need clarification, please open an issue on our
            <a href="https://github.com/khuepm/LumiBase" target="_blank" rel="noopener noreferrer" className="text-signal-400 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
