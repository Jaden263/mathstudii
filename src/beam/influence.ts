// Influence lines and moving loads by unit-load traversal. A unit vertical load walks
// along the load path (the deck) in small steps: the stiffness matrix is assembled and
// factorised once (supports eliminated, a banded Cholesky factor), and each position is
// one more right-hand side, the fixed-end forces of the load on its member. Per position
// the forces N, V, M and the displacements at stations on every member, and the support
// reactions, follow from statics along the members: those are the influence lines,
// exact at every position.
//
// For the trains an influence line is taken as straight between positions (the worksheet
// reads it exactly, as the cubic it is between joints: ilValue). The response to an axle
// train is then linear in the train's position until one of its axles passes a vertex,
// so stopping the train with each axle on each vertex, both ways, finds its extremes
// exactly (no step to miss them). A uniform load goes on the adverse parts of each line
// only: its positive area for the maximum, the negative for the minimum. Where the load
// passes a section V and N jump by the load's components; both sides are kept.
import { reducedDofs } from './buckling';
import {
  frameMesh, localK, shearStiffness, StructureError, toGlobal,
  type BeamSolution, type Extreme, type MemberResult, type NumLoad, type NumStructure, type PiecePoly, type Reaction,
} from './solve';
import { SparseSym, skylineCholesky, skylineSolve } from './sparse';

/** One member of the load path, which runs left to right along x. */
export interface PathSeg {
  member: string;
  /** Global x of its left and right end, m. */
  x0: number;
  x1: number;
  /** The member is drawn right to left (its end b is at x0). */
  flip: boolean;
}

export type InfluenceKind = 'Rx' | 'Ry' | 'Mr' | 'N' | 'V' | 'M' | 'w';

export interface InfluenceQuery {
  id: string;
  kind: InfluenceKind;
  /** Support id (Rx, Ry, Mr: the reactions). */
  support?: string;
  /** Member and fraction along it (N, V, M, w). */
  member?: string;
  t?: number;
}

export interface InfluenceLine {
  id: string;
  /** Load positions (global x, m), repeated where the line jumps. */
  x: number[];
  /** Ordinates for a unit (1 N) downward load: reactions and forces per N, M in m, w in m/N. */
  v: number[];
  /** Index ranges [first, last] of x where the line is one smooth cubic (between joints, kinks and jumps). */
  smooth: [number, number][];
}

export interface TrainSpec {
  id: string;
  /** Axle loads, N (downwards), and each axle's distance behind the first, m. */
  P: number[];
  offsets: number[];
  /** Uniform load, N/m, put on the adverse parts of each influence line. */
  q: number;
  /** Travels towards +x, −x, or both ways. */
  dir: 'both' | 'forward' | 'backward';
}

/** Where an extreme acts, and the train position that gives it. */
export interface Critical {
  value: number;
  member: string;
  /** Distance along the member, m, and the global x of the section. */
  s: number;
  x: number;
  /** The first axle's x (m) and the way the train travels; absent when the uniform load alone gives it. */
  lead?: number;
  dir?: 1 | -1;
}

export type ExtremeKey = 'M_max' | 'M_min' | 'V_max' | 'V_min' | 'N_max' | 'N_min' | 'w_max';
export type ReactionKey = 'Rx_max' | 'Rx_min' | 'Ry_max' | 'Ry_min' | 'M_max' | 'M_min';

export interface TrainEnvelope {
  id: string;
  /** Upper and lower bound over every position (the train may also be absent: bounds include 0). */
  max: BeamSolution;
  min: BeamSolution;
  /** The extremes and where they act; M sagging positive, on members drawn right to left too (`max`, `min` are in member axes). */
  extremes: Partial<Record<ExtremeKey, Critical>>;
  /** Per support id. */
  reactions: Record<string, Partial<Record<ReactionKey, { value: number; lead?: number; dir?: 1 | -1 }>>>;
}

export interface InfluenceResult {
  /** The load positions, m. */
  xs: number[];
  /** Spacing of the positions actually used, m. */
  step: number;
  lines: InfluenceLine[];
  trains: TrainEnvelope[];
}

/** Stations on a member off the load path (it is cut in this many elements). */
const OFF_PATH = 8;
/** At most about this many load positions: a finer step is widened. */
export const MAX_POSITIONS = 600;
/** At least this many steps along the path: a coarser step is narrowed (else the envelope has no inside). */
export const MIN_STEPS = 10;

/**
 * The load path as one chain from left to right: the members marked as deck, or with
 * none marked every horizontal member.
 */
