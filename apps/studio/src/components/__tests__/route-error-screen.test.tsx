// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const invalidate = vi.fn(async () => undefined);
const navigate = vi.fn(async () => undefined);
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate, navigate }) }));

import { RouteErrorScreen } from '../route-error-screen';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RouteErrorScreen (#694)', () => {
  it('shows the error with Try again and a way out instead of a blank page', () => {
    const reset = vi.fn();
    render(<RouteErrorScreen error={new Error('boom')} reset={reset} info={undefined as never} />);
    expect(screen.getByText('This page ran into a problem')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(reset).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Go to Content'));
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
  });

  it('words a dropped connection as such', () => {
    render(<RouteErrorScreen error={new TypeError('Failed to fetch')} reset={vi.fn()} info={undefined as never} />);
    expect(screen.getByText('The server could not be reached')).toBeTruthy();
  });
});
