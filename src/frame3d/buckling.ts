// Linear buckling of space frames (EN 1993-1-1 5.2.1): the factor α_cr on the loads at
// which (K + α K_G(N)) φ = 0 has a solution, with the axial forces N of the first-order
// solution. As in the plane solver: members cut into short elements with the consistent
// geometric stiffness (flexural buckling in both planes and sway; no torsional or
// lateral-torsional modes), supports eliminated, K = L Lᵀ, and the largest eigenvalues of
// L⁻¹(−K_G)L⁻ᵀ give the lowest α. The factor is the one the static solver builds: each
// member's own unknowns (the points between its elements, a released end's own
// rotation) first, then the nodes, L = [[L_o, 0], [Zᵀ, L_g]], so the eigenproblem is the
// one of the whole cut-up frame while only the nodes go into the banded factor.
import { largestEigen, symmetricEigen } from '../beam/eigen';
import { skylineBackward, skylineCholesky, skylineForward } from '../beam/sparse';
import {
  chainMatrix, elementsPerMember3, frameMesh3, frameSystem, freeRotations, gather, geometricK3, GAvy, GAvz, mechanismAt, memberAt3, nodeDofs, ownBackward, ownForward,
  StructureError, toGlobal3, type FrameSolution, type NumFrame, type Vec3,
} from './solve';

export interface Mode3Shape {
  id: string;
  /** Distance from the member's start, m, and the global displacement there (largest in the mode = 1). */
  s: number[];
  d: Vec3[];
}

export interface Buckling3Mode {
  alpha: number;
  members: Mode3Shape[];
}

export interface Buckling3Result {
  /** The lowest modes (up to three), α ascending; none when nothing is in compression. */
  modes: Buckling3Mode[];
  /** Buckling lengths of each compressed member in the lowest mode, m: π √(EI / (α_cr |N|)) about y and z. */
  Lcr: Record<string, { y: number; z: number }>;
}

/** Up to this many unknowns every eigenvalue is found (dense: repeated ones twice); above, the largest few by Lanczos. */
const DENSE_MAX = 300;
const MODE_STATIONS = 4;

