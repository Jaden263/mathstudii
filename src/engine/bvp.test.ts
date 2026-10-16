import { describe, it, expect } from 'vitest';
import { solveBvp, solveFromPoint } from './bvp';

const opts = { method: 'auto' as const, rtol: 1e-9, names: 'y' };

describe('boundary value problems', () => {
  it('single shooting where the solution stays tame', () => {
    // y″ = −y, y(0) = 0, y(1) = 1: y = sin x / sin 1
    const s = solveBvp((_t, y) => [y[1], -y[0]], 2, [{ i: 0, point: 0, value: 0 }, { i: 0, point: 1, value: 1 }], 0, 1, opts);
    expect(s.pieces).toBe(1);
    for (const x of [0.25, 0.5, 0.9]) expect(Math.abs(s.at(x)[0] - Math.sin(x) / Math.sin(1))).toBeLessThan(1e-9);
    expect(Math.abs(s.at(0)[1] - 1 / Math.sin(1))).toBeLessThan(1e-9);
  });
  it('multiple shooting when the solution grows like e^(200)', () => {
    // y″ = 400 y, y(0) = 1, y(10) = 0: y = sinh(20 (10 − x)) / sinh(200) = e^(−20x) (1 − e^(−40(10−x))) / (1 − e^(−400))
    const t0 = performance.now();
    const s = solveBvp((_t, y) => [y[1], 400 * y[0]], 2, [{ i: 0, point: 0, value: 1 }, { i: 0, point: 10, value: 0 }], 0, 10, opts);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(s.pieces).toBeGreaterThan(1);
    for (const x of [0.05, 0.3]) expect(Math.abs(s.at(x)[0] / Math.exp(-20 * x) - 1)).toBeLessThan(1e-7);
    // errors are relative to the solution's peak, y(0) = 1
    for (const x of [1, 5, 9.9]) expect(Math.abs(s.at(x)[0] - Math.exp(-20 * x))).toBeLessThan(1e-9);
    expect(Math.abs(s.at(0)[1] + 20)).toBeLessThan(1e-6); // y′(0) = −20 coth(200)
    expect(Math.abs(s.at(10)[0])).toBeLessThan(1e-12);
  });
  it('a long beam on an elastic foundation against its Fourier series', () => {
    // EI y⁗ + k y = q on simple supports (y = y″ = 0 at 0 and L):
    // y(x) = Σ_(n odd) 4q/(nπ) sin(nπx/L) / (EI (nπ/L)⁴ + k); λL = L (k/4EI)^¼ ≈ 27.6
    const q = 20e3, EI = 210e9 * 8360e-8, k = 50e6, L = 30;
    const series = (x: number) => {
      let s = 0;
      for (let n = 1; n < 20000; n += 2) s += (4 * q / (n * Math.PI)) * Math.sin((n * Math.PI * x) / L) / (EI * (n * Math.PI / L) ** 4 + k);
      return s;
    };
    const f = (_t: number, y: number[]) => [y[1], y[2], y[3], (q - k * y[0]) / EI];
    const bc = [0, 2].flatMap((i) => [{ i, point: 0, value: 0 }, { i, point: L, value: 0 }]);
    const s = solveBvp(f, 4, bc, 0, L, opts);
    for (const x of [0.5, 1.7, 4, 15, 29]) expect(Math.abs(s.at(x)[0] - series(x)) / (q / k)).toBeLessThan(1e-7);
  });
  it('reports conditions that admit no solution', () => {
    // y″ + y = 0 with y(0) = 0, y(π) = 1: every solution sin-like vanishes at π
    expect(() => solveBvp((_t, y) => [y[1], -y[0]], 2, [{ i: 0, point: 0, value: 0 }, { i: 0, point: Math.PI, value: 1 }], 0, Math.PI, opts)).toThrow(/do not determine/);
  });
  it('initial value problems run both ways from their point', () => {
    const s = solveFromPoint((_t, y) => [-y[0]], 1, [1], 0, 2, opts);
    expect(Math.abs(s.at(0)[0] - Math.E)).toBeLessThan(1e-8);
    expect(Math.abs(s.at(2)[0] - 1 / Math.E)).toBeLessThan(1e-9);
  });
});
