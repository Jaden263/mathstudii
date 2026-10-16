// Linear buckling of plane frames (EN 1993-1-1 5.2.1): the factor α_cr by which the
// loads of a combination can be multiplied before the structure becomes unstable, from
// (K + α K_G(N)) φ = 0 with the axial forces N of the first-order solution. Members are
// cut into short elements with the consistent geometric stiffness, so a member bowing
// between its ends (P-δ) is found as well as sway of the frame (P-Δ). Supports are
// eliminated from the unknowns and a hinged member end gets a rotation of its own. With
// K = L Lᵀ (Cholesky) the problem is the symmetric L⁻¹(−K_G)L⁻ᵀ y = (1/α) y, solved
// densely: its largest eigenvalues give the lowest α, and φ = L⁻ᵀ y the modes.
import { backward, cholesky, forward, largestEigen, symmetricEigen } from './eigen';
import {
  elementsPerMember, frameMesh, geometricK, localK, memberAt, shearStiffness, StructureError, subdivide, supportAxis, toGlobal,
  type BeamSolution, type FrameMesh, type NumStructure, type Piece,
} from './solve';

/** A buckling mode along one member, normalised so the largest displacement is 1. */
export interface ModeShape {
  id: string;
  /** Distance from the member's start, m. */
  s: number[];
  dx: number[];
  dy: number[];
}

export interface BucklingMode {
  alpha: number;
  members: ModeShape[];
}

export interface BucklingResult {
  /** The lowest modes (up to three), α ascending; none when nothing is in compression. */
  modes: BucklingMode[];
  /** Buckling length of each compressed member in the lowest mode, m: π √(EI / (α_cr |N|)), N its largest compression. */
  Lcr: Record<string, number>;
}

/** Stations per element along a mode shape. */
const MODE_STATIONS = 4;
/** Up to this many unknowns all eigenvalues are found (dense); above, the largest few by Lanczos. */
const DENSE_MAX = 240;