export function loadPath(st: NumStructure, deck?: Set<string>): PathSeg[] {
  const N = new Map(st.nodes.map((q) => [q.id, q]));
  let size = 0;
  for (const q of st.nodes) size = Math.max(size, Math.abs(q.x), Math.abs(q.y));
  const tol = 1e-9 * Math.max(1, size);
  const marked = !!deck?.size;
  const segs: (PathSeg & { left: string; right: string })[] = [];
  for (const m of st.members) {
    const a = N.get(m.a), b = N.get(m.b);
    if (!a || !b) continue;
    if (marked ? !deck!.has(m.id) : Math.abs(b.y - a.y) > tol) continue;
    if (Math.abs(b.x - a.x) <= tol) throw new StructureError('A vertical member cannot carry the moving loads: take it off the load path');
    const flip = b.x < a.x;
    segs.push({ member: m.id, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), flip, left: flip ? m.b : m.a, right: flip ? m.a : m.b });
  }
  if (!segs.length) throw new StructureError(marked ? 'The load path is empty' : 'No horizontal member to carry the moving loads: mark the deck members as the load path');
  segs.sort((p, q) => p.x0 - q.x0);
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].left !== segs[i - 1].right) throw new StructureError(marked
      ? 'The load path must be one chain of members from left to right'
      : 'The horizontal members are not one chain: mark the deck members as the load path');
  }
  return segs.map(({ member, x0, x1, flip }) => ({ member, x0, x1, flip }));
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Sorted, without near repeats. */
function uniq(ts: number[]): number[] {
  return [...ts].sort((a, b) => a - b).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 1e-9);
}

/** Local → global rotation of an element's end values, R = blockdiag([[c, s, 0], [−s, c, 0], [0, 0, 1]]). */
const rotation = (c: number, s: number) => [[c, s, 0, 0, 0, 0], [-s, c, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, c, s, 0], [0, 0, 0, -s, c, 0], [0, 0, 0, 0, 0, 1]];

/** A station: a point on a member where results are recorded. */
interface Station {
  member: string;
  /** Distance along the member (m) and the fraction. */
  s: number;
  t: number;
  elem: number;
  /** Global x of the section, m. */
  x: number;
}

/** Influence ordinates of one quantity, with the two sides where it jumps. */
interface Line {
  v: Float64Array;
  /** The position where the line jumps (V, N at their own station), its value just left and just right. */
  k0: number;
  left: number;
  right: number;
  /** The station's own position on the path: a kink (or the jump). */
  kink: number;
}

/** Every stop of a train: for each, the axles' segment (or vertex) and weight. */
interface Stops {
  n: number;
  na: number;
  lead: Float64Array;
  dir: Int8Array;
  /** Per stop and axle: the vertex or segment start (−1: off the path), and the weight along the segment (0: on the vertex). */
  k: Int32Array;
  w: Float64Array;
  P: Float64Array;
}

function trainStops(xs: number[], spec: TrainSpec, tol: number): Stops {
  const na = spec.P.length;
  const dirs: (1 | -1)[] = spec.dir === 'forward' ? [1] : spec.dir === 'backward' ? [-1] : [1, -1];
  const leads: [number, 1 | -1][] = [];
  for (const d of dirs) {
    // travelling +x the first axle leads: axle i is at lead − offset_i (−x: lead + offset_i)
    const at = uniq(xs.flatMap((x) => spec.offsets.map((o) => x + d * o)));
    for (const e of at) leads.push([e, d]);
  }
  const n = leads.length, P = xs.length;
  const out: Stops = { n, na, lead: new Float64Array(n), dir: new Int8Array(n), k: new Int32Array(n * na), w: new Float64Array(n * na), P: Float64Array.from(spec.P) };
  leads.forEach(([e, d], c) => {
    out.lead[c] = e;
    out.dir[c] = d;
    for (let i = 0; i < na; i++) {
      const xi = e - d * spec.offsets[i];
      let k = -1, w = 0;
      if (xi >= xs[0] - tol && xi <= xs[P - 1] + tol) {
        let lo = 0, hi = P - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (xs[mid] <= xi + tol) lo = mid;
          else hi = mid - 1;
        }
        k = lo;
        if (Math.abs(xi - xs[k]) > tol && k < P - 1) w = (xi - xs[k]) / (xs[k + 1] - xs[k]);
      }
      out.k[c * na + i] = k;
      out.w[c * na + i] = w;
    }
  });
  return out;
}

/** Largest and smallest response to the train over its stops (0 included: it may be away), and where. */
function sweep(l: Line, st: Stops): { hi: number; lo: number; ihi: number; ilo: number } {
  let hi = 0, lo = 0, ihi = -1, ilo = -1;
  const { v, k0, left, right } = l;
  for (let c = 0; c < st.n; c++) {
    let sL = 0, sR = 0;
    for (let i = 0, j = c * st.na; i < st.na; i++, j++) {
      const k = st.k[j];
      if (k < 0) continue;
      const P = st.P[i], w = st.w[j];
      if (w === 0) {
        // an axle on the station's own position: either side of the jump
        if (k === k0) {
          sL += P * left;
          sR += P * right;
        } else {
          sL += P * v[k];
          sR += P * v[k];
        }
      } else {
        const a = k === k0 ? right : v[k], b = k + 1 === k0 ? left : v[k + 1];
        const y = P * (a + (b - a) * w);
        sL += y;
        sR += y;
      }
    }
    const big = Math.max(sL, sR), small = Math.min(sL, sR);
    if (big > hi) { hi = big; ihi = c; }
    if (small < lo) { lo = small; ilo = c; }
  }
  return { hi, lo, ihi, ilo };
}

