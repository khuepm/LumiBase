import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "License - LumiBase",
  description: "License information for LumiBase - Edge-Native Headless CMS",
  alternates: {
    canonical: "/license/",
  },
};

export default function License() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-4xl font-bold">MIT License</h1>
      <p className="mt-4 text-gray-600 dark:text-gray-400">
        LumiBase is open-source software released under the MIT License.
      </p>

      <div className="mt-12 rounded-lg border border-gray-200 bg-gray-50 p-8 dark:border-gray-800 dark:bg-gray-900">
        <pre className="whitespace-pre-wrap font-mono text-sm">
          {`Copyright (c) 2025 LumiBase Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`}
        </pre>
      </div>

      <div className="mt-12 space-y-8 prose dark:prose-invert">
        <section>
          <h2 className="text-2xl font-semibold">What This Means</h2>
          <p>
            The MIT License is a permissive license that allows you to:
          </p>
          <ul>
            <li>Use LumiBase for personal and commercial projects</li>
            <li>Modify the source code to fit your needs</li>
            <li>Distribute the original or modified code</li>
            <li>Sublicense the code under different terms</li>
            <li>Use the code in proprietary software</li>
          </ul>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Requirements</h2>
          <p>
            The only requirement is to include the original copyright notice and license text in any
            substantial portions of the Software that you distribute.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">No Warranty</h2>
          <p>
            The software is provided "as is" without warranty of any kind. The authors and copyright holders
            are not liable for any damages arising from the use of this software.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Third-Party Licenses</h2>
          <p>
            LumiBase uses various open-source libraries with their own licenses. Please check the
            <code className="bg-gray-100 px-2 py-1 dark:bg-gray-800">package.json</code> file and each
            library's license information for details.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Contributing</h2>
          <p>
            By contributing to LumiBase, you agree that your contributions will be licensed under the MIT License.
            See our contributing guidelines for more information.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold">Questions?</h2>
          <p>
            If you have questions about licensing or need clarification, please open an issue on our
            <a href="https://github.com/khuepm/lumibase" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GitHub repository</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