export function bucklingAnalysis(st: NumStructure, sol: BeamSolution, count = 3): BucklingResult {
  const mesh = frameMesh(st);
  const elems = subdivide(mesh, elementsPerMember(st.members.length));

  // axial force of each element as a straight line through its two Gauss points (inside
  // the element, so clear of jumps at its ends; exact for N linear); a force that is only
  // round-off counts as none
  const results = new Map(sol.members.map((r) => [r.id, r]));
  const scale = Math.max(Math.abs(sol.max.N?.value ?? 0), Math.abs(sol.max.V?.value ?? 0), 1e-300);
  const tidy = (N: number) => (Math.abs(N) > 1e-9 * scale ? N : 0);
  const Ne = elems.map((p): [number, number] => {
    const r = results.get(p.member.id);
    if (!r) return [0, 0];
    const mid = ((p.t0 + p.t1) / 2) * r.L, g = ((p.t1 - p.t0) * r.L) / (2 * Math.sqrt(3));
    const N1 = memberAt(r, mid - g).N, N2 = memberAt(r, mid + g).N;
    const mean = (N1 + N2) / 2, half = (N2 - N1) * Math.sqrt(3) / 2; // N2 − N1 over 1/√3 of the length
    return [tidy(mean - half), tidy(mean + half)];
  });
  if (!Ne.some(([a, b]) => a < 0 || b < 0)) return { modes: [], Lcr: {} };

  const { map, ends, count: nz, springs, rotSprings } = reducedDofs(st, mesh, elems);

  const K = Array.from({ length: nz }, () => new Array<number>(nz).fill(0));
  const G = Array.from({ length: nz }, () => new Array<number>(nz).fill(0));
  const scatter = (M: number[][], dofs: number[], target: number[][]) => {
    dofs.forEach((da, a) => dofs.forEach((db, b) => {
      const v = M[a][b];
      if (v) for (const [ia, wa] of map[da]) for (const [ib, wb] of map[db]) target[ia][ib] += wa * wb * v;
    }));
  };
  elems.forEach((p, ei) => {
    const m = p.member, GAv = shearStiffness(m);
    scatter(toGlobal(localK(m.E, m.A, m.I, p.L, GAv), p.c, p.s), ends[ei], K);
    const [Na, Nb] = Ne[ei];
    if (Na || Nb) scatter(toGlobal(geometricK(Na, p.L, (12 * m.E * m.I) / (GAv * p.L * p.L), Nb), p.c, p.s), ends[ei], G);
  });
  for (const sp of springs) {
    const [nx, ny] = sp.n;
    scatter([[sp.k * nx * nx, sp.k * nx * ny], [sp.k * nx * ny, sp.k * ny * ny]], [3 * sp.node, 3 * sp.node + 1], K);
  }
  for (const sp of rotSprings) scatter([[sp.kr]], [3 * sp.node + 2], K);

  // numbered for a narrow band, K = L Lᵀ, and the eigenvalues of A = L⁻¹(−G)L⁻ᵀ: all of
  // them for a small model (repeated modes come out twice), the largest few by Lanczos
  // for a big one
  const order = bandOrder(K);
  const Kp = order.map((i) => order.map((j) => K[i][j]));
  const negG = order.map((i) => order.flatMap((j, c) => (G[i][j] ? [[c, -G[i][j]]] : [])));
  const ch = cholesky(Kp);
  if (!ch) throw new StructureError('The structure can move freely (a mechanism): add supports, or remove hinges');
  const timesG = (x: number[]) => negG.map((row) => row.reduce((acc, [c, v]) => acc + v * x[c], 0));
  let eig: { values: number[]; vectors: number[][] };
  if (nz <= DENSE_MAX) {
    const Ycols = Kp.map((_, j) => forward(ch, timesG(Kp.map((__, i) => (i === j ? 1 : 0)))));
    const Arows = Array.from({ length: nz }, (_, i) => forward(ch, Ycols.map((col) => col[i])));
    const { values, vectors } = symmetricEigen(Arows.map((row, i) => row.map((v, j) => (v + Arows[j][i]) / 2)));
    const top = Math.max(...values.map(Math.abs), 1e-300);
    const picked: number[] = [];
    for (let i = values.length - 1; i >= 0 && picked.length < count; i--) if (values[i] > 1e-10 * top) picked.push(i);
    eig = { values: picked.map((i) => values[i]), vectors: picked.map((i) => vectors.map((row) => row[i])) };
  } else eig = largestEigen((y) => forward(ch, timesG(backward(ch, y))), nz, count);

  const members = new Map(st.members.map((m) => [m.id, m]));
  const modes: BucklingMode[] = eig.values.map((mu, i) => {
    const phiP = backward(ch, eig.vectors[i]);
    const phi = new Array<number>(nz);
    order.forEach((o, k) => (phi[o] = phiP[k]));
    const full = (f: number) => map[f].reduce((acc, [z, w]) => acc + w * phi[z], 0);
    const shapes = new Map<string, ModeShape>();
    elems.forEach((p, ei) => {
      const m = p.member, r = results.get(m.id);
      const Lm = r?.L ?? p.L / (p.t1 - p.t0);
      let sh = shapes.get(m.id);
      if (!sh) shapes.set(m.id, (sh = { id: m.id, s: [], dx: [], dy: [] }));
      const g = ends[ei].map(full);
      const u1 = p.c * g[0] + p.s * g[1], v1 = -p.s * g[0] + p.c * g[1];
      const u2 = p.c * g[3] + p.s * g[4], v2 = -p.s * g[3] + p.c * g[4];
      // Timoshenko shape functions (Hermite cubics without shear)
      const f = (12 * m.E * m.I) / (shearStiffness(m) * p.L * p.L), h = p.L / (1 + f);
      const last = ei === elems.length - 1 || elems[ei + 1].member !== m;
      for (let q = 0; q <= (last ? MODE_STATIONS : MODE_STATIONS - 1); q++) {
        const x = q / MODE_STATIONS;
        const N1 = (2 * x ** 3 - 3 * x * x - f * x + 1 + f) / (1 + f), N3 = (-2 * x ** 3 + 3 * x * x + f * x) / (1 + f);
        const N2 = h * (x ** 3 - (2 + f / 2) * x * x + (1 + f / 2) * x), N4 = h * (x ** 3 - (1 - f / 2) * x * x - (f / 2) * x);
        const v = N1 * v1 + N2 * g[2] + N3 * v2 + N4 * g[5], u = u1 + (u2 - u1) * x;
        sh.s.push((p.t0 + (p.t1 - p.t0) * x) * Lm);
        sh.dx.push(p.c * u - p.s * v);
        sh.dy.push(p.s * u + p.c * v);
      }
    });
    // largest displacement 1, pointing the way the structure deflects under the loads
    // (else its largest component positive)
    let big = 0, sign = 1, along = 0, mm = 0, dd = 0;
    for (const sh of shapes.values()) {
      const r = results.get(sh.id);
      sh.dx.forEach((dx, k) => {
        const dy = sh.dy[k], mag = Math.hypot(dx, dy);
        if (mag > big) {
          big = mag;
          sign = Math.abs(dx) > Math.abs(dy) ? Math.sign(dx) : Math.sign(dy);
        }
        if (r) {
          const d = memberAt(r, Math.min(sh.s[k], r.L));
          along += dx * d.dx + dy * d.dy;
          mm += dx * dx + dy * dy;
          dd += d.dx * d.dx + d.dy * d.dy;
        }
      });
    }
    // (a mode at right angles to the deflection, like sway under symmetric loads, keeps the rule above)
    if (Math.abs(along) > 1e-3 * Math.sqrt(mm * dd)) sign = Math.sign(along);
    const k = big > 0 ? sign / big : 0;
    for (const sh of shapes.values()) {
      sh.dx = sh.dx.map((v) => v * k);
      sh.dy = sh.dy.map((v) => v * k);
    }
    return { alpha: 1 / mu, members: st.members.map((m) => shapes.get(m.id)!).filter(Boolean) };
  });

  const Lcr: Record<string, number> = {};
  const a1 = modes[0]?.alpha;
  if (a1) {
    for (const r of sol.members) {
      const m = members.get(r.id);
      const Nmin = Math.min(...r.N);
      if (m && Nmin < -1e-9 * scale) Lcr[r.id] = Math.PI * Math.sqrt((m.E * m.I) / (a1 * -Nmin));
    }
  }
  return { modes, Lcr };
}

