// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldOptionControls } from '../field-option-controls';
import { FieldInspector, type FieldFormState } from '../field-inspector';

/** #751 — field settings UI for allowClear / minLength / maxLength / slug. */

afterEach(() => cleanup());

function Harness({
  type,
  iface,
  initial,
  onChange,
}: {
  type: string;
  iface: string;
  initial: Record<string, unknown>;
  onChange: (o: Record<string, unknown>) => void;
}) {
  const [options, setOptions] = useState(initial);
  return (
    <FieldOptionControls
      type={type}
      iface={iface}
      options={options}
      onChange={(next) => {
        setOptions(next);
        onChange(next);
      }}
    />
  );
}

describe('FieldOptionControls', () => {
  it('toggles allowClear on single-choice fields, preserving other keys', () => {
    const onChange = vi.fn();
    render(<Harness type="string" iface="select-radio" initial={{ choices: [{ value: 'a' }] }} onChange={onChange} />);
    const box = screen.getByLabelText(/allow clearing the selection/i) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ choices: [{ value: 'a' }], allowClear: false });
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ choices: [{ value: 'a' }] });
  });

  it('edits min/max length and reports min > max', () => {
    const onChange = vi.fn();
    render(<Harness type="text" iface="input-multiline" initial={{ rows: 4 }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Max length'), { target: { value: '2000' } });
    expect(onChange).toHaveBeenLastCalledWith({ rows: 4, maxLength: 2000 });
    fireEvent.change(screen.getByLabelText('Min length'), { target: { value: '3000' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/minLength must not exceed maxLength/);
    expect(screen.queryByLabelText(/allow clearing/i)).toBeNull();
  });

  it('configures a slug charset with live preview and rejects unsafe patterns', () => {
    const onChange = vi.fn();
    render(<Harness type="string" iface="slug" initial={{ source: 'title' }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Slug charset'), { target: { value: 'ascii' } });
    expect(onChange).toHaveBeenLastCalledWith({ source: 'title', slug: { charset: 'ascii' } });
    expect(screen.getByTestId('slug-preview')).toHaveTextContent('tieng-viet-da-nang-2026');

    fireEvent.change(screen.getByLabelText('Slug separator'), { target: { value: '_' } });
    expect(screen.getByTestId('slug-preview')).toHaveTextContent('tieng_viet_da_nang_2026');

    fireEvent.change(screen.getByLabelText('Slug charset'), { target: { value: 'custom' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/pattern is required/);
    fireEvent.change(screen.getByLabelText('Slug pattern'), { target: { value: '(a+)+' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/groups and alternation/);
    fireEvent.change(screen.getByLabelText('Slug pattern'), { target: { value: '[a-z_]+' } });
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.change(screen.getByLabelText('Slug charset'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ source: 'title' });
  });

  it('renders nothing for unrelated field types', () => {
    const { container } = render(
      <FieldOptionControls type="integer" iface="input-number" options={{}} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FieldInspector — option validation gate', () => {
  const state: FieldFormState = {
    name: 'excerpt',
    type: 'text',
    interface: 'input-multiline',
    required: false,
    sortOrder: 0,
    options: { rows: 4 },
  };

  it('blocks Save while options are invalid and submits valid options', () => {
    const onSubmit = vi.fn();
    render(<FieldInspector state={state} onCancel={vi.fn()} onSubmit={onSubmit} isSubmitting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^interface$/i }));
    fireEvent.change(screen.getByLabelText('Max length'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Min length'), { target: { value: '10' } });
    const save = screen.getByRole('button', { name: /^save/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Min length'), { target: { value: '2' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ options: { rows: 4, maxLength: 5, minLength: 2 } }),
    );
  });
});