export function buckling3(st: NumFrame, sol: FrameSolution, count = 3): Buckling3Result {
  const mesh = frameMesh3(st, elementsPerMember3(st.members.length));
  const results = new Map(sol.members.map((r) => [r.id, r]));

  // axial force per element as a straight line through its two Gauss points (clear of jumps
  // at its ends; exact for N linear); a force that is only round-off counts as none
  let scale = 1e-300;
  for (const r of sol.members) for (const v of [...r.N, ...r.Vy, ...r.Vz]) scale = Math.max(scale, Math.abs(v));
  const tidy = (N: number) => (Math.abs(N) > 1e-9 * scale ? N : 0);
  const Ne = mesh.chains.map((c) => c.elems.map((e): [number, number] => {
    const r = results.get(c.member.id)!;
    const mid = ((e.t0 + e.t1) / 2) * r.L, g = ((e.t1 - e.t0) * r.L) / (2 * Math.sqrt(3));
    const N1 = memberAt3(r, mid - g).N, N2 = memberAt3(r, mid + g).N;
    const mean = (N1 + N2) / 2, half = ((N2 - N1) * Math.sqrt(3)) / 2;
    return [tidy(mean - half), tidy(mean + half)];
  }));
  if (!Ne.some((list) => list.some(([a, b]) => a < 0 || b < 0))) return { modes: [], Lcr: {} };

  const dofs = nodeDofs(st, mesh);
  const sys = frameSystem(st, mesh, dofs);
  for (const [a, b, v] of freeRotations(sys.K, new Float64Array(dofs.count), st, mesh, dofs).entries) sys.K.add(a, b, v);
  const fail = { row: -1 };
  const ch = dofs.count ? skylineCholesky(sys.K, fail) : null;
  if (!ch) throw new StructureError(`The structure can move freely (a mechanism)${mechanismAt(st, mesh, dofs, fail.row)}: add supports, or remove releases`);
  const G = mesh.chains.map((c, ci) => chainMatrix(c, (e, q) => geometricK3(c.member, e.L, Ne[ci][q][0], Ne[ci][q][1])));

  // the whole frame's unknowns: the nodes (in the factor's order for y), then each member's own
  const ng = dofs.count, off: number[] = [];
  let N = ng;
  for (const c of mesh.chains) {
    off.push(N);
    N += c.size - 12;
  }
  const { order } = ch;
  /** x = L⁻ᵀ y (x with the nodes in their own numbering). */
  const backward = (y: ArrayLike<number>) => {
    const yg = skylineBackward(ch, Float64Array.from({ length: ng }, (_, i) => y[i]));
    const x = new Float64Array(N);
    for (let i = 0; i < ng; i++) x[order[i]] = yg[i];
    mesh.chains.forEach((c, ci) => {
      const cs = sys.chains[ci], xe = gather(sys.maps[ci], x), ni = c.size - 12;
      const t = Array.from({ length: ni }, (_, r) => y[off[ci] + r] - cs.Z[r].reduce((s, z, e) => s + z * xe[e], 0));
      ownBackward(cs.own, t).forEach((v, r) => (x[off[ci] + r] = v));
    });
    return x;
  };
  /** y = L⁻¹ b. */
  const forward = (b: Float64Array) => {
    const y = new Float64Array(N), bg = b.slice(0, ng);
    mesh.chains.forEach((c, ci) => {
      const cs = sys.chains[ci], ni = c.size - 12;
      const yo = ownForward(cs.own, b.subarray(off[ci], off[ci] + ni));
      yo.forEach((v, r) => (y[off[ci] + r] = v));
      sys.maps[ci].forEach((list, a) => {
        let s = 0;
        for (let r = 0; r < ni; r++) s += cs.Z[r][a] * yo[r];
        for (const [eq, w] of list) bg[eq] -= w * s;
      });
    });
    const yg = skylineForward(ch, Float64Array.from({ length: ng }, (_, i) => bg[order[i]]));
    y.set(yg, 0);
    return y;
  };
  /** −K_G x. */
  const negG = (x: Float64Array) => {
    const b = new Float64Array(N);
    mesh.chains.forEach((c, ci) => {
      const ni = c.size - 12, loc = [...gather(sys.maps[ci], x), ...x.subarray(off[ci], off[ci] + ni)];
      const g = G[ci].map((row) => -row.reduce((s, v, k) => s + v * loc[k], 0));
      sys.maps[ci].forEach((list, a) => { for (const [eq, w] of list) b[eq] += w * g[a]; });
      for (let r = 0; r < ni; r++) b[off[ci] + r] += g[12 + r];
    });
    return b;
  };
  const apply = (y: ArrayLike<number>) => forward(negG(backward(y)));

  let eig: { values: number[]; vectors: number[][] };
  if (N <= DENSE_MAX) {
    const cols = Array.from({ length: N }, (_, j) => apply(Array.from({ length: N }, (__, i) => (i === j ? 1 : 0))));
    const { values, vectors } = symmetricEigen(cols.map((_, i) => cols.map((col, j) => (col[i] + cols[i][j]) / 2)));
    const top = Math.max(...values.map(Math.abs), 1e-300);
    const picked: number[] = [];
    for (let i = values.length - 1; i >= 0 && picked.length < count; i--) if (values[i] > 1e-10 * top) picked.push(i);
    eig = { values: picked.map((i) => values[i]), vectors: picked.map((i) => vectors.map((row) => row[i])) };
  } else eig = largestEigen((x) => Array.from(apply(x)), N, count);

  const modes = eig.values.map((mu, mi): Buckling3Mode => {
    const x = backward(eig.vectors[mi]);
    const members = mesh.chains.map((c, ci): Mode3Shape => {
      const m = c.member, r = results.get(m.id)!, ni = c.size - 12;
      const loc = [...gather(sys.maps[ci], x), ...x.subarray(off[ci], off[ci] + ni)];
      const sh: Mode3Shape = { id: m.id, s: [], d: [] };
      // Hermite (Timoshenko) shapes in both planes: v from θ_z, w from −θ_y
      const fy = (L: number) => (12 * m.E * m.Iz) / (GAvy(m) * L * L), fz = (L: number) => (12 * m.E * m.Iy) / (GAvz(m) * L * L);
      c.elems.forEach((e, q) => {
        const dm = e.dofs.map((d) => loc[d]);
        const hermite = (d1: number, t1: number, d2: number, t2: number, f: number, x: number) => {
          const h = e.L / (1 + f);
          const N1 = (2 * x ** 3 - 3 * x * x - f * x + 1 + f) / (1 + f), N3 = (-2 * x ** 3 + 3 * x * x + f * x) / (1 + f);
          const N2 = h * (x ** 3 - (2 + f / 2) * x * x + (1 + f / 2) * x), N4 = h * (x ** 3 - (1 - f / 2) * x * x - (f / 2) * x);
          return N1 * d1 + N2 * t1 + N3 * d2 + N4 * t2;
        };
        const last = q === c.elems.length - 1;
        for (let k = 0; k <= (last ? MODE_STATIONS : MODE_STATIONS - 1); k++) {
          const t = k / MODE_STATIONS;
          const u = dm[0] + (dm[6] - dm[0]) * t;
          const v = hermite(dm[1], dm[5], dm[7], dm[11], fy(e.L), t), w = hermite(dm[2], -dm[4], dm[8], -dm[10], fz(e.L), t);
          sh.s.push((e.t0 + (e.t1 - e.t0) * t) * r.L);
          sh.d.push(toGlobal3(c.R, [u, v, w]));
        }
      });
      return sh;
    });
    // largest displacement 1, its largest component positive
    let big = 0, sign = 1;
    for (const sh of members) for (const d of sh.d) {
      const mag = Math.hypot(...d);
      if (mag > big) {
        big = mag;
        const k = [0, 1, 2].reduce((best, c) => (Math.abs(d[c]) > Math.abs(d[best]) ? c : best), 0);
        sign = Math.sign(d[k]) || 1;
      }
    }
    const k = big > 0 ? sign / big : 0;
    for (const sh of members) sh.d = sh.d.map((d) => d.map((v) => v * k) as Vec3);
    return { alpha: 1 / mu, members };
  });

  const Lcr: Buckling3Result['Lcr'] = {};
  const a1 = modes[0]?.alpha;
  if (a1) {
    for (const m of st.members) {
      const r = results.get(m.id)!, Nmin = Math.min(...r.N);
      if (Nmin < -1e-9 * scale) Lcr[m.id] = { y: Math.PI * Math.sqrt((m.E * m.Iy) / (a1 * -Nmin)), z: Math.PI * Math.sqrt((m.E * m.Iz) / (a1 * -Nmin)) };
    }
  }
  return { modes, Lcr };
}
