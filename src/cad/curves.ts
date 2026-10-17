// Curves of the sketcher beyond lines and circles: B-splines (cubic through fit points,
// or from control points) and ellipses, with what every kernel and view needs of them.
//
// A B-spline here is non-rational, and the curves the sketch hands on are clamped (the
// first and last knots repeat deg + 1 times), so each starts at its first pole and ends
// at its last. The same poles and knots go into OCCT as a Geom_BSplineCurve, into the
// profile integrals span by span (a polynomial on each span, so Gauss–Legendre is exact)
// and into the mesh kernel as a dense polyline: every kernel sees one curve.
//
// Algorithms after Piegl & Tiller, The NURBS Book (2nd ed., 1997): A2.1 (span), A2.3
// (basis functions and derivatives), A5.1 (knot insertion), §9.2.1–9.2.2 (global
// interpolation with end conditions).
import type { Vec2 } from './profile';

export interface BSpline {
  deg: number;
  poles: Vec2[];
  /** Full knot vector: poles.length + deg + 1 non-decreasing values. */
  knots: number[];
}

const { abs, hypot, max, min, cos, sin, atan2, ceil, PI } = Math;

/** The parameter range of a B-spline, [knots[deg], knots[poles]]. */
export const bsDomain = (s: BSpline): [number, number] => [s.knots[s.deg], s.knots[s.poles.length]];

/** Span i with knots[i] ≤ u < knots[i + 1], inside the domain (the last span at its end). A2.1 */
function findSpan(s: BSpline, u: number): number {
  const n = s.poles.length - 1, p = s.deg, U = s.knots;
  if (u >= U[n + 1]) {
    let i = n;
    while (i > p && U[i] >= U[n + 1]) i--;
    return i;
  }
  if (u <= U[p]) {
    let i = p;
    while (i < n && U[i + 1] <= U[p]) i++;
    return i;
  }
  let lo = p, hi = n + 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (u < U[mid]) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** The deg + 1 basis functions that are not zero on span i and their derivatives up to nd. A2.3 */
function basisDerivs(i: number, u: number, p: number, nd: number, U: number[]): number[][] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0), right = new Array<number>(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j];
    right[j] = U[i + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }
  const ders: number[][] = Array.from({ length: nd + 1 }, () => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];
  const a = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= nd; k++) {
      let d = 0;
      const rk = r - k, pk = p - k;
      if (r >= k) {
        a[s2][0] = a[s1][0] / ndu[pk + 1][rk];
        d = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk, j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        d += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = -a[s1][k - 1] / ndu[pk + 1][r];
        d += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = d;
      [s1, s2] = [s2, s1];
    }
  }
  let r = p;
  for (let k = 1; k <= nd; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= r;
    r *= p - k;
  }
  return ders;
}

/** The point and derivatives up to nd at parameter u: [C(u), C′(u), C″(u) …]. */
export function bsEval(s: BSpline, u: number, nd = 0): Vec2[] {
  const p = s.deg, i = findSpan(s, u);
  const d = basisDerivs(i, u, p, min(nd, p), s.knots);
  const out: Vec2[] = [];
  for (let k = 0; k <= nd; k++) {
    let x = 0, y = 0;
    if (k <= p) {
      for (let j = 0; j <= p; j++) {
        const q = s.poles[i - p + j];
        x += d[k][j] * q.x;
        y += d[k][j] * q.y;
      }
    }
    out.push({ x, y });
  }
  return out;
}

export const bsPoint = (s: BSpline, u: number): Vec2 => bsEval(s, u)[0];

/** The curve run the other way: the same points, the parameter mirrored in the domain. */
export function bsReverse(s: BSpline): BSpline {
  const [a, b] = [s.knots[0], s.knots[s.knots.length - 1]];
  return { deg: s.deg, poles: [...s.poles].reverse(), knots: s.knots.map((k) => a + b - k).reverse() };
}

