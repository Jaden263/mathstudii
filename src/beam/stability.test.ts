import { describe, it, expect } from 'vitest';
import { geometricK, InstabilityError, memberAt, solveStructure, type NumMember, type NumStructure, type NumSupport } from './solve';
import { bucklingAnalysis } from './buckling';
import { cholesky, largestEigen, symmetricEigen } from './eigen';
import { POISSON, profileShearArea, rhsShearArea, rolledIShearArea, SHEAR_FACTOR, shearModulus, weldedShearArea } from './shear';

// HEB 200 in S235: E = 210 GPa, A = 78.1 cm², I_y = 5696 cm⁴, A_vz = 24.83 cm² (catalogue)
const E = 210e9, A = 78.1e-4, I = 5696e-8, EI = E * I;
const G = E / (2 * (1 + 0.3)), Av = 24.83e-4;
const sup = (id: string, node: string, type: NumSupport['type'], angle = 0, extra: Partial<NumSupport> = {}): NumSupport => ({ id, node, type, angle, label: id, ...extra });
const mem = (id: string, a: string, b: string, extra: Partial<NumMember> = {}): NumMember => ({ id, a, b, E, A, I, ...extra });
const near = (got: number, want: number, rel: number) => expect(Math.abs(got / want - 1)).toBeLessThan(rel);

/** Vertical column of height L from (0, 0), with the given supports at the foot and the head, pushed down by P at the head. */
function column(L: number, foot: NumSupport['type'], head: NumSupport | null, P = 1e3, extra: Partial<NumMember> = {}): NumStructure {
  return {
    nodes: [{ id: 'f', x: 0, y: 0 }, { id: 'h', x: 0, y: L }],
    members: [mem('c', 'f', 'h', extra)],
    supports: [sup('F', 'f', foot), ...(head ? [head] : [])],
    loads: [{ id: 'P', type: 'force', at: { node: 'h' }, Fx: 0, Fy: -P }],
  };
}

/** Smallest positive root of f between a and b (bisection). */
function root(f: (x: number) => number, a: number, b: number): number {
  let fa = f(a);
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2, fm = f(m);
    if (fa * fm <= 0) b = m;
    else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

describe('dense symmetric eigenvalues', () => {
  it('finds the eigenvalues of the second-difference matrix', () => {
    // tridiag(−1, 2, −1) of order n: λ_k = 2 − 2 cos(kπ/(n + 1))
    const n = 12;
    const T: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 2 : Math.abs(i - j) === 1 ? -1 : 0)));
    const { values, vectors } = symmetricEigen(T);
    values.forEach((v, k) => expect(v).toBeCloseTo(2 - 2 * Math.cos(((k + 1) * Math.PI) / (n + 1)), 12));
    // T v = λ v for every pair
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const Tv = T[i].reduce((s, t, j) => s + t * vectors[j][k], 0);
        expect(Tv).toBeCloseTo(values[k] * vectors[i][k], 12);
      }
    }
  });

  it('Lanczos finds the largest positive eigenvalues of a known spectrum', () => {
    // A = H diag(λ) H with the reflection H = I − 2 v vᵀ: eigenvalues exactly λ, here
    // positive and negative ones (tension members give negative ones in buckling)
    const n = 300;
    const lam = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? -1 : 1) * (1 + i) / n);
    const v0 = Array.from({ length: n }, (_, i) => Math.cos(0.37 * i + 1));
    const nv = Math.hypot(...v0), v = v0.map((x) => x / nv);
    const apply = (x: number[]) => {
      // H diag(λ) H x
      const hx = (y: number[]) => { const c = 2 * y.reduce((s, yi, i) => s + yi * v[i], 0); return y.map((yi, i) => yi - c * v[i]); };
      return hx(hx(x).map((xi, i) => lam[i] * xi));
    };
    const { values, vectors } = largestEigen(apply, n, 3);
    const want = lam.filter((l) => l > 0).sort((a, b) => b - a).slice(0, 3);
    values.forEach((x, i) => expect(x).toBeCloseTo(want[i], 9));
    // and they are eigenvectors
    const Ay = apply(vectors[0]);
    Ay.forEach((y, i) => expect(y).toBeCloseTo(values[0] * vectors[0][i], 8));
  });

  it('Cholesky refuses an indefinite matrix', () => {
    expect(cholesky([[4, 2], [2, 3]])).not.toBeNull();
    expect(cholesky([[1, 2], [2, 1]])).toBeNull();
  });
});

