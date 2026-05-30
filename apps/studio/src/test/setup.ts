// Vitest global setup for the Studio app.
//
// Registers `@testing-library/jest-dom` matchers (e.g. `toBeDisabled`,
// `toBeChecked`, `toHaveTextContent`) for component tests rendered with
// React Testing Library. Pure-helper `.ts` suites that never touch the
// DOM are unaffected — importing the matchers is a no-op for them.
import '@testing-library/jest-dom/vitest';
