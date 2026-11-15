import { describe, expect, it } from 'vitest';
import { reorderTargetFor } from '../manual-order';

describe('reorderTargetFor (#690)', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('drops after the target when dragging down, before when dragging up', () => {
    expect(reorderTargetFor(order, 'a', 'c')).toEqual({ after: 'c' });
    expect(reorderTargetFor(order, 'd', 'b')).toEqual({ before: 'b' });
  });
  it('ignores a drop on itself or unknown rows', () => {
    expect(reorderTargetFor(order, 'a', 'a')).toBeNull();
    expect(reorderTargetFor(order, 'x', 'a')).toBeNull();
  });
});
