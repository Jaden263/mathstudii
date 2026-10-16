import { describe, it, expect } from 'vitest';
import katex from 'katex';
import { evaluateWorksheet, type MathResult, type SolveResult, type PlotResult } from './evaluator';
import { emptyWorksheet, createRegion, type Region, type Worksheet } from '../model/types';

function run(lines: (string | Region)[], settings: Partial<Worksheet['settings']> = {}) {
  const ws = emptyWorksheet();
  ws.settings = { ...ws.settings, ...settings };
  ws.regions = lines.map((l, i) => {
    const r = typeof l === 'string' ? createRegion('math', 40, 40 + i * 40, { source: l }) : l;
    r.y = 40 + i * 40;
    return r;
  });
  const out = evaluateWorksheet(ws);
  for (const r of out.results.values()) {
    const texs: string[] = [];
    if (r.kind === 'math') texs.push(r.tex);
    if (r.kind === 'solve') texs.push(...r.constraints.map((c) => c.tex), r.solver.tex);
    for (const t of texs) expect(() => katex.renderToString(t, { throwOnError: true }), t).not.toThrow();
  }
  return ws.regions.map((r) => out.results.get(r.id)!);
}

const block = (constraints: string, solver: string, guesses = '') => createRegion('solve', 40, 0, { guesses, constraints, solver });

/** The value shown by the last region, as a number (unit text dropped). */
function last(lines: (string | Region)[], settings?: Partial<Worksheet['settings']>): number {
  const res = run(lines, settings);
  const r = res[res.length - 1] as MathResult;
  if (r.error) throw new Error(r.error);
  const shown = r.tex.slice(r.tex.lastIndexOf(' = ') + 3).replace(/\\,/g, '');
  const m = /^(-?[\d.]+)(?: \\cdot 10\^\{(-?\d+)\})?/.exec(shown);
  if (!m) throw new Error(`no number in ${shown}`);
  return Number(m[1]) * 10 ** Number(m[2] ?? 0);
}

function solverError(lines: (string | Region)[]): string | undefined {
  const res = run(lines);
  const s = res.find((r) => r.kind === 'solve') as SolveResult;
  return s.solver.error;
}

// damped free vibration y″ + 2ζω y′ + ω² y = 0, y(0) = y₀, y′(0) = 0 has
// y = y₀ e^(−ζωt) (cos ω_d t + ζ/√(1−ζ²) sin ω_d t), ω_d = ω√(1−ζ²)
const oscillator = [
  'ζ := 0.05', 'ω := 3 π / s', 'ω_d := ω * sqrt(1 - ζ^2)',
  'y_e(t) := 1 mm * exp(-ζ * ω * t) * (cos(ω_d * t) + ζ / sqrt(1 - ζ^2) * sin(ω_d * t))',
  block("y''(t) + 2*ζ*ω*y'(t) + ω^2*y(t) = 0\ny(0 s) = 1 mm\ny'(0 s) = 0 mm/s", 'y := odesolve(t, 10 s)'),
];

