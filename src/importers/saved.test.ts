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
