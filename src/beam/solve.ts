// Plane frame analysis by the direct stiffness method (Euler–Bernoulli members, or
// Timoshenko members with shear deformation; linear elastic). Works in SI units (N, m, Pa).
//
// Members are split where loads sit, so every piece carries a linear line load at
// most. For those pieces the nodal results are exact, and internal forces follow
// exactly from statics: N, V and M are polynomials of degree ≤ 1, 2 and 3. The deflection
// comes from integrating M/EI twice between the exact end displacements, which is
// exact too. Supports enter as constraints (Lagrange multipliers), so the multipliers
// are the support reactions and inclined rollers need no special treatment.
//
// Second order: equilibrium on the deformed structure. Each piece is cut into short
// elements carrying the consistent geometric stiffness of their axial force, so sway of
// the structure (P-Δ) and bowing of the members (P-δ) both count; the axial forces are
// iterated until the displacements settle. Along each element the moment is then statics
// on the deformed element, M = M_I + N (v − v_start).

export interface NumMember {
  id: string;
  a: string;
  b: string;
  E: number;
  A: number;
  I: number;
  W?: number;
  hingeA?: boolean;
  hingeB?: boolean;
  /** Shear modulus (Pa) and shear area (m²): with both, a Timoshenko member. */
  G?: number;
  Av?: number;
}

export interface NumSupport {
  id: string;
  node: string;
  type: 'pin' | 'roller' | 'fixed';
  /** Rotation of the support symbol, radians (0 = on the ground). */
  angle: number;
  label: string;
  /** Spring stiffness along the support normal, N/m (replaces the rigid constraint there). */
  k?: number;
  /** Rotational spring of a fixed support, N·m/rad (a semi-rigid foot). */
  kr?: number;
  /** Settlement along the support normal, m (positive into the support: down for one on the ground). */
  settle?: number;
}

export type NumAt = { node: string } | { member: string; t: number };

export type NumLoad =
  | { id: string; type: 'force'; at: NumAt; Fx: number; Fy: number }
  | { id: string; type: 'moment'; at: NumAt; M: number }
  /** q > 0 acts downwards ('global') or towards the member's right side, −local y ('local'). */
  | { id: string; type: 'line'; member: string; t1: number; t2: number; q1: number; q2: number; dir: 'global' | 'local' };

export interface NumStructure {
  nodes: { id: string; x: number; y: number }[];
  members: NumMember[];
  supports: NumSupport[];
  loads: NumLoad[];
}

export interface MemberResult {
  id: string;
  L: number;
  /** Stations: distance from the member's start node. A station repeats where a value jumps. */
  s: number[];
  N: number[];
  V: number[];
  M: number[];
  /** Global displacement at each station. */
  dx: number[];
  dy: number[];
  /** Extreme fibre stress |N|/A + |M|/W, when W is known. */
  sigma?: number[];
  /** Exact polynomials per piece (ascending coefficients in the local x of the piece). */
  pieces: PiecePoly[];
}

export interface PiecePoly {
  /** Start of the piece along the member, and its length. */
  s0: number;
  L: number;
  c: number;
  s: number;
  N: number[];
  V: number[];
  M: number[];
  /** Axial (u) and transverse (v) displacement in member axes. */
  u: number[];
  v: number[];
}

export const polyAt = (p: number[], x: number) => p.reduceRight((acc, c) => acc * x + c, 0);

/** Values at distance s along a member (the right-hand side at a jump). */
export function memberAt(r: MemberResult, s: number): { N: number; V: number; M: number; dx: number; dy: number } {
  const p = r.pieces.find((q, i) => s < q.s0 + q.L - 1e-12 || i === r.pieces.length - 1)!;
  const x = Math.min(Math.max(s - p.s0, 0), p.L);
  const u = polyAt(p.u, x), v = polyAt(p.v, x);
  return { N: polyAt(p.N, x), V: polyAt(p.V, x), M: polyAt(p.M, x), dx: p.c * u - p.s * v, dy: p.s * u + p.c * v };
}

export interface Extreme {
  value: number;
  member: string;
  s: number;
  x: number;
  y: number;
}

export interface Reaction {
  id: string;
  label: string;
  node: string;
  Rx: number;
  Ry: number;
  M: number;
}

export interface BeamSolution {
  members: MemberResult[];
  reactions: Reaction[];
  nodes: Record<string, { dx: number; dy: number; rz: number }>;
  max: { N?: Extreme; V?: Extreme; M?: Extreme; w?: Extreme; sigma?: Extreme };
  /** Degree of static indeterminacy (0 = determinate). */
  indeterminacy: number;
  /** Second order: the iterations it took, and the first-order extremes and reactions to compare. */
  secondOrder?: { iterations: number; first?: { max: BeamSolution['max']; reactions: Reaction[] } };
}

export interface SolveOptions {
  /** Equilibrium on the deformed structure (P-Δ and P-δ), iterated on the axial forces. */
  secondOrder?: boolean;
}

