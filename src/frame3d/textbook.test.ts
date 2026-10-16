// The space frame solver against the textbook direct stiffness method, written out here
// on its own: the 12 × 12 member stiffness and the geometric stiffness of McGuire,
// Gallagher & Ziemian, Matrix Structural Analysis (2nd ed.), eqs. 4.34 and 9.19 without
// the torsion terms, Timoshenko terms after Przemieniecki (Φ = 12EI/(G A_v L²)), released
// end forces by static condensation of the member matrix, handbook fixed-end forces, a
// dense solve. The solver shares none of this: it builds both bending planes from the
// plane frame, condenses each member as a substructure and factorises a banded system.
import { describe, it, expect } from 'vitest';
import { memberAt3, solveFrame3, type NumFrame, type NumMember3, type Vec3 } from './solve';
import { buckling3 } from './buckling';

type M12 = number[][];
const zeros = (n: number, m = n) => Array.from({ length: n }, () => new Array<number>(m).fill(0));

/** Member axes as the solver documents them: z down in the vertical plane through a beam, y = global Y in a column, then β about x. */
function axes(a: Vec3, b: Vec3, beta: number): Vec3[] {
  const d = [0, 1, 2].map((c) => b[c] - a[c]), L = Math.hypot(...d), x = d.map((v) => v / L) as Vec3;
  const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const unit = (p: Vec3) => p.map((v) => v / Math.hypot(...p)) as Vec3;
  let z: Vec3;
  if (Math.hypot(x[0], x[1]) < 1e-3) z = unit(cross(x, [0, 1, 0]));
  else z = unit([x[0] * x[2], x[1] * x[2], x[2] * x[2] - 1]); // (0, 0, −1) less its part along x
  const y = cross(z, x), c = Math.cos(beta), s = Math.sin(beta);
  return [x, y.map((v, i) => c * v + s * z[i]) as Vec3, z.map((v, i) => c * v - s * y[i]) as Vec3];
}

/** Member stiffness, u v w θx θy θz at each end; with N (tension positive) the geometric stiffness added. */
function memberK(m: NumMember3, L: number, N = 0): M12 {
  const k = zeros(12);
  const put = (i: number, j: number, v: number) => {
    k[i][j] += v;
    if (i !== j) k[j][i] += v;
  };
  put(0, 0, (m.E * m.A) / L); put(6, 6, (m.E * m.A) / L); put(0, 6, (-m.E * m.A) / L);
  put(3, 3, (m.G * m.It) / L); put(9, 9, (m.G * m.It) / L); put(3, 9, (-m.G * m.It) / L);
  // x-y plane (v, θz: 1 5 7 11) bends about z; x-z plane (w, θy: 2 4 8 10) about y, θy = −w′
  for (const [EI, GA, d, sg] of [[m.E * m.Iz, m.Avy, [1, 5, 7, 11], 1], [m.E * m.Iy, m.Avz, [2, 4, 8, 10], -1]] as const) {
    const ph = GA ? (12 * EI) / (m.G * GA * L * L) : 0, q = 1 + ph;
    const [v1, t1, v2, t2] = d;
    put(v1, v1, (12 * EI) / (L ** 3 * q)); put(v2, v2, (12 * EI) / (L ** 3 * q)); put(v1, v2, (-12 * EI) / (L ** 3 * q));
    for (const [i, j, f] of [[v1, t1, 1], [v1, t2, 1], [t1, v2, -1], [v2, t2, -1]] as const) put(i, j, (sg * f * 6 * EI) / (L * L * q));
    put(t1, t1, ((4 + ph) * EI) / (L * q)); put(t2, t2, ((4 + ph) * EI) / (L * q)); put(t1, t2, ((2 - ph) * EI) / (L * q));
    if (N) {
      put(v1, v1, (6 * N) / (5 * L)); put(v2, v2, (6 * N) / (5 * L)); put(v1, v2, (-6 * N) / (5 * L));
      for (const [i, j, f] of [[v1, t1, 1], [v1, t2, 1], [t1, v2, -1], [v2, t2, -1]] as const) put(i, j, (sg * f * N) / 10);
      put(t1, t1, (2 * N * L) / 15); put(t2, t2, (2 * N * L) / 15); put(t1, t2, (-N * L) / 30);
    }
  }
  return k;
}

