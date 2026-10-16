import { describe, it, expect } from 'vitest';
import { meshPlate, nearestNode, type PlateMesh } from './mesh';
import { lineReactions, solvePlate, type NumPlateLoad, type NumPlateSupport, type PlateFields, type PlateSolution } from './solve';
import { mitc4Stiffness, rigidity } from './mitc4';
import type { Pt } from './cdt';

// Timoshenko & Woinowsky-Krieger, Theory of Plates and Shells (1959), ν = 0.3, D = E t³ / 12(1 − ν²).
// The plates are thin (t = a/100) so that shear deformation (≈ (t/a)² of the bending) stays below 0.1 %.
const E = 30e9, nu = 0.3;
const Dof = (t: number, n = nu) => (E * t ** 3) / (12 * (1 - n * n));

type Fix = 'simple' | 'clamped' | 'free';

function plate(outline: Pt[], fix: Fix[] | Fix, loads: NumPlateLoad[], o: { size: number; t?: number; nu?: number; unstructured?: boolean; openings?: Pt[][]; extra?: NumPlateSupport[]; lines?: [Pt, Pt][]; points?: Pt[] }) {
  const mesh = meshPlate({
    outline, openings: o.openings ?? [], lines: o.lines ?? [], points: o.points ?? [], size: o.size, unstructured: o.unstructured,
    softLines: loads.flatMap((l) => (l.type === 'line' ? [[l.a, l.b] as [Pt, Pt]] : [])), softPoints: loads.flatMap((l) => (l.type === 'point' ? [l.at] : [])),
  });
  const supports: NumPlateSupport[] = [];
  outline.forEach((p, i) => {
    const f = Array.isArray(fix) ? fix[i] : fix;
    if (f !== 'free') supports.push({ id: `e${i}`, kind: 'line', a: p, b: outline[(i + 1) % outline.length], fix: f });
  });
  supports.push(...(o.extra ?? []));
  const t = o.t ?? 0.01;
  const sol = solvePlate({ mesh, E, nu: o.nu ?? nu, t, supports, loads, cases: ['A'], jumps: o.lines });
  return { mesh, sol, f: sol.cases[0], D: Dof(t, o.nu ?? nu) };
}

const square = (a: number, b = a): Pt[] => [[0, 0], [a, 0], [a, b], [0, b]];
const uniform = (q: number): NumPlateLoad => ({ id: 'q', case: 'A', type: 'area', q });

/** A corner field's value at the node nearest p (on the side of the first element there). */
function at(mesh: PlateMesh, field: Float64Array, p: Pt): number {
  const n = nearestNode(mesh, p).node;
  for (let c = 0; c < mesh.quads.length; c++) if (mesh.quads[c] === n) return field[c];
  return NaN;
}
const wAt = (mesh: PlateMesh, f: PlateFields, p: Pt) => f.w[nearestNode(mesh, p).node];

/** Reaction per length (Kirchhoff's V) at the node of a line support nearest p. */
function edgeReaction(sol: PlateSolution, f: PlateFields, support: number, p: Pt): number {
  const n = nearestNode(sol.mesh, p).node;
  return lineReactions(sol, f, support).r[sol.supports[support].nodes.indexOf(n)];
}

/** |value / ref − 1| ≤ rel. */
function near(value: number, ref: number, rel: number) {
  expect(Math.abs(value / ref - 1), `${value} vs ${ref}`).toBeLessThanOrEqual(rel);
}

/** Navier's double series for a simply supported a × b plate, loads as Fourier coefficients p_mn (odd terms only when symmetric). */
function navier(a: number, b: number, D: number, pmn: (m: number, n: number) => number, x: number, y: number, terms = 301) {
  let w = 0, mx = 0;
  for (let m = 1; m <= terms; m++) for (let n = 1; n <= terms; n++) {
    const p = pmn(m, n);
    if (!p) continue;
    const am = (m * Math.PI) / a, bn = (n * Math.PI) / b;
    const wmn = p / (D * (am * am + bn * bn) ** 2);
    const s = Math.sin(am * x) * Math.sin(bn * y);
    w += wmn * s;
    mx += D * wmn * (am * am + nu * bn * bn) * s;
  }
  return { w, mx };
}

