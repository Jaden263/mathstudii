// Sketch construction tools: each builds geometry together with the constraints a CAD
// user expects (a rectangle stays rectangular, a polygon stays regular, a fillet stays
// tangent), so the solver keeps the design intent when dimensions change.
//
// Functions that take a sketch work on (and return) a copy; nothing mutates the input.
import { cadId, nextDimName, removeFromSketch, type CadConstraint, type CadEntity, type CadSketch, type ConstraintType } from './model';
import type { Seg, Vec2 } from './profile';
import { entitySegs, segCrossings } from './sketchCurves';

/** A picked location: an existing point, a point on a curve, or free space. */
export interface Ref {
  id?: string;
  on?: string;
  /** Snapped to the middle of this line. */
  mid?: string;
  p: Vec2;
}

export interface Opts {
  construction?: boolean;
}

export interface ToolResult {
  sketch: CadSketch;
  /** New entities, for selecting them. */
  ids: string[];
  /** Constraints that could not be kept, in words. */
  notes: string[];
}

const K = (type: ConstraintType, refs: string[], extra: Partial<CadConstraint> = {}): CadConstraint => ({ id: cadId('k'), type, refs, ...extra });
const sub = (a: Vec2, b: Vec2) => ({ x: a.x - b.x, y: a.y - b.y });
const len = (v: Vec2) => Math.hypot(v.x, v.y);
const unit = (v: Vec2) => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};

/** A copy to edit (whatever else the sketch carries, its projected sources, goes along). */
export function cloneSketch(sk: CadSketch): CadSketch {
  return { ...sk, points: [...sk.points], entities: [...sk.entities], constraints: [...sk.constraints] };
}

/** Point id for a Ref, adding the point (and its on-curve constraint) to `sk` when needed. Mutates sk. */
export function pointFor(sk: CadSketch, r: Ref): string {
  if (r.id) return r.id;
  const id = cadId('p');
  sk.points.push({ id, x: r.p.x, y: r.p.y });
  if (r.on) {
    const e = sk.entities.find((x) => x.id === r.on);
    if (e?.type === 'line') sk.constraints.push(K('pointOnLine', [id, e.id]));
    else if (e?.type === 'circle' || e?.type === 'arc') sk.constraints.push(K('pointOnCircle', [id, e.id]));
    else if (e?.type === 'ellipse' || e?.type === 'spline') sk.constraints.push(K('pointOnCurve', [id, e.id]));
  }
  if (r.mid) sk.constraints.push(K('midpoint', [id, r.mid]));
  r.id = id;
  return id;
}

const AUTO_HV = (3 * Math.PI) / 180;

/** A line between two refs; nearly horizontal/vertical new lines get that constraint. Mutates sk. */
export function addLine(sk: CadSketch, a: Ref, b: Ref, opts: Opts & { autoHV?: boolean } = {}): string {
  const fresh = !a.id || !b.id;
  const p1 = pointFor(sk, a), p2 = pointFor(sk, b);
  const id = cadId('e');
  sk.entities.push({ id, type: 'line', p1, p2, construction: opts.construction || undefined });
  if (opts.autoHV !== false && fresh) {
    const d = sub(b.p, a.p);
    const ang = Math.atan2(Math.abs(d.y), Math.abs(d.x));
    if (ang < AUTO_HV) sk.constraints.push(K('horizontal', [id]));
    else if (Math.PI / 2 - ang < AUTO_HV) sk.constraints.push(K('vertical', [id]));
  }
  return id;
}

function closedLoop(sk: CadSketch, pts: string[], opts: Opts): string[] {
  return pts.map((p, i) => {
    const id = cadId('e');
    sk.entities.push({ id, type: 'line', p1: p, p2: pts[(i + 1) % pts.length], construction: opts.construction || undefined });
    return id;
  });
}

/** Rectangle from two opposite corners: 4 lines, kept horizontal/vertical. */
export function rectangle(sk0: CadSketch, a: Ref, c: Ref, opts: Opts = {}): ToolResult {
  const sk = cloneSketch(sk0);
  const pts = [pointFor(sk, a), pointFor(sk, { p: { x: c.p.x, y: a.p.y } }), pointFor(sk, c), pointFor(sk, { p: { x: a.p.x, y: c.p.y } })];
  const lines = closedLoop(sk, pts, opts);
  sk.constraints.push(K('horizontal', [lines[0]]), K('vertical', [lines[1]]), K('horizontal', [lines[2]]), K('vertical', [lines[3]]));
  return { sketch: sk, ids: lines, notes: [] };
}