export class StructureError extends Error {}
/** No stable equilibrium on the deformed structure: the loads reach the critical load. */
export class InstabilityError extends StructureError {}

/** One straight piece of a member between split points, with its linear line load (local axes). */
export interface Piece {
  member: NumMember;
  t0: number;
  t1: number;
  i: number; // node index at the start
  j: number; // node index at the end
  hingeI: boolean;
  hingeJ: boolean;
  L: number;
  c: number;
  s: number;
  qxa: number; qxb: number; qya: number; qyb: number;
  /** Index of the piece an element was cut from (itself for a piece). */
  group: number;
}

const STATIONS = 24;

/** Shear stiffness G·A_v of a member (∞: Euler–Bernoulli). */
export const shearStiffness = (m: NumMember): number => (m.G && m.Av && m.G > 0 && m.Av > 0 ? m.G * m.Av : Infinity);

/**
 * Local stiffness of a frame member (u1 v1 θ1 u2 v2 θ2). With a finite shear stiffness
 * G·A_v it is the Timoshenko beam, φ = 12 EI / (G A_v L²).
 */
export function localK(E: number, A: number, I: number, L: number, GAv = Infinity): number[][] {
  const phi = (12 * E * I) / (GAv * L * L);
  const a = (E * A) / L, b = (12 * E * I) / (L ** 3 * (1 + phi)), c = (6 * E * I) / (L ** 2 * (1 + phi));
  const d = ((4 + phi) * E * I) / (L * (1 + phi)), e = ((2 - phi) * E * I) / (L * (1 + phi));
  return [
    [a, 0, 0, -a, 0, 0],
    [0, b, c, 0, -b, c],
    [0, c, d, 0, -c, e],
    [-a, 0, 0, a, 0, 0],
    [0, -b, -c, 0, b, -c],
    [0, c, e, 0, -c, d],
  ];
}

/**
 * Consistent geometric stiffness of an axial force N (tension positive: it stiffens,
 * compression softens), from the cubic shape functions; with shear the Timoshenko ones.
 */
export function geometricK(N: number, L: number, phi = 0): number[][] {
  const f = N / (L * (1 + phi) ** 2);
  const a = (6 / 5 + 2 * phi + phi * phi) * f, b = (L / 10) * f;
  const c = L * L * (2 / 15 + phi / 6 + (phi * phi) / 12) * f, d = -L * L * (1 / 30 + phi / 6 + (phi * phi) / 12) * f;
  return [
    [0, 0, 0, 0, 0, 0],
    [0, a, b, 0, -a, b],
    [0, b, c, 0, -b, d],
    [0, 0, 0, 0, 0, 0],
    [0, -a, -b, 0, a, -b],
    [0, b, d, 0, -b, c],
  ];
}

/**
 * Equivalent nodal loads of a linear line load on a fixed-ended piece (local axes).
 * Euler–Bernoulli in closed form; with shear, the two end conditions of a clamped
 * Timoshenko beam (no end rotation: ∫M dx = 0, no end deflection: ∫(L−x)M/EI − ΔM/GA_v = 0)
 * give the start moment and shear.
 */
function fixedEndForces(p: Piece, EI: number, GAv: number): number[] {
  const L = p.L;
  const ax = [(L * (2 * p.qxa + p.qxb)) / 6, (L * (p.qxa + 2 * p.qxb)) / 6];
  if (!Number.isFinite(GAv)) {
    return [
      ax[0], (L * (7 * p.qya + 3 * p.qyb)) / 20, (L * L * (3 * p.qya + 2 * p.qyb)) / 60,
      ax[1], (L * (3 * p.qya + 7 * p.qyb)) / 20, (-L * L * (2 * p.qya + 3 * p.qyb)) / 60,
    ];
  }
  // M(x) = M0 + V0 x + q_a x²/2 + b x³/6
  const qa = p.qya, by = (p.qyb - p.qya) / L, psi = EI / GAv;
  const a11 = L, a12 = (L * L) / 2, r1 = -(qa * L ** 3) / 6 - (by * L ** 4) / 24;
  const a21 = (L * L) / 2, a22 = L ** 3 / 6 - psi * L, r2 = -qa * (L ** 4 / 24 - (psi * L * L) / 2) - by * (L ** 5 / 120 - (psi * L ** 3) / 6);
  const det = a11 * a22 - a12 * a21;
  const M0 = (r1 * a22 - a12 * r2) / det, V0 = (a11 * r2 - a21 * r1) / det;
  const ML = M0 + V0 * L + (qa * L * L) / 2 + (by * L ** 3) / 6;
  const Q = (L * (p.qya + p.qyb)) / 2;
  return [ax[0], -V0, M0, ax[1], Q + V0, -ML];
}

