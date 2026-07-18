import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pin the React version so `eslint-plugin-react` (pulled in by
  // eslint-config-next) skips its version auto-detection. Under ESLint 10 the
  // detect path calls the removed `context.getFilename()` and crashes
  // ("contextOrFilename.getFilename is not a function"); an explicit version
  // short-circuits that code path.
  { settings: { react: { version: '19.2' } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
