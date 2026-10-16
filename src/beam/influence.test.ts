import { describe, it, expect } from 'vitest';
import { influenceAnalysis, loadPath, trainLoads, type InfluenceLine, type InfluenceQuery, type TrainSpec } from './influence';
import { memberAt, solveStructure, type NumMember, type NumStructure, type NumSupport } from './solve';
import { SparseSym, skylineCholesky, skylineSolve } from './sparse';

const E = 210e9, I = 8356e-8, A = 53.8e-4, EI = E * I;
const mem = (id: string, a: string, b: string, extra: Partial<NumMember> = {}): NumMember => ({ id, a, b, E, A, I, ...extra });
const sup = (id: string, node: string, type: NumSupport['type'], extra: Partial<NumSupport> = {}): NumSupport => ({ id, node, type, angle: 0, label: id, ...extra });

/** Horizontal beam with nodes at xs: pin at the first, rollers at the others listed. */
function beam(xs: number[], supported: number[]): NumStructure {
  return {
    nodes: xs.map((x, i) => ({ id: `n${i}`, x, y: 0 })),
    members: xs.slice(1).map((_, i) => mem(`m${i}`, `n${i}`, `n${i + 1}`)),
    supports: supported.map((i, k) => sup(String.fromCharCode(65 + k), `n${i}`, k === 0 ? 'pin' : 'roller')),
    loads: [],
  };
}

function run(st: NumStructure, step: number, queries: InfluenceQuery[], trains: TrainSpec[] = []) {
  return influenceAnalysis(st, loadPath(st), step, queries, trains);
}

/** Ordinate at x (the right-hand side where the line jumps). */
const at = (l: InfluenceLine, x: number) => {
  let v = NaN;
  l.x.forEach((xi, i) => { if (Math.abs(xi - x) < 1e-9) v = l.v[i]; });
  return v;
};

describe('sparse Cholesky for many right-hand sides', () => {
  it('solves a banded system, in any numbering', () => {
    // −u'' = f on 40 points, numbered scattered so the ordering has work to do
    const n = 40, perm = Array.from({ length: n }, (_, i) => (i * 17) % n);
    const K = new SparseSym(n);
    for (let i = 0; i < n; i++) {
      K.add(perm[i], perm[i], 2);
      if (i > 0) { K.add(perm[i], perm[i - 1], -1); K.add(perm[i - 1], perm[i], -1); }
    }
    const ch = skylineCholesky(K)!;
    // its envelope stays a band: at most three entries per row of L
    expect(Math.max(...ch.L.map((r) => r.length))).toBeLessThanOrEqual(3);
    const b = new Float64Array(n).fill(1);
    const x = skylineSolve(ch, b);
    // u_i = i(n + 1 − i)/2 for i = 1 … n (discrete Poisson with unit load)
    for (let i = 0; i < n; i++) expect(x[perm[i]]).toBeCloseTo(((i + 1) * (n - i)) / 2, 9);
    // singular: a free end
    const S = new SparseSym(2);
    S.add(0, 0, 1); S.add(0, 1, -1); S.add(1, 0, -1); S.add(1, 1, 1);
    expect(skylineCholesky(S)).toBeNull();
  });
});