describe('MITC4 element', () => {
  const xy = [0, 0, 1.2, 0.1, 1.0, 0.9, -0.1, 0.8];
  const K = mitc4Stiffness(xy, rigidity(E, nu, 0.05));
  const mul = (u: number[]) => Array.from({ length: 12 }, (_, r) => u.reduce((s, v, c) => s + K[12 * r + c] * v, 0));
  it('has the three rigid-body modes of a plate and no others', () => {
    // w = 1; w = x with βx = −1; w = y with βy = −1 (no curvature, no shear strain)
    const modes = [
      [0, 1, 2, 3].flatMap(() => [1, 0, 0]),
      [0, 1, 2, 3].flatMap((k) => [xy[2 * k], -1, 0]),
      [0, 1, 2, 3].flatMap((k) => [xy[2 * k + 1], 0, -1]),
    ];
    const big = Math.max(...Array.from(K, Math.abs));
    for (const u of modes) for (const f of mul(u)) expect(Math.abs(f)).toBeLessThan(1e-10 * big);
    // a twist β = (y, x) bends it: energy > 0
    const tw = [0, 1, 2, 3].flatMap((k) => [0, xy[2 * k + 1], xy[2 * k]]);
    expect(mul(tw).reduce((s, f, i) => s + f * tw[i], 0)).toBeGreaterThan(0);
  });

  it('is symmetric', () => {
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) expect(K[12 * i + j]).toBeCloseTo(K[12 * j + i], 3);
  });
});