describe('odesolve: initial value problems', () => {
  it('damped oscillator with units against the closed form', () => {
    for (const t of ['0.37 s', '1 s', '4.2 s', '10 s']) {
      expect(last([...oscillator, `abs(y(${t}) - y_e(${t})) / 1 mm =`])).toBeLessThan(1e-8);
    }
    // y in mm, y′ in mm/s (the exact derivative of the closed form, by central differences)
    expect(last([...oscillator, 'y(1 s) = mm'])).toBeCloseTo(-0.6238, 4);
    const v = last([...oscillator, "y'(1 s) = mm/s"]);
    const ve = last([...oscillator, '(y_e(1 s + 1e-5 s) - y_e(1 s - 1e-5 s)) / 2e-5 s = mm/s']);
    expect(Math.abs(v - ve)).toBeLessThan(1e-4);
    // y″ comes from the equation itself
    expect(last([...oscillator, "abs(y''(2 s) + 2*ζ*ω*y'(2 s) + ω^2*y(2 s)) * 1 s^2 / 1 mm ="])).toBeLessThan(1e-9);
  });
  it('solves y′ = −y without units', () => {
    expect(last([block("y'(t) = -y(t)\ny(0) = 1", 'y := odesolve(t, 5)'), 'abs(y(3) - exp(-3)) ='])).toBeLessThan(1e-9);
  });
  it('accepts diff notation, methods and a step count', () => {
    const lines = [block("diff(y(t), t, 2) = -y(t)\ny(0) = 0\ny'(0) = 1", 'y := odesolve(t, π, "radau")')];
    expect(last([...lines, 'abs(y(π/2) - 1) ='])).toBeLessThan(1e-8);
    const fixed = [block("y'(t) = -y(t)\ny(0) = 1", 'y := odesolve(t, 2, 200, "fixed")')];
    // RK4 with h = 0.01: global error ~ h⁴
    const e = last([...fixed, 'abs(y(2) - exp(-2)) =']);
    expect(e).toBeGreaterThan(1e-12);
    expect(e).toBeLessThan(1e-9);
    expect(solverError([block("y'(t) = -y(t)\ny(0) = 1", 'y := odesolve(t, 2, "euler")')])).toMatch(/unknown method/);
  });
  it('equations that are not explicit in the highest derivative', () => {
    // e^y′ = 1 + t, y(0) = 0  ⇒  y = (1 + t) ln(1 + t) − t
    expect(last([block("exp(y'(t)) = 1 + t\ny(0) = 0", 'y := odesolve(t, 2)'), 'abs(y(2) - (3 ln(3) - 2)) ='])).toBeLessThan(1e-8);
    // m(t) y″ = −k y with the mass on the left
    expect(last([block("(1 + 0*t) * y''(t) + y(t) = 0\ny(0) = 1\ny'(0) = 0", 'y := odesolve(t, 3)'), 'abs(y(3) - cos(3)) ='])).toBeLessThan(1e-8);
  });
  it('systems of mixed order, destructured or as a vector', () => {
    // x″ = −x + z, z′ = −z: z = e^−t, x = ½(cos t + sin t ... ) — check z and the energy-free part
    const sys = [block("x''(t) = -x(t) + z(t)\nz'(t) = -z(t)\nx(0) = 1\nx'(0) = 0\nz(0) = 1", '[X; Z] := odesolve([x, z], t, 3)')];
    expect(last([...sys, 'abs(Z(3) - exp(-3)) ='])).toBeLessThan(1e-9);
    // x = ½(cos t + sin t + e^−t) solves x″ + x = e^−t with x(0) = 1, x′(0) = 0
    expect(last([...sys, 'abs(X(3) - (cos(3) + sin(3) + exp(-3)) / 2) ='])).toBeLessThan(1e-9);
    const vecForm = [block("x'(t) = -y(t)\ny'(t) = x(t)\nx(0) = 1\ny(0) = 0", 'S := odesolve([x, y], t, 5)')];
    expect(last([...vecForm, 'abs(S[1](1) - sin(1)) ='])).toBeLessThan(1e-9);
  });
  it('Lotka–Volterra keeps its first integral', () => {
    // V = δx − γ ln x + βy − α ln y is constant along solutions
    const lv = [
      'α := 1.5', 'β := 1', 'γ := 3', 'δ := 1', 'V(x, y) := δ*x - γ*ln(x) + β*y - α*ln(y)',
      block("x'(t) = α*x(t) - β*x(t)*y(t)\ny'(t) = δ*x(t)*y(t) - γ*y(t)\nx(0) = 10\ny(0) = 5", '[X; Y] := odesolve([x, y], t, 15)'),
    ];
    for (const t of [3.3, 9, 15]) expect(last([...lv, `abs(V(X(${t}), Y(${t})) / V(10, 5) - 1) =`])).toBeLessThan(1e-6);
  });
  it('a forced stiff equation with units at the default tolerance', () => {
    // τ y′ = cos(ω t) · 1 m − y, τ = 1 ms, ω = 1/s, y(0) = 0: y = (cos ωt + ωτ sin ωt − e^(−t/τ)) / (1 + ω²τ²) · 1 m
    const lines = [
      'τ := 1 ms', 'ω := 1 / s',
      block("τ * y'(t) = cos(ω * t) * 1 m - y(t)\ny(0 s) = 0 m", 'y := odesolve(t, 100 s)'),
      'y_e(t) := (cos(ω t) + ω τ sin(ω t) - exp(-t / τ)) / (1 + (ω τ)^2) * 1 m',
    ];
    const t0 = performance.now();
    for (const t of ['0.002 s', '1 s', '50 s', '100 s']) expect(last([...lines, `abs(y(${t}) - y_e(${t})) / 1 m =`]), t).toBeLessThan(1e-7);
    expect(performance.now() - t0).toBeLessThan(10000);
  }, 20000);
  it('stiff Van der Pol (μ = 1000) is detected and solved within the time budget', () => {
    // relaxation period T ≈ (3 − 2 ln 2) μ + 3·2.33811 μ^(−1/3) = 1614.4 (Dorodnitsyn)
    const vdp = ['μ := 1000', block("y''(t) - μ*(1 - y(t)^2)*y'(t) + y(t) = 0\ny(0) = 2\ny'(0) = 0", 'y := odesolve(t, 3000)')];
    const t0 = performance.now();
    const T = last([...vdp, 't_1 := root(y(t), t, 700, 900)', 't_2 := root(y(t), t, 2300, 2500)', 't_2 - t_1 ='], { precision: 6 });
    expect(performance.now() - t0).toBeLessThan(8000);
    expect(Math.abs(T - 1614.4)).toBeLessThan(0.5);
  }, 20000);
});