describe('influence lines by unit-load traversal', () => {
  const L = 10;
  const ss = () => beam([0, L], [0, 1]);

  it('simple span: M at midspan is a triangle with peak L/4, R_A falls linearly from 1 to 0', () => {
    const r = run(ss(), 0.5, [
      { id: 'M', kind: 'M', member: 'm0', t: 0.5 },
      { id: 'RA', kind: 'Ry', support: 'A' },
      { id: 'RB', kind: 'Ry', support: 'B' },
    ]);
    const [M, RA, RB] = r.lines;
    expect(Math.max(...M.v)).toBeCloseTo(L / 4, 12);
    expect(at(M, 5)).toBeCloseTo(L / 4, 12);
    // η_M(ξ) = ξ (L − x)/L left of the section, x (L − ξ)/L right of it (x = L/2)
    for (const xi of [0, 1.5, 3, 7, 8.5, 10]) {
      const exact = xi <= 5 ? (xi * (L - 5)) / L : (5 * (L - xi)) / L;
      expect(at(M, xi)).toBeCloseTo(exact, 12);
      expect(at(RA, xi)).toBeCloseTo(1 - xi / L, 12);
      // equilibrium: the reactions carry the unit load wherever it is
      expect(at(RA, xi) + at(RB, xi)).toBeCloseTo(1, 12);
    }
  });

  it('simple span: shear at x jumps by 1 where the load passes', () => {
    const x = 3;
    const V = run(ss(), 0.5, [{ id: 'V', kind: 'V', member: 'm0', t: x / L }]).lines[0];
    const i = V.x.findIndex((xi) => Math.abs(xi - x) < 1e-12);
    expect(V.x[i + 1]).toBe(V.x[i]); // the position repeats
    // left of the section −ξ/L, right of it 1 − ξ/L
    expect(V.v[i]).toBeCloseTo(-x / L, 12);
    expect(V.v[i + 1]).toBeCloseTo(1 - x / L, 12);
    expect(V.v[i + 1] - V.v[i]).toBeCloseTo(1, 12);
    expect(at(V, 1)).toBeCloseTo(-0.1, 12);
    expect(at(V, 8)).toBeCloseTo(0.2, 12);
    // at the supports: V(0⁺) jumps from 0 to 1 at ξ = 0
    const V0 = run(ss(), 0.5, [{ id: 'V0', kind: 'V', member: 'm0', t: 0 }]).lines[0];
    expect(V0.v.slice(0, 2)).toEqual([expect.closeTo(0, 12), expect.closeTo(1, 12)]);
  });

  it('deflection at midspan: Maxwell, δ = a (L − x)(2Lx − x² − a²)/(6 L EI) per unit load at a', () => {
    const w = run(ss(), 0.5, [{ id: 'w', kind: 'w', member: 'm0', t: 0.5 }]).lines[0];
    const x = 5;
    for (const a of [1, 2.5, 5]) expect(at(w, a)).toBeCloseTo((-a * (L - x) * (2 * L * x - x * x - a * a)) / (6 * L * EI), 15);
    expect(at(w, 5)).toBeCloseTo(-(L ** 3) / (48 * EI), 15);
  });

  it('two equal spans: R_B against Müller-Breslau, ξ(3L² − ξ²)/(2L³)', () => {
    const l = 8;
    const R = run(beam([0, l, 2 * l], [0, 1, 2]), 0.25, [{ id: 'RB', kind: 'Ry', support: 'B' }]).lines[0];
    // cubic in each span, symmetric about B, 1 at B
    R.x.forEach((xi, i) => {
      const u = xi <= l ? xi : 2 * l - xi;
      expect(R.v[i]).toBeCloseTo((u * (3 * l * l - u * u)) / (2 * l ** 3), 11);
    });
    expect(at(R, l)).toBeCloseTo(1, 12);
  });

  it('agrees with the direct solver on a frame with a hinge, a spring and an inclined roller', () => {
    // portal: fixed foot left, spring under the right foot, a hinge at the right corner,
    // and an overhang carried by a roller on a slope
    const st: NumStructure = {
      nodes: [{ id: 'f1', x: 0, y: 0 }, { id: 'c1', x: 0, y: 4 }, { id: 'c2', x: 6, y: 4 }, { id: 'f2', x: 6, y: 0 }, { id: 'e', x: 9, y: 4 }],
      members: [mem('col1', 'f1', 'c1'), mem('beam', 'c1', 'c2', { hingeB: true }), mem('col2', 'f2', 'c2'), mem('over', 'c2', 'e')],
      supports: [sup('A', 'f1', 'fixed'), sup('B', 'f2', 'pin', { k: 4e7 }), sup('C', 'e', 'roller', { angle: 30 * Math.PI / 180 })],
      loads: [],
    };
    const path = loadPath(st);
    expect(path.map((p) => p.member)).toEqual(['beam', 'over']);
    const r = influenceAnalysis(st, path, 0.5, [
      { id: 'M', kind: 'M', member: 'col2', t: 0.75 },
      { id: 'V', kind: 'V', member: 'beam', t: 0.5 },
      { id: 'RA', kind: 'Mr', support: 'A' },
      { id: 'RB', kind: 'Ry', support: 'B' },
      { id: 'w', kind: 'w', member: 'over', t: 2 / 3 },
    ], []);
    for (const xi of [1.5, 4.5, 6, 7.5]) {
      const m = xi <= 6 ? 'beam' : 'over';
      const t = xi <= 6 ? xi / 6 : (xi - 6) / 3;
      const s = solveStructure({ ...st, loads: [{ id: 'P', type: 'force', at: { member: m, t }, Fx: 0, Fy: -1 }] });
      const col2 = s.members.find((q) => q.id === 'col2')!, bm = s.members.find((q) => q.id === 'beam')!, ov = s.members.find((q) => q.id === 'over')!;
      expect(at(r.lines[0], xi)).toBeCloseTo(memberAt(col2, 3).M, 9);
      if (xi !== 3) expect(at(r.lines[1], xi)).toBeCloseTo(memberAt(bm, 3).V, 9);
      expect(at(r.lines[2], xi)).toBeCloseTo(s.reactions[0].M, 9);
      expect(at(r.lines[3], xi)).toBeCloseTo(s.reactions[1].Ry, 9);
      expect(at(r.lines[4], xi)).toBeCloseTo(memberAt(ov, 2).dy, 14);
    }
  });

  it('with shear deformation: fixed-end forces of a point load on a Timoshenko member', () => {
    // a deep propped cantilever (L = 4 m, h ≈ 0.6 m): shear deformation counts here
    const L = 4, G = 81e9, Av = 30e-4;
    const st: NumStructure = {
      nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: L, y: 0 }],
      members: [mem('m', 'a', 'b', { I: 9e-4, G, Av })],
      supports: [sup('A', 'a', 'fixed'), sup('B', 'b', 'roller')],
      loads: [],
    };
    const r = influenceAnalysis(st, loadPath(st), 0.25, [
      { id: 'MA', kind: 'Mr', support: 'A' }, { id: 'w', kind: 'w', member: 'm', t: 0.5 }, { id: 'V', kind: 'V', member: 'm', t: 0.25 },
    ], []);
    for (const xi of [0.75, 1.5, 2.25, 3.5]) {
      // the direct solver splits the member at the load: an independent route to the same numbers
      const s = solveStructure({ ...st, loads: [{ id: 'P', type: 'force', at: { member: 'm', t: xi / L }, Fx: 0, Fy: -1 }] });
      expect(at(r.lines[0], xi)).toBeCloseTo(s.reactions[0].M, 10);
      expect(at(r.lines[1], xi)).toBeCloseTo(memberAt(s.members[0], 2).dy, 15);
      expect(at(r.lines[2], xi)).toBeCloseTo(memberAt(s.members[0], 1).V, 10);
    }
    // R_B for a load at midspan, from compatibility at the prop with δ = PL³/3EI + PL/GA_v terms:
    // R_B = (5/48 + ψ/2)/(1/3 + ψ), ψ = EI/(G A_v L²); 5/16 without shear
    const eb = influenceAnalysis({ ...st, members: [mem('m', 'a', 'b', { I: 9e-4 })] }, loadPath(st), 0.25, [{ id: 'RB', kind: 'Ry', support: 'B' }], []);
    expect(at(eb.lines[0], 2)).toBeCloseTo(5 / 16, 12);
    const tim = influenceAnalysis(st, loadPath(st), 0.25, [{ id: 'RB', kind: 'Ry', support: 'B' }], []);
    const psi = (E * 9e-4) / (G * Av * L * L);
    expect(at(tim.lines[0], 2)).toBeCloseTo((5 / 48 + psi / 2) / (1 / 3 + psi), 12);
  });

  it('refuses a path that is not one chain', () => {
    const st = beam([0, 5, 10], [0, 2]);
    st.nodes.push({ id: 'x', x: 20, y: 0 }, { id: 'y', x: 25, y: 0 });
    st.members.push(mem('far', 'x', 'y'));
    expect(() => loadPath(st)).toThrow(/chain/);
    expect(() => loadPath(st, new Set(['m0', 'm1']))).not.toThrow();
  });
});