/** Statically condense released DOFs (their end force is zero). */
function condense(k: number[][], f: number[], released: number[]): void {
  for (const r of released) {
    const krr = k[r][r];
    if (!(Math.abs(krr) > 0)) continue;
    const col = k.map((row) => row[r]);
    const rowR = [...k[r]];
    const fr = f[r];
    for (let i = 0; i < 6; i++) {
      f[i] -= (col[i] * fr) / krr;
      for (let j = 0; j < 6; j++) k[i][j] -= (col[i] * rowR[j]) / krr;
    }
    for (let i = 0; i < 6; i++) {
      k[i][r] = 0;
      k[r][i] = 0;
    }
    f[r] = 0;
  }
}

/**
 * Gaussian elimination with partial pivoting; throws on a singular system. `info.sign`
 * receives the sign of the determinant (second order watches it flip at instability).
 */
function solveDense(A: number[][], b: number[], info?: { sign: number }): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  // (a loop: spreading n² values into Math.max overflows the stack for big frames)
  let scale = 1e-300;
  for (const row of M) for (let c = 0; c < n; c++) scale = Math.max(scale, Math.abs(row[c]));
  let sign = 1;
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    if (Math.abs(M[p][col]) < 1e-11 * scale) throw new StructureError('The structure can move freely (a mechanism): add supports, or remove hinges');
    if (p !== col) sign = -sign;
    if (M[p][col] < 0) sign = -sign;
    [M[col], M[p]] = [M[p], M[col]];
    for (let r = col + 1; r < n; r++) {
      const k = M[r][col] / M[col][col];
      if (!k) continue;
      for (let c = col; c <= n; c++) M[r][c] -= k * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  if (info) info.sign = sign;
  return x;
}

/** Nodes and pieces of a structure: members split where loads sit. */
export interface FrameMesh {
  nodeIndex: Map<string, number>;
  /** Node positions: the structure's nodes, then the split points (and element ends). */
  pos: { x: number; y: number }[];
  pieces: Piece[];
  /** The node at fraction t along a member (created on first use). */
  pointOn: (m: NumMember, t: number) => number;
}

export function frameMesh(st: NumStructure): FrameMesh {
  if (!st.members.length) throw new StructureError('Draw at least one member');
  if (!st.supports.length) throw new StructureError('Add supports: the structure needs to be held in place');
  const nodeIndex = new Map<string, number>();
  const pos: { x: number; y: number }[] = [];
  for (const q of st.nodes) {
    nodeIndex.set(q.id, pos.length);
    pos.push({ x: q.x, y: q.y });
  }
  for (const m of st.members) {
    if (!nodeIndex.has(m.a) || !nodeIndex.has(m.b)) throw new StructureError('A member is missing a node');
    if (!(m.E > 0 && m.A > 0 && m.I > 0)) throw new StructureError('E, A and I must be positive');
    const a = pos[nodeIndex.get(m.a)!], b = pos[nodeIndex.get(m.b)!];
    if (!(Math.hypot(b.x - a.x, b.y - a.y) > 0)) throw new StructureError('A member has zero length');
  }

  // split points per member: point loads, moments and the ends of partial line loads
  const splits = new Map<string, Set<number>>(st.members.map((m) => [m.id, new Set([0, 1])]));
  for (const l of st.loads) {
    if (l.type === 'line') {
      splits.get(l.member)?.add(clampT(l.t1)).add(clampT(l.t2));
    } else if ('member' in l.at) splits.get(l.at.member)?.add(clampT(l.at.t));
  }
  const inner = new Map<string, number>(); // `${member}@${t}` → node index
  const pointOn = (m: NumMember, t: number): number => {
    if (t <= 1e-12) return nodeIndex.get(m.a)!;
    if (t >= 1 - 1e-12) return nodeIndex.get(m.b)!;
    const key = `${m.id}@${t}`;
    let k = inner.get(key);
    if (k === undefined) {
      const a = pos[nodeIndex.get(m.a)!], b = pos[nodeIndex.get(m.b)!];
      k = pos.length;
      pos.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      inner.set(key, k);
    }
    return k;
  };

  const pieces: Piece[] = [];
  for (const m of st.members) {
    const ts = [...splits.get(m.id)!].sort((p, q) => p - q).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 1e-9);
    const a = pos[nodeIndex.get(m.a)!], b = pos[nodeIndex.get(m.b)!];
    const Lm = Math.hypot(b.x - a.x, b.y - a.y);
    const c = (b.x - a.x) / Lm, s = (b.y - a.y) / Lm;
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      const p: Piece = {
        member: m, t0, t1, i: pointOn(m, t0), j: pointOn(m, t1), hingeI: !!m.hingeA && t0 === 0, hingeJ: !!m.hingeB && t1 === 1,
        L: Lm * (t1 - t0), c, s, qxa: 0, qxb: 0, qya: 0, qyb: 0, group: pieces.length,
      };
      for (const l of st.loads) {
        if (l.type !== 'line' || l.member !== m.id) continue;
        const la = Math.min(l.t1, l.t2), lb = Math.max(l.t1, l.t2);
        if (t0 < la - 1e-12 || t1 > lb + 1e-12 || lb - la <= 0) continue;
        const qAt = (t: number) => l.q1 + ((l.q2 - l.q1) * (t - l.t1)) / (l.t2 - l.t1);
        const qa = qAt(t0), qb = qAt(t1);
        if (l.dir === 'local') {
          p.qya -= qa;
          p.qyb -= qb;
        } else {
          // downward per length of member: (0, −q) in local axes
          p.qxa -= qa * s; p.qxb -= qb * s;
          p.qya -= qa * c; p.qyb -= qb * c;
        }
      }
      pieces.push(p);
    }
  }
  return { nodeIndex, pos, pieces, pointOn };
}