/** Rectangle about a centre point (construction diagonals, centre at their midpoint). */
export function centerRectangle(sk0: CadSketch, center: Ref, corner: Vec2, opts: Opts = {}): ToolResult {
  const sk = cloneSketch(sk0);
  const c = center.p;
  const dx = corner.x - c.x, dy = corner.y - c.y;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => pointFor(sk, { p: { x: c.x + sx * Math.abs(dx), y: c.y + sy * Math.abs(dy) } }));
  const lines = closedLoop(sk, corners, opts);
  sk.constraints.push(K('horizontal', [lines[0]]), K('vertical', [lines[1]]), K('horizontal', [lines[2]]), K('vertical', [lines[3]]));
  const d1 = cadId('e'), d2 = cadId('e');
  sk.entities.push({ id: d1, type: 'line', p1: corners[0], p2: corners[2], construction: true }, { id: d2, type: 'line', p1: corners[1], p2: corners[3], construction: true });
  // one midpoint is enough: a rectangle's diagonals bisect each other anyway
  const cp = pointFor(sk, { ...center });
  if (!center.id) sk.entities.push({ id: cadId('e'), type: 'point', p: cp, construction: true });
  sk.constraints.push(K('midpoint', [cp, d1]));
  return { sketch: sk, ids: lines, notes: [] };
}

export function circle(sk0: CadSketch, center: Ref, r: number, through?: Ref, opts: Opts = {}): ToolResult {
  const sk = cloneSketch(sk0);
  const c = pointFor(sk, { ...center });
  const id = cadId('e');
  sk.entities.push({ id, type: 'circle', c, r, construction: opts.construction || undefined });
  if (through?.id) sk.constraints.push(K('pointOnCircle', [through.id, id]));
  return { sketch: sk, ids: [id], notes: [] };
}

/** Arc by centre, start and an end direction (counter-clockwise). */
export function centerArc(sk0: CadSketch, center: Ref, start: Ref, end: Ref, opts: Opts = {}): ToolResult {
  const sk = cloneSketch(sk0);
  const c = pointFor(sk, { ...center });
  const p1 = pointFor(sk, start);
  const r = len(sub(start.p, center.p));
  const ang = Math.atan2(end.p.y - center.p.y, end.p.x - center.p.x);
  const e2: Ref = end.id ? end : { p: { x: center.p.x + r * Math.cos(ang), y: center.p.y + r * Math.sin(ang) }, on: end.on };
  const p2 = pointFor(sk, e2);
  const id = cadId('e');
  sk.entities.push({ id, type: 'arc', c, p1, p2, construction: opts.construction || undefined });
  return { sketch: sk, ids: [id], notes: [] };
}

/** Centre of the circle through three points, or null when they are collinear. */
export function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12 * Math.max(1, len(sub(b, a)) ** 2)) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  return { x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d };
}

