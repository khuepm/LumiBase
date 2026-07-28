import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

// eslint-config-next 16 ships ONLY a flat config (its `core-web-vitals` export
// is a config array). The previous setup ran eslintrc mode
// (`ESLINT_USE_FLAT_CONFIG=false` + `.eslintrc.json` extending
// "next/core-web-vitals"), which fed that array to the eslintrc validator; it
// failed the shareable-config schema and then crashed while formatting the
// error ("Converting circular structure to JSON" on the react plugin object),
// hiding the real cause. Flat config is the supported path — mirrors
// apps/consumer/eslint.config.mjs.
const eslintConfig = defineConfig([
  ...nextVitals,
  // Pin the React version so `eslint-plugin-react` (pulled in by
  // eslint-config-next) skips its version auto-detection. Under ESLint 10 the
  // detect path calls the removed `context.getFilename()` and crashes; an
  // explicit version short-circuits that code path. This app is on React 18.
  { settings: { react: { version: "18.3" } } },
  // Carried over from the previous .eslintrc.json so lint behaviour is unchanged.
  { rules: { "react/no-unescaped-entities": "off" } },
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