/** u inserted r more times (r + its multiplicity ≤ deg). A5.1 */
export function insertKnot(s: BSpline, u: number, r: number): BSpline {
  if (r <= 0) return s;
  const p = s.deg, UP = s.knots, P = s.poles, np = P.length - 1, mp = np + p + 1;
  const k = findSpan(s, u);
  let m = 0;
  for (const x of UP) if (x === u) m++;
  if (r + m > p) throw new Error('a knot cannot be inserted more often than the degree');
  const UQ: number[] = new Array(mp + r + 1);
  for (let i = 0; i <= k; i++) UQ[i] = UP[i];
  for (let i = 1; i <= r; i++) UQ[k + i] = u;
  for (let i = k + 1; i <= mp; i++) UQ[i + r] = UP[i];
  const Q: Vec2[] = new Array(np + r + 1);
  for (let i = 0; i <= k - p; i++) Q[i] = P[i];
  for (let i = k - m; i <= np; i++) Q[i + r] = P[i];
  const R: Vec2[] = [];
  for (let i = 0; i <= p - m; i++) R[i] = P[k - p + i];
  let L = 0;
  for (let j = 1; j <= r; j++) {
    L = k - p + j;
    for (let i = 0; i <= p - j - m; i++) {
      const al = (u - UP[L + i]) / (UP[i + k + 1] - UP[L + i]);
      R[i] = { x: al * R[i + 1].x + (1 - al) * R[i].x, y: al * R[i + 1].y + (1 - al) * R[i].y };
    }
    Q[L] = R[0];
    Q[k + r - j - m] = R[p - j - m];
  }
  for (let i = L + 1; i < k - m; i++) Q[i] = R[i - L];
  return { deg: p, poles: Q, knots: UQ };
}

/** The two clamped curves either side of u (inside the domain). */
export function bsSplit(s: BSpline, u: number): [BSpline, BSpline] {
  const p = s.deg;
  let m = 0;
  for (const x of s.knots) if (x === u) m++;
  const t = insertKnot(s, u, max(0, p - m));
  const a = t.knots.indexOf(u);
  const left: BSpline = { deg: p, poles: t.poles.slice(0, a), knots: [...t.knots.slice(0, a), ...new Array<number>(p + 1).fill(u)] };
  const right: BSpline = { deg: p, poles: t.poles.slice(a - 1), knots: [...new Array<number>(p + 1).fill(u), ...t.knots.slice(a + p)] };
  return [left, right];
}

/** A curve over [a, b] of an unclamped one (a periodic curve unwrapped), clamped at both ends. */
function clampTo(s: BSpline, a: number, b: number): BSpline {
  const right = bsSplit(s, a)[1];
  return bsSplit(right, b)[0];
}

/** Distinct knots inside the domain, from its start to its end (the spans' ends). */
export function bsBreaks(s: BSpline): number[] {
  const [a, b] = bsDomain(s);
  const out = [a];
  for (const k of s.knots) if (k > out[out.length - 1] && k <= b) out.push(k);
  return out;
}

// ------------------------------------------------------------ dense linear systems

/** Solve A X = B (A n × n, B n × m) by Gaussian elimination with partial pivoting; null if singular. */
export function solveLinear(A: number[][], B: number[][]): number[][] | null {
  const n = A.length, m = B[0]?.length ?? 0;
  const M = A.map((row, i) => [...row, ...B[i]]);
  let scale = 0;
  for (const row of A) for (const v of row) scale = max(scale, abs(v));
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (abs(M[r][c]) > abs(M[piv][c])) piv = r;
    if (!(abs(M[piv][c]) > 1e-14 * scale)) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k < n + m; k++) M[r][k] -= f * M[c][k];
    }
  }
  const X = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let r = n - 1; r >= 0; r--) {
    for (let j = 0; j < m; j++) {
      let v = M[r][n + j];
      for (let k = r + 1; k < n; k++) v -= M[r][k] * X[k][j];
      X[r][j] = v / M[r][r];
    }
  }
  return X;
}

// ------------------------------------------------------------ splines from points

export interface Interpolated {
  curve: BSpline;
  /** The parameter of each fit point (chord length, 0 at the first and 1 at the end). */
  params: number[];
}

/**
 * The cubic through the points in order, parameterised by chord length on [0, 1].
 * Open: knots at the fit points' parameters and two end conditions, each a given first
 * derivative (d0, d1) or a natural end (no second derivative, so no curvature there).
 * A tangent handle h0 (h1) is the second (last but one) pole instead: the end derivative is
 * 3·(h0 − Q₀)/u₁, so the handle sits where a Bézier's control point would on the first span.
 * Closed: a periodic cubic, C² all round (the first point is not repeated at the end).
 * Null when two neighbouring points coincide or too few are given.
 */