const angOf = (c: Vec2, p: Vec2) => Math.atan2(p.y - c.y, p.x - c.x);
/** CCW sweep from angle a to angle b in [0, 2π). */
const ccw = (a: number, b: number) => (((b - a) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** Arc from a to b passing through m. */
export function threePointArc(sk0: CadSketch, a: Ref, b: Ref, m: Vec2, opts: Opts = {}): ToolResult | string {
  const c = circumcenter(a.p, b.p, m);
  if (!c) return 'The three points are on one line';
  const sk = cloneSketch(sk0);
  const cp = pointFor(sk, { p: c });
  const pa = pointFor(sk, a), pb = pointFor(sk, b);
  // counter-clockwise from a to b must pass m, otherwise run from b to a
  const passes = ccw(angOf(c, a.p), angOf(c, m)) < ccw(angOf(c, a.p), angOf(c, b.p));
  const id = cadId('e');
  sk.entities.push({ id, type: 'arc', c: cp, p1: passes ? pa : pb, p2: passes ? pb : pa, construction: opts.construction || undefined });
  return { sketch: sk, ids: [id], notes: [] };
}

/** Regular polygon inscribed in a construction circle: equal sides, every vertex on the circle. */
export function polygon(sk0: CadSketch, center: Ref, vertex: Vec2, sides: number, opts: Opts = {}): ToolResult | string {
  const n = Math.round(sides);
  if (!(n >= 3 && n <= 64)) return 'A polygon needs 3 to 64 sides';
  const r = len(sub(vertex, center.p));
  if (!(r > 0)) return 'The polygon has no size';
  const sk = cloneSketch(sk0);
  const c = pointFor(sk, { ...center });
  const circ = cadId('e');
  sk.entities.push({ id: circ, type: 'circle', c, r, construction: true });
  const a0 = angOf(center.p, vertex);
  const pts = Array.from({ length: n }, (_, i) => pointFor(sk, { p: { x: center.p.x + r * Math.cos(a0 + (2 * Math.PI * i) / n), y: center.p.y + r * Math.sin(a0 + (2 * Math.PI * i) / n) } }));
  const lines = closedLoop(sk, pts, opts);
  for (const p of pts) sk.constraints.push(K('pointOnCircle', [p, circ]));
  for (let i = 1; i < n; i++) sk.constraints.push(K('equal', [lines[0], lines[i]]));
  return { sketch: sk, ids: lines, notes: [] };
}

/** Straight slot between two centre points: two lines tangent to two equal end arcs. */
export function slot(sk0: CadSketch, a: Ref, b: Vec2, width: number, opts: Opts = {}): ToolResult | string {
  const L = len(sub(b, a.p));
  if (!(L > 0) || !(width > 0)) return 'The slot has no size';
  const sk = cloneSketch(sk0);
  const u = unit(sub(b, a.p)), n = { x: -u.y, y: u.x }, r = width / 2;
  const c1 = pointFor(sk, { ...a }), c2 = pointFor(sk, { p: b });
  const at = (c: Vec2, s: number) => ({ p: { x: c.x + n.x * r * s, y: c.y + n.y * r * s } });
  const q1 = pointFor(sk, at(a.p, 1)), q2 = pointFor(sk, at(b, 1)), q3 = pointFor(sk, at(b, -1)), q4 = pointFor(sk, at(a.p, -1));
  const top = cadId('e'), bot = cadId('e'), arc1 = cadId('e'), arc2 = cadId('e'), axis = cadId('e');
  const cons = opts.construction || undefined;
  sk.entities.push(
    { id: top, type: 'line', p1: q2, p2: q1, construction: cons },
    // around c1 on the far side: counter-clockwise from +n through −u to −n
    { id: arc1, type: 'arc', c: c1, p1: q1, p2: q4, construction: cons },
    { id: bot, type: 'line', p1: q4, p2: q3, construction: cons },
    { id: arc2, type: 'arc', c: c2, p1: q3, p2: q2, construction: cons },
    { id: axis, type: 'line', p1: c1, p2: c2, construction: true },
  );
  sk.constraints.push(K('tangent', [top, arc1]), K('tangent', [top, arc2]), K('tangent', [bot, arc1]), K('tangent', [bot, arc2]), K('equal', [arc1, arc2]));
  return { sketch: sk, ids: [top, arc1, bot, arc2], notes: [] };
}

// ------------------------------------------------------------ fillet

/**
 * Round the corner where two lines meet. The corner point stays as a construction
 * "virtual sharp" (on both lines' extensions) when constraints still refer to it, and
 * length dimensions of the two lines are re-attached to it, so the design keeps its size.
 */
export function fillet(sk0: CadSketch, P: Map<string, Vec2>, cornerId: string, radius: number): ToolResult | string {
  // construction geometry at the corner (a centre rectangle's diagonals) stays on the virtual sharp
  const lines = sk0.entities.filter((e): e is Extract<CadEntity, { type: 'line' }> => e.type === 'line' && !e.construction && (e.p1 === cornerId || e.p2 === cornerId));
  const others = sk0.entities.filter((e) => !e.construction && e.type !== 'line' && e.type !== 'point' && (e.type === 'circle' ? e.c === cornerId : e.type === 'arc' && (e.c === cornerId || e.p1 === cornerId || e.p2 === cornerId)));
  const guides = sk0.entities.some((e) => e.construction && e.type !== 'point' && (e.type === 'line' ? e.p1 === cornerId || e.p2 === cornerId : e.type === 'circle' ? e.c === cornerId : e.type === 'arc' && (e.c === cornerId || e.p1 === cornerId || e.p2 === cornerId)));
  if (lines.length !== 2 || others.length) return 'Pick a corner where exactly two lines meet';
  if (!(radius > 0)) return 'The fillet radius must be positive';
  const V = P.get(cornerId)!;
  const far = lines.map((l) => (l.p1 === cornerId ? l.p2 : l.p1));
  const A = P.get(far[0])!, B = P.get(far[1])!;
  const u1 = unit(sub(A, V)), u2 = unit(sub(B, V));
  const cos = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cos);
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return 'The lines are parallel at that corner';
  const t = radius / Math.tan(theta / 2);
  if (t >= len(sub(A, V)) - 1e-9 || t >= len(sub(B, V)) - 1e-9) return 'The radius is too large for these lines';
  const sk = cloneSketch(sk0);
  const T1 = { x: V.x + u1.x * t, y: V.y + u1.y * t }, T2 = { x: V.x + u2.x * t, y: V.y + u2.y * t };
  const bis = unit({ x: u1.x + u2.x, y: u1.y + u2.y });
  const C = { x: V.x + bis.x * (radius / Math.sin(theta / 2)), y: V.y + bis.y * (radius / Math.sin(theta / 2)) };
  const t1 = pointFor(sk, { p: T1 }), t2 = pointFor(sk, { p: T2 }), c = pointFor(sk, { p: C });
  sk.entities = sk.entities.map((e) => {
    if (e.id === lines[0].id) return { ...lines[0], ...(lines[0].p1 === cornerId ? { p1: t1 } : { p2: t1 }) };
    if (e.id === lines[1].id) return { ...lines[1], ...(lines[1].p1 === cornerId ? { p1: t2 } : { p2: t2 }) };
    return e;
  });
  const arc = cadId('e');
  const short = ccw(angOf(C, T1), angOf(C, T2)) < Math.PI;
  sk.entities.push({ id: arc, type: 'arc', c, p1: short ? t1 : t2, p2: short ? t2 : t1, construction: lines[0].construction && lines[1].construction ? true : undefined });
  const notes: string[] = [];
  // dimensions of the two lines measure to the virtual sharp from now on
  let keepSharp = guides;
  sk.constraints = sk.constraints.flatMap((k): CadConstraint[] => {
    const i = lines.findIndex((l) => k.refs.includes(l.id));
    if (i >= 0 && k.type === 'length') {
      keepSharp = true;
      return [{ ...k, type: 'distance', refs: [cornerId, far[i]] }];
    }
    if (i >= 0 && k.type === 'equal') {
      notes.push('An equal-length constraint on a filleted line was removed');
      return [];
    }
    if (k.refs.includes(cornerId)) keepSharp = true;
    return [k];
  });
  sk.constraints.push(K('tangent', [lines[0].id, arc]), K('tangent', [lines[1].id, arc]), K('radius', [arc], { value: String(+radius.toPrecision(6)), name: nextDimName(sk) }));
  if (keepSharp) {
    sk.entities.push({ id: cadId('e'), type: 'point', p: cornerId, construction: true });
    sk.constraints.push(K('pointOnLine', [cornerId, lines[0].id]), K('pointOnLine', [cornerId, lines[1].id]));
  }
  return { sketch: keepSharp ? sk : removeFromSketch(sk, new Set([cornerId])), ids: [arc], notes };
}

// ------------------------------------------------------------ trim

interface Cut {
  /** Parameter along the target (line: 0..1; circle/arc: CCW angle from the start). */
  t: number;
  p: Vec2;
  by: string;
}

type Curve =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number }
  | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number };

