// Use the `/vitest` entry, not the bare `@testing-library/jest-dom` one.
//
// The bare entry declares its matchers on the global `jest.Matchers` interface.
// Vitest read that interface up to v4, so `toBeInTheDocument` and friends
// type-checked by accident; Vitest 5 stopped reading it (a library supporting
// both runners now has to augment `jest.Matchers` and `vitest.Matchers`
// separately). Under v5 the bare import leaves every matcher untyped —
// `Property 'toBeInTheDocument' does not exist on type 'Assertion<void,
// HTMLElement>'` across `LinkRewriter.test.tsx` and
// `analytics-consent.test.tsx`, which fails `typecheck` and `build` while the
// tests themselves still pass at runtime. `apps/studio` already imports the
// `/vitest` entry, so it was unaffected; this brings the two apps in step.
import '@testing-library/jest-dom/vitest';

// Vitest's jsdom environment does not always expose `window.localStorage` in this
// monorepo, but the analytics-consent wiring tests need a working in-memory store.
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      length: 0,
    },
    writable: true,
  });
}