describe('moving loads', () => {
  const point = (P: number): TrainSpec => ({ id: 'P', P: [P], offsets: [0], q: 0, dir: 'both' });

  it('a single load P: M_max = PL/4 at midspan, the reaction P, δ = PL³/48EI', () => {
    const L = 12, P = 100e3;
    const r = run(beam([0, L], [0, 1]), 0.25, [], [point(P)]);
    const t = r.trains[0];
    expect(t.extremes.M_max!.value).toBeCloseTo((P * L) / 4, 6);
    expect(t.extremes.M_max!.x).toBeCloseTo(L / 2, 12);
    expect(t.extremes.M_max!.lead).toBeCloseTo(L / 2, 12);
    // a point load only sags a simple span
    expect(Math.abs(t.extremes.M_min!.value)).toBeLessThan(1e-9 * P * L);
    expect(t.reactions.A.Ry_max!.value).toBeCloseTo(P, 6);
    expect(t.extremes.w_max!.value).toBeCloseTo((P * L ** 3) / (48 * EI), 12);
    // shear envelope: V_max(x) = P (1 − x/L) just right of the load
    const H = t.max.members[0], Lo = t.min.members[0];
    H.s.forEach((s, i) => {
      expect(H.V[i]).toBeCloseTo(P * (1 - s / L), 6);
      expect(Lo.V[i]).toBeCloseTo((-P * s) / L, 6);
      // M_max(x) = P x (L − x)/L
      expect(H.M[i]).toBeCloseTo((P * s * (L - s)) / L, 6);
    });
  });

  it('two equal axles at spacing a: absolute M_max = P(2L − a)²/(8L) at L/2 ± a/4', () => {
    const L = 20, a = 4, P = 100e3;
    // a < 0.586 L, so both axles on the span govern (else one axle at midspan)
    const r = run(beam([0, L], [0, 1]), 0.1, [], [{ id: 'T', P: [P, P], offsets: [0, a], q: 0, dir: 'both' }]);
    const e = r.trains[0].extremes.M_max!;
    expect(e.value).toBeCloseTo((P * (2 * L - a) ** 2) / (8 * L), 5);
    expect(Math.abs(e.x - L / 2)).toBeCloseTo(a / 4, 9);
    // R_A,max = P + P (L − a)/L with the first axle over A
    expect(r.trains[0].reactions.A.Ry_max!.value).toBeCloseTo(P + (P * (L - a)) / L, 6);
    // the train at that position, solved directly, gives the same moment
    const st = beam([0, L], [0, 1]);
    const s = solveStructure({ ...st, loads: trainLoads(loadPath(st), st, { P: [P, P], offsets: [0, a] }, e.lead!, e.dir!) });
    expect(s.max.M!.value).toBeCloseTo(e.value, 5);
  });

  it('a train placed a millimetre from a joint still solves directly', () => {
    // the axle goes onto the joint (a 1 mm sliver of a 25 m member is too ill-conditioned);
    // R_B then differs from Σ P η by about P·η′·1 mm only
    const st = beam([0, 25, 50], [0, 1, 2]);
    const R = run(st, 0.5, [{ id: 'RB', kind: 'Ry', support: 'B' }]).lines[0];
    const P = 300e3, lead = 24.999;
    const s = solveStructure({ ...st, loads: trainLoads(loadPath(st), st, { P: [P, P], offsets: [0, 1.2] }, lead, 1) });
    // η_RB = u(3L² − u²)/(2L³): 1 at B, and at 23.799 m
    const eta = (u: number) => (u * (3 * 625 - u * u)) / (2 * 25 ** 3);
    expect(s.reactions[1].Ry / (P * (eta(lead) + eta(lead - 1.2)))).toBeCloseTo(1, 5);
    expect(at(R, 24.5)).toBeCloseTo(eta(24.5), 11);
  });

  it('a wide spacing a > (2 − √2) L: one axle at midspan governs, M = PL/4', () => {
    const L = 10, a = 7, P = 50e3;
    const r = run(beam([0, L], [0, 1]), 0.1, [], [{ id: 'T', P: [P, P], offsets: [0, a], q: 0, dir: 'both' }]);
    const e = r.trains[0].extremes.M_max!;
    // both axles on the span would give only P(2L − a)²/(8L) = 2.11 P·m < PL/4 = 2.5 P·m
    expect((P * (2 * L - a) ** 2) / (8 * L)).toBeLessThan((P * L) / 4);
    expect(e.value).toBeCloseTo((P * L) / 4, 5);
    expect(e.x).toBeCloseTo(L / 2, 9);
  });

  it('uniform load on two spans: adverse parts only — hogging −qL²/8 at B, sagging 49/512 qL² in a span', () => {
    const l = 8, q = 10e3;
    const r = run(beam([0, l, 2 * l], [0, 1, 2]), 0.1, [], [{ id: 'q', P: [], offsets: [], q, dir: 'both' }]);
    const t = r.trains[0];
    // the IL of M_B is negative on both spans: both loaded
    expect(t.extremes.M_min!.value / ((q * l * l) / 8)).toBeCloseTo(-1, 9);
    expect(Math.abs(t.extremes.M_min!.x - l)).toBeLessThan(1e-9);
    // largest sagging: one span loaded, at 7l/16 from the end support
    expect(t.extremes.M_max!.value / ((49 / 512) * q * l * l)).toBeCloseTo(1, 9);
    expect(Math.min(Math.abs(t.extremes.M_max!.x - (7 * l) / 16), Math.abs(t.extremes.M_max!.x - (2 * l - (7 * l) / 16)))).toBeLessThan(1e-9);
    // R_B,max = 5/4 q l (both spans), R_A,min = −q l/16 (span 2 alone lifts A)
    expect(t.reactions.B.Ry_max!.value / (1.25 * q * l)).toBeCloseTo(1, 9);
    expect(t.reactions.A.Ry_min!.value / (-(q * l) / 16)).toBeCloseTo(1, 9);
    // loading everything at once would understate the span moment: 0.0703 q l² < 0.0957 q l²
    const full = solveStructure({ ...beam([0, l, 2 * l], [0, 1, 2]), loads: ['m0', 'm1'].map((m) => ({ id: m, type: 'line' as const, member: m, t1: 0, t2: 1, q1: q, q2: q, dir: 'global' as const })) });
    const spanMax = Math.max(...full.members[0].M);
    expect(spanMax).toBeLessThan(t.extremes.M_max!.value * 0.75);
  });

  it('direction matters for an uneven train', () => {
    // a heavy and a light axle: on a cantilever the heavy one should reach the tip
    const st: NumStructure = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 5, y: 0 }], members: [mem('m', 'a', 'b')], supports: [sup('A', 'a', 'fixed')], loads: [] };
    const spec = (dir: TrainSpec['dir']): TrainSpec => ({ id: 'T', P: [200e3, 50e3], offsets: [0, 2], q: 0, dir });
    const fwd = influenceAnalysis(st, loadPath(st), 0.5, [], [spec('forward')]).trains[0];
    const back = influenceAnalysis(st, loadPath(st), 0.5, [], [spec('backward')]).trains[0];
    // forward: heavy axle at the tip, light 2 m behind: M_A = −(200·5 + 50·3) kN·m
    expect(fwd.extremes.M_min!.value).toBeCloseTo(-(200e3 * 5 + 50e3 * 3), 4);
    // backward the light axle trails 2 m behind (towards +x): with the heavy one at the tip it is off the beam
    expect(back.extremes.M_min!.value).toBeCloseTo(-200e3 * 5, 4);
  });
});
