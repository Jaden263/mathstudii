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
  it('dense output backwards reads the step that holds t, not its neighbour', () => {
    // y″ = −y from t = 20 back to 0 with y = sin t: between the steps the interpolant must do
    // as well as forwards (a lookup one step off extrapolates: 50× worse with Radau)
    const f = (_t: number, y: number[]) => [y[1], -y[0]];
    type Sol = ReturnType<typeof solveIvp>;
    const mid = (s: Sol, own: boolean) =>
      Math.max(...s.segments.map((g) => Math.abs((own ? g.at((g.a + g.b) / 2) : s.at((g.a + g.b) / 2))[0] - Math.sin((g.a + g.b) / 2))));
    for (const method of ['dopri', 'radau', 'bs'] as OdeMethod[]) {
      const back = solveIvp(f, 20, [Math.sin(20), Math.cos(20)], 0, { method, rtol: 1e-6 });
      expect(mid(back, false), method).toBe(mid(back, true));
      expect(mid(back, false), method).toBeLessThan(3 * mid(solveIvp(f, 0, [0, 1], 20, { method, rtol: 1e-6 }), false));
    }
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
    // auto stays explicit: the oscillator is not stiff (its short Radau trials are not kept)
    if (method === 'auto') {
      expect(s.stiffAt).toBeUndefined();
      expect(s.kinds.filter((k) => k === 'radau').length).toBeLessThan(0.1 * s.steps);
      // and they cost little: within 5 % of Dormand–Prince alone
      expect(s.evals).toBeLessThan(1.05 * solveIvp(f, 0, [y0, 0], 10, { method: 'dopri', rtol: 1e-9 }).evals);
    }
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
  it('a forced stiff equation at a tight tolerance switches on trial', () => {
    // y′ = −λ(y − cos t), y(0) = 0: y = (λ² cos t + λ sin t − λ² e^(−λt)) / (λ² + 1). Dormand–Prince
    // needs h|λ| ≈ 0.9 here (≈ 10⁵ steps), never reaching the stability boundary Hairer's test watches
    const lam = 1000;
    const exact = (t: number) => (lam * lam * Math.cos(t) + lam * Math.sin(t) - lam * lam * Math.exp(-lam * t)) / (lam * lam + 1);
    const s = solveIvp((t, y) => [-lam * (y[0] - Math.cos(t))], 0, [0], 100, { rtol: 1e-9 });
    expect(s.stiffAt).toBeDefined();
    expect(s.steps).toBeLessThan(5000);
    let worst = 0;
    for (let i = 0; i <= 1000; i++) worst = Math.max(worst, Math.abs(s.at(i * 0.1)[0] - exact(i * 0.1)));
    expect(worst).toBeLessThan(1e-7);
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
    // Hairer & Wanner's reference solution at x = 40 (Solving ODEs II, IV.10)
    const ref = [0.7158270687193941, 9.185534764557522e-6, 0.2841637457458413];
    fine.forEach((v, i) => expect(Math.abs(v - ref[i]) / ref[i]).toBeLessThan(1e-8));
  });
  it('Van der Pol, ε = 10⁻⁶, against Hairer & Wanner\'s reference solution', () => {
    // VDPOL: y₁′ = y₂, ε y₂′ = (1 − y₁²) y₂ − y₁, y(0) = (2, 0); at x = 2 (Solving ODEs II, IV.10)
    // y₁ = 1.706167732170469, y₂ = −0.8928097010248125
    const eps = 1e-6;
    const f = (_t: number, y: number[]) => [y[1], ((1 - y[0] * y[0]) * y[1] - y[0]) / eps];
    for (const [method, rtol, tol] of [['auto', 1e-9, 1e-8], ['radau', 1e-12, 1e-10]] as [OdeMethod, number, number][]) {
      const y = solveIvp(f, 0, [2, 0], 2, { method, rtol }).at(2);
      expect(Math.abs(y[0] - 1.706167732170469), method).toBeLessThan(tol);
      expect(Math.abs(y[1] + 0.8928097010248125), method).toBeLessThan(10 * tol);
    }
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
  it('replays explicit and implicit stretches with the method that made them', () => {
    // y₁′ = −a y₁ + (a − 1) y₂, y₂′ = −y₂ + cos t: y₁ = y₂(0) e^−t + (y₁(0) − y₂(0)) e^(−at) + forced part,
    // so ∂y₁(T)/∂y₂(0) = e^−T − e^(−aT). An explicit replay of the long implicit steps would blow up.
    const a = 1000;
    const f = (t: number, y: number[]) => [-a * y[0] + (a - 1) * y[1], -y[1] + Math.cos(t)];
    const base = solveIvp(f, 0, [0, 1], 3, { rtol: 1e-8 });
    expect(new Set(base.kinds)).toEqual(new Set(['dopri', 'radau']));
    const replay = (y0: number[]) => solveIvp(f, 0, y0, 3, { mesh: base.ts, meshKinds: base.kinds });
    expect(replay([0, 1]).ys.at(-1)![0]).toBeCloseTo(base.ys.at(-1)![0], 12);
    const d = 1e-6;
    const sens = (replay([0, 1 + d]).at(3)[0] - replay([0, 1 - d]).at(3)[0]) / (2 * d);
    expect(Math.abs(sens - (Math.exp(-3) - Math.exp(-3 * a)))).toBeLessThan(1e-7);
  });
});

describe('banded systems (method of lines)', () => {
  it('Radau on a band gives the dense result, from fewer evaluations', () => {
    // y_i′ = (y_{i−1} − 2y_i + y_{i+1})/h², y = 0 at both ends: the discrete sine mode decays
    // exactly as e^(λt), λ = −(4/h²) sin²(πh/2)
    const n = 39, h = 1 / (n + 1);
    const f = (_t: number, y: number[]) => y.map((v, i) => ((i > 0 ? y[i - 1] : 0) - 2 * v + (i < n - 1 ? y[i + 1] : 0)) / (h * h));
    const y0 = Array.from({ length: n }, (_, i) => Math.sin(Math.PI * (i + 1) * h));
    const dense = solveIvp(f, 0, y0, 0.1, { method: 'radau', rtol: 1e-9 });
    const band = solveIvp(f, 0, y0, 0.1, { method: 'radau', rtol: 1e-9, band: 1 });
    const lambda = -(4 / (h * h)) * Math.sin((Math.PI * h) / 2) ** 2;
    for (const t of [0.013, 0.05, 0.1]) {
      const a = dense.at(t), b = band.at(t);
      for (let i = 0; i < n; i++) {
        expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-12);
        expect(Math.abs(b[i] - y0[i] * Math.exp(lambda * t))).toBeLessThan(1e-8);
      }
    }
    // each Jacobian from 3 evaluations instead of 39
    expect(band.evals).toBeLessThan(dense.evals);
  });
});
