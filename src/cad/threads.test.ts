// ISO metric threads against the tables of ISO 724 (basic dimensions) and ISO 898-1 (stress areas).
import { describe, expect, it } from 'vitest';
import { grooveArea, grooveWidth, parseThread, threadFor, threadIn, threadSizes } from './threads';

const close = (v: number, want: number, tol: number) => expect(Math.abs(v - want)).toBeLessThan(tol);

describe('ISO metric threads', () => {
  it('M10: coarse pitch 1.5, d2, d1, d3 and A_s as tabulated', () => {
    const s = parseThread('M10');
    expect(s.P).toBe(1.5);
    expect(s.name).toBe('M10');
    // ISO 724: d2 = 9.026, d1 = 8.376 (d − 1.082532 P); d3 = d − 1.226869 P = 8.160
    close(s.d2, 9.026, 5e-4);
    close(s.d1, 8.376, 5e-4);
    close(s.d3, 8.160, 5e-4);
    close(s.H, 0.866025 * 1.5, 1e-6);
    // ISO 898-1: A_s = 58.0 mm²
    close(s.As, 58.0, 0.05);
    // tap drill d − P
    expect(s.drill).toBe(8.5);
  });

  it('M12x1.25 (fine): d2, d1 and A_s as tabulated', () => {
    const s = parseThread('M12x1.25');
    expect(s.P).toBe(1.25);
    expect(s.fine).toBe(true);
    // ISO 724: d2 = 11.188, d1 = 10.647; ISO 898-1: A_s = 92.1 mm²
    close(s.d2, 11.188, 5e-4);
    close(s.d1, 10.647, 5e-4);
    close(s.As, 92.1, 0.05);
    expect(s.drill).toBe(10.75);
  });

  it('the coarse M12, M16, M20 and M24 stress areas of ISO 898-1', () => {
    // 84.3, 157, 245, 353 mm²
    for (const [name, As] of [['M12', 84.3], ['M16', 157], ['M20', 245], ['M24', 353]] as const) close(parseThread(name).As, As, As * 0.003);
  });

  it('reads designations however they are written and refuses sizes outside ISO 262', () => {
    expect(parseThread(' m12 × 1,5 ').P).toBe(1.5);
    expect(parseThread('M12*1.75').fine).toBe(false);
    expect(() => parseThread('M13')).toThrow(/not an ISO 262 size/);
    expect(() => parseThread('M12x1.1')).toThrow(/coarse pitch 1.75 mm and the fine 1.5, 1.25 mm/);
    expect(() => parseThread('12 mm')).toThrow(/M12x1.25/);
  });

  it('the table runs from M1.6 to M64 with coarse and fine series', () => {
    const all = threadSizes();
    expect(all[0].name).toBe('M1.6');
    expect(all[all.length - 1].name).toBe('M64x4');
    expect(all.filter((s) => !s.fine).length).toBe(29);
    expect(parseThread('M64').P).toBe(6);
  });

  it('finds the size for a shaft (its major diameter) or a hole (its tap drill)', () => {
    expect(threadFor(12, false)?.name).toBe('M12');
    expect(threadFor(11.9, false)?.name).toBe('M12');
    expect(threadFor(8.5, true)?.name).toBe('M10');
    expect(threadFor(10.2, true)?.name).toBe('M12');
    expect(threadFor(13, false)).toBeNull();
  });

  it('the basic profile: groove widths at the diameters and the area per unit length', () => {
    const s = parseThread('M10');
    // bolt: P/4 at d1, 7P/8 at d; nut: P/8 at D, 3P/4 at D1
    close(grooveWidth(s, s.d1 / 2, false), s.P / 4, 1e-12);
    close(grooveWidth(s, s.d / 2, false), (7 * s.P) / 8, 1e-12);
    close(grooveWidth(s, s.d / 2, true), s.P / 8, 1e-12);
    close(grooveWidth(s, s.d1 / 2, true), (3 * s.P) / 4, 1e-12);
    // (2π/P) ∫ r w(r) dr, against the midpoint rule on many slices
    const A = grooveArea(s, s.d1 / 2, s.d / 2, false);
    let I = 0;
    const n = 20000, r0 = s.d1 / 2, r1 = s.d / 2;
    for (let k = 0; k < n; k++) {
      const r = r0 + ((k + 0.5) / n) * (r1 - r0);
      I += r * grooveWidth(s, r, false) * ((r1 - r0) / n);
    }
    close(A, ((2 * Math.PI) / s.P) * I, 1e-9);
  });

  it('in part units: an M10 in centimetres', () => {
    const s = threadIn(parseThread('M10'), 'cm');
    close(s.d, 1, 1e-12);
    close(s.P, 0.15, 1e-12);
    close(s.As, 0.58, 0.0005);
  });
});