/** The polynomial through (px, pf) at x. */
function lagrange(px: number[], pf: number[], x: number): number {
  let y = 0;
  for (let i = 0; i < px.length; i++) {
    let w = pf[i];
    for (let j = 0; j < px.length; j++) if (j !== i) w *= (x - px[j]) / (px[i] - px[j]);
    y += w;
  }
  return y;
}

/**
 * The ordinate of a line at x (m): the cubic through the nearest four ordinates of its
 * smooth stretch, so exact between positions too; the right-hand value where it jumps.
 */
export function ilValue(l: InfluenceLine, x: number): number {
  // the last position at or before x (of a repeated one, the right-hand side)
  let i = 0, hi = l.x.length - 2;
  while (i < hi) {
    const mid = (i + hi + 1) >> 1;
    if (l.x[mid] <= x) i = mid;
    else hi = mid - 1;
  }
  const h = l.x[i + 1] - l.x[i];
  if (!(h > 0)) return l.v[i + 1];
  const st = l.smooth.find(([a, b]) => a <= i && i + 1 <= b);
  if (!st) return l.v[i] + ((l.v[i + 1] - l.v[i]) * (x - l.x[i])) / h;
  const j0 = Math.max(st[0], Math.min(i - 1, st[1] - 3)), j1 = Math.min(st[1], j0 + 3);
  return lagrange(l.x.slice(j0, j1 + 1), l.v.slice(j0, j1 + 1), x);
}

/** The largest (dir 1) or smallest (−1) ordinate, between positions too, and where. */
export function ilPeak(l: InfluenceLine, dir: 1 | -1): { x: number; v: number } {
  let i = 0;
  l.v.forEach((v, k) => { if (dir * v > dir * l.v[i]) i = k; });
  const best = { x: l.x[i], v: l.v[i] };
  // a smooth crest between its neighbours: golden section on the cubic
  if (!l.smooth.some(([a, b]) => a < i && i < b)) return best;
  let a = l.x[i - 1], b = l.x[i + 1];
  const g = (Math.sqrt(5) - 1) / 2, f = (x: number) => dir * ilValue(l, x);
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let it = 0; it < 80 && b - a > 1e-12 * (Math.abs(a) + Math.abs(b) + 1); it++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  const xm = (a + b) / 2, vm = ilValue(l, xm);
  return dir * vm > dir * best.v ? { x: xm, v: vm } : best;
}

/**
 * Positive and negative parts of ∫ p dx over [a, b], p the polynomial through (px, pf)
 * with p(a) = fa, p(b) = fb: cut at its root where the sign changes, each part by
 * two-point Gauss, which is exact up to cubics.
 */
function polyParts(px: number[], pf: number[], a: number, b: number, fa: number, fb: number): [number, number] {
  const p = (x: number) => lagrange(px, pf, x);
  const gauss = (u: number, w: number) => {
    const m = (u + w) / 2, d = (w - u) / (2 * Math.sqrt(3));
    return ((w - u) / 2) * (p(m - d) + p(m + d));
  };
  if (fa * fb >= 0) {
    const I = gauss(a, b);
    return fa + fb > 0 || (fa + fb === 0 && I > 0) ? [I, 0] : [0, I];
  }
  // p is the line itself here, so its root is where the line crosses zero
  let lo = a, hi = b;
  for (let it = 0; it < 80 && hi - lo > 1e-13 * (b - a); it++) {
    const mid = (lo + hi) / 2;
    if (p(mid) * fa > 0) lo = mid;
    else hi = mid;
  }
  const r = (lo + hi) / 2, I1 = gauss(a, r), I2 = gauss(r, b);
  return fa > 0 ? [I1, I2] : [I2, I1];
}

/**
 * Positive and negative area under a line (the uniform load's adverse parts). Between
 * joints and its own station the line is one cubic (the response to a unit load moving
 * along an unloaded member), so Simpson's rule over two equal steps (3/8 over three at
 * the end of an odd stretch) is exact where the sign does not change; where it does,
 * the cubic through the four nearest ordinates, cut at its root, is exact too.
 */
