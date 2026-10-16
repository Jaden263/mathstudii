import { describe, it, expect } from 'vitest';
import { solveIvp, type OdeMethod } from './ode';

const decay = (_t: number, y: number[]) => [-y[0]];

describe('ODE solvers on y′ = −y', () => {
  it('match e^−t everywhere in the interval (dense output)', () => {
    const cases: [OdeMethod, number][] = [['auto', 1e-9], ['dopri', 1e-9], ['radau', 1e-9], ['bs', 1e-9]];
    for (const [method, rtol] of cases) {
      const s = solveIvp(decay, 0, [1], 5, { method, rtol, stops: method === 'bs' ? [1, 2, 3, 4] : undefined });
      // error relative to the solution's peak (1), at the steps and between them
      const pts = method === 'bs' ? [1, 2, 3, 4, 5] : Array.from({ length: 101 }, (_, i) => i * 0.05);
      const worst = Math.max(...pts.map((t) => Math.abs(s.at(t)[0] - Math.exp(-t))));
      expect(worst, method).toBeLessThan(20 * rtol);
    }
  });
  it('fixed-step RK4 converges with order 4', () => {
    const err = (n: number) => Math.abs(solveIvp(decay, 0, [1], 2, { method: 'rk4', steps: n }).at(2)[0] - Math.exp(-2));
    const ratio = err(20) / err(40);
    expect(ratio).toBeGreaterThan(14);
    expect(ratio).toBeLessThan(18); // 2⁴ = 16
  });
  it('integrates backwards', () => {
    const s = solveIvp(decay, 3, [Math.exp(-3)], 0, { rtol: 1e-10 });
    expect(Math.abs(s.at(0)[0] - 1)).toBeLessThan(1e-9);
    expect(Math.abs(s.at(1.5)[0] - Math.exp(-1.5))).toBeLessThan(1e-9);
  });
  it('reports a solution that blows up', () => {
    // y′ = y², y(0) = 1 has y = 1/(1 − t): a singularity at t = 1
    expect(() => solveIvp((_t, y) => [y[0] * y[0]], 0, [1], 2)).toThrow(/too small at t = 1\.0000/);
  });
});

describe('damped oscillator', () => {
  // y″ + 2ζω y′ + ω² y = 0, y(0) = y₀, y′(0) = 0:
  // y = y₀ e^(−ζωt) (cos ω_d t + ζ/√(1−ζ²) sin ω_d t), ω_d = ω √(1−ζ²)
  const z = 0.05, w = 2 * Math.PI * 1.5, y0 = 1e-3;
  const wd = w * Math.sqrt(1 - z * z);
  const exact = (t: number) => y0 * Math.exp(-z * w * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t));
  const f = (_t: number, y: number[]) => [y[1], -2 * z * w * y[1] - w * w * y[0]];
  it.each(['auto', 'radau', 'rk4'] as OdeMethod[])('%s', (method) => {
    const s = solveIvp(f, 0, [y0, 0], 10, { method, rtol: 1e-9, steps: method === 'rk4' ? 4000 : undefined });
    let worst = 0;
    for (let i = 0; i <= 1000; i++) worst = Math.max(worst, Math.abs(s.at(i * 0.01)[0] - exact(i * 0.01)));
    expect(worst / y0).toBeLessThan(method === 'rk4' ? 1e-7 : 2e-8);
    // auto stays explicit: the oscillator is not stiff
    if (method === 'auto') expect(s.methods).toEqual(['Dormand–Prince 5(4)']);
  });
});

