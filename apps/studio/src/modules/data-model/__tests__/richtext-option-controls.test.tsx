// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RichTextOptionControls } from '../richtext-option-controls';

afterEach(cleanup);

describe('RichTextOptionControls', () => {
  it('stores only restrictions and keeps unknown keys', () => {
    const onChange = vi.fn();
    render(<RichTextOptionControls options={{ keep: 1 }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Tables'));
    expect(onChange).toHaveBeenLastCalledWith({ keep: 1, blocks: ['heading', 'quote', 'list', 'code', 'rule', 'embed', 'footnote', 'custom'] });
    fireEvent.click(screen.getByLabelText('H1'));
    expect(onChange).toHaveBeenLastCalledWith({ keep: 1, headingLevels: [2, 3, 4, 5, 6] });
    fireEvent.click(screen.getByLabelText('Links'));
    expect(onChange).toHaveBeenLastCalledWith({ keep: 1, links: false });
    fireEvent.change(screen.getByLabelText('Allowed custom block names'), { target: { value: 'callout, gallery' } });
    expect(onChange).toHaveBeenLastCalledWith({ keep: 1, customBlocks: ['callout', 'gallery'] });
  });

  it('re-enabling everything removes the key', () => {
    const onChange = vi.fn();
    render(<RichTextOptionControls options={{ headingLevels: [2, 3, 4, 5, 6] }} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('H1'));
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