function areas(l: Line, xs: number[], joint: boolean[]): [number, number] {
  let pos = 0, neg = 0;
  const P = xs.length;
  let s = 0;
  while (s < P - 1) {
    let e = s + 1;
    while (e < P - 1 && !joint[e] && e !== l.kink && e !== l.k0) e++;
    // the stretch's ordinates, a jump at its ends seen from inside
    const val = (k: number) => (k === l.k0 ? (k === s ? l.right : l.left) : l.v[k]);
    for (let k = s; k < e;) {
      const n = e - k, m = n === 3 ? 3 : n >= 2 ? 2 : 1, h = xs[k + 1] - xs[k];
      if (m > 1 && Math.abs(xs[k + 2] - xs[k + 1] - h) < 1e-9 * h && (m === 2 || Math.abs(xs[k + 3] - xs[k + 2] - h) < 1e-9 * h)) {
        const f0 = val(k), f1 = val(k + 1), f2 = val(k + 2), f3 = m === 3 ? val(k + 3) : 0;
        const lo = Math.min(f0, f1, f2, f3), hi = Math.max(f0, f1, f2, f3);
        if (lo >= 0 || hi <= 0) {
          const I = m === 2 ? (h / 3) * (f0 + 4 * f1 + f2) : ((3 * h) / 8) * (f0 + 3 * f1 + 3 * f2 + f3);
          if (hi > 0) pos += I;
          else neg += I;
          k += m;
          continue;
        }
      }
      // one step at a time: the cubic through the nearest four ordinates of the stretch
      const j0 = Math.max(s, Math.min(k - 1, e - 3)), j1 = Math.min(e, j0 + 3);
      const px: number[] = [], pf: number[] = [];
      for (let j = j0; j <= j1; j++) { px.push(xs[j]); pf.push(val(j)); }
      const [p, q] = polyParts(px, pf, xs[k], xs[k + 1], val(k), val(k + 1));
      pos += p;
      neg += q;
      k += 1;
    }
    s = e;
  }
  return [pos, neg];
}

/** Straight pieces between stations, so a station-wise solution reads like an exact one (memberAt). */
export function linearPieces(r: { s: number[]; N: number[]; V: number[]; M: number[]; dx: number[]; dy: number[] }): PiecePoly[] {
  const out: PiecePoly[] = [];
  const line = (a: number, b: number, L: number) => [a, (b - a) / L];
  for (let i = 0; i + 1 < r.s.length; i++) {
    const L = r.s[i + 1] - r.s[i];
    if (!(L > 1e-12)) continue;
    out.push({
      s0: r.s[i], L, c: 1, s: 0,
      N: line(r.N[i], r.N[i + 1], L), V: line(r.V[i], r.V[i + 1], L), M: line(r.M[i], r.M[i + 1], L),
      u: line(r.dx[i], r.dx[i + 1], L), v: line(r.dy[i], r.dy[i + 1], L),
    });
  }
  return out;
}

/** The extremes of a pair of bounds (largest magnitude over both), set on both like an envelope's. */
export function boundExtremes(hi: BeamSolution, lo: BeamSolution): void {
  for (const key of ['N', 'V', 'M'] as const) {
    let best: Extreme | undefined;
    for (const env of [hi, lo]) for (const mr of env.members) mr[key].forEach((v, i) => {
      if (!best || Math.abs(v) > Math.abs(best.value)) best = { value: v, member: mr.id, s: mr.s[i], x: 0, y: 0 };
    });
    if (best) hi.max[key] = lo.max[key] = best;
  }
  let w: Extreme | undefined, sig: Extreme | undefined;
  for (const env of [hi, lo]) for (const mr of env.members) mr.dy.forEach((v, i) => {
    const mag = Math.hypot(v, mr.dx[i]);
    if (!w || mag > w.value) w = { value: mag, member: mr.id, s: mr.s[i], x: 0, y: 0 };
  });
  for (const mr of hi.members) mr.sigma?.forEach((v, i) => {
    if (!sig || v > sig.value) sig = { value: v, member: mr.id, s: mr.s[i], x: 0, y: 0 };
  });
  if (w) hi.max.w = lo.max.w = w;
  if (sig) hi.max.sigma = lo.max.sigma = sig;
}

/**
 * Equivalent nodal loads (local axes, both ends fixed) of a point load (Fx, Fy) at a
 * along an element: with M(x) = M₀ + V₀x + F_y (x − a)₊ the two end conditions of a
 * clamped member, no end rotation (∫M dx = 0) and no end deflection
 * (∫(L − x) M/EI dx − ΔM/GA_v = 0), as for line loads in solve.ts. Without shear these
 * are the handbook values F_y b²(3a + b)/L³, F_y a b²/L² ….
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
 * Influence lines for the queries, and the envelopes of the trains, for a unit load
 * travelling along `path` at positions about `step` apart. The members stay whole (a
 * fine mesh would cost digits: its condition number grows with the fourth power of the
 * element count); the load sits on its member as fixed-end forces, and the forces along
 * a member follow from statics, exactly as in solve.ts.
 */