describe('Euler columns: P_cr = π² EI / (β L)²', () => {
  const L = 4;
  const Pcr = (beta: number) => (Math.PI ** 2 * EI) / (beta * L) ** 2;
  // a roller turned 90° holds the head sideways only
  const sideways = sup('H', 'h', 'roller', 90);

  it('pinned–pinned (β = 1), with the second mode at 4 P_cr', () => {
    const st = column(L, 'pin', sideways);
    const b = bucklingAnalysis(st, solveStructure(st));
    near(b.modes[0].alpha * 1e3, Pcr(1), 0.005);
    near(b.modes[1].alpha / b.modes[0].alpha, 4, 0.005);
    // the mode is a half sine wave, normalised to 1 at mid-height
    const m = b.modes[0].members[0];
    m.s.forEach((s, i) => expect(Math.abs(m.dx[i])).toBeCloseTo(Math.sin((Math.PI * s) / L), 2));
    // L_cr = L
    near(b.Lcr.c, L, 0.005);
  });

  it('cantilever (β = 2), fixed–pinned (β = 0.699) and fixed–fixed (β = 0.5)', () => {
    const cant = column(L, 'fixed', null);
    const bc = bucklingAnalysis(cant, solveStructure(cant));
    near(bc.modes[0].alpha * 1e3, Pcr(2), 0.005);
    near(bc.Lcr.c, 2 * L, 0.005);
    // fixed–pinned: tan(kL) = kL, kL = 4.4934, β = π / 4.4934 = 0.6992
    const kL = root((x) => Math.tan(x) - x, 4.0, 4.6);
    const fp = column(L, 'fixed', sideways);
    near(bucklingAnalysis(fp, solveStructure(fp)).modes[0].alpha * 1e3, Pcr(Math.PI / kL), 0.005);
    expect(Math.PI / kL).toBeCloseTo(0.699, 3);
    // fixed–fixed: the head is clamped but slides vertically (a fixed support on a soft
    // axial spring), so α_cr |N| is the critical load
    const ff = column(L, 'fixed', sup('H', 'h', 'fixed', 0, { k: 1e3 }));
    const sol = solveStructure(ff);
    const N = sol.members[0].N[0];
    near(bucklingAnalysis(ff, sol).modes[0].alpha * -N, Pcr(0.5), 0.005);
  });

  it('with shear deformation: Engesser, P_cr = P_E / (1 + P_E / (G A_v))', () => {
    // a short, deep column where shear matters (HEB 200, 1.5 m pinned–pinned)
    const Ls = 1.5, PE = (Math.PI ** 2 * EI) / Ls ** 2;
    const st = column(Ls, 'pin', sup('H', 'h', 'roller', 90), 1e3, { G, Av });
    const a = bucklingAnalysis(st, solveStructure(st)).modes[0].alpha;
    near(a * 1e3, PE / (1 + PE / (G * Av)), 0.005);
    expect(a * 1e3).toBeLessThan(PE * 0.97);
  });

  it('springs and hinges: a cantilever on a rotational spring, and hinged member ends at fixed supports', () => {
    // free head, foot on a rotational spring k_r: kL tan(kL) = k_r L / EI (here 2)
    const kr = (2 * EI) / L;
    const kL = root((x) => x * Math.tan(x) - 2, 0.1, Math.PI / 2 - 1e-9);
    const st: NumStructure = { ...column(L, 'fixed', null), supports: [sup('F', 'f', 'fixed', 0, { kr })] };
    near(bucklingAnalysis(st, solveStructure(st)).modes[0].alpha * 1e3, (kL * kL * EI) / (L * L), 0.005);
    // clamped at both ends by the supports, but the member is hinged at both: β = 1
    const h = column(L, 'fixed', sup('H', 'h', 'fixed', 0, { k: 1e3 }), 1e3, { hingeA: true, hingeB: true });
    const sol = solveStructure(h);
    near(bucklingAnalysis(h, sol).modes[0].alpha * -sol.members[0].N[0], Pcr(1), 0.005);
  });

  it('a big model (Lanczos path): a pinned column drawn as 30 members', () => {
    const n = 30;
    const st: NumStructure = {
      nodes: Array.from({ length: n + 1 }, (_, i) => ({ id: `n${i}`, x: 0, y: (L * i) / n })),
      members: Array.from({ length: n }, (_, i) => mem(`m${i}`, `n${i}`, `n${i + 1}`)),
      supports: [sup('F', 'n0', 'pin'), sup('H', `n${n}`, 'roller', 90)],
      loads: [{ id: 'P', type: 'force', at: { node: `n${n}` }, Fx: 0, Fy: -1e3 }],
    };
    const b = bucklingAnalysis(st, solveStructure(st));
    near(b.modes[0].alpha * 1e3, Pcr(1), 0.005);
    near(b.modes[1].alpha / b.modes[0].alpha, 4, 0.005);
    near(b.modes[2].alpha / b.modes[0].alpha, 9, 0.005);
  });

  it('a column under its own weight (Greenhill): (q L)_cr = 7.837 EI / L²', () => {
    // Timoshenko & Gere, Theory of Elastic Stability, 2.10: a cantilever under a uniform
    // axial load q has (q L)_cr = 7.837 EI/L². N varies along every element, so this needs
    // the geometric stiffness of a linearly varying force (a mean value per element: 0.6 % low)
    const Lg = 10, q = 1e3;
    const st: NumStructure = { ...column(Lg, 'fixed', null), loads: [{ id: 'q', type: 'line', member: 'c', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }] };
    const b = bucklingAnalysis(st, solveStructure(st));
    near(b.modes[0].alpha * q * Lg, (7.837 * EI) / Lg ** 2, 0.001);
    // in second order the sway grows like 1/(1 − 1/α) towards it, and stops at it
    const at = (f: number): NumStructure => ({ ...st, loads: [{ id: 'q', type: 'line', member: 'c', t1: 0, t2: 1, q1: f * q * b.modes[0].alpha, q2: f * q * b.modes[0].alpha, dir: 'global' }, { id: 'H', type: 'force', at: { node: 'h' }, Fx: 100, Fy: 0 }] });
    const amp = solveStructure(at(0.9), { secondOrder: true }).nodes.h.dx / solveStructure(at(0.9)).nodes.h.dx;
    near(amp, 1 / (1 - 0.9), 0.03);
    expect(() => solveStructure(at(1.01), { secondOrder: true })).toThrow(InstabilityError);
  });

  it('the geometric stiffness of a linearly varying force agrees with the constant one', () => {
    // ∫ N ψ′ψ′ dx is linear in N: K(N_a, N_b) + K(N_b, N_a) = 2 K((N_a + N_b)/2), and K(N, N) is the closed form
    const Lg = 1.7, phi = 0.2;
    const sum = geometricK(-3, Lg, phi, 5).map((row, i) => row.map((v, j) => v + geometricK(5, Lg, phi, -3)[i][j]));
    const twice = geometricK(1, Lg, phi).map((row) => row.map((v) => 2 * v));
    sum.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(twice[i][j], 12)));
    // (the quadrature path, a hair away from constant, against the closed form)
    const quad = geometricK(2, Lg, phi, 2 * (1 + 1e-12)), closed = geometricK(2, Lg, phi);
    quad.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(closed[i][j], 9)));
  });

  it('a column in tension does not buckle', () => {
    const st = column(L, 'fixed', null, -1e3);
    expect(bucklingAnalysis(st, solveStructure(st)).modes).toEqual([]);
  });
});