function curveOf(e: CadEntity, P: Map<string, Vec2>, R: Map<string, number>): Curve | null {
  if (e.type === 'line') return { kind: 'line', a: P.get(e.p1)!, b: P.get(e.p2)! };
  if (e.type === 'circle') return { kind: 'circle', c: P.get(e.c)!, r: R.get(e.id) ?? Math.abs(e.r) };
  if (e.type === 'arc') {
    const c = P.get(e.c)!, a = P.get(e.p1)!, b = P.get(e.p2)!;
    const a0 = angOf(c, a);
    return { kind: 'arc', c, r: len(sub(a, c)), a0, sweep: ccw(a0, angOf(c, b)) || 2 * Math.PI };
  }
  return null;
}

/** Points where two curves meet (infinite line / full circle), then filtered to the actual extents. */
function meet(A: Curve, B: Curve): Vec2[] {
  const raw: Vec2[] = [];
  const lineLine = (a: Vec2, b: Vec2, c: Vec2, d: Vec2) => {
    const r = sub(b, a), s = sub(d, c);
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-12 * len(r) * len(s)) return;
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
    raw.push({ x: a.x + t * r.x, y: a.y + t * r.y });
  };
  const lineCircle = (a: Vec2, b: Vec2, c: Vec2, r: number) => {
    const d = sub(b, a), f = sub(a, c);
    const qa = d.x * d.x + d.y * d.y, qb = 2 * (f.x * d.x + f.y * d.y), qc = f.x * f.x + f.y * f.y - r * r;
    const disc = qb * qb - 4 * qa * qc;
    if (disc < -1e-12 * qa * r * r) return;
    const sq = Math.sqrt(Math.max(0, disc));
    for (const t of disc <= 0 ? [-qb / (2 * qa)] : [(-qb - sq) / (2 * qa), (-qb + sq) / (2 * qa)]) raw.push({ x: a.x + t * d.x, y: a.y + t * d.y });
  };
  const circleCircle = (c1: Vec2, r1: number, c2: Vec2, r2: number) => {
    const d = len(sub(c2, c1));
    if (d < 1e-12 || d > r1 + r2 + 1e-9 * (r1 + r2) || d < Math.abs(r1 - r2) - 1e-9 * (r1 + r2)) return;
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
    const m = { x: c1.x + (a * (c2.x - c1.x)) / d, y: c1.y + (a * (c2.y - c1.y)) / d };
    const ox = (-(c2.y - c1.y) * h) / d, oy = ((c2.x - c1.x) * h) / d;
    raw.push({ x: m.x + ox, y: m.y + oy });
    if (h > 1e-12) raw.push({ x: m.x - ox, y: m.y - oy });
  };
  const round = (X: Curve) => (X.kind === 'line' ? null : { c: X.c, r: X.r });
  if (A.kind === 'line' && B.kind === 'line') lineLine(A.a, A.b, B.a, B.b);
  else if (A.kind === 'line') lineCircle(A.a, A.b, round(B)!.c, round(B)!.r);
  else if (B.kind === 'line') lineCircle(B.a, B.b, A.c, A.r);
  else circleCircle(A.c, A.r, B.c, B.r);
  return raw.filter((p) => onExtent(A, p) && onExtent(B, p));
}