describe('stiff problems', () => {
  it('Van der Pol, μ = 1000: Radau, and auto switching to it, within the time budget', () => {
    // y″ − μ(1 − y²)y′ + y = 0, y(0) = 2, y′(0) = 0. For large μ the relaxation period is
    // T = (3 − 2 ln 2) μ + 3 a μ^(−1/3) + O(ln μ / μ), a = 2.33811 (−first zero of Ai) — Dorodnitsyn's formula
    const mu = 1000;
    const vdp = (_t: number, y: number[]) => [y[1], mu * (1 - y[0] * y[0]) * y[1] - y[0]];
    const T = (3 - 2 * Math.LN2) * mu + 3 * 2.338107410459767 * Math.pow(mu, -1 / 3);
    for (const method of ['radau', 'auto'] as OdeMethod[]) {
      const t0 = performance.now();
      const s = solveIvp(vdp, 0, [2, 0], 3000, { method, rtol: 1e-6 });
      const ms = performance.now() - t0;
      expect(s.methods.at(-1)).toBe('Radau IIA (order 5)');
      expect(s.steps).toBeLessThan(2000);
      expect(ms).toBeLessThan(2000);
      // downward zero crossings, located on the dense output
      const cross: number[] = [];
      for (let i = 1; i < s.ts.length; i++) {
        if (s.ys[i - 1][0] > 0 && s.ys[i][0] <= 0) {
          let a = s.ts[i - 1], b = s.ts[i];
          for (let k = 0; k < 60; k++) { const m = (a + b) / 2; if (s.at(m)[0] > 0) a = m; else b = m; }
          cross.push(a);
        }
      }
      expect(cross.length).toBe(2);
      expect(Math.abs(cross[1] - cross[0] - T)).toBeLessThan(0.5);
    }
  });
  it('Robertson kinetics: mass conserved, the explicit solver hands over', () => {
    // y₁′ = −0.04 y₁ + 10⁴ y₂y₃, y₂′ = 0.04 y₁ − 10⁴ y₂y₃ − 3·10⁷ y₂², y₃′ = 3·10⁷ y₂²
    const rob = (_t: number, y: number[]) => [
      -0.04 * y[0] + 1e4 * y[1] * y[2],
      0.04 * y[0] - 1e4 * y[1] * y[2] - 3e7 * y[1] * y[1],
      3e7 * y[1] * y[1],
    ];
    const s = solveIvp(rob, 0, [1, 0, 0], 40, { rtol: 1e-8 });
    expect(s.stiffAt).toBeDefined();
    expect(s.steps).toBeLessThan(5000);
    const y = s.at(40);
    expect(Math.abs(y[0] + y[1] + y[2] - 1)).toBeLessThan(1e-12);
    const fine = solveIvp(rob, 0, [1, 0, 0], 40, { method: 'radau', rtol: 1e-11 }).at(40);
    y.forEach((v, i) => expect(Math.abs(v - fine[i]) / fine[i]).toBeLessThan(1e-6));
  });
});

describe('invariants and replay', () => {
  it('Lotka–Volterra keeps its first integral', () => {
    // x′ = αx − βxy, y′ = δxy − γy conserves V = δx − γ ln x + βy − α ln y
    const [a, b, c, d] = [1.5, 1, 3, 1];
    const V = (x: number, y: number) => d * x - c * Math.log(x) + b * y - a * Math.log(y);
    const s = solveIvp((_t, y) => [a * y[0] - b * y[0] * y[1], d * y[0] * y[1] - c * y[1]], 0, [10, 5], 15, { rtol: 1e-11 });
    const v0 = V(10, 5);
    let drift = 0;
    for (let i = 0; i <= 300; i++) {
      const y = s.at(i * 0.05);
      drift = Math.max(drift, Math.abs(V(y[0], y[1]) - v0) / Math.abs(v0));
    }
    expect(drift).toBeLessThan(1e-8);
  });
  it('replaying a mesh gives a smooth map from the initial values', () => {
    // y″ = −y: the sensitivity of y(10) to y′(0) is sin(10)
    const f = (_t: number, y: number[]) => [y[1], -y[0]];
    const base = solveIvp(f, 0, [1, 0], 10, { rtol: 1e-10 });
    const d = 1e-6;
    const pert = solveIvp(f, 0, [1, d], 10, { mesh: base.ts, method: 'dopri' });
    expect(pert.steps).toBe(base.steps);
    expect(Math.abs((pert.at(10)[0] - base.at(10)[0]) / d - Math.sin(10))).toBeLessThan(1e-8);
  });
});