const clampT = (t: number) => Math.min(1, Math.max(0, t));

/**
 * Elements per member for second order and buckling. Eight cubic elements put the
 * critical load of a fixed-ended column within 0.1 % (four: 0.8 %); big frames get
 * fewer, never under four.
 */
export function elementsPerMember(members: number): number {
  return Math.max(4, Math.min(8, Math.floor(160 / Math.max(1, members))));
}

/**
 * Cut the pieces into elements, about `n` per member (at least one per piece). Line
 * loads are interpolated; hinges stay at the member ends.
 */
export function subdivide(mesh: FrameMesh, n: number): Piece[] {
  const out: Piece[] = [];
  for (const p of mesh.pieces) {
    const k = Math.max(1, Math.round(n * (p.t1 - p.t0)));
    for (let q = 0; q < k; q++) {
      const f0 = q / k, f1 = (q + 1) / k;
      const t0 = q === 0 ? p.t0 : p.t0 + (p.t1 - p.t0) * f0, t1 = q === k - 1 ? p.t1 : p.t0 + (p.t1 - p.t0) * f1;
      const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
      out.push({
        ...p, t0, t1, i: q === 0 ? p.i : mesh.pointOn(p.member, t0), j: q === k - 1 ? p.j : mesh.pointOn(p.member, t1),
        hingeI: p.hingeI && q === 0, hingeJ: p.hingeJ && q === k - 1, L: p.L / k,
        qxa: lerp(p.qxa, p.qxb, f0), qxb: lerp(p.qxa, p.qxb, f1), qya: lerp(p.qya, p.qyb, f0), qyb: lerp(p.qya, p.qyb, f1),
      });
    }
  }
  return out;
}

/** Transformation local → global of an element's end values, R = blockdiag([[c, s, 0], [−s, c, 0], [0, 0, 1]]). */
const rotation = (c: number, s: number) => [[c, s, 0, 0, 0, 0], [-s, c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, c, s, 0], [0, 0, 0, -s, c, 0], [0, 0, 0, 0, 0, 1]];

/** Rᵀ k R: a local element matrix in global axes. */
export function toGlobal(k: number[][], c: number, s: number): number[][] {
  const R = rotation(c, s);
  const kR = k.map((row) => R[0].map((_, j) => row.reduce((acc, v, q) => acc + v * R[q][j], 0)));
  return R[0].map((_, a) => R[0].map((__, b) => {
    let v = 0;
    for (let q = 0; q < 6; q++) v += R[q][a] * kR[q][b];
    return v;
  }));
}

// polynomials, ascending coefficients
const padd = (a: number[], b: number[]) => Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
const pscale = (a: number[], k: number) => a.map((v) => v * k);
const pint = (a: number[]) => [0, ...a.map((v, i) => v / (i + 1))];
const pder = (a: number[]) => a.slice(1).map((v, i) => v * (i + 1));

/** Roots of a polynomial inside (0, L), by sign changes on a fine grid and bisection. */
function rootsIn(p: number[], L: number, n = 12): number[] {
  const out: number[] = [];
  let x0 = 0, f0 = polyAt(p, 0);
  for (let k = 1; k <= n; k++) {
    const x1 = (L * k) / n, f1 = polyAt(p, x1);
    if (f0 * f1 < 0) {
      let a = x0, b = x1, fa = f0;
      for (let it = 0; it < 50; it++) {
        const m = (a + b) / 2, fm = polyAt(p, m);
        if (fa * fm <= 0) b = m;
        else { a = m; fa = fm; }
      }
      out.push((a + b) / 2);
    }
    x0 = x1; f0 = f1;
  }
  return out;
}

const MAX_ITERATIONS = 30;

