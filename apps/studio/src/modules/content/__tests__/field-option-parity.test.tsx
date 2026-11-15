// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldResource } from '@lumibase/sdk';
import { SelectRadioInterface } from '../interfaces/select-radio';
import { SelectDropdownInterface } from '../interfaces/select';
import { TextInterface, TextMultilineInterface } from '../interfaces/text';
import { SlugInterface } from '../interfaces/slug';

/** #751 — Studio inputs honour allowClear / minLength / maxLength / slug policy. */

function makeField(iface: string, options: Record<string, unknown>, extra: Partial<FieldResource> = {}): FieldResource {
  return {
    id: 'f1',
    collectionId: 'c1',
    name: 'f',
    type: 'string',
    interface: iface,
    options,
    required: false,
    hidden: false,
    ...extra,
  } as FieldResource;
}

const choices = [{ value: 'a', text: 'A' }, { value: 'b', text: 'B' }];

afterEach(() => cleanup());

describe('select-radio allowClear', () => {
  it('offers "Clear selection" by default when a value is set', () => {
    const onChange = vi.fn();
    render(<SelectRadioInterface value="a" field={makeField('select-radio', { choices })} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /clear selection/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('hides the clear affordance when allowClear is false', () => {
    render(<SelectRadioInterface value="a" field={makeField('select-radio', { choices, allowClear: false })} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /clear selection/i })).toBeNull();
  });

  it('hides it for required fields and when nothing is selected', () => {
    const { rerender } = render(
      <SelectRadioInterface value="a" field={makeField('select-radio', { choices }, { required: true })} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /clear selection/i })).toBeNull();
    rerender(<SelectRadioInterface value={null} field={makeField('select-radio', { choices })} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /clear selection/i })).toBeNull();
  });
});

describe('select-dropdown allowClear', () => {
  it('keeps the empty option by default', () => {
    render(<SelectDropdownInterface value="a" field={makeField('select-dropdown', { choices })} onChange={vi.fn()} />);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['— select —', 'A', 'B']);
  });

  it('drops the empty option once a value is set and allowClear is false', () => {
    const { rerender } = render(
      <SelectDropdownInterface value="a" field={makeField('select-dropdown', { choices, allowClear: false })} onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['A', 'B']);
    // Still empty → the placeholder stays so the select can show "nothing chosen".
    rerender(<SelectDropdownInterface value={null} field={makeField('select-dropdown', { choices, allowClear: false })} onChange={vi.fn()} />);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});

describe('text length counter', () => {
  it('counts code points, not UTF-16 units', () => {
    render(<TextInterface value="😀😀😀" field={makeField('input', { maxLength: 3 })} onChange={vi.fn()} />);
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    // No native maxLength (it counts UTF-16 units and would block valid input).
    expect(screen.getByRole('textbox')).not.toHaveAttribute('maxLength');
  });

  it('flags over-length and under-length values', () => {
    const { rerender } = render(
      <TextMultilineInterface value="Tiếng Việt" field={makeField('input-multiline', { maxLength: 5 })} onChange={vi.fn()} />,
    );
    expect(screen.getByText('10 / 5')).toHaveClass('text-destructive');
    rerender(<TextMultilineInterface value="ab" field={makeField('input-multiline', { minLength: 3 })} onChange={vi.fn()} />);
    expect(screen.getByText(/Minimum 3/)).toHaveClass('text-destructive');
  });

  it('renders no counter without length options', () => {
    render(<TextInterface value="hello" field={makeField('input', {})} onChange={vi.fn()} />);
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
  });
});

describe('slug interface charset policy', () => {
  it('transliterates Vietnamese on blur by default (ascii)', () => {
    const onChange = vi.fn();
    render(<SlugInterface value="Tiếng Việt" field={makeField('slug', {})} onChange={onChange} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenCalledWith('tieng-viet');
  });

  it('keeps Unicode letters under charset unicode', () => {
    const onChange = vi.fn();
    render(<SlugInterface value="Tiếng Việt" field={makeField('slug', { slug: { charset: 'unicode' } })} onChange={onChange} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenCalledWith('tiếng-việt');
  });

  it('honours separator and shows a policy violation hint', () => {
    const onChange = vi.fn();
    render(<SlugInterface value="Đà Nẵng" field={makeField('slug', { slug: { charset: 'ascii', separator: '_' } })} onChange={onChange} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/ASCII slug/);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenCalledWith('da_nang');
  });

  it('validates a custom pattern', () => {
    render(
      <SlugInterface
        value="xin-chao"
        field={makeField('slug', { slug: { charset: 'custom', pattern: '^[a-z]{2}/[a-z-]+$' } })}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/slug pattern/);
  });
});
