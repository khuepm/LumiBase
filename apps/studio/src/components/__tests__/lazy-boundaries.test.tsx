// @vitest-environment jsdom
/**
 * #757 lazy boundaries and progressive widgets: each boundary shows its
 * fallback while the chunk loads, then the real component; a failing widget
 * is contained.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense, type ComponentType } from 'react';

let releaseMonaco: (() => void) | null = null;
vi.mock('@monaco-editor/react', async () => {
  await new Promise<void>((resolve) => {
    releaseMonaco = resolve;
  });
  return {
    default: ({ value, height }: { value?: string; height?: string }) => (
      <textarea aria-label="monaco" data-height={height} defaultValue={value} />
    ),
  };
});

import { LazyMonacoEditor } from '@/components/lazy-monaco-editor';
import { DashboardWidget } from '@/components/dashboard-widget';

afterEach(cleanup);

describe('LazyMonacoEditor', () => {
  it('renders a sized placeholder until the editor chunk resolves, then the editor', async () => {
    render(<LazyMonacoEditor height="240px" value='{"a":1}' />);
    const fallback = screen.getByTestId('monaco-editor-fallback');
    expect(fallback).toHaveAccessibleName('Loading editor');
    expect(fallback).toHaveStyle({ height: '240px' });
    expect(screen.queryByLabelText('monaco')).toBeNull();

    await vi.waitFor(() => expect(releaseMonaco).not.toBeNull());
    await act(async () => {
      releaseMonaco?.();
    });
    expect(await screen.findByLabelText('monaco')).toHaveValue('{"a":1}');
    expect(screen.queryByTestId('monaco-editor-fallback')).toBeNull();
  });
});

describe('DashboardWidget', () => {
  it('shows its own skeleton while its content suspends, without blocking sibling widgets', async () => {
    let resolveSlow: (m: { default: ComponentType }) => void = () => {};
    const Slow = lazy(
      () =>
        new Promise<{ default: ComponentType }>((r) => {
          resolveSlow = r;
        }),
    );
    render(
      <>
        <DashboardWidget title="Slow widget">
          <Slow />
        </DashboardWidget>
        <DashboardWidget title="Fast widget">
          <p>fast content</p>
        </DashboardWidget>
      </>,
    );
    expect(screen.getByText('fast content')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading Slow widget' })).toBeInTheDocument();
    await act(async () => {
      resolveSlow({ default: () => <p>slow content</p> });
    });
    expect(await screen.findByText('slow content')).toBeInTheDocument();
  });

  it('contains a widget that throws and lets it retry', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let broken = true;
    function Flaky() {
      if (broken) throw new Error('boom');
      return <p>recovered</p>;
    }
    render(
      <Suspense fallback={null}>
        <DashboardWidget title="Flaky widget">
          <Flaky />
        </DashboardWidget>
        <DashboardWidget title="Healthy widget">
          <p>healthy content</p>
        </DashboardWidget>
      </Suspense>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Flaky widget is unavailable.');
    expect(screen.getByText('healthy content')).toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