export function solveStructure(st: NumStructure, opts: SolveOptions = {}): BeamSolution {
  const mesh = frameMesh(st);
  const { nodeIndex, pos, pieces, pointOn } = mesh;
  const second = !!opts.secondOrder;
  // second order works on short elements; first order on the pieces themselves (exact)
  const elems = second ? subdivide(mesh, elementsPerMember(st.members.length)) : pieces;

  const nodeOf = (at: NumAt): number => {
    if ('node' in at) {
      const k = nodeIndex.get(at.node);
      if (k === undefined) throw new StructureError('A load sits on a missing node');
      return k;
    }
    const m = st.members.find((q) => q.id === at.member);
    if (!m) throw new StructureError('A load sits on a missing member');
    return pointOn(m, clampT(at.t));
  };
  // nodal loads find their nodes before the size of the system is known
  const nodal = st.loads.map((l) => (l.type === 'line' ? -1 : nodeOf(l.at)));

  const nn = pos.length, ndof = 3 * nn;
  // springs act as stiffness instead of a constraint; their reactions are added afterwards
  const springs: { support: number; node: number; n: [number, number]; k: number; settle: number }[] = [];
  const rotSprings: { support: number; node: number; kr: number }[] = [];
  st.supports.forEach((sp, si) => {
    const k = nodeIndex.get(sp.node);
    if (k === undefined) return;
    if (sp.k && sp.k > 0) springs.push({ support: si, node: k, n: [-Math.sin(sp.angle), Math.cos(sp.angle)], k: sp.k, settle: sp.settle ?? 0 });
    if (sp.type === 'fixed' && sp.kr && sp.kr > 0) rotSprings.push({ support: si, node: k, kr: sp.kr });
  });

  /** Global stiffness and load vector; `Ne` (second order) are the elements' axial forces. */
  const assemble = (Ne?: number[]) => {
    const K = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0));
    const F = new Array<number>(ndof).fill(0);
    const elemK: number[][][] = [];
    const elemF: number[][] = [];
    elems.forEach((p, pi) => {
      const m = p.member, GAv = shearStiffness(m);
      const k = localK(m.E, m.A, m.I, p.L, GAv);
      if (Ne) {
        const kg = geometricK(Ne[pi], p.L, (12 * m.E * m.I) / (GAv * p.L * p.L));
        for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) k[a][b] += kg[a][b];
      }
      const f = fixedEndForces(p, m.E * m.I, GAv);
      condense(k, f, [...(p.hingeI ? [2] : []), ...(p.hingeJ ? [5] : [])]);
      elemK.push(k);
      elemF.push(f);
      // global: k_g = Tᵀ k T, f_g = Tᵀ f with T = blockdiag(R, R), R = [[c, s, 0], [−s, c, 0], [0, 0, 1]]
      const T = (v: number[]) => [p.c * v[0] - p.s * v[1], p.s * v[0] + p.c * v[1], v[2]];
      const dofs = [3 * p.i, 3 * p.i + 1, 3 * p.i + 2, 3 * p.j, 3 * p.j + 1, 3 * p.j + 2];
      const kg = toGlobal(k, p.c, p.s);
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) K[dofs[a]][dofs[b]] += kg[a][b];
      const fg = [...T(f.slice(0, 3)), ...T(f.slice(3))];
      dofs.forEach((d, a) => (F[d] += fg[a]));
    });
    st.loads.forEach((l, li) => {
      if (l.type === 'force') {
        F[3 * nodal[li]] += l.Fx;
        F[3 * nodal[li] + 1] += l.Fy;
      } else if (l.type === 'moment') F[3 * nodal[li] + 2] += l.M;
    });
    for (const sp of springs) {
      const [nx, ny] = sp.n, k = sp.node;
      K[3 * k][3 * k] += sp.k * nx * nx;
      K[3 * k][3 * k + 1] += sp.k * nx * ny;
      K[3 * k + 1][3 * k] += sp.k * nx * ny;
      K[3 * k + 1][3 * k + 1] += sp.k * ny * ny;
      // the spring's foot moves down by the settlement: it pulls the node along
      F[3 * k] -= sp.k * sp.settle * nx;
      F[3 * k + 1] -= sp.k * sp.settle * ny;
    }
    for (const sp of rotSprings) K[3 * sp.node + 2][3 * sp.node + 2] += sp.kr;
    return { K, F, elemK, elemF };
  };

  const first = assemble();
  const { K } = first;
  let { F, elemK, elemF } = first;

  // constraints: supports, plus rotations nothing holds (every member end hinged there)
  // rows hold displacements: normal (along the support's axis) and, for pins and fixed
  // supports, tangential; `rhs` is a prescribed displacement (settlement)
  const rows: { dof: number[]; w: number[]; support?: number; dir: [number, number, number]; rhs?: number }[] = [];
  st.supports.forEach((sp, si) => {
    const k = nodeIndex.get(sp.node);
    if (k === undefined) return;
    const nx = -Math.sin(sp.angle), ny = Math.cos(sp.angle);
    const settle = sp.settle ?? 0;
    if (!(sp.k && sp.k > 0)) rows.push({ dof: [3 * k, 3 * k + 1], w: [nx, ny], support: si, dir: [nx, ny, 0], ...(settle ? { rhs: -settle } : {}) });
    if (sp.type !== 'roller') rows.push({ dof: [3 * k, 3 * k + 1], w: [ny, -nx], support: si, dir: [ny, -nx, 0] });
    if (sp.type === 'fixed' && !(sp.kr && sp.kr > 0)) rows.push({ dof: [3 * k + 2], w: [1], support: si, dir: [0, 0, 1] });
  });
  const kmax = Math.max(...K.map((row, i) => Math.abs(row[i])), 1e-300);
  const heldRot = new Set(rows.filter((r) => r.dir[2]).map((r) => r.dof[0]));
  for (let k = 0; k < nn; k++) {
    const d = 3 * k + 2;
    if (Math.abs(K[d][d]) > 1e-12 * kmax || heldRot.has(d)) continue;
    if (Math.abs(F[d]) > 0) throw new StructureError('A moment acts on a hinge, where nothing can carry it');
    rows.push({ dof: [d], w: [1], dir: [0, 0, 0] });
  }

  // augmented system [K Cᵀ; C 0] (constraint rows scaled to the stiffness)
  const nc = rows.length;
  const solveSystem = (Kx: number[][], Fx: number[], info?: { sign: number }) => {
    const Aug = Array.from({ length: ndof + nc }, (_, i) => (i < ndof ? [...Kx[i], ...new Array<number>(nc).fill(0)] : new Array<number>(ndof + nc).fill(0)));
    rows.forEach((r, c) => r.dof.forEach((d, q) => {
      Aug[ndof + c][d] = r.w[q] * kmax;
      Aug[d][ndof + c] = r.w[q] * kmax;
    }));
    return solveDense(Aug, [...Fx, ...rows.map((r) => (r.rhs ?? 0) * kmax)], info);
  };
  const det0 = { sign: 1 };
  let sol = solveSystem(K, F, det0);
  let D = sol.slice(0, ndof);

  /** End displacements and end forces of an element in its local axes. */
  const endForces = (p: Piece, k: number[][], f: number[]) => {
    const g = [3 * p.i, 3 * p.i + 1, 3 * p.i + 2, 3 * p.j, 3 * p.j + 1, 3 * p.j + 2].map((d) => D[d]);
    const loc = (u: number, v: number) => [p.c * u + p.s * v, -p.s * u + p.c * v];
    const [u1, v1] = loc(g[0], g[1]), [u2, v2] = loc(g[3], g[4]);
    const dl = [u1, v1, g[2], u2, v2, g[5]];
    return { dl, pe: k.map((row, i) => row.reduce((acc, v, j) => acc + v * dl[j], 0) - f[i]) };
  };

  // second order: re-solve with the geometric stiffness of the current axial forces until
  // the displacements stop changing. A determinant changing sign means a stiffness went
  // negative: the loads passed a critical load, and there is no stable equilibrium.
  let iterations = 0;
  if (second) {
    let converged = false;
    for (let it = 1; it <= MAX_ITERATIONS && !converged; it++) {
      const Ne = elems.map((p, pi) => {
        const { pe } = endForces(p, elemK[pi], elemF[pi]);
        // mean axial force over the element (N varies with an axial line load)
        return -pe[0] - (p.qxa * p.L) / 2 - ((p.qxb - p.qxa) * p.L) / 6;
      });
      const next = assemble(Ne);
      const det = { sign: 1 };
      let s2: number[];
      try {
        s2 = solveSystem(next.K, next.F, det);
      } catch (e) {
        if (e instanceof StructureError) throw new InstabilityError('Second order: the structure is at its critical (buckling) load');
        throw e;
      }
      if (det.sign !== det0.sign) throw new InstabilityError('Second order: the loads are above the critical (buckling) load, so there is no stable equilibrium');
      const D2 = s2.slice(0, ndof);
      let dn = 0, nrm = 0;
      for (let q = 0; q < ndof; q++) {
        dn += (D2[q] - D[q]) ** 2;
        nrm += D2[q] ** 2;
      }
      converged = Math.sqrt(dn) <= 1e-6 * Math.sqrt(nrm) || nrm === 0;
      sol = s2;
      D = D2;
      ({ F, elemK, elemF } = next);
      iterations = it;
    }
    if (!converged) throw new InstabilityError(`Second order did not converge in ${MAX_ITERATIONS} iterations: the loads are close to or above the critical load`);
  }

  // reactions: K d = F + R, R = −Cᵀλ
  const reactions: Reaction[] = st.supports.map((sp) => ({ id: sp.id, label: sp.label, node: sp.node, Rx: 0, Ry: 0, M: 0 }));
  rows.forEach((r, c) => {
    if (r.support === undefined) return;
    const mag = -sol[ndof + c] * kmax;
    const R = reactions[r.support];
    R.Rx += mag * r.dir[0];
    R.Ry += mag * r.dir[1];
    R.M += mag * r.dir[2];
  });
  for (const sp of springs) {
    // spring force on the node: k (u_foot − u)·n along n, u_foot = −settle n
    const un = D[3 * sp.node] * sp.n[0] + D[3 * sp.node + 1] * sp.n[1];
    const f = -sp.k * (un + sp.settle);
    reactions[sp.support].Rx += f * sp.n[0];
    reactions[sp.support].Ry += f * sp.n[1];
  }
  for (const sp of rotSprings) reactions[sp.support].M += -sp.kr * D[3 * sp.node + 2];

  // internal forces along each piece
  const byMember = new Map<string, MemberResult>();
  const max: BeamSolution['max'] = {};
  const consider = (key: keyof BeamSolution['max'], value: number, member: string, s: number, x: number, y: number) => {
    const cur = max[key];
    if (!cur || Math.abs(value) > Math.abs(cur.value) * (1 + 1e-9)) max[key] = { value, member, s, x, y };
  };
  const resultOf = (m: NumMember) => {
    let r = byMember.get(m.id);
    if (!r) {
      const a = pos[nodeIndex.get(m.a)!], b = pos[nodeIndex.get(m.b)!];
      r = { id: m.id, L: Math.hypot(b.x - a.x, b.y - a.y), s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [], ...(m.W ? { sigma: [] } : {}) };
      byMember.set(m.id, r);
    }
    return r;
  };
  const record = (r: MemberResult, m: NumMember, sx: number, gx: number, gy: number, N: number, V: number, M: number, dxg: number, dyg: number) => {
    r.s.push(sx); r.N.push(N); r.V.push(V); r.M.push(M); r.dx.push(dxg); r.dy.push(dyg);
    consider('N', N, m.id, sx, gx, gy);
    consider('V', V, m.id, sx, gx, gy);
    consider('M', M, m.id, sx, gx, gy);
    consider('w', Math.hypot(dxg, dyg), m.id, sx, gx, gy);
    if (r.sigma && m.W) {
      const sg = Math.abs(N) / m.A + Math.abs(M) / m.W;
      r.sigma.push(sg);
      consider('sigma', sg, m.id, sx, gx, gy);
    }
  };

  if (!second) {
    pieces.forEach((p, pi) => {
      const m = p.member;
      const r = resultOf(m);
      const { dl, pe } = endForces(p, elemK[pi], elemF[pi]);
      const [u1, v1, , u2, v2] = dl;
      const L = p.L, EI = m.E * m.I, EA = m.E * m.A;
      // shear strain −V/GA_v adds −(M − M(0))/GA_v to the deflection (Timoshenko)
      const GAv = shearStiffness(m), sh = Number.isFinite(GAv) ? 1 / GAv : 0;
      const bx = (p.qxb - p.qxa) / L, by = (p.qyb - p.qya) / L;
      const Nf = (x: number) => -pe[0] - (p.qxa * x + (bx * x * x) / 2);
      const Vf = (x: number) => pe[1] + p.qya * x + (by * x * x) / 2;
      const Mf = (x: number) => -pe[2] + pe[1] * x + (p.qya * x * x) / 2 + (by * x ** 3) / 6;
      const Wf = (x: number) => ((-pe[2] * x * x) / 2 + (pe[1] * x ** 3) / 6 + (p.qya * x ** 4) / 24 + (by * x ** 5) / 120) / EI - sh * (pe[1] * x + (p.qya * x * x) / 2 + (by * x ** 3) / 6);
      const Uf = (x: number) => (-pe[0] * x - (p.qxa * x * x) / 2 - (bx * x ** 3) / 6) / EA;
      const WL = Wf(L), UL = Uf(L);
      const vLin = (v2 - v1 - WL) / L, uLin = (u2 - u1 - UL) / L;
      r.pieces.push({
        s0: p.t0 * r.L, L, c: p.c, s: p.s,
        N: [-pe[0], -p.qxa, -bx / 2], V: [pe[1], p.qya, by / 2], M: [-pe[2], pe[1], p.qya / 2, by / 6],
        u: [u1, -pe[0] / EA + uLin, -p.qxa / (2 * EA), -bx / (6 * EA)],
        v: [v1, vLin - sh * pe[1], -pe[2] / (2 * EI) - (sh * p.qya) / 2, pe[1] / (6 * EI) - (sh * by) / 6, p.qya / (24 * EI), by / (120 * EI)],
      });
      const xs = new Set<number>();
      for (let q = 0; q <= STATIONS; q++) xs.add((L * q) / STATIONS);
      // where V = 0, M peaks: pe1 + qya x + by x²/2 = 0
      const roots = Math.abs(by) > 1e-14 * (Math.abs(p.qya) + 1e-300)
        ? (() => {
          const disc = p.qya * p.qya - 2 * by * pe[1];
          return disc < 0 ? [] : [(-p.qya + Math.sqrt(disc)) / by, (-p.qya - Math.sqrt(disc)) / by];
        })()
        : Math.abs(p.qya) > 0 ? [-pe[1] / p.qya] : [];
      for (const x of roots) if (x > 0 && x < L) xs.add(x);
      const base = (p.t0 * r.L);
      for (const x of [...xs].sort((a, b) => a - b)) {
        const uL = u1 + Uf(x) - (x / L) * (UL - (u2 - u1));
        const vL = v1 + ((v2 - v1) * x) / L + Wf(x) - (x / L) * WL;
        record(r, m, base + x, pos[p.i].x + p.c * x, pos[p.i].y + p.s * x, Nf(x), Vf(x), Mf(x), p.c * uL - p.s * vL, p.s * uL + p.c * vL);
      }
    });
  } else {
    // exact polynomials per element; stations as in first order, per piece
    const polys = elems.map((p, ei) => {
      const { dl, pe } = endForces(p, elemK[ei], elemF[ei]);
      return { p, poly: secondOrderPoly(p, dl, pe, resultOf(p.member).L) };
    });
    pieces.forEach((p, gi) => {
      const m = p.member;
      const r = resultOf(m);
      const subs = polys.filter((q) => q.p.group === gi);
      const base = p.t0 * r.L;
      r.pieces.push(...subs.map((q) => q.poly));
      const xs = new Set<number>();
      for (let q = 0; q <= STATIONS; q++) xs.add((p.L * q) / STATIONS);
      // where M peaks inside an element (dM/dx = V = 0)
      for (const { poly } of subs) for (const x of rootsIn(poly.V, poly.L)) xs.add(poly.s0 - base + x);
      for (const x of [...xs].sort((a, b) => a - b)) {
        const sx = base + x;
        const q = subs.find((e, i) => sx <= e.poly.s0 + e.poly.L + 1e-12 * r.L || i === subs.length - 1)!.poly;
        const xl = Math.min(Math.max(sx - q.s0, 0), q.L);
        const u = polyAt(q.u, xl), v = polyAt(q.v, xl);
        record(r, m, sx, pos[p.i].x + p.c * x, pos[p.i].y + p.s * x, polyAt(q.N, xl), polyAt(q.V, xl), polyAt(q.M, xl), p.c * u - p.s * v, p.s * u + p.c * v);
      }
    });
  }

  const nodes: BeamSolution['nodes'] = {};
  for (const q of st.nodes) {
    const k = nodeIndex.get(q.id)!;
    nodes[q.id] = { dx: D[3 * k], dy: D[3 * k + 1], rz: D[3 * k + 2] };
  }
  // degree of indeterminacy of the frame: 3m + r − 3j − c (c = released end moments)
  const releases = st.members.reduce((acc, m) => acc + (m.hingeA ? 1 : 0) + (m.hingeB ? 1 : 0), 0);
  const restraints = rows.filter((r) => r.support !== undefined).length;
  const orphan = rows.length - restraints;
  const indeterminacy = 3 * st.members.length + restraints - 3 * st.nodes.length - releases + orphan;
  return {
    members: st.members.map((m) => byMember.get(m.id)!), reactions, nodes, max, indeterminacy,
    ...(second ? { secondOrder: { iterations } } : {}),
  };
}

