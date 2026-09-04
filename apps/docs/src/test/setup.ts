import '@testing-library/jest-dom';

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