export function influenceAnalysis(st: NumStructure, path: PathSeg[], step: number, queries: InfluenceQuery[], trains: TrainSpec[]): InfluenceResult {
  const onPath = new Map(path.map((p) => [p.member, p]));
  const span = path[path.length - 1].x1 - path[0].x0;
  if (!(span > 0)) throw new StructureError('The load path has no length');
  step = Math.min(Math.max(step > 0 ? step : span / 200, span / MAX_POSITIONS), span / MIN_STEPS);

  // stations per member: on the path the load positions, a grid every `step` from its
  // left end (so axles spaced in whole steps stand on positions together) plus the
  // member ends; elsewhere a few; and the sections asked for
  const Nd = new Map(st.nodes.map((q) => [q.id, q]));
  const grid = Array.from({ length: Math.floor(span / step + 1e-9) + 1 }, (_, k) => path[0].x0 + k * step);
  const tset = new Map<string, number[]>();
  for (const m of st.members) {
    const seg = onPath.get(m.id);
    if (!seg) {
      tset.set(m.id, Array.from({ length: OFF_PATH + 1 }, (_, k) => k / OFF_PATH));
      continue;
    }
    const xa = Nd.get(m.a)!.x, xb = Nd.get(m.b)!.x;
    const inside = grid.filter((x) => x > seg.x0 + 1e-9 * span && x < seg.x1 - 1e-9 * span);
    tset.set(m.id, [0, 1, ...inside.map((x) => (x - xa) / (xb - xa))]);
  }
  for (const q of queries) if (q.member && q.t !== undefined) tset.get(q.member)?.push(clamp01(q.t));
  for (const [id, ts] of tset) tset.set(id, uniq(ts));

  const mesh = frameMesh({ ...st, loads: [] });
  const elems = mesh.pieces;
  const elemOf = new Map(elems.map((p, e) => [p.member.id, e]));
  const { map, ends, count: nz, springs, rotSprings } = reducedDofs(st, mesh, elems);
  const K = new SparseSym(nz);
  const scatter = (M: number[][], dofs: number[]) => dofs.forEach((da, a) => dofs.forEach((db, b) => {
    const v = M[a][b];
    if (v) for (const [ia, wa] of map[da]) for (const [ib, wb] of map[db]) K.add(ia, ib, wa * wb * v);
  }));
  const kLoc = elems.map((p) => localK(p.member.E, p.member.A, p.member.I, p.L, shearStiffness(p.member)));
  elems.forEach((p, e) => scatter(toGlobal(kLoc[e], p.c, p.s), ends[e]));
  for (const sp of springs) {
    const [nx, ny] = sp.n;
    scatter([[sp.k * nx * nx, sp.k * nx * ny], [sp.k * nx * ny, sp.k * ny * ny]], [3 * sp.node, 3 * sp.node + 1]);
  }
  for (const sp of rotSprings) scatter([[sp.kr]], [3 * sp.node + 2]);
  const ch = nz ? skylineCholesky(K) : null;
  if (!ch) throw new StructureError('The structure can move freely (a mechanism): add supports, or remove hinges');

  // load positions along the path, left to right, each on the members it lies on (a
  // joint between two of them on both); the load is put on the first
  const xs: number[] = [];
  const on: { e: number; a: number }[][] = [];
  /** Positions at the ends of path members, where the lines have kinks. */
  const joint: boolean[] = [];
  path.forEach((seg, si) => {
    const e = elemOf.get(seg.member)!, p = elems[e];
    const ts = seg.flip ? [...tset.get(seg.member)!].reverse() : tset.get(seg.member)!;
    ts.forEach((t, k) => {
      if (si > 0 && k === 0) {
        on[on.length - 1].push({ e, a: t * p.L });
        return;
      }
      xs.push(mesh.pos[p.i].x + (mesh.pos[p.j].x - mesh.pos[p.i].x) * t);
      on.push([{ e, a: t * p.L }]);
      joint.push(k === 0 || k === ts.length - 1);
    });
  });
  const P = xs.length;
  // the unit load (0, −1) on an element: (−s, −c) in its axes
  const fixed = (e: number, a: number) => {
    const p = elems[e], m = p.member;
    return pointFixedEnd(p.L, a, -p.s, -p.c, m.E * m.I, shearStiffness(m));
  };
  const loadF = on.map((list) => ({ e: list[0].e, f: fixed(list[0].e, list[0].a) }));
  // one solve per position: the reduced displacements Z[k]
  const Z = new Float64Array(P * nz);
  const rhs = new Float64Array(nz);
  for (let k = 0; k < P; k++) {
    const { e, f } = loadF[k], p = elems[e];
    const fg = [p.c * f[0] - p.s * f[1], p.s * f[0] + p.c * f[1], f[2], p.c * f[3] - p.s * f[4], p.s * f[3] + p.c * f[4], f[5]];
    rhs.fill(0);
    ends[e].forEach((d, i) => { for (const [z, w] of map[d]) rhs[z] += w * fg[i]; });
    Z.set(skylineSolve(ch, rhs), k * nz);
  }
  const full = (d: number, k: number) => {
    let v = 0;
    for (const [z, w] of map[d]) v += w * Z[k * nz + z];
    return v;
  };
  // k·d of an element (local axes) as a linear map of the reduced displacements
  const ops = elems.map((p, e) => {
    const R = rotation(p.c, p.s), kl = kLoc[e];
    const kR = kl.map((row) => R[0].map((_, j) => row.reduce((acc, v, q) => acc + v * R[q][j], 0)));
    const acc = new Map<number, Float64Array>();
    ends[e].forEach((d, a) => {
      for (const [z, w] of map[d]) {
        let c = acc.get(z);
        if (!c) acc.set(z, (c = new Float64Array(6)));
        for (let i = 0; i < 6; i++) c[i] += kR[i][a] * w;
      }
    });
    return { z: [...acc.keys()], c: [...acc.values()] };
  });
  /** End forces of an element at position k (local axes), less the fixed-end forces of a load on it. */
  const endForces = (e: number, k: number, f?: number[]) => {
    const pe = new Float64Array(6);
    const { z, c } = ops[e];
    for (let q = 0; q < z.length; q++) {
      const v = Z[k * nz + z[q]];
      if (v) for (let i = 0; i < 6; i++) pe[i] += c[q][i] * v;
    }
    if (f) for (let i = 0; i < 6; i++) pe[i] -= f[i];
    return pe;
  };

  // stations, member by member
  const stations: Station[] = [];
  const stationsOf = new Map<string, Station[]>();
  for (const m of st.members) {
    const e = elemOf.get(m.id)!, p = elems[e];
    const A = mesh.pos[p.i], B = mesh.pos[p.j];
    const list = tset.get(m.id)!.map((t): Station => ({ member: m.id, s: t * p.L, t, elem: e, x: A.x + (B.x - A.x) * t }));
    stationsOf.set(m.id, list);
    stations.push(...list);
  }

  type Lines = Record<'N' | 'V' | 'M' | 'dx' | 'dy', Line>;
  /**
   * The five influence lines (N, V, M, dx, dy) of every station on a member: statics
   * along it, with the load's own terms when the load is on it (V and N jump where it
   * passes). The member's end forces are found once per position.
   */
  const memberLines = (id: string): Lines[] => {
    const list = stationsOf.get(id)!;
    const e = elemOf.get(id)!, p = elems[e], m = p.member, L = p.L;
    const EI = m.E * m.I, EA = m.E * m.A, GAv = shearStiffness(m), sh = Number.isFinite(GAv) ? 1 / GAv : 0;
    const Fx = -p.s, Fy = -p.c, flip = !!onPath.get(id)?.flip;
    const out = list.map(() => ({
      N: new Float64Array(P), V: new Float64Array(P), M: new Float64Array(P), dx: new Float64Array(P), dy: new Float64Array(P),
      jN: { k0: -1, left: 0, right: 0 }, jV: { k0: -1, left: 0, right: 0 }, kink: -1,
    }));
    for (let k = 0; k < P; k++) {
      const own = onPath.has(id) ? on[k].find((q) => q.e === e) : undefined;
      const pe = endForces(e, k, own ? fixed(e, own.a) : undefined);
      // the load's terms: F (x − a)₊ and its integrals
      const a = own ? own.a : Infinity, fx = own ? Fx : 0, fy = own ? Fy : 0;
      // deflection: the exact double integral of M/EI (and −ΔM/GA_v) between the end displacements
      const p0 = pe[0], p1 = pe[1], p2 = pe[2];
      const W = (x: number, d: number) => (-p2 * x * x / 2 + (p1 * x * x * x) / 6 + (fy * d * d * d) / 6) / EI - sh * (p1 * x + fy * d);
      const U = (x: number, d: number) => (-p0 * x - fx * d) / EA;
      const dL = Math.max(0, L - a), WL = W(L, dL), UL = U(L, dL);
      const g = [full(3 * p.i, k), full(3 * p.i + 1, k), full(3 * p.j, k), full(3 * p.j + 1, k)];
      const u1 = p.c * g[0] + p.s * g[1], v1 = -p.s * g[0] + p.c * g[1], u2 = p.c * g[2] + p.s * g[3], v2 = -p.s * g[2] + p.c * g[3];
      list.forEach((sn, i) => {
        const o = out[i], x = sn.s, d = Math.max(0, x - a), before = own !== undefined && a < x;
        o.N[k] = -p0 - (before ? fx : 0);
        o.V[k] = p1 + (before ? fy : 0);
        o.M[k] = -p2 + p1 * x + fy * d;
        if (own && a === x) {
          // on the station: the load just before it along the member, or just after
          const nb = -p0 - fx, na = -p0, vb = p1 + fy, va = p1;
          o.kink = k;
          o.jN = { k0: k, left: flip ? na : nb, right: flip ? nb : na };
          o.jV = { k0: k, left: flip ? va : vb, right: flip ? vb : va };
        }
        const v = v1 + ((v2 - v1) * x) / L + W(x, d) - (x / L) * WL;
        const u = u1 + ((u2 - u1) * x) / L + U(x, d) - (x / L) * UL;
        o.dx[k] = p.c * u - p.s * v;
        o.dy[k] = p.s * u + p.c * v;
      });
    }
    return out.map((o) => {
      const flat = (v: Float64Array): Line => ({ v, k0: -1, left: 0, right: 0, kink: o.kink });
      return { N: { v: o.N, ...o.jN, kink: o.kink }, V: { v: o.V, ...o.jV, kink: o.kink }, M: flat(o.M), dx: flat(o.dx), dy: flat(o.dy) };
    });
  };

  /** Influence lines of a support's reactions: the end forces of its members (the load is always on one). */
  const reactionLines = (supportId: string): Record<'Rx' | 'Ry' | 'Mr', Line> => {
    const sp = st.supports.find((q) => q.id === supportId);
    const node = sp ? mesh.nodeIndex.get(sp.node) : undefined;
    const Rx = new Float64Array(P), Ry = new Float64Array(P), Mr = new Float64Array(P);
    if (node !== undefined) {
      const at = elems.flatMap((p, e) => [...(p.i === node ? [[e, 0]] : []), ...(p.j === node ? [[e, 3]] : [])]);
      for (let k = 0; k < P; k++) {
        let fx = 0, fy = 0, mz = 0;
        for (const [e, o] of at) {
          const q = endForces(e, k, loadF[k].e === e ? loadF[k].f : undefined), c = elems[e].c, s = elems[e].s;
          fx += c * q[o] - s * q[o + 1];
          fy += s * q[o] + c * q[o + 1];
          mz += q[o + 2];
        }
        Rx[k] = fx;
        Ry[k] = fy;
        Mr[k] = mz;
      }
    }
    const flat = (v: Float64Array): Line => ({ v, k0: -1, left: 0, right: 0, kink: -1 });
    return { Rx: flat(Rx), Ry: flat(Ry), Mr: flat(Mr) };
  };

  const toLine = (id: string, l: Line): InfluenceLine => {
    const x: number[] = [], v: number[] = [], smooth: [number, number][] = [];
    let start = 0;
    for (let k = 0; k < P; k++) {
      if (k === l.k0) {
        x.push(xs[k], xs[k]);
        v.push(l.left, l.right);
        smooth.push([start, x.length - 2]);
        start = x.length - 1;
      } else {
        x.push(xs[k]);
        v.push(l.v[k]);
        // a kink: a joint, or the station's own position
        if (k > 0 && k < P - 1 && (joint[k] || k === l.kink)) {
          smooth.push([start, x.length - 1]);
          start = x.length - 1;
        }
      }
    }
    smooth.push([start, x.length - 1]);
    return { id, x, v, smooth: smooth.filter(([a, b]) => b > a) };
  };
  const lines: InfluenceLine[] = [];
  const memo = new Map<string, Lines[]>();
  for (const q of queries) {
    if (q.kind === 'Rx' || q.kind === 'Ry' || q.kind === 'Mr') {
      if (!q.support) continue;
      lines.push(toLine(q.id, reactionLines(q.support)[q.kind]));
      continue;
    }
    const i = q.member ? stationsOf.get(q.member)?.findIndex((x) => Math.abs(x.t - clamp01(q.t ?? 0)) < 1e-9) ?? -1 : -1;
    if (i < 0) continue;
    if (!memo.has(q.member!)) memo.set(q.member!, memberLines(q.member!));
    const ls = memo.get(q.member!)![i];
    lines.push(toLine(q.id, q.kind === 'w' ? ls.dy : ls[q.kind]));
  }

  // trains: every station's lines swept and integrated
  const tol = 1e-9 * Math.max(1, span);
  const specs = trains.map((t) => ({ spec: t, stops: t.P.length ? trainStops(xs, t, tol) : null }));
  type Bound = { hi: number; lo: number; ihi: number; ilo: number };
  const bound = (l: Line, t: (typeof specs)[number]): Bound => {
    const b = t.stops ? sweep(l, t.stops) : { hi: 0, lo: 0, ihi: -1, ilo: -1 };
    if (t.spec.q) {
      const [pos, neg] = areas(l, xs, joint);
      const q = t.spec.q;
      b.hi += q > 0 ? q * pos : q * neg;
      b.lo += q > 0 ? q * neg : q * pos;
    }
    return b;
  };
  const QS = ['N', 'V', 'M', 'dx', 'dy'] as const;
  const perTrain = specs.map(() => stations.map(() => ({} as Record<(typeof QS)[number], Bound>)));
  if (specs.length) {
    let i = 0;
    for (const m of st.members) {
      for (const ls of memo.get(m.id) ?? memberLines(m.id)) {
        specs.forEach((t, ti) => {
          for (const key of QS) perTrain[ti][i][key] = bound(ls[key], t);
        });
        i++;
      }
    }
  }
  const reactionBounds = st.supports.map((sp) => {
    if (!specs.length) return [];
    const ls = reactionLines(sp.id);
    return specs.map((t) => ({ Rx: bound(ls.Rx, t), Ry: bound(ls.Ry, t), Mr: bound(ls.Mr, t) }));
  });

  const envelopes = specs.map((t, ti): TrainEnvelope => {
    const mk = (): BeamSolution => ({ members: [], reactions: [], nodes: {}, max: {}, indeterminacy: 0 });
    const hi = mk(), lo = mk();
    const extremes: TrainEnvelope['extremes'] = {};
    const stopAt = (c: number) => (t.stops && c >= 0 ? { lead: t.stops.lead[c], dir: t.stops.dir[c] as 1 | -1 } : {});
    const consider = (key: ExtremeKey, value: number, sn: Station, c: number, larger: (a: number, b: number) => boolean) => {
      const cur = extremes[key];
      if (cur && !larger(value, cur.value)) return;
      extremes[key] = { value, member: sn.member, s: sn.s, x: sn.x, ...stopAt(c) };
    };
    let k = 0;
    for (const m of st.members) {
      const list = stationsOf.get(m.id)!;
      const L = list[list.length - 1].s;
      // the extremes of M in the beam's sign convention, as the influence lines: on a member
      // drawn right to left its local y points down, so its sagging bound is the lower one
      const sg = Nd.get(m.b)!.x < Nd.get(m.a)!.x ? -1 : 1;
      const H: MemberResult = { id: m.id, L, s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [] };
      const Lo: MemberResult = { id: m.id, L, s: [], N: [], V: [], M: [], dx: [], dy: [], pieces: [] };
      for (const sn of list) {
        const b = perTrain[ti][k++];
        H.s.push(sn.s); Lo.s.push(sn.s);
        for (const key of QS) {
          H[key].push(b[key].hi);
          Lo[key].push(b[key].lo);
        }
        const gt = (a: number, c: number) => a > c, lt = (a: number, c: number) => a < c;
        for (const key of ['M', 'V', 'N'] as const) {
          const up = key === 'M' && sg < 0 ? { v: -b.M.lo, c: b.M.ilo } : { v: b[key].hi, c: b[key].ihi };
          const down = key === 'M' && sg < 0 ? { v: -b.M.hi, c: b.M.ihi } : { v: b[key].lo, c: b[key].ilo };
          consider(`${key}_max`, up.v, sn, up.c, gt);
          consider(`${key}_min`, down.v, sn, down.c, lt);
        }
        // the largest vertical deflection, either way
        const down = -b.dy.lo >= b.dy.hi;
        consider('w_max', down ? -b.dy.lo : b.dy.hi, sn, down ? b.dy.ilo : b.dy.ihi, gt);
      }
      if (m.W) {
        // extreme |N| and |M| at each station taken together (on the safe side)
        H.sigma = H.s.map((_, i) => Math.max(Math.abs(H.N[i]), Math.abs(Lo.N[i])) / m.A + Math.max(Math.abs(H.M[i]), Math.abs(Lo.M[i])) / m.W!);
      }
      H.pieces = linearPieces(H);
      Lo.pieces = linearPieces(Lo);
      hi.members.push(H);
      lo.members.push(Lo);
    }
    const reactions: TrainEnvelope['reactions'] = {};
    st.supports.forEach((sp, si) => {
      const b = reactionBounds[si][ti];
      const base = { id: sp.id, label: sp.label, node: sp.node };
      hi.reactions.push({ ...base, Rx: b.Rx.hi, Ry: b.Ry.hi, M: b.Mr.hi } as Reaction);
      lo.reactions.push({ ...base, Rx: b.Rx.lo, Ry: b.Ry.lo, M: b.Mr.lo } as Reaction);
      reactions[sp.id] = {
        Rx_max: { value: b.Rx.hi, ...stopAt(b.Rx.ihi) }, Rx_min: { value: b.Rx.lo, ...stopAt(b.Rx.ilo) },
        Ry_max: { value: b.Ry.hi, ...stopAt(b.Ry.ihi) }, Ry_min: { value: b.Ry.lo, ...stopAt(b.Ry.ilo) },
        M_max: { value: b.Mr.hi, ...stopAt(b.Mr.ihi) }, M_min: { value: b.Mr.lo, ...stopAt(b.Mr.ilo) },
      };
    });
    boundExtremes(hi, lo);
    return { id: t.spec.id, max: hi, min: lo, extremes, reactions };
  });

  return { xs, step, lines, trains: envelopes };
}

/** Point loads of a train with its first axle at `lead`, travelling `dir` (for the response at one position). */
export function trainLoads(path: PathSeg[], st: NumStructure, spec: Pick<TrainSpec, 'P' | 'offsets'>, lead: number, dir: 1 | -1): NumLoad[] {
  const N = new Map(st.nodes.map((q) => [q.id, q]));
  const members = new Map(st.members.map((m) => [m.id, m]));
  const out: NumLoad[] = [];
  spec.P.forEach((P, i) => {
    const x = lead - dir * spec.offsets[i];
    const seg = path.find((p) => x >= p.x0 - 1e-12 && x <= p.x1 + 1e-12);
    const m = seg && members.get(seg.member);
    if (!m) return;
    const a = N.get(m.a)!, b = N.get(m.b)!;
    // an axle a hair from a joint goes onto it: the direct solver splits the member there,
    // and a sliver of member (under about 1e-4 of its length) leaves it ill-conditioned
    let t = clamp01((x - a.x) / (b.x - a.x));
    if (t < 2e-4) t = 0;
    else if (t > 1 - 2e-4) t = 1;
    out.push({ id: `axle${i}`, type: 'force', at: { member: m.id, t }, Fx: 0, Fy: -P });
  });
  return out;
}
