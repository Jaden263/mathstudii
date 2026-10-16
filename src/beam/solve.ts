// Plane frame analysis by the direct stiffness method (Euler–Bernoulli members, or
// Timoshenko members with shear deformation; linear elastic). Works in SI units (N, m, Pa).
//
// Members stay whole: a load on a member enters through its fixed-end forces (exact for
// point forces, moments and linear line loads anywhere along it), so the nodal results
// are exact, and the internal forces follow exactly from statics: between loads N, V and
// M are polynomials of degree ≤ 1, 2 and 3. (Splitting members at the loads instead made a
// load 1 mm from a node a piece (L/h)³ ≈ 10¹² times stiffer than its neighbour, and the
// system lost that many digits.) The deflection comes from integrating M/EI twice between
// the exact end displacements, which is exact too. Supports enter as constraints
// (Lagrange multipliers), so the multipliers are the support reactions and inclined
// rollers need no special treatment.
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

/**
 * A load on a piece in its own axes, at a distance from its start: a point force or a
 * concentrated moment (counter-clockwise) at a, or a line load from a to b varying linearly.
 */
export type PieceLoad =
  | { kind: 'force'; a: number; Fx: number; Fy: number }
  | { kind: 'moment'; a: number; M: number }
  | { kind: 'line'; a: number; b: number; qxa: number; qxb: number; qya: number; qyb: number };