describe('portal frames: sway buckling', () => {
  // columns h, beam L, same section; vertical load P on each column head. With pinned
  // feet, kh tan(kh) = 6 I_b h / (I_c L); with fixed feet, kh / tan(kh) = −6 I_b h / (I_c L)
  // (Timoshenko & Gere, Theory of Elastic Stability, 2.11), k² = P / EI_c
  const h = 4, Lb = 6, P = 1e3;
  const portal = (feet: NumSupport['type']): NumStructure => ({
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: h }, { id: 'c', x: Lb, y: h }, { id: 'd', x: Lb, y: 0 }],
    members: [mem('ab', 'a', 'b'), mem('bc', 'b', 'c'), mem('dc', 'd', 'c')],
    supports: [sup('A', 'a', feet), sup('D', 'd', feet)],
    loads: [{ id: 'P1', type: 'force', at: { node: 'b' }, Fx: 0, Fy: -P }, { id: 'P2', type: 'force', at: { node: 'c' }, Fx: 0, Fy: -P }],
  });

  it('pinned feet', () => {
    const r = (6 * h) / Lb;
    const kh = root((x) => x * Math.tan(x) - r, 0.01, Math.PI / 2 - 1e-9);
    const st = portal('pin');
    const b = bucklingAnalysis(st, solveStructure(st));
    near(b.modes[0].alpha * P, (kh * kh * EI) / (h * h), 0.005);
    // the mode is sway: both column heads move the same way
    const top = (id: string) => b.modes[0].members.find((m) => m.id === id)!.dx.at(-1)!;
    expect(Math.sign(top('ab'))).toBe(Math.sign(top('dc')));
    // L_cr of the columns = π / k
    near(b.Lcr.ab, (Math.PI * h) / kh, 0.005);
  });

  it('fixed feet', () => {
    const r = (6 * h) / Lb;
    const kh = root((x) => x / Math.tan(x) + r, Math.PI / 2 + 1e-9, Math.PI - 1e-9);
    const st = portal('fixed');
    near(bucklingAnalysis(st, solveStructure(st)).modes[0].alpha * P, (kh * kh * EI) / (h * h), 0.005);
  });
});