describe('plates against Timoshenko & Woinowsky-Krieger', () => {
  const a = 1, q = 1000, P = 1000;

  it('simply supported square, uniform load (Table 8, b/a = 1)', () => {
    const { mesh, sol, f, D } = plate(square(a), 'simple', [uniform(q)], { size: a / 32 });
    // w_max = 0.00406 q a⁴ / D, m_x = m_y = 0.0479 q a² at the centre
    expect(wAt(mesh, f, [a / 2, a / 2]) / ((q * a ** 4) / D)).toBeCloseTo(0.00406, 5);
    expect(at(mesh, f.mx, [a / 2, a / 2]) / (q * a * a)).toBeCloseTo(0.0479, 3);
    expect(at(mesh, f.my, [a / 2, a / 2]) / (q * a * a)).toBeCloseTo(0.0479, 3);
    // the shear at the middle of an edge Q_x = 0.338 q a, the edge reaction V_x = Q_x + ∂M_xy/∂y = 0.420 q a
    expect(at(mesh, f.vx, [0, a / 2]) / (q * a)).toBeCloseTo(0.338, 2);
    expect(edgeReaction(sol, f, 3, [0, a / 2]) / (q * a)).toBeCloseTo(0.420, 2);
    // the corners are held down by R = 2 M_xy = 0.065 q a², with |M_xy| = 0.0325 q a² there
    expect(f.R[nearestNode(mesh, [0, 0]).node] / (q * a * a)).toBeCloseTo(-0.065, 2);
    expect(Math.abs(at(mesh, f.mxy, [0, 0])) / (q * a * a)).toBeCloseTo(0.0325, 3);
    // equilibrium: the four edges carry q a²
    expect(f.support.reduce((s, r) => s + r, 0)).toBeCloseTo(q * a * a, 6);
    expect(f.load).toBeCloseTo(q * a * a, 9);
  });

  it('clamped square, uniform load (Table 35)', () => {
    const { mesh, f, D } = plate(square(a), 'clamped', [uniform(q)], { size: a / 32 });
    // w_max = 0.00126 q a⁴ / D, M at the centre 0.0231 q a², at the middle of an edge −0.0513 q a²
    // (the table's three digits; the series give 0.0012653, 0.02291 and −0.05133)
    near(wAt(mesh, f, [a / 2, a / 2]) / ((q * a ** 4) / D), 0.00126, 0.01);
    near(at(mesh, f.mx, [a / 2, a / 2]) / (q * a * a), 0.0231, 0.01);
    near(at(mesh, f.mx, [0, a / 2]) / (q * a * a), -0.0513, 0.01);
    near(at(mesh, f.my, [a / 2, 0]) / (q * a * a), -0.0513, 0.01);
  });

  it('simply supported square, central point load (Table 23)', () => {
    const { mesh, f, D } = plate(square(a), 'simple', [{ id: 'P', case: 'A', type: 'point', F: P, at: [a / 2, a / 2] }], { size: a / 32 });
    // w = 0.01160 P a² / D
    expect(wAt(mesh, f, [a / 2, a / 2]) / ((P * a * a) / D)).toBeCloseTo(0.0116, 4);
  });

  it('simply supported rectangle b/a = 2, uniform load (Table 8)', () => {
    const { mesh, f, D } = plate(square(a, 2 * a), 'simple', [uniform(q)], { size: a / 24 });
    // w = 0.01013 q a⁴ / D, M_x = 0.1017 q a², M_y = 0.0464 q a²
    expect(wAt(mesh, f, [a / 2, a]) / ((q * a ** 4) / D)).toBeCloseTo(0.01013, 4);
    expect(at(mesh, f.mx, [a / 2, a]) / (q * a * a)).toBeCloseTo(0.1017, 3);
    expect(at(mesh, f.my, [a / 2, a]) / (q * a * a)).toBeCloseTo(0.0464, 3);
  });

  const circle = (r: number, n = 96): Pt[] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);

  it('simply supported circular plate, uniform load', () => {
    const r = 1;
    const { mesh, f, D } = plate(circle(r), 'simple', [uniform(q)], { size: r / 16 });
    expect(mesh.structured).toBe(false);
    // w_c = (5 + ν) q a⁴ / 64 (1 + ν) D, M_c = (3 + ν) q a² / 16
    expect(wAt(mesh, f, [0, 0]) / (((5 + nu) * q * r ** 4) / (64 * (1 + nu) * D))).toBeCloseTo(1, 2);
    expect(at(mesh, f.mx, [0, 0]) / (((3 + nu) * q * r * r) / 16)).toBeCloseTo(1, 2);
  });

  it('clamped circular plate, uniform load', () => {
    const r = 1;
    const { mesh, f, D } = plate(circle(r), 'clamped', [uniform(q)], { size: r / 16 });
    // w_c = q a⁴ / 64 D, M_r at the edge = −q a² / 8
    expect(wAt(mesh, f, [0, 0]) / ((q * r ** 4) / (64 * D))).toBeCloseTo(1, 2);
    expect(at(mesh, f.mx, [r, 0]) / (-(q * r * r) / 8)).toBeCloseTo(1, 1);
  });

  it('a thick simply supported square (t/a = 0.1, 0.2) adds the shear deflection exactly', () => {
    // hard simply supported polygonal Reissner–Mindlin plates (Wang, Reddy & Lee, Shear
    // Deformable Beams and Plates, 2000, ch. 10): w = w_K + M_K / (κ G t), M_K = (m_x + m_y)/(1 + ν)
    // of the Kirchhoff plate: at the centre w_K = 0.00406235 q a⁴/D and m_x = m_y = 0.047886 q a²
    for (const ta of [0.1, 0.2]) {
      const t = ta * a;
      const { mesh, f, D } = plate(square(a), 'simple', [uniform(q)], { size: a / 32, t });
      const S = ((5 / 6) * E * t) / (2 * (1 + nu));
      const ref = (0.00406235 * q * a ** 4) / D + (2 * 0.047886 * q * a * a) / (1 + nu) / S;
      near(wAt(mesh, f, [a / 2, a / 2]), ref, 1e-3);
    }
  });

  it('an interior panel of a flat slab on point columns (§ 100, ν = 0.2)', () => {
    // a square panel of an endless slab on columns: by symmetry its edges do not turn
    // (β_n = 0: rotational springs, no vertical ones) and columns hold its corners;
    // w = 0.00581 q a⁴ / D at the centre, where M_x = M_y = 0.0331 q a²; each column a quarter
    const sq = square(a);
    const D2 = Dof(0.01, 0.2);
    const springs: NumPlateSupport[] = sq.map((p, i) => ({ id: `s${i}`, kind: 'line', a: p, b: sq[(i + 1) % 4], fix: 'spring', k: 0, kr: (1e6 * D2) / a }));
    const columns: NumPlateSupport[] = sq.map((p, i) => ({ id: `c${i}`, kind: 'point', at: p }));
    const { mesh, f, D } = plate(sq, 'free', [uniform(q)], { size: a / 48, nu: 0.2, points: sq, extra: [...springs, ...columns] });
    near(wAt(mesh, f, [a / 2, a / 2]) / ((q * a ** 4) / D), 0.00581, 0.003);
    near(at(mesh, f.mx, [a / 2, a / 2]) / (q * a * a), 0.0331, 0.005);
    for (let i = 4; i < 8; i++) expect(f.support[i] / (q * a * a)).toBeCloseTo(0.25, 9);
  });

  it('converges at second order in h', () => {
    const err = [4, 8, 16, 32].map((n) => {
      const { mesh, f, D } = plate(square(a), 'simple', [uniform(q)], { size: a / n });
      // the exact Kirchhoff value from Navier's series, w_c = 0.00406235 q a⁴ / D
      const exact = navier(a, a, D, (m, k) => (m % 2 && k % 2 ? (16 * q) / (Math.PI ** 2 * m * k) : 0), a / 2, a / 2).w;
      return Math.abs(wAt(mesh, f, [a / 2, a / 2]) - exact) / exact;
    });
    for (let i = 1; i < err.length; i++) {
      expect(err[i]).toBeLessThan(err[i - 1]);
      expect(err[i - 1] / err[i]).toBeGreaterThan(3);
    }
    expect(err[3]).toBeLessThan(2e-3);
  });

  it('unstructured meshes give the same simply supported square', () => {
    const { mesh, f, D } = plate(square(a), 'simple', [uniform(q)], { size: a / 24, unstructured: true });
    expect(mesh.structured).toBe(false);
    expect(mesh.minAngle).toBeGreaterThan(25);
    expect(wAt(mesh, f, [a / 2, a / 2]) / ((q * a ** 4) / D)).toBeCloseTo(0.00406, 4);
    expect(at(mesh, f.mx, [a / 2, a / 2]) / (q * a * a)).toBeCloseTo(0.0479, 3);
  });

  it('turned 30° the square gives the same results (supports on skew edges)', () => {
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    const turned = square(a).map(([x, y]) => [x * c - y * s, x * s + y * c] as Pt);
    const { mesh, sol, f, D } = plate(turned, 'simple', [uniform(q)], { size: a / 24 });
    const centre: Pt = [(a / 2) * (c - s), (a / 2) * (s + c)];
    expect(wAt(mesh, f, centre) / ((q * a ** 4) / D)).toBeCloseTo(0.00406, 4);
    // the principal moments at the centre are both 0.0479 q a² (m_x + m_y is invariant)
    expect((at(mesh, f.mx, centre) + at(mesh, f.my, centre)) / (2 * q * a * a)).toBeCloseTo(0.0479, 3);
    const mid: Pt = [-(a / 2) * s, (a / 2) * c];
    expect(edgeReaction(sol, f, 3, mid) / (q * a)).toBeCloseTo(0.42, 2);
    expect(f.R[nearestNode(mesh, turned[0]).node] / (q * a * a)).toBeCloseTo(-0.065, 2);
  });
});