function onExtent(X: Curve, p: Vec2): boolean {
  const tol = 1e-9;
  if (X.kind === 'line') {
    const d = sub(X.b, X.a), L2 = d.x * d.x + d.y * d.y;
    const t = ((p.x - X.a.x) * d.x + (p.y - X.a.y) * d.y) / L2;
    return t >= -tol && t <= 1 + tol;
  }
  if (X.kind === 'circle') return true;
  return ccw(X.a0, angOf(X.c, p)) <= X.sweep + tol || ccw(X.a0, angOf(X.c, p)) >= 2 * Math.PI - tol;
}

function param(X: Curve, p: Vec2): number {
  if (X.kind === 'line') {
    const d = sub(X.b, X.a);
    return ((p.x - X.a.x) * d.x + (p.y - X.a.y) * d.y) / (d.x * d.x + d.y * d.y);
  }
  if (X.kind === 'circle') return ccw(0, angOf(X.c, p));
  return ccw(X.a0, angOf(X.c, p));
}

/**
 * Remove the piece of an entity between the nearest crossings around `at`. A line or
 * arc with no crossing is deleted; a circle needs two crossings and becomes an arc.
 */
export function trim(sk0: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, entityId: string, at: Vec2): ToolResult | string {
  const target = sk0.entities.find((e) => e.id === entityId);
  if (!target || target.type === 'point') return 'Pick a line, circle or arc to trim';
  const T = curveOf(target, P, R);
  if (!T) return 'Trim works on lines, circles and arcs: break splines and ellipses instead';
  const cuts: Cut[] = [];
  const tSeg: Seg = T.kind === 'line' ? { kind: 'line', a: T.a, b: T.b } : T.kind === 'circle' ? { kind: 'arc', c: T.c, r: T.r, a0: 0, a1: 2 * Math.PI } : { kind: 'arc', c: T.c, r: T.r, a0: T.a0, a1: T.a0 + T.sweep };
  for (const e of sk0.entities) {
    if (e.id === entityId || e.type === 'point' || e.type === 'text') continue;
    const other = curveOf(e, P, R);
    if (other) {
      for (const p of meet(T, other)) cuts.push({ t: param(T, p), p, by: e.id });
      continue;
    }
    // splines and ellipses: where their curves cross it
    for (const sg of entitySegs(e, (id) => P.get(id), (id) => R.get(id))) for (const x of segCrossings(tSeg, sg)) cuts.push({ t: param(T, x.p), p: x.p, by: e.id });
  }
  const span = T.kind === 'line' ? 1 : T.kind === 'circle' ? 2 * Math.PI : T.sweep;
  const eps = 1e-7 * span;
  const inner = cuts.filter((c) => (T.kind === 'circle' ? true : c.t > eps && c.t < span - eps)).sort((a, b) => a.t - b.t);
  // merge crossings at the same place (several curves through one point)
  const uniq = inner.filter((c, i) => i === 0 || c.t - inner[i - 1].t > eps);
  const tc = param(T, at);
  const notes: string[] = [];

  if (T.kind === 'circle') {
    if (uniq.length < 2) return 'A circle needs two crossings to trim; delete it instead';
    let hi = uniq.find((c) => c.t > tc) ?? uniq[0];
    let lo = [...uniq].reverse().find((c) => c.t < tc) ?? uniq[uniq.length - 1];
    if (hi === lo) [lo, hi] = [uniq[0], uniq[1]];
    const sk = cloneSketch(sk0);
    const ph = pointFor(sk, { p: hi.p, on: hi.by }), pl = pointFor(sk, { p: lo.p, on: lo.by });
    // what is left runs counter-clockwise from the crossing after the pick to the one before it
    sk.entities = sk.entities.map((e) => (e.id === entityId ? { id: e.id, type: 'arc', c: (target as { c: string }).c, p1: ph, p2: pl, construction: e.construction } : e));
    return { sketch: sk, ids: [entityId], notes };
  }

  const lo = [...uniq].reverse().find((c) => c.t < tc);
  const hi = uniq.find((c) => c.t > tc);
  if (!lo && !hi) return { sketch: removeFromSketch(sk0, new Set([entityId])), ids: [], notes };
  const sk = cloneSketch(sk0);
  const ends = target.type === 'line' ? [target.p1, target.p2] : [(target as { p1: string }).p1, (target as { p2: string }).p2];
  const dropDims = () => {
    sk.constraints = sk.constraints.filter((k) => {
      if (!k.refs.includes(entityId)) return true;
      if (k.type === 'length' || k.type === 'midpoint' || (k.type === 'equal' && target.type === 'line')) {
        notes.push(`A ${k.type === 'length' ? 'length dimension' : k.type === 'midpoint' ? 'midpoint constraint' : 'equal-length constraint'} on the trimmed line was removed`);
        return false;
      }
      return true;
    });
  };
  if (lo && hi) {
    // the middle goes: the entity keeps its start, a new piece takes the end
    const pl = pointFor(sk, { p: lo.p, on: lo.by }), ph = pointFor(sk, { p: hi.p, on: hi.by });
    const piece = cadId('e');
    dropDims();
    if (target.type === 'line') {
      sk.entities = sk.entities.map((e) => (e.id === entityId ? { ...target, p2: pl } : e));
      sk.entities.push({ id: piece, type: 'line', p1: ph, p2: ends[1], construction: target.construction });
      // keep both pieces on one line
      sk.constraints.push(K('pointOnLine', [ph, entityId]), K('pointOnLine', [ends[1], entityId]));
    } else {
      const arc = target as Extract<CadEntity, { type: 'arc' }>;
      sk.entities = sk.entities.map((e) => (e.id === entityId ? { ...arc, p2: pl } : e));
      sk.entities.push({ id: piece, type: 'arc', c: arc.c, p1: ph, p2: arc.p2, construction: arc.construction });
      sk.constraints.push(K('equal', [entityId, piece]));
    }
    return { sketch: removeUnused(sk), ids: [entityId, piece], notes };
  }
  // one end goes: move that end to the crossing
  dropDims();
  if (hi) {
    const ph = pointFor(sk, { p: hi.p, on: hi.by });
    sk.entities = sk.entities.map((e) => (e.id === entityId ? { ...(e as Extract<CadEntity, { type: 'line' | 'arc' }>), p1: ph } : e));
  } else if (lo) {
    const pl = pointFor(sk, { p: lo.p, on: lo.by });
    sk.entities = sk.entities.map((e) => (e.id === entityId ? { ...(e as Extract<CadEntity, { type: 'line' | 'arc' }>), p2: pl } : e));
  }
  return { sketch: removeUnused(sk), ids: [entityId], notes };
}