describe('Timoshenko members', () => {
  const cantilever = (L: number, loads: NumStructure['loads'], supports: NumSupport[] = [sup('A', 'a', 'fixed')]): NumStructure => ({
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
    members: [mem('m', 'a', 'b', { G, Av })],
    supports, loads,
  });

  it('cantilever tip deflection: P L³ / (3 EI) + P L / (G A_v)', () => {
    const P = 100e3, L = 1;
    const sol = solveStructure(cantilever(L, [{ id: 'P', type: 'force', at: { node: 'b' }, Fx: 0, Fy: -P }]));
    expect(-sol.nodes.b.dy).toBeCloseTo((P * L ** 3) / (3 * EI) + (P * L) / (G * Av), 12);
    // the bending part alone would be 18 % less
    expect((P * L) / (G * Av) / ((P * L ** 3) / (3 * EI))).toBeGreaterThan(0.15);
    // the deflection line ends there too, and the moment is unchanged: M = −P L at the root
    expect(-sol.members[0].dy.at(-1)!).toBeCloseTo(-sol.nodes.b.dy, 12);
    expect(sol.reactions[0].M).toBeCloseTo(P * L, 6);
  });

  it('simple beam under a uniform load: 5 q L⁴ / (384 EI) + q L² / (8 G A_v)', () => {
    const q = 50e3, L = 2;
    const sol = solveStructure({
      ...cantilever(L, [{ id: 'q', type: 'line', member: 'm', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }], [sup('A', 'a', 'pin'), sup('B', 'b', 'roller')]),
    });
    expect(sol.max.w!.value).toBeCloseTo((5 * q * L ** 4) / (384 * EI) + (q * L * L) / (8 * G * Av), 12);
    expect(sol.max.M!.value).toBeCloseTo((q * L * L) / 8, 6);
  });

  it('propped cantilever: shear changes the indeterminate reaction (uniform and triangular load)', () => {
    // R_B = δ_q / f with the cantilever's tip deflection δ_q and flexibility f = L³/3EI + L/GA_v.
    // Uniform q: δ_q = q L⁴/8EI + q L²/2GA_v. Triangular 0 → q (rising to the tip): δ_q = 11 q L⁴/120EI + q L²/3GA_v
    const q = 40e3, L = 1.5;
    const f = L ** 3 / (3 * EI) + L / (G * Av);
    const props = [sup('A', 'a', 'fixed'), sup('B', 'b', 'roller')];
    const u = solveStructure(cantilever(L, [{ id: 'q', type: 'line', member: 'm', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }], props));
    expect(u.reactions[1].Ry).toBeCloseTo(((q * L ** 4) / (8 * EI) + (q * L * L) / (2 * G * Av)) / f, 5);
    const t = solveStructure(cantilever(L, [{ id: 'q', type: 'line', member: 'm', t1: 0, t2: 1, q1: 0, q2: q, dir: 'global' }], props));
    expect(t.reactions[1].Ry).toBeCloseTo(((11 * q * L ** 4) / (120 * EI) + (q * L * L) / (3 * G * Av)) / f, 5);
    // shear flexibility moves R_B from 3qL/8 (bending only) towards qL/2 (shear only)
    expect(u.reactions[1].Ry).toBeGreaterThan((3 * q * L) / 8);
    expect(u.reactions[1].Ry).toBeLessThan((q * L) / 2);
  });
});