export function interpolate(Q: Vec2[], o: { closed?: boolean; d0?: Vec2; d1?: Vec2; h0?: Vec2; h1?: Vec2 } = {}): Interpolated | null {
  const n = Q.length;
  if (o.closed ? n < 3 : n < 2) return null;
  const chords: number[] = [];
  for (let i = 1; i < n + (o.closed ? 1 : 0); i++) chords.push(hypot(Q[i % n].x - Q[i - 1].x, Q[i % n].y - Q[i - 1].y));
  const total = chords.reduce((a, b) => a + b, 0);
  if (!(total > 0) || chords.some((c) => !(c > 1e-12 * total))) return null;
  const u = [0];
  for (const c of chords) u.push(u[u.length - 1] + c / total);
  u[u.length - 1] = 1;
  if (o.closed) return closedFit(Q, u);
  const m = n - 1;
  const d0 = o.h0 ? { x: (3 * (o.h0.x - Q[0].x)) / u[1], y: (3 * (o.h0.y - Q[0].y)) / u[1] } : o.d0;
  const d1 = o.h1 ? { x: (3 * (Q[m].x - o.h1.x)) / (1 - u[m - 1]), y: (3 * (Q[m].y - o.h1.y)) / (1 - u[m - 1]) } : o.d1;
  return openFit(Q, u, d0, d1);
}

function openFit(Q: Vec2[], u: number[], d0?: Vec2, d1?: Vec2): Interpolated | null {
  const n = Q.length - 1, p = 3;
  const knots = [0, 0, 0, 0, ...u.slice(1, n), 1, 1, 1, 1];
  const N = n + 3;
  const s: BSpline = { deg: p, poles: new Array(N).fill({ x: 0, y: 0 }), knots };
  const row = (t: number, k: number) => {
    const i = findSpan(s, t);
    const d = basisDerivs(i, t, p, k, knots)[k];
    const r = new Array<number>(N).fill(0);
    for (let j = 0; j <= p; j++) r[i - p + j] += d[j];
    return r;
  };
  const A: number[][] = [], B: number[][] = [];
  for (let k = 0; k <= n; k++) {
    A.push(row(u[k], 0));
    B.push([Q[k].x, Q[k].y]);
  }
  A.push(row(0, d0 ? 1 : 2));
  B.push(d0 ? [d0.x, d0.y] : [0, 0]);
  A.push(row(1, d1 ? 1 : 2));
  B.push(d1 ? [d1.x, d1.y] : [0, 0]);
  const X = solveLinear(A, B);
  if (!X) return null;
  const poles = X.map(([x, y]) => ({ x, y }));
  // the ends are the end points themselves (exactly, so profiles close on them)
  poles[0] = { ...Q[0] };
  poles[N - 1] = { ...Q[n] };
  return { curve: { deg: p, poles, knots }, params: u.slice(0, n + 1) };
}

/** A periodic cubic through n points, unwrapped (n + 3 poles) and clamped to [0, 1]. */
function closedFit(Q: Vec2[], u: number[]): Interpolated | null {
  const n = Q.length, p = 3;
  // knots of the unwrapped curve: t_i = U(i − 3), U(j) = u[j mod n] + ⌊j / n⌋
  const U = (j: number) => u[((j % n) + n) % n] + Math.floor(j / n);
  const knots = Array.from({ length: n + 2 * p + 1 }, (_, i) => U(i - p));
  const s: BSpline = { deg: p, poles: new Array(n + p).fill({ x: 0, y: 0 }), knots };
  const A: number[][] = [], B: number[][] = [];
  for (let k = 0; k < n; k++) {
    const i = findSpan(s, u[k]);
    const d = basisDerivs(i, u[k], p, 0, knots)[0];
    const r = new Array<number>(n).fill(0);
    for (let j = 0; j <= p; j++) r[(i - p + j) % n] += d[j];
    A.push(r);
    B.push([Q[k].x, Q[k].y]);
  }
  const X = solveLinear(A, B);
  if (!X) return null;
  const P = X.map(([x, y]) => ({ x, y }));
  const curve = clampTo({ deg: p, poles: Array.from({ length: n + p }, (_, i) => P[i % n]), knots }, 0, 1);
  curve.poles[0] = { ...Q[0] };
  curve.poles[curve.poles.length - 1] = { ...Q[0] };
  return { curve, params: u.slice(0, n) };
}

/**
 * The B-spline with these poles: open, clamped with uniform knots (degree 3, or less
 * with fewer than four poles); closed, periodic and uniform, clamped where it starts.
 * Null with too few poles.
 */
export function controlSpline(P: Vec2[], closed = false): BSpline | null {
  const m = P.length;
  if (closed) {
    if (m < 3) return null;
    const p = 3;
    const knots = Array.from({ length: m + 2 * p + 1 }, (_, i) => (i - p) / m);
    // shifted by one, so the curve starts next to the first pole: (P₋₁ + 4P₀ + P₁)/6
    const c = clampTo({ deg: p, poles: Array.from({ length: m + p }, (_, i) => P[(i + m - 1) % m]), knots }, 0, 1);
    // the seam closes exactly
    c.poles[c.poles.length - 1] = { ...c.poles[0] };
    return c;
  }
  if (m < 2) return null;
  const p = min(3, m - 1);
  const inner = Array.from({ length: m - p - 1 }, (_, i) => (i + 1) / (m - p));
  return { deg: p, poles: P.map((q) => ({ ...q })), knots: [...new Array<number>(p + 1).fill(0), ...inner, ...new Array<number>(p + 1).fill(1)] };
}