/** Drop points no entity uses any more (and constraints on them). */
function removeUnused(sk: CadSketch): CadSketch {
  return removeFromSketch(sk, new Set());
}

// ------------------------------------------------------------ mirror

/** Mirror entities about a line: copies are tied to the originals by symmetry constraints. */
export function mirror(sk0: CadSketch, P: Map<string, Vec2>, ids: string[], axisId: string): ToolResult | string {
  const axis = sk0.entities.find((e) => e.id === axisId);
  if (axis?.type !== 'line') return 'Pick a line to mirror about';
  const a = P.get(axis.p1)!, b = P.get(axis.p2)!;
  const d = unit(sub(b, a));
  const items = sk0.entities.filter((e) => ids.includes(e.id) && e.id !== axisId);
  if (!items.length) return 'Select the geometry to mirror first';
  const sk = cloneSketch(sk0);
  let size = 1;
  for (const p of P.values()) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const map = new Map<string, string>();
  const notes: string[] = [];
  const image = (id: string): string => {
    if (map.has(id)) return map.get(id)!;
    const p = P.get(id)!;
    const v = sub(p, a), along = v.x * d.x + v.y * d.y;
    const foot = { x: a.x + d.x * along, y: a.y + d.y * along };
    // points on the axis are their own mirror image
    if (len(sub(p, foot)) < 1e-9 * size) {
      map.set(id, id);
      return id;
    }
    const q = pointFor(sk, { p: { x: 2 * foot.x - p.x, y: 2 * foot.y - p.y } });
    sk.constraints.push(K('symmetric', [id, q, axisId]));
    map.set(id, q);
    return q;
  };
  const out: string[] = [];
  for (const e of items) {
    const id = cadId('e');
    const cons = e.construction;
    if (e.type === 'line') sk.entities.push({ id, type: 'line', p1: image(e.p1), p2: image(e.p2), construction: cons });
    else if (e.type === 'circle') {
      sk.entities.push({ id, type: 'circle', c: image(e.c), r: e.r, construction: cons });
      sk.constraints.push(K('equal', [e.id, id]));
    } else if (e.type === 'arc') {
      // a mirror image runs the other way round
      sk.entities.push({ id, type: 'arc', c: image(e.c), p1: image(e.p2), p2: image(e.p1), construction: cons });
      sk.constraints.push(K('equal', [e.id, id]));
    } else if (e.type === 'ellipse') {
      sk.entities.push({ id, type: 'ellipse', c: image(e.c), a: image(e.a), r: e.r, ...(e.p1 && e.p2 ? { p1: image(e.p2), p2: image(e.p1) } : {}), construction: cons });
      sk.constraints.push(K('equal', [e.id, id]));
    } else if (e.type === 'spline') {
      sk.entities.push({ ...e, id, pts: e.pts.map(image), ...(e.h1 ? { h1: image(e.h1) } : {}), ...(e.h2 ? { h2: image(e.h2) } : {}), ref: undefined });
    } else if (e.type === 'point') sk.entities.push({ id, type: 'point', p: image(e.p), construction: cons });
    else {
      notes.push('Text is not mirrored (it would read backwards)');
      continue;
    }
    out.push(id);
  }
  return { sketch: sk, ids: out, notes };
}