/** The unknowns of a mesh with the supports eliminated (see {@link reducedDofs}). */
export interface ReducedDofs {
  /** Each full unknown (x, y, rotation per node, then one per hinged element end) as [reduced unknown, weight] pairs. */
  map: [number, number][][];
  /** The six full unknowns at the ends of each element. */
  ends: number[][];
  count: number;
  /** Elastic supports: along their axis, and rotational. */
  springs: { node: number; n: [number, number]; k: number }[];
  rotSprings: { node: number; kr: number }[];
}

/**
 * Unknowns: per node x and y (less what the supports hold) and the rotation (unless
 * held, or every member end there is hinged); a hinged member end turns on its own.
 * A node held in one direction keeps one unknown along the other, so inclined rollers
 * need nothing special.
 */
export function reducedDofs(st: NumStructure, mesh: FrameMesh, elems: Piece[]): ReducedDofs {
  const nn = mesh.pos.length;
  const held = Array.from({ length: nn }, () => ({ dirs: [] as [number, number][], rot: false }));
  const springs: ReducedDofs['springs'] = [];
  const rotSprings: ReducedDofs['rotSprings'] = [];
  for (const sp of st.supports) {
    const k = mesh.nodeIndex.get(sp.node);
    if (k === undefined) continue;
    const n = supportAxis(sp.angle);
    if (sp.k && sp.k > 0) springs.push({ node: k, n, k: sp.k });
    else held[k].dirs.push(n);
    if (sp.type !== 'roller') held[k].dirs.push([n[1], -n[0]]);
    if (sp.type === 'fixed') {
      if (sp.kr && sp.kr > 0) rotSprings.push({ node: k, kr: sp.kr });
      else held[k].rot = true;
    }
  }
  const turns = new Array<boolean>(nn).fill(false);
  for (const p of elems) {
    if (!p.hingeI) turns[p.i] = true;
    if (!p.hingeJ) turns[p.j] = true;
  }
  // full unknowns: 3 per node, then one per hinged element end; each maps onto the reduced ones
  const map: [number, number][][] = [];
  let nz = 0;
  for (let k = 0; k < nn; k++) {
    const { dirs, rot } = held[k];
    const d0 = dirs[0];
    if (!d0) {
      map.push([[nz++, 1]], [[nz++, 1]]);
    } else if (dirs.every((d) => Math.abs(d0[0] * d[1] - d0[1] * d[0]) < 1e-9)) {
      // held in one direction: free along the other
      const z = nz++;
      map.push([[z, -d0[1]]], [[z, d0[0]]]);
    } else map.push([], []);
    map.push(turns[k] && !rot ? [[nz++, 1]] : []);
  }
  const ends = elems.map((p) => {
    const a = p.hingeI ? map.push([[nz++, 1]]) - 1 : 3 * p.i + 2;
    const b = p.hingeJ ? map.push([[nz++, 1]]) - 1 : 3 * p.j + 2;
    return [3 * p.i, 3 * p.i + 1, a, 3 * p.j, 3 * p.j + 1, b];
  });
  return { map, ends, count: nz, springs, rotSprings };
}

/**
 * Reverse Cuthill–McKee: a numbering that keeps the nonzeros of a sparse symmetric
 * matrix near the diagonal, so its Cholesky factor stays inside a narrow envelope.
 */
function bandOrder(K: number[][]): number[] {
  const n = K.length;
  const adj = K.map((row, i) => row.flatMap((v, j) => (v !== 0 && j !== i ? [j] : [])));
  const seen = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  while (order.length < n) {
    // each connected part from an unvisited unknown of least degree
    let s = -1;
    for (let i = 0; i < n; i++) if (!seen[i] && (s < 0 || adj[i].length < adj[s].length)) s = i;
    seen[s] = true;
    const queue = [s];
    for (let h = 0; h < queue.length; h++) {
      const v = queue[h];
      order.push(v);
      for (const w of adj[v].filter((x) => !seen[x]).sort((x, y) => adj[x].length - adj[y].length)) {
        seen[w] = true;
        queue.push(w);
      }
    }
  }
  return order.reverse();
}