/** A member (or, in second order, an element cut from it) with the loads on it in its axes. */
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
  loads: PieceLoad[];
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
 * With `Nb` the force varies linearly from N at the start to Nb at the end (an axial line
 * load, a column's own weight): a constant mean value would make the critical load
 * converge only with the square of the element length.
 */
export function geometricK(N: number, L: number, phi = 0, Nb = N): number[][] {
  if (Nb !== N) return linearGeometricK(N, Nb, L, phi);
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

/** Three-point Gauss on [0, 1]: exact for ∫ N ψ′ψ′ dx with N linear and ψ′ quadratic. */
const GAUSS3: [number, number][] = [[0.5 - Math.sqrt(0.15), 5 / 18], [0.5, 8 / 18], [0.5 + Math.sqrt(0.15), 5 / 18]];

/** K_G = ∫ N(x) ψ′ψ′ᵀ dx for N linear from Na to Nb, ψ the transverse shape functions (v1 θ1 v2 θ2). */
function linearGeometricK(Na: number, Nb: number, L: number, phi: number): number[][] {
  const k = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const dofs = [1, 2, 4, 5], q = 1 + phi;
  for (const [x, w] of GAUSS3) {
    const d1 = (6 * x * x - 6 * x - phi) / (q * L);
    const d = [d1, (3 * x * x - (4 + phi) * x + 1 + phi / 2) / q, -d1, (3 * x * x - (2 - phi) * x - phi / 2) / q];
    const nw = (Na + (Nb - Na) * x) * w * L;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) k[dofs[a]][dofs[b]] += nw * d[a] * d[b];
  }
  return k;
}

/** Equivalent nodal loads (local axes, both ends fixed) of everything on a piece. */
function fixedEndForces(p: Piece, EI: number, GAv: number): number[] {
  const f = [0, 0, 0, 0, 0, 0];
  for (const l of p.loads) {
    const g = l.kind === 'force' ? pointFixedEnd(p.L, l.a, l.Fx, l.Fy, EI, GAv)
      : l.kind === 'moment' ? momentFixedEnd(p.L, l.a, l.M, EI, GAv)
      : lineFixedEnd(p.L, l, EI, GAv);
    for (let i = 0; i < 6; i++) f[i] += g[i];
  }
  return f;
}

/**
 * A linear line load over the whole piece: Euler–Bernoulli in closed form; with shear,
 * the two end conditions of a clamped Timoshenko beam (no end rotation: ∫M dx = 0, no end
 * deflection: ∫(L−x)M/EI − ΔM/GA_v = 0) give the start moment and shear. A load over part
 * of the piece is the point load's values integrated over it: they are cubic in the
 * position, so three Gauss points on the linear load are exact.
 */
export function lineFixedEnd(L: number, l: { a: number; b: number; qxa: number; qxb: number; qya: number; qyb: number }, EI: number, GAv = Infinity): number[] {
  if (l.a > 1e-12 * L || l.b < L * (1 - 1e-12)) {
    const f = [0, 0, 0, 0, 0, 0], len = l.b - l.a;
    for (const [x, w] of GAUSS3) {
      const g = pointFixedEnd(L, l.a + len * x, (l.qxa + (l.qxb - l.qxa) * x) * w * len, (l.qya + (l.qyb - l.qya) * x) * w * len, EI, GAv);
      for (let i = 0; i < 6; i++) f[i] += g[i];
    }
    return f;
  }
  const ax = [(L * (2 * l.qxa + l.qxb)) / 6, (L * (l.qxa + 2 * l.qxb)) / 6];
  if (!Number.isFinite(GAv)) {
    return [
      ax[0], (L * (7 * l.qya + 3 * l.qyb)) / 20, (L * L * (3 * l.qya + 2 * l.qyb)) / 60,
      ax[1], (L * (3 * l.qya + 7 * l.qyb)) / 20, (-L * L * (2 * l.qya + 3 * l.qyb)) / 60,
    ];
  }
  // M(x) = M0 + V0 x + q_a x²/2 + b x³/6
  const qa = l.qya, by = (l.qyb - l.qya) / L, psi = EI / GAv;
  const a11 = L, a12 = (L * L) / 2, r1 = -(qa * L ** 3) / 6 - (by * L ** 4) / 24;
  const a21 = (L * L) / 2, a22 = L ** 3 / 6 - psi * L, r2 = -qa * (L ** 4 / 24 - (psi * L * L) / 2) - by * (L ** 5 / 120 - (psi * L ** 3) / 6);
  const det = a11 * a22 - a12 * a21;
  const M0 = (r1 * a22 - a12 * r2) / det, V0 = (a11 * r2 - a21 * r1) / det;
  const ML = M0 + V0 * L + (qa * L * L) / 2 + (by * L ** 3) / 6;
  const Q = (L * (l.qya + l.qyb)) / 2;
  return [ax[0], -V0, M0, ax[1], Q + V0, -ML];
}

/**
 * Equivalent nodal loads (local axes, both ends fixed) of a point load (Fx, Fy) at a
 * along an element: with M(x) = M₀ + V₀x + F_y (x − a)₊ the two end conditions of a
 * clamped member, no end rotation (∫M dx = 0) and no end deflection
 * (∫(L − x) M/EI dx − ΔM/GA_v = 0), as for line loads. Without shear these are the
 * handbook values F_y b²(3a + b)/L³, F_y a b²/L² ….
 */
export function pointFixedEnd(L: number, a: number, Fx: number, Fy: number, EI: number, GAv = Infinity): number[] {
  const b = L - a, psi = Number.isFinite(GAv) ? EI / GAv : 0;
  const a11 = L, a12 = (L * L) / 2, r1 = (-Fy * b * b) / 2;
  const a21 = (L * L) / 2, a22 = L ** 3 / 6 - psi * L, r2 = -Fy * (b ** 3 / 6 - psi * b);
  const det = a11 * a22 - a12 * a21;
  const M0 = (r1 * a22 - a12 * r2) / det, V0 = (a11 * r2 - a21 * r1) / det;
  const ML = M0 + V0 * L + Fy * b;
  return [(Fx * b) / L, -V0, M0, (Fx * a) / L, Fy + V0, -ML];
}

/**
 * The same for a concentrated moment C (counter-clockwise) at a: M(x) = M₀ + V₀x − C for
 * x > a, and the shear V₀ is all there is to deform in shear. Without shear the end
 * moments are C b(2a − b)/L² and C a(2b − a)/L².
 */
export function momentFixedEnd(L: number, a: number, C: number, EI: number, GAv = Infinity): number[] {
  const b = L - a, psi = Number.isFinite(GAv) ? EI / GAv : 0;
  const a11 = L, a12 = (L * L) / 2, r1 = C * b;
  const a21 = (L * L) / 2, a22 = L ** 3 / 6 - psi * L, r2 = (C * b * b) / 2;
  const det = a11 * a22 - a12 * a21;
  const M0 = (r1 * a22 - a12 * r2) / det, V0 = (a11 * r2 - a21 * r1) / det;
  const ML = M0 + V0 * L - C;
  return [0, -V0, M0, 0, V0, -ML];
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
  // Each pivot is judged against its own column. Stiffnesses in one structure differ by
  // many orders (a 1 mm piece next to a 10 m one: (L/h)³ = 1e12 in 12EI/L³), so against
  // the largest entry of the whole matrix the long piece's own pivots looked like zero.
  // Elimination only mixes a column with multiples (≤ 1) of itself, so a dependent
  // column ends at round-off of its own size.
  const colScale = new Array<number>(n).fill(1e-300);
  for (const row of M) for (let c = 0; c < n; c++) colScale[c] = Math.max(colScale[c], Math.abs(row[c]));
  let sign = 1;
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    if (Math.abs(M[p][col]) < 1e-11 * colScale[col]) throw new StructureError('The structure can move freely (a mechanism): add supports, or remove hinges');
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

/** Nodes and pieces of a structure: one piece per member, with the loads on it. */
export interface FrameMesh {
  nodeIndex: Map<string, number>;
  /** Node positions: the structure's nodes, then element ends (second order and buckling). */
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

  const pieces: Piece[] = st.members.map((m, k) => {
    const i = nodeIndex.get(m.a)!, j = nodeIndex.get(m.b)!;
    const L = Math.hypot(pos[j].x - pos[i].x, pos[j].y - pos[i].y);
    return {
      member: m, t0: 0, t1: 1, i, j, hingeI: !!m.hingeA, hingeJ: !!m.hingeB,
      L, c: (pos[j].x - pos[i].x) / L, s: (pos[j].y - pos[i].y) / L, loads: [], group: k,
    };
  });
  const byId = new Map(pieces.map((p) => [p.member.id, p]));
  for (const l of st.loads) {
    if (l.type === 'line') {
      const p = byId.get(l.member);
      const ta = clampT(Math.min(l.t1, l.t2)), tb = clampT(Math.max(l.t1, l.t2));
      if (!p || !(tb > ta)) continue;
      const qAt = (t: number) => l.q1 + ((l.q2 - l.q1) * (t - l.t1)) / (l.t2 - l.t1);
      const qa = qAt(ta), qb = qAt(tb);
      // 'local': towards the member's right side (−y); 'global': downwards per length of
      // member, (0, −q) in local axes
      p.loads.push(l.dir === 'local'
        ? { kind: 'line', a: ta * p.L, b: tb * p.L, qxa: 0, qxb: 0, qya: -qa, qyb: -qb }
        : { kind: 'line', a: ta * p.L, b: tb * p.L, qxa: -qa * p.s, qxb: -qb * p.s, qya: -qa * p.c, qyb: -qb * p.c });
    } else if ('member' in l.at) {
      const p = byId.get(l.at.member);
      if (!p) throw new StructureError('A load sits on a missing member');
      const a = clampT(l.at.t) * p.L;
      p.loads.push(l.type === 'force' ? { kind: 'force', a, Fx: p.c * l.Fx + p.s * l.Fy, Fy: -p.s * l.Fx + p.c * l.Fy } : { kind: 'moment', a, M: l.M });
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
 * Cut the pieces into elements, about `n` per member (at least one per piece). Each
 * element takes the loads on it (a point load on a cut goes to the element after it);
 * hinges stay at the member ends.
 */
export function subdivide(mesh: FrameMesh, n: number): Piece[] {
  const out: Piece[] = [];
  for (const p of mesh.pieces) {
    const k = Math.max(1, Math.round(n * (p.t1 - p.t0)));
    for (let q = 0; q < k; q++) {
      const f0 = q / k, f1 = (q + 1) / k;
      const t0 = q === 0 ? p.t0 : p.t0 + (p.t1 - p.t0) * f0, t1 = q === k - 1 ? p.t1 : p.t0 + (p.t1 - p.t0) * f1;
      out.push({
        ...p, t0, t1, i: q === 0 ? p.i : mesh.pointOn(p.member, t0), j: q === k - 1 ? p.j : mesh.pointOn(p.member, t1),
        hingeI: p.hingeI && q === 0, hingeJ: p.hingeJ && q === k - 1, L: p.L / k,
        loads: loadsWithin(p.loads, p.L * f0, q === k - 1 ? p.L : p.L * f1, q === k - 1),
      });
    }
  }
  return out;
}

/** The loads between x0 and x1 of a piece, measured from x0 (line loads cut there). */
function loadsWithin(loads: PieceLoad[], x0: number, x1: number, last: boolean): PieceLoad[] {
  const out: PieceLoad[] = [];
  for (const l of loads) {
    if (l.kind !== 'line') {
      if (l.a >= x0 && (l.a < x1 || last)) out.push({ ...l, a: l.a - x0 });
      continue;
    }
    const a = Math.max(l.a, x0), b = Math.min(l.b, x1);
    if (!(b - a > 1e-12 * (x1 - x0))) continue;
    const at = (x: number, qa: number, qb: number) => qa + ((qb - qa) * (x - l.a)) / (l.b - l.a);
    out.push({ kind: 'line', a: a - x0, b: b - x0, qxa: at(a, l.qxa, l.qxb), qxb: at(b, l.qxa, l.qxb), qya: at(a, l.qya, l.qyb), qyb: at(b, l.qya, l.qyb) });
  }
  return out;
}

/** A stretch of a piece between loads: where it starts, its length, and N, V, M along it (in its own x). */
interface Stretch {
  x0: number;
  L: number;
  N: number[];
  V: number[];
  M: number[];
}

/**
 * N, V and M along a piece from statics: the forces at its start (pe, local axes) and the
 * loads before each point. A stretch begins at every point load and at both ends of every
 * line load and holds the values just after it, so both sides of a jump are kept; within
 * a stretch the forces are polynomials of degree ≤ 1, 2 and 3.
 */
export function pieceStatics(L: number, loads: PieceLoad[], pe: number[]): Stretch[] {
  const tol = 1e-12 * L;
  const cuts = loads.flatMap((l) => (l.kind === 'line' ? [l.a, l.b] : [l.a])).sort((p, q) => p - q);
  const xs = [0];
  for (const x of cuts) if (x > xs[xs.length - 1] + tol && x < L - tol) xs.push(x);
  xs.push(L);
  return xs.slice(0, -1).map((x0, k) => {
    let N = [-pe[0]], V = [pe[1]], M = [-pe[2] + pe[1] * x0, pe[1]];
    for (const l of loads) {
      if (l.kind === 'force') {
        if (l.a > x0 + tol) continue;
        N = padd(N, [-l.Fx]);
        V = padd(V, [l.Fy]);
        M = padd(M, [l.Fy * (x0 - l.a), l.Fy]);
      } else if (l.kind === 'moment') {
        if (l.a <= x0 + tol) M = padd(M, [-l.M]);
      } else {
        // the part from a to min(x0, b) as a resultant, the rest along the stretch
        const len = l.b - l.a, c = Math.min(x0, l.b), part = Math.max(0, c - l.a), inside = x0 >= l.a - tol && x0 < l.b - tol;
        const add = (qa: number, qb: number) => {
          const slope = (qb - qa) / len, qc = qa + slope * part, Q = (part * (qa + qc)) / 2;
          const q0 = inside ? qa + slope * (x0 - l.a) : 0, b = inside ? slope : 0;
          return { F: [Q, q0, b / 2], Mo: [(x0 - c) * Q + (part * part * (2 * qa + qc)) / 6, Q, q0 / 2, b / 6] };
        };
        const ax = add(l.qxa, l.qxb), tr = add(l.qya, l.qyb);
        N = padd(N, pscale(ax.F, -1));
        V = padd(V, tr.F);
        M = padd(M, tr.Mo);
      }
    }
    return { x0, L: xs[k + 1] - x0, N, V, M };
  });
}

/** ∫₀ˣ of a function given per stretch (each in its own x), continuous from stretch to stretch. */
function stretchInt(parts: { L: number }[], f: number[][]): number[][] {
  let acc = 0;
  return f.map((p, k) => {
    const q = pint(p);
    q[0] += acc;
    acc = polyAt(q, parts[k].L);
    return q;
  });
}

/** The value at x along a piece of a function given per stretch. */
function stretchAt(parts: Stretch[], f: number[][], x: number): number {
  const k = parts.findIndex((q, i) => x <= q.x0 + q.L || i === parts.length - 1);
  return polyAt(f[k], x - parts[k].x0);
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

/**
 * The axis a support holds (its normal): (−sin a, cos a). Snapped at whole right angles,
 * where cos(π/2) ≈ 6e-17 would otherwise leak a sliver of the load into the other direction.
 */
export function supportAxis(angle: number): [number, number] {
  const snap = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  return [snap(-Math.sin(angle)), snap(Math.cos(angle))];
}

const MAX_ITERATIONS = 30;

export function solveStructure(st: NumStructure, opts: SolveOptions = {}): BeamSolution {
  const mesh = frameMesh(st);
  const { nodeIndex, pos, pieces } = mesh;
  const second = !!opts.secondOrder;
  // second order works on short elements; first order on the members themselves (exact)
  const elems = second ? subdivide(mesh, elementsPerMember(st.members.length)) : pieces;

  // loads on nodes (those on members are in their pieces' fixed-end forces)
  const nodal = st.loads.map((l) => {
    if (l.type === 'line' || !('node' in l.at)) return -1;
    const k = nodeIndex.get(l.at.node);
    if (k === undefined) throw new StructureError('A load sits on a missing node');
    return k;
  });

  const nn = pos.length, ndof = 3 * nn;
  // springs act as stiffness instead of a constraint; their reactions are added afterwards
  const springs: { support: number; node: number; n: [number, number]; k: number; settle: number }[] = [];
  const rotSprings: { support: number; node: number; kr: number }[] = [];
  st.supports.forEach((sp, si) => {
    const k = nodeIndex.get(sp.node);
    if (k === undefined) return;
    if (sp.k && sp.k > 0) springs.push({ support: si, node: k, n: supportAxis(sp.angle), k: sp.k, settle: sp.settle ?? 0 });
    if (sp.type === 'fixed' && sp.kr && sp.kr > 0) rotSprings.push({ support: si, node: k, kr: sp.kr });
  });

  /** Global stiffness and load vector; `Ne` (second order) are the elements' axial forces at their ends. */
  const assemble = (Ne?: [number, number][]) => {
    const K = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0));
    const F = new Array<number>(ndof).fill(0);
    const elemK: number[][][] = [];
    const elemF: number[][] = [];
    elems.forEach((p, pi) => {
      const m = p.member, GAv = shearStiffness(m);
      const k = localK(m.E, m.A, m.I, p.L, GAv);
      if (Ne) {
        const kg = geometricK(Ne[pi][0], p.L, (12 * m.E * m.I) / (GAv * p.L * p.L), Ne[pi][1]);
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
      if (nodal[li] < 0) return;
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
    const [nx, ny] = supportAxis(sp.angle);
    const settle = sp.settle ?? 0;
    if (!(sp.k && sp.k > 0)) rows.push({ dof: [3 * k, 3 * k + 1], w: [nx, ny], support: si, dir: [nx, ny, 0], ...(settle ? { rhs: -settle } : {}) });
    if (sp.type !== 'roller') rows.push({ dof: [3 * k, 3 * k + 1], w: [ny, -nx], support: si, dir: [ny, -nx, 0] });
    if (sp.type === 'fixed' && !(sp.kr && sp.kr > 0)) rows.push({ dof: [3 * k + 2], w: [1], support: si, dir: [0, 0, 1] });
  });
  // a rotation nothing holds is exactly zero on the diagonal (released ends are condensed
  // out); it is told apart from a merely soft one by the bending stiffness at its node
  const rotScale = new Array<number>(nn).fill(0);
  for (const p of elems) {
    const ei = (p.member.E * p.member.I) / p.L;
    rotScale[p.i] += ei;
    rotScale[p.j] += ei;
  }
  const heldRot = new Set(rows.filter((r) => r.dir[2]).map((r) => r.dof[0]));
  for (let k = 0; k < nn; k++) {
    const d = 3 * k + 2;
    if (Math.abs(K[d][d]) > 1e-12 * rotScale[k] || heldRot.has(d)) continue;
    if (Math.abs(F[d]) > 0) throw new StructureError('A moment acts on a hinge, where nothing can carry it');
    rows.push({ dof: [d], w: [1], dir: [0, 0, 0] });
  }

  // augmented system [K Cᵀ; C 0]; each constraint row is scaled to the stiffness of its own
  // unknowns (the stiffest unknown of the structure would swamp a soft support's column)
  const nc = rows.length;
  const kmax = Math.max(...K.map((row, i) => Math.abs(row[i])), 1e-300);
  const rowScale = rows.map((r) => {
    const own = Math.max(...r.dof.map((d) => Math.abs(K[d][d])));
    if (own > 0) return own;
    const k0 = r.dof[0] - (r.dof[0] % 3);
    return Math.max(Math.abs(K[k0][k0]), Math.abs(K[k0 + 1][k0 + 1]), Math.abs(K[k0 + 2][k0 + 2])) || kmax;
  });
  const solveSystem = (Kx: number[][], Fx: number[], info?: { sign: number }) => {
    const Aug = Array.from({ length: ndof + nc }, (_, i) => (i < ndof ? [...Kx[i], ...new Array<number>(nc).fill(0)] : new Array<number>(ndof + nc).fill(0)));
    rows.forEach((r, c) => r.dof.forEach((d, q) => {
      Aug[ndof + c][d] = r.w[q] * rowScale[c];
      Aug[d][ndof + c] = r.w[q] * rowScale[c];
    }));
    return solveDense(Aug, [...Fx, ...rows.map((r, c) => (r.rhs ?? 0) * rowScale[c])], info);
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
  // negative: the loads passed a critical load, and there is no stable equilibrium. (Two
  // passed at once, as with two equal columns, keep the sign: evaluate.ts checks α_cr first.)
  let iterations = 0;
  if (second) {
    let converged = false;
    for (let it = 1; it <= MAX_ITERATIONS && !converged; it++) {
      const Ne = elems.map((p, pi): [number, number] => {
        const { pe } = endForces(p, elemK[pi], elemF[pi]);
        // axial force at both ends (it varies along the element with axial loads on it)
        const parts = pieceStatics(p.L, p.loads, pe), last = parts[parts.length - 1];
        return [polyAt(parts[0].N, 0), polyAt(last.N, last.L)];
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
    const mag = -sol[ndof + c] * rowScale[c];
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

  // stations along each stretch between loads (both ends, so a jump keeps both sides),
  // and where M peaks (dM/dx = V = 0)
  const stations = (p: Piece, polys: PiecePoly[], Lm: number) => {
    const r = resultOf(p.member), a = pos[nodeIndex.get(p.member.a)!];
    for (const q of polys) {
      const n = Math.max(2, Math.ceil((STATIONS * q.L) / Lm));
      const xs = new Set<number>();
      for (let k = 0; k <= n; k++) xs.add((q.L * k) / n);
      for (const x of peaksOf(q.V, q.L)) xs.add(x);
      for (const x of [...xs].sort((u, v) => u - v)) {
        const u = polyAt(q.u, x), v = polyAt(q.v, x), sx = q.s0 + x;
        record(r, p.member, sx, a.x + p.c * sx, a.y + p.s * sx, polyAt(q.N, x), polyAt(q.V, x), polyAt(q.M, x), p.c * u - p.s * v, p.s * u + p.c * v);
      }
    }
  };
  elems.forEach((p, ei) => {
    const { dl, pe } = endForces(p, elemK[ei], elemF[ei]);
    const r = resultOf(p.member);
    // exact polynomials per stretch; in second order per stretch of each element
    const polys = second ? secondOrderPolys(p, dl, pe, r.L) : elasticLine(p, dl, pe, r.L);
    r.pieces.push(...polys);
    stations(p, polys, r.L);
  });

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

/** Where a shear polynomial vanishes inside (0, L): exactly for a quadratic, else by bisection. */
function peaksOf(V: number[], L: number): number[] {
  if (V.length > 3) return rootsIn(V, L);
  const [c0, c1 = 0, c2 = 0] = V;
  const xs = Math.abs(c2) > 1e-14 * (Math.abs(c1) + Math.abs(c0) / L + 1e-300) / L
    ? (() => {
      const disc = c1 * c1 - 4 * c2 * c0;
      return disc < 0 ? [] : [(-c1 + Math.sqrt(disc)) / (2 * c2), (-c1 - Math.sqrt(disc)) / (2 * c2)];
    })()
    : Math.abs(c1) > 0 ? [-c0 / c1] : [];
  return xs.filter((x) => x > 0 && x < L);
}

/**
 * Internal forces and displacements of a piece (first order) as polynomials per stretch:
 * N, V and M from statics, the deflection the double integral of M/EI between the exact
 * end displacements (with shear, the shear strain −V/GA_v integrated too), the axial
 * displacement the integral of N/EA.
 */
function elasticLine(p: Piece, dl: number[], pe: number[], Lm: number): PiecePoly[] {
  const m = p.member, L = p.L, EI = m.E * m.I, EA = m.E * m.A;
  const GAv = shearStiffness(m), sh = Number.isFinite(GAv) ? 1 / GAv : 0;
  const [u1, v1, , u2, v2] = dl;
  const parts = pieceStatics(L, p.loads, pe);
  const bend = stretchInt(parts, stretchInt(parts, parts.map((q) => pscale(q.M, 1 / EI))));
  const shear = stretchInt(parts, parts.map((q) => pscale(q.V, -sh)));
  const W = parts.map((_, k) => padd(bend[k], shear[k])), U = stretchInt(parts, parts.map((q) => pscale(q.N, 1 / EA)));
  const vLin = (v2 - v1 - stretchAt(parts, W, L)) / L, uLin = (u2 - u1 - stretchAt(parts, U, L)) / L;
  return parts.map((q, k) => ({
    s0: p.t0 * Lm + q.x0, L: q.L, c: p.c, s: p.s, N: q.N, V: q.V, M: q.M,
    u: padd(U[k], [u1 + uLin * q.x0, uLin]),
    v: padd(W[k], [v1 + vLin * q.x0, vLin]),
  }));
}

/**
 * Internal forces and displacements of one second-order element as polynomials (per
 * stretch between the loads on it). The moment is statics on the deformed element:
 * M = M_I + N₀ (v − v₁), where the bending line v comes from M itself, so a few rounds of
 * substitution (each shrinks the change by about N L²/10EI of the short element); then it
 * is closed onto the end moment the stiffness gives (they differ only by an axial load's
 * lever arms). V = dM/dx is the shear across the deformed axis, and the deflection is the
 * double integral of M/EI (plus −∫V/GA_v with shear).
 */
function secondOrderPolys(p: Piece, dl: number[], pe: number[], Lm: number): PiecePoly[] {
  const m = p.member, L = p.L, EI = m.E * m.I, EA = m.E * m.A;
  const GAv = shearStiffness(m), sh = Number.isFinite(GAv) ? 1 / GAv : 0;
  const [u1, v1, , u2, v2] = dl;
  const parts = pieceStatics(L, p.loads, pe);
  const shape = (M: number[][]) => {
    const bend = stretchInt(parts, stretchInt(parts, M.map((q) => pscale(q, 1 / EI))));
    const shear = stretchInt(parts, M.map((q) => pscale(pder(q), -sh)));
    const W = parts.map((_, k) => padd(bend[k], shear[k]));
    const lin = (v2 - v1 - stretchAt(parts, W, L)) / L;
    return W.map((w, k) => padd(w, [v1 + lin * parts[k].x0, lin]));
  };
  const MI = parts.map((q) => q.M);
  // (with only the first-order line in it, the shear came out several per cent off and
  // jumped between elements)
  let M = MI;
  const size = Math.max(...parts.flatMap((q) => q.M.map((c, i) => Math.abs(c) * q.L ** i)), Math.abs(pe[5]), 1e-300);
  for (let round = 0; round < 8; round++) {
    const v = shape(M);
    const next = MI.map((mi, k) => padd(mi, pscale(padd(v[k], [-v1]), -pe[0])));
    const change = Math.max(Math.abs(stretchAt(parts, next, L) - stretchAt(parts, M, L)), Math.abs(stretchAt(parts, next, L / 2) - stretchAt(parts, M, L / 2)));
    M = next;
    if (change <= 1e-10 * size) break;
  }
  const close = (pe[5] - stretchAt(parts, M, L)) / L;
  M = M.map((q, k) => padd(q, [close * parts[k].x0, close]));
  const U = stretchInt(parts, parts.map((q) => pscale(q.N, 1 / EA)));
  const uLin = (u2 - u1 - stretchAt(parts, U, L)) / L;
  const v = shape(M);
  return parts.map((q, k) => ({
    s0: p.t0 * Lm + q.x0, L: q.L, c: p.c, s: p.s,
    N: q.N, V: pder(M[k]), M: M[k],
    u: padd(U[k], [u1 + uLin * q.x0, uLin]), v: v[k],
  }));
}
