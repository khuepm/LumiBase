// Vitest global setup for the Studio app.
//
// Registers `@testing-library/jest-dom` matchers (e.g. `toBeDisabled`,
// `toBeChecked`, `toHaveTextContent`) for component tests rendered with
// React Testing Library. Pure-helper `.ts` suites that never touch the
// DOM are unaffected — importing the matchers is a no-op for them.
import '@testing-library/jest-dom/vitest';

// Node >= 25 ships built-in Web Storage globals. Vitest's jsdom environment
// only copies window keys that do NOT already exist on globalThis, so jsdom's
// working Storage is shadowed by Node's `localStorage` getter — which returns
// `undefined` unless the process was started with `--localstorage-file` — and
// bare `localStorage.getItem(...)` throws in component tests. jsdom's own
// Storage is unreachable (vitest aliases `window` to the populated global),
// so install a minimal in-memory Storage wherever the global one is broken.
// No-op in the node env (no `window`) and on Node <= 24 (jsdom's copy works).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.store.set(String(key), String(value));
  }
}

if (typeof window !== 'undefined') {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (typeof globalThis[key]?.getItem !== 'function') {
      Object.defineProperty(globalThis, key, {
        value: new MemoryStorage(),
        configurable: true,
        writable: true,
      });
    }
  }
}
