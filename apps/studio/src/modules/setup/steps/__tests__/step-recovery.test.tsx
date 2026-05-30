// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  StepRecovery,
  buildBackupCodesFileContent,
  joinBackupCodesForClipboard,
  BACKUP_CODES_FILE_HEADER,
} from '../step-recovery';
import { useSetupStore } from '../../setup-store';

/**
 * Tests for the "Recovery Setup" step of the Setup Wizard.
 *
 * `StepRecovery` is a presentational + controlled component: it
 * receives the plaintext backup codes via a prop (sourced from the
 * in-memory `/setup/complete` response — never persisted), renders
 * them in monospace with copy/download affordances, and gates a
 * "Finish setup" action behind the store-backed `confirmed`
 * acknowledgement checkbox.
 *
 * The Zustand store is reset before and after every test so the
 * `confirmed` flag never leaks across cases.
 *
 * **Validates: Requirements 14.1, 14.3**
 */

// Eight representative `XXXX-XXXX` codes (alphabet excludes I/O/0/1/L
// per Req 14.1; exact alphabet is the server's concern — we only need
// well-formed strings here).
const CODES: readonly string[] = [
  'A2BC-D3EF',
  'G4HJ-K5MN',
  'P6QR-S7TV',
  'W8XY-Z2A3',
  'B4CD-E5FG',
  'H6JK-M7NP',
  'Q8RS-T2VW',
  'X3YZ-A4BC',
];

beforeEach(() => {
  useSetupStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useSetupStore.getState().reset();
  vi.restoreAllMocks();
});

describe('StepRecovery — rendering', () => {
  it('renders all 8 backup codes in monospace <code> blocks', () => {
    render(<StepRecovery backupCodes={CODES} />);
    for (const code of CODES) {
      const el = screen.getByText(code);
      expect(el).toBeInTheDocument();
      // The codes render inside `<code class="... font-mono ...">`.
      expect(el.tagName.toLowerCase()).toBe('code');
      expect(el.className).toContain('font-mono');
    }
  });

  it('renders the confirmation checkbox with the exact Req 14.3 label', () => {
    render(<StepRecovery backupCodes={CODES} />);
    const checkbox = screen.getByLabelText('I have saved these backup codes');
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveProperty('type', 'checkbox');
  });

  it('exposes Copy and Download controls with descriptive aria-labels', () => {
    render(<StepRecovery backupCodes={CODES} />);
    expect(
      screen.getByRole('button', { name: 'Copy backup codes' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Download backup codes as a text file',
      }),
    ).toBeInTheDocument();
  });
});

describe('StepRecovery — confirmation gate (Req 14.3)', () => {
  it('disables "Finish setup" until the checkbox is ticked', () => {
    render(<StepRecovery backupCodes={CODES} />);
    const finish = screen.getByRole('button', { name: 'Finish setup' });
    expect(finish).toBeDisabled();
  });

  it('enables "Finish setup" after the checkbox is ticked', () => {
    render(<StepRecovery backupCodes={CODES} />);
    const checkbox = screen.getByLabelText('I have saved these backup codes');
    fireEvent.click(checkbox);
    const finish = screen.getByRole('button', { name: 'Finish setup' });
    expect(finish).toBeEnabled();
  });

  it('ticking the checkbox sets the store `confirmed` flag', () => {
    render(<StepRecovery backupCodes={CODES} />);
    expect(useSetupStore.getState().confirmed).toBe(false);
    fireEvent.click(
      screen.getByLabelText('I have saved these backup codes'),
    );
    expect(useSetupStore.getState().confirmed).toBe(true);
  });

  it('unticking the checkbox clears the store `confirmed` flag', () => {
    render(<StepRecovery backupCodes={CODES} />);
    const checkbox = screen.getByLabelText('I have saved these backup codes');
    fireEvent.click(checkbox); // tick
    expect(useSetupStore.getState().confirmed).toBe(true);
    fireEvent.click(checkbox); // untick
    expect(useSetupStore.getState().confirmed).toBe(false);
  });

  it('reflects an already-confirmed store flag on mount', () => {
    useSetupStore.getState().setConfirmed(true);
    render(<StepRecovery backupCodes={CODES} />);
    expect(
      screen.getByLabelText('I have saved these backup codes'),
    ).toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Finish setup' }),
    ).toBeEnabled();
  });
});

describe('StepRecovery — onFinish', () => {
  it('calls onFinish when "Finish setup" is clicked while enabled', () => {
    const onFinish = vi.fn();
    render(<StepRecovery backupCodes={CODES} onFinish={onFinish} />);
    fireEvent.click(
      screen.getByLabelText('I have saved these backup codes'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('does not call onFinish while the gate is closed', () => {
    const onFinish = vi.fn();
    render(<StepRecovery backupCodes={CODES} onFinish={onFinish} />);
    // The button is disabled; a click should not fire the handler.
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(onFinish).not.toHaveBeenCalled();
  });
});

describe('StepRecovery — copy', () => {
  it('writes the newline-joined codes to the clipboard on Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // jsdom doesn't implement the clipboard API; define it for the test.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<StepRecovery backupCodes={CODES} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy backup codes' }),
    );

    // The async clipboard write flips the button to its "Copied" state;
    // awaiting that transition also settles the write microtask and
    // keeps the state update inside React's act() scope.
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(CODES.join('\n'));
  });
});

describe('StepRecovery — empty fallback', () => {
  it('renders the fallback panel when no codes are provided', () => {
    render(<StepRecovery backupCodes={[]} />);
    expect(
      screen.getByText('No backup codes to display'),
    ).toBeInTheDocument();
    // The gated finish flow is absent in the fallback.
    expect(
      screen.queryByRole('button', { name: 'Finish setup' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText('I have saved these backup codes'),
    ).not.toBeInTheDocument();
    // A clear way back into the wizard is offered.
    expect(
      screen.getByRole('link', { name: 'Return to setup' }),
    ).toHaveAttribute('href', '/setup');
  });
});

describe('buildBackupCodesFileContent (pure helper)', () => {
  it('prefixes a header line then one code per line, trailing newline', () => {
    const content = buildBackupCodesFileContent(CODES);
    expect(content).toBe(
      `${BACKUP_CODES_FILE_HEADER}\n${CODES.join('\n')}\n`,
    );
  });

  it('still emits the header for an empty code list', () => {
    expect(buildBackupCodesFileContent([])).toBe(
      `${BACKUP_CODES_FILE_HEADER}\n`,
    );
  });

  it('round-trips: split drops header and yields exactly the codes', () => {
    const lines = buildBackupCodesFileContent(CODES)
      .trimEnd()
      .split('\n');
    expect(lines[0]).toBe(BACKUP_CODES_FILE_HEADER);
    expect(lines.slice(1)).toEqual([...CODES]);
  });
});

describe('joinBackupCodesForClipboard (pure helper)', () => {
  it('joins codes with newlines and omits the file header', () => {
    const joined = joinBackupCodesForClipboard(CODES);
    expect(joined).toBe(CODES.join('\n'));
    expect(joined).not.toContain(BACKUP_CODES_FILE_HEADER);
  });
});
