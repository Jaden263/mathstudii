import { describe, it, expect } from 'vitest';
import katex from 'katex';
import { evaluateWorksheet, type MathResult, type SolveResult } from './evaluator';
import { solvePdeBlock } from './pdesolve';
import { compileExpr } from './compile';
import { ChainScope } from './scope';
import { splitTop } from './syntax';
import { toSINumber } from './math';
import { createRegion, emptyWorksheet, type Region } from '../model/types';

/** Solve a block directly: definitions, equations (lhs = rhs) and the Pdesolve arguments. */
function pde(defs: [string, string][], eqs: string[], args: string, names = ['u']) {
  const scope = new ChainScope(null);
  for (const [k, src] of defs) scope.set(k, compileExpr(src).evaluate(scope));
  const lines = eqs.map((e) => {
    const i = e.indexOf(' = ');
    return { lhs: e.slice(0, i), op: '=', rhs: e.slice(i + 3) };
  });
  const { functions } = solvePdeBlock(lines, splitTop(args, ',').map((a) => a.trim()), names, scope, 1e-9);
  return functions.map((f) => (x: number, t: number) => toSINumber(f(x, t)));
}

function run(items: (string | Region)[]) {
  const ws = emptyWorksheet();
  ws.regions = items.map((l, i) => {
    const r = typeof l === 'string' ? createRegion('math', 40, 0, { source: l }) : l;
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
const block = (constraints: string, solver: string) => createRegion('solve', 40, 0, { guesses: '', constraints, solver });

const HEAT = ['u_t(x, t) = α*u_xx(x, t)', 'u(x, 0) = sin(π*x/L)', 'u(0, t) = 0', 'u(L, t) = 0'];

describe('Pdesolve: the heat equation', () => {
  // separation of variables: u = e^(−απ²t/L²) sin(πx/L)
  const L = 1, a = 0.1, T = L ** 2 / (a * Math.PI ** 2);
  const exact = (x: number, t: number) => Math.exp((-a * Math.PI ** 2 * t) / L ** 2) * Math.sin((Math.PI * x) / L);
  const worst = (u: (x: number, t: number) => number) => {
    let e = 0;
    for (const x of [0.1, 0.3, 0.5, 0.77, 0.95]) for (const t of [0.2 * T, 0.5 * T, T]) e = Math.max(e, Math.abs(u(x, t) / exact(x, t) - 1));
    return e;
  };
  const defs: [string, string][] = [['L', '1'], ['α', '0.1'], ['T', 'L^2/(α π^2)']];

  it('the decaying sine to a relative error below 10⁻⁴ on the default grid', () => {
    const [u] = pde(defs, HEAT, 'u, x, [0, L], t, [0, T]');
    expect(worst(u)).toBeLessThan(1e-4);
    // between nodes too (the spline in x), and at the ends of the ranges
    expect(u(0.5, 0)).toBeCloseTo(1, 9);
    expect(Math.abs(u(0.0123, T) / exact(0.0123, T) - 1)).toBeLessThan(1e-4);
  });

  it('converges at second order in x ([xpts, tpts] form)', () => {
    const [coarse] = pde(defs, HEAT, 'u, x, [0, L], t, [0, T], [51, 20]');
    const [fine] = pde(defs, HEAT, 'u, x, [0, L], t, [0, T], 101, 20');
    // the error of central differences is (πh/L)²/12 · απ²t/L²: a quarter for half the step
    const ratio = worst(coarse) / worst(fine);
    expect(ratio).toBeGreaterThan(3.6);
    expect(ratio).toBeLessThan(4.4);
    expect(worst(coarse)).toBeCloseTo((Math.PI / 50) ** 2 / 12, 4);
  });

  it('an insulated rod keeps its heat: ∫u dx is conserved and u levels out at the mean', () => {
    // a step u = 1 on the left half; 200 nodes put the step between two of them, so the
    // nodes' trapezoidal integral starts at exactly L/2
    const d: [string, string][] = [['L', '1'], ['α', '0.01'], ['T', '10/(α π^2)']];
    const eqs = ['u_t(x, t) = α*u_xx(x, t)', 'u(x, 0) = if(x < L/2, 1, 0)', 'u_x(0, t) = 0', 'u_x(L, t) = 0'];
    const [u] = pde(d, eqs, 'u, x, [0, L], t, [0, T], 200');
    const T = 10 / (0.01 * Math.PI ** 2);
    const integral = (t: number) => {
      let s = 0;
      for (let i = 0; i < 200; i++) s += (i === 0 || i === 199 ? 0.5 : 1) * u(i / 199, t);
      return s / 199;
    };
    for (const t of [0, 0.01 * T, 0.3 * T, T]) expect(Math.abs(integral(t) - 0.5)).toBeLessThan(1e-9);
    // e^(−10) of the first cosine mode is left at the end
    for (const x of [0, 0.3, 1]) expect(Math.abs(u(x, T) - 0.5)).toBeLessThan(1e-4);
    // Fourier series: u = 1/2 + Σ 2/(nπ) sin(nπ/2) cos(nπx/L) e^(−α(nπ/L)²t)
    const t1 = 0.1 / (0.01 * Math.PI ** 2);
    const series = (x: number) => {
      let s = 0.5;
      for (let k = 1; k < 400; k++) s += (2 / (k * Math.PI)) * Math.sin((k * Math.PI) / 2) * Math.cos(k * Math.PI * x) * Math.exp(-0.01 * (k * Math.PI) ** 2 * t1);
      return s;
    };
    for (const x of [0.1, 0.4, 0.5, 0.6, 0.9]) expect(Math.abs(u(x, t1) - series(x))).toBeLessThan(2e-4);
  });

  it('a Robin end (convection): the first eigenmode decays at its own rate', () => {
    // u_x(0) = 0 and k u_x(L) = −h u(L) with Bi = hL/k = 1: u = cos(μx/L) e^(−αμ²t/L²), μ tan μ = 1,
    // μ₁ = 0.8603 (Incropera, Table 5.1); the condition is not solved for u_x, so it is iterated
    const mu = 0.8603335890193798;
    expect(mu * Math.tan(mu)).toBeCloseTo(1, 12);
    const d: [string, string][] = [['L', '2'], ['α', '0.5'], ['k', '3'], ['h', '1.5'], ['μ', String(mu)], ['T', 'L^2/(α μ^2)']];
    const eqs = ['u_t(x, t) = α*u_xx(x, t)', 'u(x, 0) = cos(μ*x/L)', 'u_x(0, t) = 0', 'k*u_x(L, t) + h*u(L, t) = 0'];
    const [u] = pde(d, eqs, 'u, x, [0, L], t, [0, T]');
    const T = 4 / (0.5 * mu * mu);
    for (const x of [0, 1, 2]) for (const t of [0.3 * T, T]) {
      const ex = Math.cos((mu * x) / 2) * Math.exp((-0.5 * mu * mu * t) / 4);
      expect(Math.abs(u(x, t) / ex - 1)).toBeLessThan(1e-4);
    }
  });

  it('a system: two coupled equations exchanging heat', () => {
    // u_t = αu_xx − κ(u − v), v_t = αv_xx + κ(u − v): u + v and u − v decay as single modes
    const d: [string, string][] = [['L', '1'], ['α', '0.1'], ['κ', '2'], ['T', '1']];
    const eqs = [
      'u_t(x, t) = α*u_xx(x, t) - κ*(u(x, t) - v(x, t))', 'v_t(x, t) = α*v_xx(x, t) + κ*(u(x, t) - v(x, t))',
      'u(x, 0) = sin(π*x/L)', 'v(x, 0) = 0', 'u(0, t) = 0', 'u(L, t) = 0', 'v(0, t) = 0', 'v(L, t) = 0',
    ];
    const [u, v] = pde(d, eqs, '[u; v], x, [0, L], t, [0, T]', ['u', 'v']);
    for (const x of [0.2, 0.5]) for (const t of [0.1, 1]) {
      const s = Math.exp(-0.1 * Math.PI ** 2 * t) * Math.sin(Math.PI * x), dd = s * Math.exp(-4 * t);
      expect(Math.abs(u(x, t) - (s + dd) / 2) / s).toBeLessThan(1e-4);
      expect(Math.abs(v(x, t) - (s - dd) / 2) / s).toBeLessThan(1e-4);
    }
  });
});

describe('Pdesolve: the wave equation', () => {
  it('a standing wave keeps its shape and period', () => {
    // u_tt = c²u_xx with fixed ends from rest: u = sin(πx/L) cos(πct/L), period 2L/c
    const d: [string, string][] = [['L', '1'], ['c', '2']];
    const eqs = ['u_tt(x, t) = c^2*u_xx(x, t)', 'u(x, 0) = sin(π*x/L)', 'u_t(x, 0) = 0', 'u(0, t) = 0', 'u(L, t) = 0'];
    const [u] = pde(d, eqs, 'u, x, [0, L], t, [0, 2*L/c]');
    for (const x of [0.25, 0.5, 0.9]) for (const t of [0.1, 0.25, 0.5, 0.8, 1]) {
      expect(Math.abs(u(x, t) - Math.sin(Math.PI * x) * Math.cos(2 * Math.PI * t))).toBeLessThan(1e-3);
    }
    // diff(…, t, 2) notation gives the same
    const [w] = pde(d, ['diff(u(x, t), t, 2) = c^2*diff(u(x, t), x, 2)', ...eqs.slice(1)], 'u, x, [0, L], t, [0, 1]');
    expect(Math.abs(w(0.5, 0.5) - u(0.5, 0.5))).toBeLessThan(1e-9);
  });
});

describe('Pdesolve in a worksheet', () => {
  it('works with units: a steel strip cooling to its end temperature', () => {
    const r = run([
      'L := 10 cm', 'α := 1.2e-5 m^2/s', 'T_0 := 293.15 K', 'ΔT := 50 K',
      block('u_t(x, t) = α*u_xx(x, t)\nu(x, 0 s) = T_0 + ΔT*sin(π*x/L)\nu(0 m, t) = T_0\nu(L, t) = T_0', 'u := Pdesolve(u, x, [0 m, L], t, [0 s, 2 min])'),
      'u(5 cm, 60 s) = K', 'u(0.05 m, 1 min) = K', 'u(0.05, 60 s) =',
    ]);
    const s = r[4] as SolveResult;
    expect(s.solver.error).toBeUndefined();
    // T_0 + ΔT e^(−απ²t/L²) at the middle
    const ex = 293.15 + 50 * Math.exp((-1.2e-5 * Math.PI ** 2 * 60) / 0.01);
    for (const i of [5, 6]) {
      const m = /= ([\d.]+)\\ \\mathrm\{K\}$/.exec((r[i] as MathResult).tex);
      expect(Number(m![1])).toBeCloseTo(ex, 2);
    }
    expect((r[7] as MathResult).error).toMatch(/needs units like m/);
  });

  it('says what is wrong', () => {
    const err = (constraints: string, solver = 'u := Pdesolve(u, x, [0, 1], t, [0, 1])') =>
      (run([block(constraints, solver)])[0] as SolveResult).solver.error;
    expect(err('u_t(x, t) = u_xx(x, t)\nu(x, 0) = 1\nu(0, t) = 0')).toMatch(/boundary condition at each end/);
    expect(err('u_t(x, t) = u_xx(x, t)\nu(0, t) = 0\nu(1, t) = 0')).toMatch(/Missing initial condition/);
    expect(err('u_t(x, t) = u_xt(x, t)\nu(x, 0) = 1')).toMatch(/mixed derivatives/);
    expect(err("u'(x, t) = u(x, t)\nu(x, 0) = 1")).toMatch(/subscripts/);
    expect(err('u_t(x, t) = u_xx(x, t)\nu(x, 0) = 1\nu(0.5, t) = 0\nu(1, t) = 0')).toMatch(/ends of the x range/);
    expect(err('u_t(x, t) = u_xx(x, t)\nu(x, 0.5) = 1\nu(0, t) = 0\nu(1, t) = 0')).toMatch(/start of the t range/);
    expect(err('u_t(x, t) = 2 m*u_x(x, t)\nu(x, 0) = 1 K\nu(0, t) = 1 K', 'u := Pdesolve(u, x, [0 m, 1 m], t, [0 s, 1 s])')).toMatch(/units/);
    const outside = run(['u := Pdesolve(u, x, [0, 1], t, [0, 1])'])[0] as MathResult;
    expect(outside.error).toMatch(/solver of a solve block/);
  });
});

describe('numol', () => {
  it('the heat equation as a matrix of nodal values', () => {
    const r = run([
      'pde(x, t, u, ux, uxx) := [0.1*uxx[0]]', 'pinit(x) := sin(π*x)', 'bc(t) := [0, 0, "D"]',
      'M := numol([0, 1], 51, [0, 1], 11, 1, 0, pde, pinit, bc)', 'rows(M) =', 'cols(M) =', 'M[25, 10] =', 'M[10, 4] =',
    ]);
    const n = (i: number) => Number(/= (-?[\d.]+)/.exec((r[i] as MathResult).tex)![1]);
    expect([n(4), n(5)]).toEqual([51, 11]);
    expect(n(6)).toBeCloseTo(Math.exp(-0.1 * Math.PI ** 2), 3);
    expect(n(7)).toBeCloseTo(Math.exp(-0.1 * Math.PI ** 2 * 0.4) * Math.sin(Math.PI * 0.2), 3);
  });
});
