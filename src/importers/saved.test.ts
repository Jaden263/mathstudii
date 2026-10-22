import { describe, it, expect } from 'vitest';
import { agrees } from './saved';
import { math } from '../engine/math';

describe('agrees: a recalculated value against the saved one', () => {
  it('NaN agrees with NaN, an infinity with itself, and nothing else with either', () => {
    expect(agrees(NaN, NaN)).toBe(true);
    expect(agrees(math.matrix([[0.1], [NaN], [0.999]]), math.matrix([[0.1], [NaN], [0.999]]))).toBe(true);
    expect(agrees(math.matrix([[0.1], [NaN]]), math.matrix([[0.2], [NaN]]))).toBe(false);
    expect(agrees(NaN, 0)).toBe(false);
    expect(agrees(Infinity, Infinity)).toBe(true);
    expect(agrees(Infinity, -Infinity)).toBe(false);
  });
  it('compares complex quantities by their SI value', () => {
    expect(agrees(math.evaluate('(5 + 2i) mm'), math.evaluate('(0.005 + 0.002i) m'))).toBe(true);
    expect(agrees(math.evaluate('(5 + 2i) mm'), math.evaluate('(5 + 2i) m'))).toBe(false);
    expect(agrees(math.complex(3, 0), 3)).toBe(true);
  });
});

describe('compareSaved: a value saved in its display unit', () => {
  it('a ratio shown in % is saved in percent', async () => {
    const { compareSaved } = await import('./saved');
    const { createRegion } = await import('../model/types');
    const r = createRegion('math', 0, 0, { source: 'δ := 0.0243 = %' });
    expect(compareSaved([{ regionId: r.id, expr: '2.43' }], [r], new Map([[r.id, 0.0243]]))).toMatchObject({ checked: 1, agree: 1 });
    expect(compareSaved([{ regionId: r.id, expr: '0.0243' }], [r], new Map([[r.id, 0.0243]]))).toMatchObject({ checked: 1, agree: 1 });
    expect(compareSaved([{ regionId: r.id, expr: '2.5' }], [r], new Map([[r.id, 0.0243]]))).toMatchObject({ checked: 1, agree: 0 });
  });
});
