import { describe, expect, it } from 'vitest';
import { formatPriceTiers, priceTiers, unitPrice } from '../commerce';

const variant = {
  prices: [
    { currency: 'usd', amount: 8, minQuantity: 10, maxQuantity: null },
    { currency: 'USD', amount: 10, minQuantity: 1, maxQuantity: 9 },
    { currency: 'EUR', amount: 9, minQuantity: null, maxQuantity: null },
    { currency: 'USD', amount: 6.5, minQuantity: 50, maxQuantity: null },
  ],
};

describe('commerce price tiers (#764)', () => {
  it('sorts tiers, closes open ranges and labels them', () => {
    expect(priceTiers(variant, 'usd')).toEqual([
      { min: 1, max: 9, amount: 10, compareAt: null, label: '1–9' },
      { min: 10, max: 49, amount: 8, compareAt: null, label: '10–49' },
      { min: 50, max: null, amount: 6.5, compareAt: null, label: '50+' },
    ]);
    expect(priceTiers(variant, 'EUR')).toEqual([{ min: 1, max: null, amount: 9, compareAt: null, label: '1+' }]);
    expect(priceTiers(variant, 'GBP')).toEqual([]);
  });

  it('prices a quantity and formats the tiers', () => {
    expect(unitPrice(variant, 'USD', 1)).toBe(10);
    expect(unitPrice(variant, 'USD', 10)).toBe(8);
    expect(unitPrice(variant, 'USD', 500)).toBe(6.5);
    expect(formatPriceTiers(variant, 'USD')).toEqual(['1–9: $10.00', '10–49: $8.00', '50+: $6.50']);
  });

  it('every quantity ≥ 1 maps to at most one tier, and tiers never overlap (seeded random cases)', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let run = 0; run < 500; run += 1) {
      const prices = Array.from({ length: rnd(6) }, () => {
        const min = 1 + rnd(100);
        const max = rnd(3) === 0 ? null : min + rnd(100);
        return { currency: 'USD', amount: 1 + rnd(1000), minQuantity: min, maxQuantity: max };
      });
      const tiers = priceTiers({ prices }, 'USD');
      for (let i = 1; i < tiers.length; i += 1) expect(tiers[i]!.min).toBeGreaterThan(tiers[i - 1]!.max ?? Infinity);
      for (let q = 1; q <= 250; q += 7) {
        expect(tiers.filter((t) => q >= t.min && (t.max === null || q <= t.max)).length).toBeLessThanOrEqual(1);
      }
    }
  });
});