/**
 * Internal forces and displacements of one second-order element as polynomials. The
 * moment is statics on the deformed element: M = M_I + N₀ (v − v₁), with v the
 * first-order shape, closed onto the end moment the stiffness gives (they differ only
 * by an axial line load's lever arms). V = dM/dx is the shear across the deformed axis,
 * and the deflection is the double integral of M/EI (plus −ΔM/GA_v with shear).
 */
function secondOrderPoly(p: Piece, dl: number[], pe: number[], Lm: number): PiecePoly {
  const m = p.member, L = p.L, EI = m.E * m.I, EA = m.E * m.A;
  const GAv = shearStiffness(m), sh = Number.isFinite(GAv) ? 1 / GAv : 0;
  const [u1, v1, , u2, v2] = dl;
  const bx = (p.qxb - p.qxa) / L, by = (p.qyb - p.qya) / L;
  const shape = (M: number[]) => {
    const W = padd(pscale(pint(pint(M)), 1 / EI), pscale(padd(M, [-M[0]]), -sh));
    return padd(W, [v1, (v2 - v1 - polyAt(W, L)) / L]);
  };
  const MI = [-pe[2], pe[1], p.qya / 2, by / 6];
  let M = padd(MI, pscale(padd(shape(MI), [-v1]), -pe[0]));
  M = padd(M, [0, (pe[5] - polyAt(M, L)) / L]);
  const Uf = [0, -pe[0] / EA, -p.qxa / (2 * EA), -bx / (6 * EA)];
  const uLin = (u2 - u1 - polyAt(Uf, L)) / L;
  return {
    s0: p.t0 * Lm, L, c: p.c, s: p.s,
    N: [-pe[0], -p.qxa, -bx / 2], V: pder(M), M,
    u: padd(Uf, [u1, uLin]), v: shape(M),
  };
}