describe('second order', () => {
  it('cantilever column with a lateral tip load: δ = H (tan kL − kL) / (P k), M₀ = H tan(kL) / k', () => {
    // k = √(P/EI); here P = 0.5 P_cr
    const L = 4, H = 10e3, P = 0.5 * (Math.PI ** 2 * EI) / (2 * L) ** 2, k = Math.sqrt(P / EI);
    const st: NumStructure = {
      ...column(L, 'fixed', null, P),
      loads: [{ id: 'P', type: 'force', at: { node: 'h' }, Fx: H, Fy: -P }],
    };
    const first = solveStructure(st);
    const sol = solveStructure(st, { secondOrder: true });
    const delta = (H * (Math.tan(k * L) - k * L)) / (P * k);
    near(sol.nodes.h.dx, delta, 0.005);
    // the foot's reaction moment is counter-clockwise: H L + P δ
    near(sol.reactions[0].M, (H * Math.tan(k * L)) / k, 0.005);
    // amplified against first order (H L³ / 3EI)
    expect(first.nodes.h.dx).toBeCloseTo((H * L ** 3) / (3 * EI), 9);
    expect(sol.nodes.h.dx / first.nodes.h.dx).toBeGreaterThan(1.8);
    expect(sol.secondOrder!.iterations).toBeGreaterThan(1);
    // the moment line is continuous and reaches P δ + H L at the foot
    near(Math.abs(sol.max.M!.value), H * L + P * delta, 0.005);
  });

  it('beam-column under a uniform load: exact amplification, and ≈ 1 / (1 − P/P_cr)', () => {
    // simple beam, q down, axial compression P: with u = kL/2,
    // w_mid = 5qL⁴/384EI · 12(2 sec u − 2 − u²)/(5u⁴),  M_mid = qL²/8 · 2(sec u − 1)/u²
    const L = 6, q = 10e3, Pcr = (Math.PI ** 2 * EI) / L ** 2, P = 0.4 * Pcr;
    const u = (Math.sqrt(P / EI) * L) / 2, sec = 1 / Math.cos(u);
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
      members: [mem('m', 'a', 'b')],
      supports: [sup('A', 'a', 'pin'), sup('B', 'b', 'roller')],
      loads: [{ id: 'q', type: 'line', member: 'm', t1: 0, t2: 1, q1: q, q2: q, dir: 'global' }, { id: 'P', type: 'force', at: { node: 'b' }, Fx: -P, Fy: 0 }],
    };
    const sol = solveStructure(st, { secondOrder: true });
    const w0 = (5 * q * L ** 4) / (384 * EI), M0 = (q * L * L) / 8;
    // the deflection across the beam at midspan (max.w also has the axial shortening in it)
    const w = -memberAt(sol.members[0], L / 2).dy;
    near(w, (w0 * 12 * (2 * sec - 2 - u * u)) / (5 * u ** 4), 0.005);
    near(sol.max.M!.value, (M0 * 2 * (sec - 1)) / (u * u), 0.005);
    // the textbook amplification 1/(1 − P/P_cr) is within 1.5 % here (exact: (1 + 0.03 P/P_cr)/(1 − P/P_cr) roughly)
    near(w / w0, 1 / (1 - P / Pcr), 0.015);
    expect(sol.max.M!.s).toBeCloseTo(L / 2, 2);
  });

  it('a shear-flexible cantilever column (Engesser): δ = H tan(kL) / (P k (1 − P/GA_v)) − H L / P', () => {
    // EI w″ (1 − P/GA_v) = M with the shear strain from dM/dx (the force across the
    // deformed axis), so k² = P / (EI (1 − P/GA_v)); the foot turns by H/(GA_v − P).
    // Shear-soft (G/20) so that it matters: P/GA_v = 0.22 at 0.7 P_cr
    const L = 3, H = 1e3, Gs = G / 20, GA = Gs * Av;
    const PE = (Math.PI ** 2 * EI) / (2 * L) ** 2, P = (0.7 * PE) / (1 + PE / GA);
    const st: NumStructure = { ...column(L, 'fixed', null, P, { G: Gs, Av, A: 1 }), loads: [{ id: 'P', type: 'force', at: { node: 'h' }, Fx: H, Fy: -P }] };
    const sol = solveStructure(st, { secondOrder: true });
    const k = Math.sqrt(P / (EI * (1 - P / GA)));
    const delta = (H * Math.tan(k * L)) / (P * k * (1 - P / GA)) - (H * L) / P;
    near(sol.nodes.h.dx, delta, 0.005);
    near(sol.reactions[0].M, H * L + P * delta, 0.005);
    // without the shear flexibility it would be a quarter less
    expect(delta / ((H * (Math.tan(Math.sqrt(P / EI) * L) - Math.sqrt(P / EI) * L)) / (P * Math.sqrt(P / EI)))).toBeGreaterThan(1.25);
  });

  it('moment and shear along a beam-column under a central point load', () => {
    // simple beam, Q at midspan, axial compression P (k² = P/EI): for x ≤ L/2
    // M(x) = Q sin(kx) / (2k cos(kL/2)), and the shear across the deformed axis V = dM/dx = Q cos(kx) / (2 cos(kL/2))
    const L = 6, Q = 10e3, P = 0.7 * (Math.PI ** 2 * EI) / L ** 2, k = Math.sqrt(P / EI);
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
      members: [mem('m', 'a', 'b')],
      supports: [sup('A', 'a', 'pin'), sup('B', 'b', 'roller')],
      loads: [{ id: 'Q', type: 'force', at: { member: 'm', t: 0.5 }, Fx: 0, Fy: -Q }, { id: 'P', type: 'force', at: { node: 'b' }, Fx: -P, Fy: 0 }],
    };
    const r = solveStructure(st, { secondOrder: true }).members[0];
    const c = Math.cos((k * L) / 2);
    // on both sides of every element boundary (the shear used to jump there by several per cent)
    for (const p of r.pieces.filter((q) => q.s0 < L / 2 - 1e-9)) {
      for (const x of [p.s0 + 1e-9, p.s0 + p.L / 2, p.s0 + p.L - 1e-9]) {
        const v = memberAt(r, x);
        expect(Math.abs(v.M - (Q * Math.sin(k * x)) / (2 * k * c)) / ((Q * L) / 4)).toBeLessThan(1e-3);
        expect(Math.abs(v.V - (Q * Math.cos(k * x)) / (2 * c)) / (Q / 2)).toBeLessThan(1e-3);
      }
    }
  });

  it('above the critical load there is no equilibrium', () => {
    const L = 4, Pcr = (Math.PI ** 2 * EI) / (2 * L) ** 2;
    const st = (P: number): NumStructure => ({ ...column(L, 'fixed', null, P), loads: [{ id: 'P', type: 'force', at: { node: 'h' }, Fx: 1e3, Fy: -P }] });
    expect(() => solveStructure(st(1.2 * Pcr), { secondOrder: true })).toThrow(InstabilityError);
    expect(() => solveStructure(st(0.9 * Pcr), { secondOrder: true })).not.toThrow();
  });

  it('a hinged truss under second order matches first order when nothing bends', () => {
    // triangle truss, apex load: members only carry axial force, no transverse load on them
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 2, y: 3 }],
      members: [mem('ab', 'a', 'b', { hingeA: true, hingeB: true }), mem('ac', 'a', 'c', { hingeA: true, hingeB: true }), mem('bc', 'b', 'c', { hingeA: true, hingeB: true })],
      supports: [sup('A', 'a', 'pin'), sup('B', 'b', 'roller')],
      loads: [{ id: 'P', type: 'force', at: { node: 'c' }, Fx: 0, Fy: -10e3 }],
    };
    // (the joints move a little, so the bar forces change in the sixth digit)
    const s1 = solveStructure(st), s2 = solveStructure(st, { secondOrder: true });
    near(s2.members[1].N[0], s1.members[1].N[0], 1e-4);
    expect(Math.max(...s2.members[1].M.map(Math.abs))).toBeLessThan(1e-3);
    expect(s2.reactions[0].Ry).toBeCloseTo(s1.reactions[0].Ry, 6);
  });
});