/** Equivalent nodal loads of a uniform load q and a point force P at a (member axes), both ends fixed: q L/2, q L²/12; P b²(3a + b)/L³, P a b²/L². */
function fixedEnd(L: number, q: Vec3, P: Vec3, a: number): number[] {
  const f = new Array<number>(12).fill(0), b = L - a;
  f[0] = (q[0] * L) / 2 + (P[0] * b) / L;
  f[6] = (q[0] * L) / 2 + (P[0] * a) / L;
  for (const [c, [v1, t1, v2, t2], sg] of [[1, [1, 5, 7, 11], 1], [2, [2, 4, 8, 10], -1]] as const) {
    f[v1] += (q[c] * L) / 2 + (P[c] * b * b * (3 * a + b)) / L ** 3;
    f[v2] += (q[c] * L) / 2 + (P[c] * a * a * (a + 3 * b)) / L ** 3;
    f[t1] += sg * ((q[c] * L * L) / 12 + (P[c] * a * b * b) / (L * L));
    f[t2] -= sg * ((q[c] * L * L) / 12 + (P[c] * a * a * b) / (L * L));
  }
  return f;
}

/** Static condensation of released end forces (zero force there). */
function condense(k: M12, f: number[], released: number[]): void {
  for (const r of released) {
    const krr = k[r][r];
    for (let i = 0; i < 12; i++) {
      if (i === r) continue;
      f[i] -= (k[i][r] * f[r]) / krr;
      for (let j = 0; j < 12; j++) if (j !== r) k[i][j] -= (k[i][r] * k[r][j]) / krr;
    }
    for (let i = 0; i < 12; i++) k[i][r] = k[r][i] = 0;
    f[r] = 0;
  }
}

interface RefLoads { q?: Vec3; P?: Vec3; a?: number }

/** Member matrices in global axes (T = blockdiag(R, R, R, R)): k_g = Tᵀ k T, f_g = Tᵀ f. */
function globalMember(m: NumMember3, a: Vec3, b: Vec3, loads: RefLoads, N = 0) {
  const R = axes(a, b, m.beta ?? 0), L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const k = memberK(m, L, N), f = fixedEnd(L, loads.q ?? [0, 0, 0], loads.P ?? [0, 0, 0], loads.a ?? 0);
  condense(k, f, [...(m.relA ?? []).flatMap((r, i) => (r ? [i] : [])), ...(m.relB ?? []).flatMap((r, i) => (r ? [6 + i] : []))]);
  const T = zeros(12);
  for (let blk = 0; blk < 12; blk += 3) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[blk + i][blk + j] = R[i][j];
  const kg = zeros(12), fg = new Array<number>(12).fill(0);
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) {
    fg[j] += T[i][j] * f[i];
    let s = 0;
    for (let p = 0; p < 12; p++) for (let q = 0; q < 12; q++) s += T[p][i] * k[p][q] * T[q][j];
    kg[i][j] = s;
  }
  return { k, f, T, kg, fg };
}

/** Gaussian elimination with partial pivoting. */
function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}

/** Negative pivots of a symmetric matrix (LDLᵀ without pivoting): by Sylvester's law of inertia, its negative eigenvalues. */
function negativePivots(A: number[][]): number {
  const n = A.length, M = A.map((r) => [...r]);
  let neg = 0;
  for (let c = 0; c < n; c++) {
    if (M[c][c] < 0) neg++;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let j = c; j < n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return neg;
}

let seed = 20261016;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

/**
 * A random frame of 8 nodes and 11 members (beams in every direction, a column, inclined
 * members, β), clamped at two nodes, pinned at one, on a spring at another, with random
 * nodal loads and, optionally, releases, shear deformation and loads along the members.
 */
function randomFrame(o: { releases: boolean; shear: boolean; memberLoads: boolean }) {
  const pos: Vec3[] = Array.from({ length: 7 }, () => [rnd() * 8, rnd() * 6, rnd() * 5].map((v) => Math.round(v * 10) / 10) as Vec3);
  pos.push([pos[0][0], pos[0][1], pos[0][2] + 3]);
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 0], [1, 4], [2, 5], [0, 7], [7, 3]];
  const rel = (k: number, end: 'a' | 'b') => {
    if (!o.releases) return undefined;
    const pick = end === 'a' ? { 7: 0, 8: 3, 4: 1 }[k] : { 2: 4, 5: 4, 6: 2 }[k];
    if (pick === undefined) return undefined;
    const r = [false, false, false, false, false, false];
    r[pick] = true;
    if (end === 'b' && k === 2) r[5] = true; // a hinge (My, Mz)
    return r;
  };
  const members: NumMember3[] = pairs.map(([a, b], k) => ({
    id: `m${k}`, a: `n${a}`, b: `n${b}`, E: 210e9, G: 81e9, A: (40 + 30 * rnd()) * 1e-4, Iy: (5000 + 5000 * rnd()) * 1e-8, Iz: (500 + 1500 * rnd()) * 1e-8,
    It: (20 + 40 * rnd()) * 1e-8, beta: k % 3 ? rnd() * 2 : 0, relA: rel(k, 'a'), relB: rel(k, 'b'), ...(o.shear ? { Avy: 30e-4, Avz: 20e-4 } : {}),
  }));
  const supports: NumFrame['supports'] = [
    { id: 's0', node: 'n0', dofs: [true, true, true, true, true, true] },
    { id: 's3', node: 'n3', dofs: [true, true, true, true, true, true] },
    { id: 's6', node: 'n6', dofs: [true, true, true, false, false, false] },
    { id: 's5', node: 'n5', dofs: [false, false, 2e6, false, false, 5e5] },
  ];
  const memberLoads: RefLoads[] = members.map(() => ({}));
  const loads: NumFrame['loads'] = pos.map((_, i) => ({ id: `l${i}`, type: 'node', node: `n${i}`, F: [0, 0, 0].map(() => (rnd() - 0.5) * 2e4) as Vec3, M: [0, 0, 0].map(() => (rnd() - 0.5) * 2e4) as Vec3 }));
  if (o.memberLoads) members.forEach((m, k) => {
    // (the handbook point load values are Euler–Bernoulli ones: point loads only without shear)
    const q = [(rnd() - 0.5) * 4e3, (rnd() - 0.5) * 4e3, (rnd() - 0.5) * 8e3] as Vec3, t = 0.1 + 0.8 * rnd();
    const P = o.shear ? undefined : [(rnd() - 0.5) * 4e3, (rnd() - 0.5) * 4e3, (rnd() - 0.5) * 8e3] as Vec3;
    const [a, b] = pairs[k], L = Math.hypot(...[0, 1, 2].map((c) => pos[b][c] - pos[a][c]));
    memberLoads[k] = { q, P, a: t * L };
    loads.push({ id: `q${k}`, type: 'line', member: m.id, t1: 0, t2: 1, q1: q, q2: q, local: true });
    if (P) loads.push({ id: `p${k}`, type: 'point', member: m.id, t, F: P, M: [0, 0, 0], local: true });
  });
  const st: NumFrame = { nodes: pos.map((p, i) => ({ id: `n${i}`, x: p[0], y: p[1], z: p[2] })), members, supports, loads };
  return { st, pos, pairs, memberLoads };
}