describe('odesolve: boundary value problems (shooting)', () => {
  const beam = ['q := 10 kN/m', 'E := 210 GPa', 'I := 8000 cm^4', 'L := 6 m'];
  it('simply supported beam: EI y⁗ = q, y = y″ = 0 at both ends', () => {
    const ss = [...beam, block("y''''(x) = q/(E*I)\ny(0) = 0\ny(L) = 0\ny''(0) = 0\ny''(L) = 0", 'y := odesolve(x, L)')];
    // midspan 5qL⁴/(384EI), end slope qL³/(24EI); the bare zeros take their units from the equation
    expect(last([...ss, 'abs(y(L/2) / (5*q*L^4/(384*E*I)) - 1) ='])).toBeLessThan(1e-9);
    expect(last([...ss, "abs(y'(0 m) / (q*L^3/(24*E*I)) - 1) ="])).toBeLessThan(1e-9);
    expect(last([...ss, 'y(L/2) = mm'])).toBeCloseTo(10.0446, 4);
  });
  it('works out units from the equation, whichever way it is written', () => {
    for (const eq of ["E*I*y''''(x) - q = 0", "y''''(x) * (E*I) = q", "0 = q - E*I*y''''(x)"]) {
      const ss = [...beam, block(`${eq}\ny(0) = 0\ny(L) = 0\ny''(0) = 0\ny''(L) = 0`, 'y := odesolve(x, L)')];
      expect(last([...ss, 'y(L/2) = mm']), eq).toBeCloseTo(10.0446, 4);
    }
  });
  it('cantilever: clamped at 0, free at L (conditions at both ends)', () => {
    const cant = [...beam, block("E*I*y''''(x) = q\ny(0 m) = 0 mm\ny'(0 m) = 0\ny''(L) = 0 / m\ny'''(L) = 0 / m^2", 'y := odesolve(x, L)')];
    // tip deflection qL⁴/(8EI), clamping moment −EI y″(0) = −qL²/2
    expect(last([...cant, 'abs(y(L) / (q*L^4/(8*E*I)) - 1) ='])).toBeLessThan(1e-9);
    expect(last([...cant, "E*I*y''(0 m) = kN*m"])).toBeCloseTo(180, 6);
  });
  it('a nonlinear BVP: y″ = −e^y, y(0) = y(1) = 0 (Bratu), lower branch', () => {
    // y = −2 ln(cosh((x − ½) θ/2) / cosh(θ/4)) with θ = √2 cosh(θ/4) (θ ≈ 1.5171645990507543)
    const b = [block("y''(x) = -exp(y(x))\ny(0) = 0\ny(1) = 0", 'y := odesolve(x, 1)'), 'θ := 1.5171645990507543'];
    expect(last([...b, 'abs(y(0.5) - (-2*ln(1/cosh(θ/4)))) ='])).toBeLessThan(1e-8);
  });
  it('a long beam on an elastic foundation (multiple shooting)', () => {
    // EI y⁗ + k y = q, simply supported: y(x) = Σ_(n odd) 4q/(nπ) sin(nπx/L) / (EI (nπ/L)⁴ + k) (Hetényi);
    // λL = L (k/4EI)^¼ = 27.6, so single shooting would see the integration error grow by e^27.6
    const found = [
      'q := 20 kN/m', 'EI := 210 GPa * 8360 cm^4', 'k_s := 50 MPa', 'L := 30 m',
      block("EI * y''''(x) + k_s * y(x) = q\ny(0) = 0\ny(L) = 0\ny''(0) = 0\ny''(L) = 0", 'y := odesolve(x, L)'),
      'y_F(x) := sum(4 q / ((2 j + 1) π) * sin((2 j + 1) π x / L) / (EI * ((2 j + 1) π / L)^4 + k_s), j, 0, 3000)',
    ];
    const t0 = performance.now();
    for (const x of ['1 m', '3.3 m', '15 m']) expect(last([...found, `abs(y(${x}) - y_F(${x})) / (q / k_s) =`]), x).toBeLessThan(1e-6);
    expect(performance.now() - t0).toBeLessThan(15000);
    // far from the supports the beam just rests on the foundation: y = q/k
    expect(last([...found, 'y(L/2) = mm'])).toBeCloseTo(0.4, 6);
  }, 30000);
  it('fixed RK4 steps in a boundary value problem count over the whole interval', () => {
    // u″ = 400u, u(0) = 1, u(10) = 0 ≈ e^(−20x), by multiple shooting with 2000 RK4 steps in all (h = 0.005):
    // the RK4 error per step ~ (20h)⁵/120 compounds to ≈ 1.7e−6 relative at x = 0.1; with 2000 steps
    // in each of the 8 pieces it would be 8⁴ times smaller
    const e = last([block("u''(x) = 400*u(x)\nu(0) = 1\nu(10) = 0", 'u := odesolve(x, 10, 2000, "fixed")'), 'abs(u(0.1) / exp(-2) - 1) =']);
    expect(e).toBeGreaterThan(5e-7);
    expect(e).toBeLessThan(5e-6);
    // RK4 integrates the beam's quartic exactly, replayed shots included
    const ss = [...beam, block("y''''(x) = q/(E*I)\ny(0) = 0\ny(L) = 0\ny''(0) = 0\ny''(L) = 0", 'y := odesolve(x, L, 10, "fixed")')];
    expect(last([...ss, 'abs(y(L/2) / (5*q*L^4/(384*E*I)) - 1) ='])).toBeLessThan(1e-9);
  });
  it('says when the conditions cannot be met', () => {
    // Bratu y″ = −λ e^y, y(0) = y(1) = 0 has no solution for λ > 3.5138 (the fold)
    expect(solverError([block("y''(x) = -4*exp(y(x))\ny(0) = 0\ny(1) = 0", 'y := odesolve(x, 1)')])).toMatch(/could not be met/);
    // y″ + y = 0 with y(0) = 0 and y(π) = 1: every solution through the origin vanishes at π
    expect(solverError([block("y''(x) + y(x) = 0\ny(0) = 0\ny(π) = 1", 'y := odesolve(x, π)')])).toMatch(/do not determine/);
  });
});

