import { describe, expect, it } from 'vitest';
import { chainLoops } from './outline';

const P = (x: number, y: number) => ({ x, y });

describe('section outline chains', () => {
  it('joins pieces in any order and direction into one closed loop', () => {
    // the four sides of a 10 × 10 square, shuffled, two of them reversed
    const loops = chainLoops([
      [P(10, 10), P(0, 10)],
      [P(0, 0), P(10, 0)],
      [P(0, 0), P(0, 10)],
      [P(10, 10), P(10, 0)],
    ], 1e-9);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    expect(l).toHaveLength(4);
    // shoelace: a closed 10 × 10 loop encloses 100 either way round
    let a = 0;
    for (let i = 0; i < l.length; i++) a += l[i].x * l[(i + 1) % l.length].y - l[(i + 1) % l.length].x * l[i].y;
    expect(Math.abs(a / 2)).toBeCloseTo(100, 12);
  });

  it('keeps separate loops apart and bridges gaps within the tolerance only', () => {
    const loops = chainLoops([
      [P(0, 0), P(4, 0), P(4, 4)],
      [P(4, 4 + 1e-7), P(0, 4), P(0, 0)],
      [P(20, 0), P(24, 0), P(22, 3), P(20, 0)],
    ], 1e-6);
    expect(loops.map((l) => l.length).sort()).toEqual([3, 4]);
    // a gap wider than the tolerance stays open
    const open = chainLoops([[P(0, 0), P(4, 0)], [P(4.1, 0), P(8, 0)]], 1e-3);
    expect(open).toHaveLength(2);
  });
});