describe('space frame against the textbook stiffness method', () => {
  for (const o of [
    { releases: false, shear: false, memberLoads: false },
    { releases: true, shear: false, memberLoads: true },
    { releases: false, shear: true, memberLoads: true },
    { releases: true, shear: true, memberLoads: true },
  ]) {
    it(`random frame${o.releases ? ', releases' : ''}${o.shear ? ', Timoshenko' : ''}${o.memberLoads ? ', loads along members' : ''}`, () => {
      const { st, pos, pairs, memberLoads } = randomFrame(o);
      // the textbook: assemble, eliminate the supports, add the springs, solve
      const n = 6 * pos.length, K = zeros(n), F = new Array<number>(n).fill(0);
      for (const l of st.loads) if (l.type === 'node') [...l.F, ...l.M].forEach((v, c) => (F[6 * Number(l.node.slice(1)) + c] += v));
      const els = st.members.map((m, k) => {
        const e = globalMember(m, pos[pairs[k][0]], pos[pairs[k][1]], memberLoads[k]);
        const idx = [0, 1].flatMap((end) => [0, 1, 2, 3, 4, 5].map((c) => 6 * pairs[k][end] + c));
        idx.forEach((I, a) => {
          F[I] += e.fg[a];
          idx.forEach((J, b) => (K[I][J] += e.kg[a][b]));
        });
        return { ...e, idx };
      });
      const held = new Set<number>();
      for (const s of st.supports) s.dofs.forEach((d, c) => {
        const q = 6 * Number(s.node.slice(1)) + c;
        if (d === true) held.add(q);
        else if (typeof d === 'number') K[q][q] += d;
      });
      const free = [...Array(n).keys()].filter((q) => !held.has(q));
      const x = solveDense(free.map((i) => free.map((j) => K[i][j])), free.map((i) => F[i]));
      const D = new Array<number>(n).fill(0);
      free.forEach((q, i) => (D[q] = x[i]));

      const sol = solveFrame3(st);
      const big = Math.max(...D.map(Math.abs));
      st.nodes.forEach((p, i) => sol.nodes[p.id].forEach((v, c) => expect(Math.abs(v - D[6 * i + c]) / big).toBeLessThan(1e-9)));
      // reactions R = K D − F at held unknowns, −k u at springs
      const R = K.map((row, i) => row.reduce((s, v, j) => s + v * D[j], 0) - F[i]);
      const bigR = Math.max(...R.map(Math.abs));
      for (const r of sol.reactions) {
        const i = Number(r.node.slice(1)), sp = st.supports.find((s) => s.id === r.id)!;
        [...r.F, ...r.M].forEach((v, c) => {
          const d = sp.dofs[c], ref = d === true ? R[6 * i + c] : typeof d === 'number' ? -d * D[6 * i + c] : 0;
          expect(Math.abs(v - ref) / bigR).toBeLessThan(1e-9);
        });
      }
      // member end forces k d − f (member axes), and the internal forces at the ends: S(0) = −start, S(L) = end
      const ends = els.map((e) => {
        const dl = e.T.map((row) => row.reduce((s, v, j) => s + v * D[e.idx[j]], 0));
        return e.k.map((row, a) => row.reduce((s, v, j) => s + v * dl[j], 0) - e.f[a]);
      });
      const bigE = Math.max(...ends.flat().map(Math.abs));
      sol.members.forEach((m, k) => {
        [...m.ends[0], ...m.ends[1]].forEach((v, c) => expect(Math.abs(v - ends[k][c]) / bigE).toBeLessThan(1e-8));
        const s0 = memberAt3(m, 0), s1 = memberAt3(m, m.L);
        (['N', 'Vy', 'Vz', 'T', 'My', 'Mz'] as const).forEach((key, c) => {
          expect(Math.abs(s0[key] + ends[k][c]) / bigE).toBeLessThan(1e-8);
          expect(Math.abs(s1[key] - ends[k][6 + c]) / bigE).toBeLessThan(1e-8);
        });
      });
    });
  }

  it('α_cr of a 3-D portal: K + α K_G turns indefinite at the solver’s α_cr (Sylvester)', () => {
    // four columns of unequal height (two pinned, two clamped), four beams, β on some;
    // members cut into the solver's eight elements; below α_cr no negative pivot, just
    // above it one (two for the second, distinct, value)
    const pos: Vec3[] = [[0, 0, 0], [6, 0, 0], [6, 4, 0], [0, 4, 0], [0, 0, 4], [6, 0, 4.5], [6, 4, 4], [0, 4, 3.5]];
    const pairs = [[0, 4], [1, 5], [2, 6], [3, 7], [4, 5], [5, 6], [6, 7], [7, 4]], betas = [0, 0.5, 1.1, 0, 0, 0.3, 0, 0];
    const sec = { E: 210e9, G: 81e9, A: 78.1e-4, Iy: 5696e-8, Iz: 2003e-8, It: 59.3e-8 };
    const st: NumFrame = {
      nodes: pos.map((p, i) => ({ id: `n${i}`, x: p[0], y: p[1], z: p[2] })),
      members: pairs.map(([a, b], k) => ({ id: `m${k}`, a: `n${a}`, b: `n${b}`, ...sec, beta: betas[k] })),
      supports: [0, 1, 2, 3].map((i) => ({ id: `s${i}`, node: `n${i}`, dofs: i % 2 ? [true, true, true, true, true, true] : [true, true, true, false, false, false] })),
      loads: [4, 5, 6, 7].map((i) => ({ id: `P${i}`, type: 'node' as const, node: `n${i}`, F: [10e3, 5e3, -400e3] as Vec3, M: [0, 0, 0] as Vec3 })),
    };
    const first = solveFrame3(st), b = buckling3(st, first);
    const parts = 8, all: Vec3[] = [...pos], elems: { m: NumMember3; a: number; b: number; N: number }[] = [];
    pairs.forEach(([a, bb], k) => {
      let prev = a;
      for (let e = 1; e <= parts; e++) {
        const cur = e === parts ? bb : all.push(pos[a].map((v, c) => v + ((pos[bb][c] - v) * e) / parts) as Vec3) - 1;
        elems.push({ m: st.members[k], a: prev, b: cur, N: memberAt3(first.members[k], first.members[k].L / 2).N });
        prev = cur;
      }
    });
    const n = 6 * all.length, K = zeros(n), KG = zeros(n);
    for (const e of elems) {
      const k0 = globalMember(e.m, all[e.a], all[e.b], {}).kg, k1 = globalMember(e.m, all[e.a], all[e.b], {}, e.N).kg;
      const idx = [e.a, e.b].flatMap((p) => [0, 1, 2, 3, 4, 5].map((c) => 6 * p + c));
      idx.forEach((I, p) => idx.forEach((J, q) => {
        K[I][J] += k0[p][q];
        KG[I][J] += k1[p][q] - k0[p][q];
      }));
    }
    const free = [...Array(n).keys()].filter((q) => q >= 24 || (Math.floor(q / 6) % 2 === 0 && q % 6 >= 3));
    const below = (alpha: number) => negativePivots(free.map((i) => free.map((j) => K[i][j] + alpha * KG[i][j])));
    const [a1, a2] = b.modes.map((m) => m.alpha);
    expect(a2 / a1).toBeGreaterThan(1.01);
    expect(below(a1 * (1 - 1e-6))).toBe(0);
    expect(below(a1 * (1 + 1e-6))).toBe(1);
    expect(below(a2 * (1 - 1e-6))).toBe(1);
    expect(below(a2 * (1 + 1e-6))).toBe(2);
  });
});