describe('odesolve: messages', () => {
  it('explains what is missing or wrong', () => {
    expect(solverError([block("y''(t) = -y(t)\ny(0) = 1", 'y := odesolve(t, 5)')])).toBe("missing initial condition for y'");
    expect(solverError([block("y''(t) = -y(t)\ny(0) = 1\ny'(0) = 0\ny''(0) = 1", 'y := odesolve(t, 5)')])).toMatch(/only fix y, y'/);
    expect(solverError([block("y''(t) = -y(t)\ny(0 s) = 1 mm\ny'(0 s) = 1 mm", 'y := odesolve(t, 1 s)')])).toMatch(/y' needs units of mm \/ s/);
    expect(solverError([block("y'(t) = -y(t)\ny(0 s) = 1", 'y := odesolve(t, 1 m)')])).toMatch(/units of s, the variable t has m/);
    expect(solverError([block("y'(t) = y(t - 1)\ny(0) = 1", 'y := odesolve(t, 2)')])).toMatch(/with t itself/);
    expect(solverError([block("y'(t) = y(t)^2\ny(0) = 1", 'y := odesolve(t, 2)')])).toMatch(/too small at t = 1\.0000/);
    expect(solverError([block('y(t) = 1\ny(0) = 1', 'y := odesolve(t, 2)')])).toMatch(/No derivative of y/);
    expect(solverError([block("y'(t) = 1\ny(0) = 1", 'odesolve(t, 2)')])).toMatch(/Assign the solution/);
    const out = run([block("y'(t) = -y(t)\ny(0 s) = 1 mm", 'y := odesolve(t, 10 s)'), 'y(12 s) =']);
    expect((out[1] as MathResult).error).toBe('y(12 s) is outside the solution interval 0 s … 10 s');
    expect((run(['odesolve(t, 1) ='])[0] as MathResult).error).toMatch(/solver of a solve block/);
  });
});

describe('prime notation and plots', () => {
  it("f'(x) differentiates worksheet functions; A'(x) stays transpose-times", () => {
    expect(last(['f(x) := x^3 * 1 m', "f'(2) = m"])).toBeCloseTo(12, 8);
    expect(last(['f(x) := sin(x)', "f''(1) + sin(1) ="])).toBeLessThan(1e-6);
    const r = run(['A := [1, 2; 3, 4]', "B := A'(2)", 'B[0, 1] =']);
    expect((r[2] as MathResult).tex).toMatch(/= 6$/); // transpose(A)·2
  });
  it('plots an odesolve solution over its interval', () => {
    const plot = createRegion('plot', 40, 0, { xExpr: 't', traces: [{ y: 'y(t)', style: 'line' }], xmin: '0 s', xmax: '10 s', xUnit: 's', yUnit: 'mm' });
    const res = run([...oscillator, plot]);
    const p = res[res.length - 1] as PlotResult;
    expect(p.error).toBeUndefined();
    const ys = p.series[0].ys;
    expect(ys.length).toBe(601);
    expect(ys.every(Number.isFinite)).toBe(true);
    expect(ys[0]).toBeCloseTo(1, 12);
    expect(Math.min(...ys)).toBeLessThan(-0.8); // first trough ≈ −e^(−πζ/√(1−ζ²)) = −0.855 mm
  });
});

describe('Mathcad ODE functions with units', () => {
  // m x″ = −k x, x(0) = 10 mm: x = 10 mm cos(√(k/m) t)
  const sys = ['k := 4 kN/m', 'M := 10 kg', 'D(t, x) := [x[1]; -k/M*x[0]]', 'x_e(t) := 10 mm * cos(sqrt(k/M) * t)'];
  it.each(['Rkadapt', 'Radau', 'Bulstoer', 'AdamsBDF', 'BDF'])('%s', (fn) => {
    const lines = [...sys, `S := ${fn}([10 mm; 0 m/s], 0 s, 1 s, 8, D)`];
    expect(last([...lines, 'abs(S[8, 1] - x_e(1 s)) / 1 mm ='])).toBeLessThan(1e-7);
    expect(last([...lines, 'S[4, 0] = s'])).toBe(0.5);
  });
  it('Stiffb with a Jacobian J(x, y) = [∂D/∂x, ∂D/∂y]', () => {
    const lines = [...sys, 'J(t, x) := [0 / s, 0 / s, 1 / s; 0 m/s^3, -k/M, 0 / s]', 'S := Stiffb([10 mm; 0 m/s], 0 s, 1 s, 4, D, J)'];
    expect(last([...lines, 'abs(S[4, 1] - x_e(1 s)) / 1 mm ='])).toBeLessThan(1e-7);
  });
  it('rkfixed keeps its fixed steps; rkadapt(…, kmax, save) returns the solver steps', () => {
    expect(last(['D(t, y) := [-y[0]]', 'S := rkfixed([1], 0, 1, 10, D)', 'S[10, 1] ='])).toBeCloseTo(0.3679, 4);
    const r = run([...sys, 'S := rkadapt([10 mm; 0 m/s], 0 s, 1 s, 1e-8, D, 6, 0.1 s)', 'rows(S) =', 'S[rows(S) - 1, 0] = s']);
    expect((r[r.length - 2] as MathResult).tex).toMatch(/= [2-7]$/);
    expect((r[r.length - 1] as MathResult).tex).toMatch(/= 1\\ \\mathrm\{s\}$/);
    expect((run([...sys, 'S := Rkadapt([10 mm; 0 kg], 0 s, 1 s, 4, D)'])[4] as MathResult).error).toMatch(/units of/);
  });
});
