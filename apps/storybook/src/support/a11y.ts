/**
 * The ONLY sanctioned way to relax the a11y gate for a story.
 *
 * `.storybook/preview.tsx` sets `parameters.a11y.test = 'error'`, so any axe
 * violation fails the story test run. When a violation is genuinely not the
 * component's to fix (e.g. it only exists because the story renders a
 * fragment outside its real page landmark), disable that one rule for that
 * one story and say why:
 *
 *   parameters: a11yException([
 *     { rule: 'region', justification: 'Rendered without the app shell landmarks…' },
 *   ]),
 *
 * The `guards` vitest project fails when a story turns a rule off any other
 * way (`enabled: false`, `test: 'off' | 'todo'`, `disable: true`) or when a
 * justification is shorter than {@link MIN_JUSTIFICATION} characters.
 */
export const MIN_JUSTIFICATION = 40;

export interface A11yRuleException {
  /** axe-core rule id, e.g. `color-contrast`. */
  rule: string;
  /** Why the violation is accepted for this story — reviewed like code. */
  justification: string;
}

export interface A11yExceptionParameters {
  a11y: {
    config: { rules: Array<{ id: string; enabled: boolean }> };
    exceptions: A11yRuleException[];
  };
}

export function a11yException(exceptions: A11yRuleException[]): A11yExceptionParameters {
  for (const exception of exceptions) {
    if (exception.justification.trim().length < MIN_JUSTIFICATION) {
      throw new Error(
        `a11yException(${exception.rule}): justification must be at least ${MIN_JUSTIFICATION} characters`,
      );
    }
  }
  return {
    a11y: {
      config: { rules: exceptions.map(({ rule }) => ({ id: rule, enabled: false })) },
      exceptions,
    },
  };
}
