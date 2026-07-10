// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * Image transform UI tests (image-transform-dsl Req 5.4, 6.2, 5.3).
 * **Validates: Requirements 5.4, 6.2**
 */

import { FocalPicker } from '../focal-picker';
import { transformUrl } from '../transform-panel';

afterEach(cleanup);

describe('transformUrl', () => {
  it('builds a media URL with sorted, present params', () => {
    expect(transformUrl('a/b.jpg', { width: 100, format: 'webp' })).toBe(
      '/api/v1/media/a/b.jpg?width=100&format=webp',
    );
  });
  it('returns the bare path for an empty DSL (original)', () => {
    expect(transformUrl('a/b.jpg', {})).toBe('/api/v1/media/a/b.jpg');
  });
  it('encodes the focal point as x,y', () => {
    expect(transformUrl('img.jpg', { focal: { x: 0.25, y: 0.75 } })).toContain('focal=0.25%2C0.75');
  });
});

describe('FocalPicker', () => {
  it('sets a normalized {x,y} on click and renders the marker', () => {
    const onChange = vi.fn();
    render(<FocalPicker src="img.jpg" onChange={onChange} />);
    const region = screen.getByRole('button', { name: /set focal point/i });
    // jsdom gives 0-size rects; stub getBoundingClientRect for a deterministic click.
    region.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(region, { clientX: 100, clientY: 50 });
    expect(onChange).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });
  });

  it('renders a marker for the current focal point', () => {
    render(<FocalPicker src="img.jpg" focal={{ x: 0.3, y: 0.4 }} onChange={vi.fn()} />);
    expect(screen.getByTestId('focal-marker')).toBeTruthy();
  });
});