// ------------------------------------------------------------ closest points

/** The parameter of the point of the curve nearest to q (sampled, then Newton). */
export function bsClosest(s: BSpline, q: Vec2): number {
  const [a, b] = bsDomain(s);
  const breaks = bsBreaks(s);
  let best = a, bd = Infinity;
  for (let k = 0; k + 1 < breaks.length; k++) {
    for (let j = 0; j <= 16; j++) {
      const t = breaks[k] + ((breaks[k + 1] - breaks[k]) * j) / 16;
      const p = bsPoint(s, t);
      const d = hypot(p.x - q.x, p.y - q.y);
      if (d < bd) [bd, best] = [d, t];
    }
  }
  let t = best;
  for (let it = 0; it < 30; it++) {
    const [p, d1, d2] = bsEval(s, t, 2);
    const ex = p.x - q.x, ey = p.y - q.y;
    const f = ex * d1.x + ey * d1.y;
    const fp = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
    if (!(abs(fp) > 0)) break;
    const next = max(a, min(b, t - f / fp));
    if (abs(next - t) < 1e-15 * (b - a)) {
      t = next;
      break;
    }
    t = next;
  }
  return t;
}

// ------------------------------------------------------------ ellipses

export interface Ellipse {
  c: Vec2;
  /** Semi-axis along the direction at angle rot … */
  ra: number;
  /** … and across it. */
  rb: number;
  rot: number;
}

export function ellipsePoint(e: Ellipse, t: number): Vec2 {
  const cr = cos(e.rot), sr = sin(e.rot), x = e.ra * cos(t), y = e.rb * sin(t);
  return { x: e.c.x + x * cr - y * sr, y: e.c.y + x * sr + y * cr };
}

export function ellipseDeriv(e: Ellipse, t: number): Vec2 {
  const cr = cos(e.rot), sr = sin(e.rot), x = -e.ra * sin(t), y = e.rb * cos(t);
  return { x: x * cr - y * sr, y: x * sr + y * cr };
}

/** The parameter (eccentric anomaly) of the point of the ellipse in the direction of q seen in its own scaled frame. */
export function ellipseParam(e: Ellipse, q: Vec2): number {
  const cr = cos(e.rot), sr = sin(e.rot), dx = q.x - e.c.x, dy = q.y - e.c.y;
  return atan2((-dx * sr + dy * cr) / e.rb, (dx * cr + dy * sr) / e.ra);
}

/** ρ = √((x′/a)² + (y′/b)²) of q in the ellipse's frame: 1 on it, less inside. */
export function ellipseRho(e: Ellipse, q: Vec2): number {
  const cr = cos(e.rot), sr = sin(e.rot), dx = q.x - e.c.x, dy = q.y - e.c.y;
  return hypot((dx * cr + dy * sr) / e.ra, (-dx * sr + dy * cr) / e.rb);
}

/** The parameter of the point of the ellipse nearest to q (Newton from the scaled direction). */
export function ellipseClosest(e: Ellipse, q: Vec2): number {
  let t = ellipseParam(e, q);
  for (let it = 0; it < 30; it++) {
    const p = ellipsePoint(e, t), d1 = ellipseDeriv(e, t);
    const d2 = { x: e.c.x - p.x, y: e.c.y - p.y }; // C″ = −(C − c)
    const ex = p.x - q.x, ey = p.y - q.y;
    const f = ex * d1.x + ey * d1.y, fp = d1.x * d1.x + d1.y * d1.y + ex * d2.x + ey * d2.y;
    if (!(abs(fp) > 0)) break;
    const step = f / fp;
    t -= step;
    if (abs(step) < 1e-15) break;
  }
  return t;
}

/** CCW sweep from angle a to b in (0, 2π]. */
export const sweepCCW = (a: number, b: number) => {
  const s = (((b - a) % (2 * PI)) + 2 * PI) % (2 * PI);
  return s > 1e-12 ? s : 2 * PI;
};

/** Number of pieces for a curve whose tangent turns by `turn` radians, at most `step` each. */
export const piecesFor = (turn: number, step: number) => max(1, ceil(abs(turn) / step - 1e-9));