describe('shear areas and moduli', () => {
  it('follows EN 1993-1-1 6.2.6(3) and the material', () => {
    // IPE 300 catalogue A_vz = 25.68 cm²; HEB 200: 24.83 cm² (ArcelorMittal)
    expect(profileShearArea('IPE 300')! * 1e4).toBeCloseTo(25.68, 1);
    expect(profileShearArea('HEB 200')! * 1e4).toBeCloseTo(24.83, 1);
    expect(profileShearArea('custom')).toBeNull();
    // flanges 100×2, web 96×10 (mm), no fillets: A − 2 b t_f + t_w t_f = 980 mm²; with η = 1.2 the floor η h_w t_w = 1152 mm² governs
    const Ai = (2 * 100 * 2 + 96 * 10) * 1e-6;
    expect(rolledIShearArea(Ai, 0.1, 0.002, 0.01, 0, 0.096) * 1e6).toBeCloseTo(980, 9);
    expect(rolledIShearArea(Ai, 0.1, 0.002, 0.01, 0, 0.096, 1.2) * 1e6).toBeCloseTo(1152, 9);
    expect(weldedShearArea(0.5, 0.01)).toBeCloseTo(0.005, 12);
    expect(rhsShearArea(30e-4, 0.2, 0.1)).toBeCloseTo((30e-4 * 2) / 3, 12);
    // CHS 2A/π, rectangle 5/6 A, solid circle 0.9 A
    expect(profileShearArea('CHS 168.3x5')! / (Math.PI / 4 * (0.1683 ** 2 - 0.1583 ** 2))).toBeCloseTo(2 / Math.PI, 9);
    expect(SHEAR_FACTOR.rect).toBeCloseTo(5 / 6, 12);
    expect(SHEAR_FACTOR.circle).toBe(0.9);
    // G = E / 2(1 + ν): steel 80.8 GPa, concrete (ν = 0.2) E/2.4; timber C24 G_mean = 0.69 GPa (EN 338)
    expect(shearModulus(210e9) / 1e9).toBeCloseTo(80.77, 2);
    expect(shearModulus(33e9, 'concrete')).toBeCloseTo(33e9 / (2 * (1 + POISSON.concrete)), 3);
    expect(shearModulus(11e9, 'timber', 'C24')).toBeCloseTo(0.69e9, 3);
    expect(shearModulus(11e9, 'timber')).toBeCloseTo(11e9 / 16, 3);
  });
});