describe('plates against beam theory and Navier series', () => {
  it('a cantilever strip with ν = 0 is a Timoshenko beam', () => {
    // clamped at x = 0, free elsewhere: δ = q L⁴ / 8EI + q L² / 2 κ G A per unit width, I = t³/12, κ = 5/6
    const L = 3, b = 0.5, t = 0.2, q = 10e3;
    const { mesh, f } = plate(square(L, b), ['free', 'free', 'free', 'clamped'], [uniform(q)], { size: 0.05, t, nu: 0 });
    const EI = (E * t ** 3) / 12, GA = (5 / 6) * (E / 2) * t;
    const exact = (q * L ** 4) / (8 * EI) + (q * L * L) / (2 * GA);
    expect(wAt(mesh, f, [L, b / 2]) / exact).toBeCloseTo(1, 3);
    expect(at(mesh, f.mx, [0, b / 2]) / (-(q * L * L) / 2)).toBeCloseTo(1, 2);
    // with ν = 0.3 the strip lies between the beam (EI) and a plate strip in cylindrical bending (D)
    const p3 = plate(square(L, b), ['free', 'free', 'free', 'clamped'], [uniform(q)], { size: 0.05, t, nu: 0.3 });
    const w3 = wAt(p3.mesh, p3.f, [L, b / 2]);
    expect(w3).toBeLessThan(exact);
    expect(w3).toBeGreaterThan(exact * (1 - 0.3 ** 2));
  });

  it('a strip over a wall is a two-span beam: 1.25 q L on the wall, −q L²/8 over it', () => {
    const L = 4, b = 0.6, t = 0.2, q = 10e3;
    const wall: [Pt, Pt] = [[L, 0], [L, b]];
    const { mesh, sol, f } = plate(square(2 * L, b), ['free', 'simple', 'free', 'simple'], [uniform(q)], {
      size: 0.1, t, nu: 0, lines: [wall], extra: [{ id: 'wall', kind: 'line', a: wall[0], b: wall[1], fix: 'simple' }],
    });
    const iw = sol.supports.findIndex((s) => s.id === 'wall');
    expect(f.support[iw] / (q * L * b)).toBeCloseTo(1.25, 3);
    expect(at(mesh, f.mx, [L, b / 2]) / (-(q * L * L) / 8)).toBeCloseTo(1, 2);
    // the shear jumps at the wall: ±5/8 q L on its two sides
    const n = nearestNode(mesh, [L, b / 2]).node;
    const sides = [...mesh.quads.keys()].filter((c) => mesh.quads[c] === n).map((c) => f.vx[c]);
    expect(Math.max(...sides) / (q * L)).toBeCloseTo(0.625, 1);
    expect(Math.min(...sides) / (q * L)).toBeCloseTo(-0.625, 1);
  });

  it('a column under a simply supported square takes 0.00406 / 0.01160 of q a² (compatibility)', () => {
    // with R the column's force, w_q − w_R = 0 at the centre: R = (0.00406 q a⁴/D) / (0.01160 a²/D)
    const a = 6, q = 10e3, t = 0.06;
    const { sol, f } = plate(square(a), 'simple', [uniform(q)], { size: a / 32, t, points: [[a / 2, a / 2]], extra: [{ id: 'col', kind: 'point', at: [a / 2, a / 2] }] });
    const ic = sol.supports.findIndex((s) => s.id === 'col');
    expect(f.support[ic] / (q * a * a)).toBeCloseTo(0.00406 / 0.0116, 2);
    expect(f.support.reduce((s, r) => s + r, 0)).toBeCloseTo(q * a * a, 3);
  });

  it('a column head (elastic bedding) takes about the same and smooths the peak', () => {
    const a = 6, q = 10e3, t = 0.06, c = 0.3;
    const head: Pt[] = [[a / 2 - c / 2, a / 2 - c / 2], [a / 2 + c / 2, a / 2 - c / 2], [a / 2 + c / 2, a / 2 + c / 2], [a / 2 - c / 2, a / 2 + c / 2]];
    const lines = head.map((p, i) => [p, head[(i + 1) % 4]] as [Pt, Pt]);
    const point = plate(square(a), 'simple', [uniform(q)], { size: a / 40, t, points: [[a / 2, a / 2]], extra: [{ id: 'col', kind: 'point', at: [a / 2, a / 2] }] });
    // a bedding modulus E_c / H (C30/37, 3 m): k A = E_c A / H, nearly rigid next to the plate
    const bed = plate(square(a), 'simple', [uniform(q)], { size: a / 40, t, lines, extra: [{ id: 'col', kind: 'area', polygon: head, c: 33e9 / 3 }] });
    const ic = (s: PlateSolution) => s.supports.findIndex((x) => x.id === 'col');
    expect(bed.f.support[ic(bed.sol)] / point.f.support[ic(point.sol)]).toBeCloseTo(1, 1);
    expect(bed.f.support.reduce((s, r) => s + r, 0)).toBeCloseTo(q * a * a, 3);
    // the hogging peak over the column is spread over its head (here two elements wide)
    const peak = (p: typeof point) => Math.min(...Array.from(p.f.mx));
    expect(Math.abs(peak(bed))).toBeLessThan(0.85 * Math.abs(peak(point)));
  });

  it('a line load matches Navier’s series', () => {
    // q_L along x = ξ over the whole width: p_mn = 8 q_L sin(mπξ/a) / (a n π), n odd
    const a = 2, qL = 5e3, xi = 0.7, t = 0.02;
    const { mesh, f, D } = plate(square(a), 'simple', [{ id: 'L', case: 'A', type: 'line', q: qL, a: [xi, 0], b: [xi, a] }], { size: a / 32, t });
    const ref = navier(a, a, D, (m, n) => (n % 2 ? (8 * qL * Math.sin((m * Math.PI * xi) / a)) / (a * n * Math.PI) : 0), a / 2, a / 2);
    expect(wAt(mesh, f, [a / 2, a / 2]) / ref.w).toBeCloseTo(1, 2);
    expect(f.load).toBeCloseTo(qL * a, 6);
  });

  it('a patch load matches Navier’s series, on a mesh that does not follow it', () => {
    // q over [x1, x2] × [y1, y2]: p_mn = 16 q / (π² m n) × sin-products of the patch (Timoshenko 30)
    const a = 2, q = 20e3, t = 0.02, x1 = 0.33, x2 = 1.17, y1 = 0.51, y2 = 1.38;
    const patch: Pt[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    const coef = (m: number, n: number) => {
      const am = (m * Math.PI) / a, bn = (n * Math.PI) / a;
      return ((4 * q) / (a * a)) * ((Math.cos(am * x1) - Math.cos(am * x2)) / am) * ((Math.cos(bn * y1) - Math.cos(bn * y2)) / bn);
    };
    const ref = navier(a, a, Dof(t), coef, 0.9, 1.0);
    for (const size of [a / 30, a / 31]) {
      const mesh = meshPlate({ outline: square(a), openings: [], lines: [], points: [], softLines: [], softPoints: [], size });
      const supports: NumPlateSupport[] = square(a).map((p, i) => ({ id: `e${i}`, kind: 'line', a: p, b: square(a)[(i + 1) % 4], fix: 'simple' }));
      const sol = solvePlate({ mesh, E, nu, t, supports, loads: [{ id: 'p', case: 'A', type: 'area', q, polygon: patch }], cases: ['A'] });
      expect(sol.cases[0].load).toBeCloseTo(q * (x2 - x1) * (y2 - y1), 6);
      expect(wAt(mesh, sol.cases[0], [0.9, 1.0]) / ref.w).toBeCloseTo(1, 2);
    }
  });

  it('springs along the edges carry the load, an opening leaves equilibrium intact', () => {
    const a = 4, q = 5e3, k = 2e6;
    const outline = square(a);
    const mesh = meshPlate({ outline, openings: [[[1, 1], [2, 1], [2, 2.5], [1, 2.5]]], lines: [], points: [], softLines: [], softPoints: [], size: 0.2 });
    const supports: NumPlateSupport[] = outline.map((p, i) => ({ id: `e${i}`, kind: 'line', a: p, b: outline[(i + 1) % 4], fix: 'spring', k }));
    // a very stiff plate on springs moves as a rigid body: w = F/(k P) + F e_x (x − 2)/I + F e_y (y − 2)/I,
    // with P = 16 m of springs, I = k ∫ (y − 2)² ds = k 128/3 m³ about the square's centre and
    // e the offset of the load's centroid (the opening shifts it)
    const sol = solvePlate({ mesh, E: 1e3 * E, nu, t: 0.2, supports, loads: [uniform(q)].map((l) => ({ ...l, case: 'A' })), cases: ['A'] });
    const A = a * a - 1.5, F = q * A;
    const ex = (16 * 2 - 1.5 * 1.5) / A - 2, ey = (16 * 2 - 1.5 * 1.75) / A - 2, I = (k * 128) / 3;
    expect(sol.cases[0].load).toBeCloseTo(F, 6);
    expect(sol.cases[0].support.reduce((s, r) => s + r, 0)).toBeCloseTo(F, 3);
    for (const p of [[3, 3], [0.5, 3.5], [3.5, 0.2]] as Pt[]) {
      const n = nearestNode(mesh, p).node, x = mesh.x[n], y = mesh.y[n];
      near(sol.cases[0].w[n], F / (k * 16) + (F * ex * (x - 2)) / I + (F * ey * (y - 2)) / I, 1e-3);
    }
  });

  it('a wall across an opening holds the plate only where there is plate', () => {
    // a rigid plate, symmetric about its centre, on springs k along its 16 m of edges and a
    // spring wall along y = 2 that crosses a 2 m opening: 2 m of the wall are under the plate,
    // so it settles by w = F / (k · 18 m) and the wall takes F · 2/18 (the stretch across
    // the opening counted as a spring made that 20 m and 4/20)
    const a = 4, q = 5e3, k = 2e6;
    const outline = square(a), hole: Pt[] = [[1, 1.5], [3, 1.5], [3, 2.5], [1, 2.5]], wall: [Pt, Pt] = [[0, 2], [4, 2]];
    const mesh = meshPlate({ outline, openings: [hole], lines: [wall], points: [], softLines: [], softPoints: [], size: 0.25 });
    const supports: NumPlateSupport[] = outline.map((p, i) => ({ id: `e${i}`, kind: 'line', a: p, b: outline[(i + 1) % 4], fix: 'spring', k }));
    supports.push({ id: 'w', kind: 'line', a: wall[0], b: wall[1], fix: 'spring', k });
    const sol = solvePlate({ mesh, E: 1e3 * E, nu, t: 0.2, supports, loads: [uniform(q)], cases: ['A'] });
    const F = q * (a * a - 2);
    near(sol.cases[0].support[4], (F * 2) / 18, 1e-3);
    near(sol.cases[0].w[nearestNode(mesh, [0.5, 3.5]).node], F / (k * 18), 1e-3);
    // a rigid wall: its nodes' shares of the line add up to the 2 m under the plate
    const rigid = solvePlate({ mesh, E, nu, t: 0.2, supports: [...supports.slice(0, 4), { id: 'w', kind: 'line', a: wall[0], b: wall[1], fix: 'simple' }], loads: [uniform(q)], cases: ['A'] });
    expect(rigid.supports[4].trib!.reduce((s, v) => s + v, 0)).toBeCloseTo(2, 9);
    expect(rigid.cases[0].support.reduce((s, r) => s + r, 0)).toBeCloseTo(F, 3);
  });

  it('springs and bedding next to rigid supports: every newton once', () => {
    // a spring edge, a column head on a bedding and a point spring each meet simple edges;
    // at a held node F − f_int is what all its supports carry together (with a spring's or the
    // bedding's force there counted twice, this plate's reactions came to 166 kN of 160 kN)
    const a = 4, q = 10e3;
    const head: Pt[] = [[1.8, 3.6], [2.2, 3.6], [2.2, 4], [1.8, 4]];
    const outline = square(a);
    const extra: NumPlateSupport[] = [
      { id: 'spring', kind: 'line', a: outline[0], b: outline[1], fix: 'spring', k: 5e6, kr: 2e5 },
      { id: 'head', kind: 'area', polygon: head, c: 33e9 / 3 },
      { id: 'col', kind: 'point', at: [0, 2], k: 1e7 },
    ];
    const { f } = plate(outline, ['free', 'simple', 'simple', 'simple'], [uniform(q)], { size: 0.2, t: 0.2, lines: head.map((p, i) => [p, head[(i + 1) % 4]] as [Pt, Pt]), points: [[0, 2]], extra });
    near(f.support.reduce((s, r) => s + r, 0), q * a * a, 1e-9);
    near(f.R.reduce((s, r) => s + r, 0), q * a * a, 1e-9);
  });

  it('clamped edges keep their own reactions (an L with clamped re-entrant edges)', () => {
    // Kirchhoff: m_ns = 0 along a clamped edge, so V = q_n there and a corner where a clamped
    // edge meets a simple one has no corner force; each edge's total converges with the mesh
    const L: Pt[] = [[0, 0], [8, 0], [8, 3.5], [4, 3.5], [4, 7], [0, 7]], q = 13.275e3;
    const fix: Fix[] = ['simple', 'simple', 'clamped', 'clamped', 'simple', 'simple'];
    const [coarse, fine] = [0.2, 0.1].map((size) => plate(L, fix, [uniform(q)], { size, t: 0.2, nu: 0.2 }));
    const total = q * 42;
    for (const p of [coarse, fine]) expect(p.f.support.reduce((s, r) => s + r, 0) / total).toBeCloseTo(1, 9);
    // E3 and E4 (supports 2 and 3) meet at the re-entrant corner, where the shear is singular:
    // their shares move by ±3 % from mesh to mesh round 127 kN each (splitting the corner's
    // couple between them, one edge took the other's clamping moment: 97 → 154 → 92 → 161 kN)
    for (const i of [2, 3]) near(fine.f.support[i], coarse.f.support[i], 0.08);
    near(fine.f.support[2] + fine.f.support[3], coarse.f.support[2] + coarse.f.support[3], 0.01);
    // the corner (8, 3.5) of simple E2 and clamped E3: no corner force (< 0.2 % of the load)
    const end = lineReactions(fine.sol, fine.f, 2).ends[0];
    expect(Math.abs(end) / total).toBeLessThan(0.002);
  });

  it('reports a plate that is not held', () => {
    const mesh = meshPlate({ outline: square(2), openings: [], lines: [], points: [[1, 1]], softLines: [], softPoints: [], size: 0.25 });
    expect(() => solvePlate({ mesh, E, nu, t: 0.1, supports: [{ id: 'p', kind: 'point', at: [1, 1] }], loads: [uniform(1)], cases: ['q'] })).toThrow(/not held enough/);
  });
});
