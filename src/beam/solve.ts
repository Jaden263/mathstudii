// Plane frame analysis by the direct stiffness method (Euler–Bernoulli members,
// small displacements, linear elastic). Works in SI units (N, m, Pa).
//
// Members are split where loads sit, so every piece carries a linear line load at
// most. For those pieces the nodal results are exact, and internal forces follow
// exactly from statics: N, V and M are polynomials of degree ≤ 1, 2 and 3. The deflection
// comes from integrating M/EI twice between the exact end displacements, which is
// exact too. Supports enter as constraints (Lagrange multipliers), so the multipliers
// are the support reactions and inclined rollers need no special treatment.

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
}

export class StructureError extends Error {}

/** One straight piece of a member between split points, with its linear line load (local axes). */
interface Piece {
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
}

const STATIONS = 24;

/** Local stiffness of a frame member (u1 v1 θ1 u2 v2 θ2). */
function localK(E: number, A: number, I: number, L: number): number[][] {
  const a = (E * A) / L, b = (12 * E * I) / L ** 3, c = (6 * E * I) / L ** 2, d = (4 * E * I) / L, e = (2 * E * I) / L;
  return [
    [a, 0, 0, -a, 0, 0],
    [0, b, c, 0, -b, c],
    [0, c, d, 0, -c, e],
    [-a, 0, 0, a, 0, 0],
    [0, -b, -c, 0, b, -c],
    [0, c, e, 0, -c, d],
  ];
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

/** Gaussian elimination with partial pivoting; throws on a singular system. */
function solveDense(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  const scale = Math.max(...M.flatMap((row) => row.slice(0, n).map(Math.abs)), 1e-300);
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    if (Math.abs(M[p][col]) < 1e-11 * scale) throw new StructureError('The structure can move freely (a mechanism): add supports, or remove hinges');
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
  return x;
}

export function solveStructure(st: NumStructure): BeamSolution {
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
  const clampT = (t: number) => Math.min(1, Math.max(0, t));
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
        L: Lm * (t1 - t0), c, s, qxa: 0, qxb: 0, qya: 0, qyb: 0,
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

  const nn = pos.length, ndof = 3 * nn;
  const K = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0));
  const F = new Array<number>(ndof).fill(0);
  const pieceK: number[][][] = [];
  const pieceF: number[][] = [];
  for (const p of pieces) {
    const k = localK(p.member.E, p.member.A, p.member.I, p.L);
    const L = p.L;
    const f = [
      (L * (2 * p.qxa + p.qxb)) / 6, (L * (7 * p.qya + 3 * p.qyb)) / 20, (L * L * (3 * p.qya + 2 * p.qyb)) / 60,
      (L * (p.qxa + 2 * p.qxb)) / 6, (L * (3 * p.qya + 7 * p.qyb)) / 20, (-L * L * (2 * p.qya + 3 * p.qyb)) / 60,
    ];
    condense(k, f, [...(p.hingeI ? [2] : []), ...(p.hingeJ ? [5] : [])]);
    pieceK.push(k);
    pieceF.push(f);
    // global: k_g = Tᵀ k T, f_g = Tᵀ f with T = blockdiag(R, R), R = [[c, s, 0], [−s, c, 0], [0, 0, 1]]
    const T = (v: number[]) => [p.c * v[0] - p.s * v[1], p.s * v[0] + p.c * v[1], v[2]];
    const dofs = [3 * p.i, 3 * p.i + 1, 3 * p.i + 2, 3 * p.j, 3 * p.j + 1, 3 * p.j + 2];
    const R = [[p.c, p.s, 0, 0, 0, 0], [-p.s, p.c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, p.c, p.s, 0], [0, 0, 0, -p.s, p.c, 0], [0, 0, 0, 0, 0, 1]];
    const kR = k.map((row) => R[0].map((_, j) => row.reduce((acc, v, q) => acc + v * R[q][j], 0)));
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
      let v = 0;
      for (let q = 0; q < 6; q++) v += R[q][a] * kR[q][b];
      K[dofs[a]][dofs[b]] += v;
    }
    const fg = [...T(f.slice(0, 3)), ...T(f.slice(3))];
    dofs.forEach((d, a) => (F[d] += fg[a]));
  }
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
  for (const l of st.loads) {
    if (l.type === 'force') {
      const k = nodeOf(l.at);
      F[3 * k] += l.Fx;
      F[3 * k + 1] += l.Fy;
    } else if (l.type === 'moment') F[3 * nodeOf(l.at) + 2] += l.M;
  }

  // constraints: supports, plus rotations nothing holds (every member end hinged there)
  // rows hold displacements: normal (along the support's axis) and, for pins and fixed
  // supports, tangential; `rhs` is a prescribed displacement (settlement)
  const rows: { dof: number[]; w: number[]; support?: number; dir: [number, number, number]; rhs?: number }[] = [];
  // springs act as stiffness instead of a constraint; their reactions are added afterwards
  const springs: { support: number; node: number; n: [number, number]; k: number; settle: number }[] = [];
  const rotSprings: { support: number; node: number; kr: number }[] = [];
  st.supports.forEach((sp, si) => {
    const k = nodeIndex.get(sp.node);
    if (k === undefined) return;
    const nx = -Math.sin(sp.angle), ny = Math.cos(sp.angle);
    const settle = sp.settle ?? 0;
    if (sp.k && sp.k > 0) {
      springs.push({ support: si, node: k, n: [nx, ny], k: sp.k, settle });
      K[3 * k][3 * k] += sp.k * nx * nx;
      K[3 * k][3 * k + 1] += sp.k * nx * ny;
      K[3 * k + 1][3 * k] += sp.k * nx * ny;
      K[3 * k + 1][3 * k + 1] += sp.k * ny * ny;
      // the spring's foot moves down by the settlement: it pulls the node along
      F[3 * k] -= sp.k * settle * nx;
      F[3 * k + 1] -= sp.k * settle * ny;
    } else {
      rows.push({ dof: [3 * k, 3 * k + 1], w: [nx, ny], support: si, dir: [nx, ny, 0], ...(settle ? { rhs: -settle } : {}) });
    }
    if (sp.type !== 'roller') rows.push({ dof: [3 * k, 3 * k + 1], w: [ny, -nx], support: si, dir: [ny, -nx, 0] });
    if (sp.type === 'fixed') {
      if (sp.kr && sp.kr > 0) {
        rotSprings.push({ support: si, node: k, kr: sp.kr });
        K[3 * k + 2][3 * k + 2] += sp.kr;
      } else rows.push({ dof: [3 * k + 2], w: [1], support: si, dir: [0, 0, 1] });
    }
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
  const Aug = Array.from({ length: ndof + nc }, (_, i) => (i < ndof ? [...K[i], ...new Array<number>(nc).fill(0)] : new Array<number>(ndof + nc).fill(0)));
  rows.forEach((r, c) => r.dof.forEach((d, q) => {
    Aug[ndof + c][d] = r.w[q] * kmax;
    Aug[d][ndof + c] = r.w[q] * kmax;
  }));
  const sol = solveDense(Aug, [...F, ...rows.map((r) => (r.rhs ?? 0) * kmax)]);
  const D = sol.slice(0, ndof);

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
  pieces.forEach((p, pi) => {
    const m = p.member;
    let r = byMember.get(m.id);
    if (!r) {
      const a = pos[nodeIndex.get(m.a)!], b = pos[nodeIndex.get(m.b)!];
      r = { id: m.id, L: Math.hypot(b.x - a.x, b.y - a.y), s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [], ...(m.W ? { sigma: [] } : {}) };
      byMember.set(m.id, r);
    }
    const g = [3 * p.i, 3 * p.i + 1, 3 * p.i + 2, 3 * p.j, 3 * p.j + 1, 3 * p.j + 2].map((d) => D[d]);
    const loc = (u: number, v: number) => [p.c * u + p.s * v, -p.s * u + p.c * v];
    const [u1, v1] = loc(g[0], g[1]), [u2, v2] = loc(g[3], g[4]);
    const dl = [u1, v1, g[2], u2, v2, g[5]];
    const k = pieceK[pi], f = pieceF[pi];
    const pe = k.map((row, i) => row.reduce((acc, v, j) => acc + v * dl[j], 0) - f[i]);
    const L = p.L, EI = m.E * m.I, EA = m.E * m.A;
    const bx = (p.qxb - p.qxa) / L, by = (p.qyb - p.qya) / L;
    const Nf = (x: number) => -pe[0] - (p.qxa * x + (bx * x * x) / 2);
    const Vf = (x: number) => pe[1] + p.qya * x + (by * x * x) / 2;
    const Mf = (x: number) => -pe[2] + pe[1] * x + (p.qya * x * x) / 2 + (by * x ** 3) / 6;
    const Wf = (x: number) => ((-pe[2] * x * x) / 2 + (pe[1] * x ** 3) / 6 + (p.qya * x ** 4) / 24 + (by * x ** 5) / 120) / EI;
    const Uf = (x: number) => (-pe[0] * x - (p.qxa * x * x) / 2 - (bx * x ** 3) / 6) / EA;
    const WL = Wf(L), UL = Uf(L);
    const vLin = (v2 - v1 - WL) / L, uLin = (u2 - u1 - UL) / L;
    r.pieces.push({
      s0: p.t0 * r.L, L, c: p.c, s: p.s,
      N: [-pe[0], -p.qxa, -bx / 2], V: [pe[1], p.qya, by / 2], M: [-pe[2], pe[1], p.qya / 2, by / 6],
      u: [u1, -pe[0] / EA + uLin, -p.qxa / (2 * EA), -bx / (6 * EA)],
      v: [v1, vLin, -pe[2] / (2 * EI), pe[1] / (6 * EI), p.qya / (24 * EI), by / (120 * EI)],
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
      const dxg = p.c * uL - p.s * vL, dyg = p.s * uL + p.c * vL;
      const N = Nf(x), V = Vf(x), M = Mf(x);
      const sx = base + x;
      const gx = pos[p.i].x + p.c * x, gy = pos[p.i].y + p.s * x;
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
    }
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
  return { members: st.members.map((m) => byMember.get(m.id)!), reactions, nodes, max, indeterminacy };
}
