// Sketch tools for the curves beyond lines and arcs, and the modify tools that work on
// chains: splines, ellipses and text; offset, chamfer, extend, break; rectangular and
// circular patterns. Like tools.ts, each builds geometry together with the constraints
// that keep its intent (an offset stays at its distance from its chain, a pattern's copies
// follow their source), and works on a copy of the sketch.
import { cadId, entityPoints, nextDimName, removeFromSketch, type CadConstraint, type CadEntity, type CadSketch, type ConstraintType } from './model';
import { reverseSeg, segBreaks, segDeriv, segPoint, segPolyline, type Seg, type Vec2 } from './profile';
import { bsClosest, bsDomain, bsSplit, ellipseParam, ellipsePoint, sweepCCW, type BSpline } from './curves';
import { entityEnds, entitySegs, segCrossings, splineOf } from './sketchCurves';
import { cloneSketch, pointFor, type Opts, type Ref, type ToolResult } from './tools';

const { abs, hypot, atan2, cos, sin, sqrt, max, min, PI } = Math;

const K = (type: ConstraintType, refs: string[], extra: Partial<CadConstraint> = {}): CadConstraint => ({ id: cadId('k'), type, refs, ...extra });
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const len = (v: Vec2) => hypot(v.x, v.y);
const unit = (v: Vec2): Vec2 => {
  const l = len(v) || 1;
  return { x: v.x / l, y: v.y / l };
};
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const left = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const fmt = (v: number) => String(+v.toPrecision(6));
const sizeOf = (P: Map<string, Vec2>) => {
  let s = 1;
  for (const p of P.values()) s = max(s, abs(p.x), abs(p.y));
  return s;
};

// ------------------------------------------------------------ splines, ellipses, text

/** A spline through (fit) or on (control) the picked points; closed splines leave out a repeated first point. */
export function spline(sk0: CadSketch, refs: Ref[], o: Opts & { mode?: 'fit' | 'control'; closed?: boolean } = {}): ToolResult | string {
  const sk = cloneSketch(sk0);
  const ids = refs.map((r) => pointFor(sk, { ...r }));
  const pts = o.closed && ids.length > 1 && ids[ids.length - 1] === ids[0] ? ids.slice(0, -1) : ids;
  if (pts.length < (o.closed ? 3 : 2)) return o.closed ? 'A closed spline needs three points' : 'A spline needs two points';
  for (let i = 1; i < pts.length; i++) if (pts[i] === pts[i - 1]) return 'Two neighbouring spline points are the same';
  const id = cadId('e');
  sk.entities.push({ id, type: 'spline', pts, ...(o.mode === 'control' ? { mode: 'control' as const } : {}), ...(o.closed ? { closed: true } : {}), construction: o.construction || undefined });
  return { sketch: sk, ids: [id], notes: [] };
}

/** An ellipse about c, its first axis to the point a, the other semi-axis `minor`; a construction line along the axis to constrain it by. */
export function ellipse(sk0: CadSketch, c: Ref, a: Ref, minor: number, o: Opts = {}): ToolResult | string {
  if (!(len(sub(a.p, c.p)) > 0 && minor > 0)) return 'The ellipse has no size';
  const sk = cloneSketch(sk0);
  const pc = pointFor(sk, { ...c }), pa = pointFor(sk, { ...a });
  const id = cadId('e');
  sk.entities.push({ id, type: 'ellipse', c: pc, a: pa, r: minor, construction: o.construction || undefined });
  sk.entities.push({ id: cadId('e'), type: 'line', p1: pc, p2: pa, construction: true });
  return { sketch: sk, ids: [id], notes: [] };
}

/**
 * An elliptical arc: centre, first-axis end, then its start (which sets the other semi-axis:
 * the start lies on the ellipse) and its end, counter-clockwise.
 */
export function ellipticalArc(sk0: CadSketch, c: Ref, a: Ref, start: Vec2, end: Vec2, o: Opts = {}): ToolResult | string {
  const ra = len(sub(a.p, c.p));
  if (!(ra > 0)) return 'The ellipse has no size';
  const rot = atan2(a.p.y - c.p.y, a.p.x - c.p.x);
  const d = sub(start, c.p), x = d.x * cos(rot) + d.y * sin(rot), y = -d.x * sin(rot) + d.y * cos(rot);
  if (!(abs(x) < ra * (1 - 1e-9)) || !(abs(y) > 0)) return 'Click the start between the ends of the axis, off it';
  const rb = abs(y) / sqrt(1 - (x / ra) ** 2);
  const el = { c: c.p, ra, rb, rot };
  const sk = cloneSketch(sk0);
  const pc = pointFor(sk, { ...c }), pa = pointFor(sk, { ...a });
  const p1 = pointFor(sk, { p: ellipsePoint(el, ellipseParam(el, start)) }), p2 = pointFor(sk, { p: ellipsePoint(el, ellipseParam(el, end)) });
  const id = cadId('e');
  sk.entities.push({ id, type: 'ellipse', c: pc, a: pa, r: rb, p1, p2, construction: o.construction || undefined });
  sk.entities.push({ id: cadId('e'), type: 'line', p1: pc, p2: pa, construction: true });
  return { sketch: sk, ids: [id], notes: [] };
}

/** A line of text with its baseline starting at `at`. */
export function text(sk0: CadSketch, at: Ref, s: string, size: number, angle = 0): ToolResult | string {
  if (!s.trim()) return 'Type some text';
  if (!(size > 0)) return 'The text size must be positive';
  const sk = cloneSketch(sk0);
  const p = pointFor(sk, { ...at });
  const id = cadId('e');
  sk.entities.push({ id, type: 'text', p, text: s, size, ...(angle ? { angle } : {}) });
  return { sketch: sk, ids: [id], notes: [] };
}

// ------------------------------------------------------------ chains

interface Piece {
  e: CadEntity;
  /** Run from its first end to its second (else backwards). */
  fwd: boolean;
  /** Point ids where the chain enters and leaves it. */
  from: string;
  to: string;
  seg: Seg;
}

/** The picked curves in chain order, open or closed; or one curve that is closed by itself. */
export function chainOf(sk: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, ids: string[]): { pieces: Piece[]; closed: boolean; whole?: CadEntity } | string {
  const ents = sk.entities.filter((e) => ids.includes(e.id) && e.type !== 'point' && e.type !== 'text');
  if (!ents.length) return 'Select the curves to offset (a chain of lines, arcs and splines, or one closed curve)';
  const segOf = (e: CadEntity) => entitySegs(e, (id) => P.get(id), (id) => R.get(id))[0];
  const whole = ents.find((e) => !entityEnds(e));
  if (whole) {
    if (ents.length > 1) return 'A closed curve is offset on its own: select it alone, or the curves of one chain';
    const seg = segOf(whole);
    return seg ? { pieces: [{ e: whole, fwd: true, from: '', to: '', seg }], closed: true, whole } : 'The curve has no size';
  }
  // ends that are the same point (or on the same spot) are one node
  const size = sizeOf(P);
  const nodeOf = new Map<string, string>();
  const reps: string[] = [];
  for (const e of ents) for (const id of entityEnds(e)!) {
    if (nodeOf.has(id)) continue;
    const q = P.get(id)!;
    const same = reps.find((r) => len(sub(P.get(r)!, q)) <= 1e-7 * size);
    nodeOf.set(id, same ?? id);
    if (!same) reps.push(id);
  }
  const deg = new Map<string, number>();
  for (const e of ents) for (const id of entityEnds(e)!) deg.set(nodeOf.get(id)!, (deg.get(nodeOf.get(id)!) ?? 0) + 1);
  if ([...deg.values()].some((d) => d > 2)) return 'The curves branch: three meet at a point — select one chain';
  const open = [...deg].filter(([, d]) => d === 1).map(([n]) => n);
  if (open.length !== 0 && open.length !== 2) return 'The curves are not joined end to end';
  let node = open[0] ?? nodeOf.get(entityEnds(ents[0])![0])!;
  const left = new Set(ents);
  const pieces: Piece[] = [];
  while (left.size) {
    const next = [...left].find((e) => entityEnds(e)!.some((id) => nodeOf.get(id) === node));
    if (!next) return 'The curves fall into separate pieces: select one chain';
    left.delete(next);
    const [a, b] = entityEnds(next)!;
    const fwd = nodeOf.get(a) === node;
    const seg = segOf(next);
    if (!seg) return 'A curve of the chain has no size';
    pieces.push({ e: next, fwd, from: fwd ? a : b, to: fwd ? b : a, seg: fwd ? seg : reverseSeg(seg) });
    node = nodeOf.get(fwd ? b : a)!;
  }
  return { pieces, closed: open.length === 0 };
}

// ------------------------------------------------------------ offset

/** One piece moved off its chain: exact for lines and arcs, else points along it for a spline through them. */
interface Moved {
  kind: 'line' | 'arc' | 'fit';
  a: Vec2;
  b: Vec2;
  /** Arcs: centre and the new radius. */
  c?: Vec2;
  r?: number;
  /** Fits: the points along it, ends included. */
  pts?: Vec2[];
  /** Tangents (the way the chain runs) at its ends. */
  ta: Vec2;
  tb: Vec2;
}

function movePiece(pc: Piece, d: number, s: number): Moved | string {
  const g = pc.seg;
  const ta = unit(segDeriv(g, 0)), tb = unit(segDeriv(g, 1));
  if (g.kind === 'line') {
    const n = mul(left(unit(sub(g.b, g.a))), s * d);
    return { kind: 'line', a: add(g.a, n), b: add(g.b, n), ta, tb };
  }
  if (g.kind === 'arc') {
    // left of a counter-clockwise run is towards the centre
    const ccw = g.a1 > g.a0;
    const r = g.r + (ccw ? -s * d : s * d);
    if (!(r > 1e-9 * g.r)) return 'The offset is larger than the radius of an arc of the chain';
    const at = (a: number) => ({ x: g.c.x + r * cos(a), y: g.c.y + r * sin(a) });
    return { kind: 'arc', a: at(g.a0), b: at(g.a1), c: g.c, r, ta, tb };
  }
  // splines and ellipses: their offset is no spline or ellipse; points along it (approximate)
  const n = g.kind === 'bspline' ? max(12, 6 * (segBreaks(g).length - 1)) : 24;
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return add(segPoint(g, t), mul(left(unit(segDeriv(g, t))), s * d));
  });
  return { kind: 'fit', a: pts[0], b: pts[n], pts, ta, tb };
}

/** Points of a spline's offset up to x (atEnd) or from x on, x taking the place of the cut end. */
function cutFit(pts: Vec2[], x: Vec2, atEnd: boolean): Vec2[] {
  let k = 0, bd = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], u = sub(pts[i + 1], a), t = max(0, min(1, dot(sub(x, a), u) / (dot(u, u) || 1)));
    const dd = len(sub(add(a, mul(u, t)), x));
    if (dd < bd) [bd, k] = [dd, i];
  }
  return atEnd ? [...pts.slice(0, k + 1), x] : [x, ...pts.slice(k + 1)];
}

/** Where two moved pieces meet near the corner v (concave corners). */
function meetMoved(a: Moved, b: Moved, v: Vec2): Vec2 | null {
  const segOf = (m: Moved): Seg[] => {
    if (m.kind === 'line') {
      // the lines' full extent (an offset line may have to grow to meet the next)
      const u = unit(sub(m.b, m.a)), L = len(sub(m.b, m.a)) + 1;
      return [{ kind: 'line', a: sub(m.a, mul(u, 1e3 * L)), b: add(m.b, mul(u, 1e3 * L)) }];
    }
    if (m.kind === 'arc') return [{ kind: 'arc', c: m.c!, r: m.r!, a0: 0, a1: 2 * PI }];
    const p = m.pts!;
    return p.slice(1).map((q, i) => ({ kind: 'line' as const, a: p[i], b: q }));
  };
  let best: Vec2 | null = null;
  for (const A of segOf(a)) for (const B of segOf(b)) for (const x of segCrossings(A, B)) if (!best || len(sub(x.p, v)) < len(sub(best, v))) best = x.p;
  return best;
}

/**
 * The chain (or closed curve) offset by d to the side of `towards`. Corners the chain turns
 * away from the offset get an arc about the corner (radius d), corners it turns into are
 * trimmed where the offsets meet. Lines and arcs stay associative: one offset dimension
 * holds every offset line parallel at d from its source and every offset arc d further
 * out or in round the same centre, the corner arcs tangent to their neighbours, open ends
 * square to the source's ends. Splines and ellipses are offset once, as splines through
 * points along their offset.
 */
export function offset(sk0: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, ids: string[], d: number, towards: Vec2): ToolResult | string {
  if (!(d > 0)) return 'The offset distance must be positive';
  const ch = chainOf(sk0, P, R, ids);
  if (typeof ch === 'string') return ch;
  const sk = cloneSketch(sk0);
  const notes: string[] = [];
  const name = nextDimName(sk);

  // the side: the click's side of the nearest piece (left of the way the chain runs: +1)
  let s = 1, bd = Infinity;
  for (const pc of ch.pieces) {
    const pts = segPolyline(pc.seg, PI / 90);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], u = sub(pts[i], a), L2 = dot(u, u) || 1;
      const t = max(0, min(1, dot(sub(towards, a), u) / L2));
      const q = add(a, mul(u, t)), dd = len(sub(towards, q));
      if (dd < bd) [bd, s] = [dd, cross(u, sub(towards, q)) >= 0 ? 1 : -1];
    }
  }

  // a closed curve by itself
  if (ch.whole) {
    const e = ch.whole;
    if (e.type === 'circle') {
      const r = R.get(e.id) ?? e.r, out = len(sub(towards, P.get(e.c)!)) > r;
      const r2 = r + (out ? d : -d);
      if (!(r2 > 0)) return 'The offset is larger than the circle';
      const id = cadId('e');
      sk.entities.push({ id, type: 'circle', c: e.c, r: r2, construction: e.construction });
      sk.constraints.push(K('offset', [e.id, id], { value: fmt(d), name, sides: [out ? 1 : -1] }));
      return { sketch: sk, ids: [id], notes };
    }
    const m = movePiece(ch.pieces[0], d, s);
    if (typeof m === 'string') return m;
    const pts = m.pts!.slice(0, -1).map((q) => pointFor(sk, { p: q }));
    const id = cadId('e');
    sk.entities.push({ id, type: 'spline', pts, closed: true, construction: e.construction });
    notes.push('A spline or ellipse is offset once (as a spline): it does not follow its source');
    return { sketch: sk, ids: [id], notes };
  }

  const moved: Moved[] = [];
  for (const pc of ch.pieces) {
    const m = movePiece(pc, d, s);
    if (typeof m === 'string') return m;
    moved.push(m);
  }
  const n = moved.length;
  // the points where each moved piece starts and ends
  const startId: string[] = new Array(n), endId: string[] = new Array(n);
  const corners: { i: number; kind: 'smooth' | 'arc' | 'meet' }[] = [];
  for (let i = 0; i < (ch.closed ? n : n - 1); i++) {
    const j = (i + 1) % n, a = moved[i], b = moved[j];
    const turn = cross(a.tb, b.ta), v = P.get(ch.pieces[i].to)!;
    if (abs(turn) < 1e-9 && dot(a.tb, b.ta) > 0) {
      endId[i] = startId[j] = pointFor(sk, { p: a.b });
      corners.push({ i, kind: 'smooth' });
    } else if (s * turn < 0) {
      endId[i] = pointFor(sk, { p: a.b });
      startId[j] = pointFor(sk, { p: b.a });
      corners.push({ i, kind: 'arc' });
    } else {
      const x = meetMoved(a, b, v);
      if (!x) return 'The offset is too large for this chain: two of its offsets do not meet';
      endId[i] = startId[j] = pointFor(sk, { p: x });
      corners.push({ i, kind: 'meet' });
      // a spline's offset points past the meeting point go
      if (a.kind === 'fit') a.pts = cutFit(a.pts!, x, true);
      if (b.kind === 'fit') b.pts = cutFit(b.pts!, x, false);
    }
  }
  if (!ch.closed) {
    startId[0] = pointFor(sk, { p: moved[0].a });
    endId[n - 1] = pointFor(sk, { p: moved[n - 1].b });
  }
  // move the meeting points of fits onto them: the fit runs through its own points between its ends
  const made: string[] = [];
  const pairs: string[] = [], sides: number[] = [];
  const newId: string[] = [];
  moved.forEach((m, i) => {
    const pc = ch.pieces[i], src = pc.e, id = cadId('e');
    newId.push(id);
    made.push(id);
    const cons = src.construction;
    if (m.kind === 'line') {
      const [p1, p2] = pc.fwd ? [startId[i], endId[i]] : [endId[i], startId[i]];
      sk.entities.push({ id, type: 'line', p1, p2, construction: cons });
      pairs.push(src.id, id);
      sides.push(pc.fwd ? s : -s);
    } else if (m.kind === 'arc' && src.type === 'arc') {
      const [p1, p2] = pc.fwd ? [startId[i], endId[i]] : [endId[i], startId[i]];
      sk.entities.push({ id, type: 'arc', c: src.c, p1, p2, construction: cons });
      const r0 = (pc.seg as Extract<Seg, { kind: 'arc' }>).r;
      pairs.push(src.id, id);
      sides.push(m.r! > r0 ? 1 : -1);
    } else {
      // through its offset points, the ends where the corners put them
      const inner = m.pts!.slice(1, -1).map((q) => pointFor(sk, { p: q }));
      sk.entities.push({ id, type: 'spline', pts: [startId[i], ...inner, endId[i]], construction: cons });
    }
  });
  const assoc = (i: number) => moved[i].kind !== 'fit';
  for (const { i, kind } of corners) {
    const j = (i + 1) % n;
    if (kind === 'smooth') {
      if (assoc(i) && assoc(j) && (moved[i].kind === 'arc' || moved[j].kind === 'arc')) sk.constraints.push(K('tangent', [newId[i], newId[j]]));
      else if (moved[i].kind === 'line' && moved[j].kind === 'line') {
        // two lines on one line: their shared end square to the source's
        const guide = cadId('e');
        sk.entities.push({ id: guide, type: 'line', p1: ch.pieces[i].to, p2: endId[i], construction: true });
        sk.constraints.push(K('perpendicular', [guide, ch.pieces[i].e.id]));
      }
      continue;
    }
    if (kind !== 'arc') continue;
    // a corner arc about the corner, the short way round, tangent to both neighbours
    const v = ch.pieces[i].to, V = P.get(v)!;
    const pa = moved[i].b, pb = moved[j].a;
    const short = sweepCCW(atan2(pa.y - V.y, pa.x - V.x), atan2(pb.y - V.y, pb.x - V.x)) < PI;
    const id = cadId('e');
    made.push(id);
    sk.entities.push({ id, type: 'arc', c: v, p1: short ? endId[i] : startId[j], p2: short ? startId[j] : endId[i], construction: ch.pieces[i].e.construction });
    if (assoc(i)) sk.constraints.push(K('tangent', [newId[i], id]));
    if (assoc(j)) sk.constraints.push(K('tangent', [newId[j], id]));
  }
  // open ends square to the source's ends
  if (!ch.closed) {
    for (const [i, end] of [[0, 'from'], [n - 1, 'to']] as const) {
      const pc = ch.pieces[i];
      if (!assoc(i)) continue;
      const srcEnd = pc[end], offEnd = end === 'from' ? startId[i] : endId[i];
      const guide = cadId('e');
      if (pc.e.type === 'line') {
        sk.entities.push({ id: guide, type: 'line', p1: srcEnd, p2: offEnd, construction: true });
        sk.constraints.push(K('perpendicular', [guide, pc.e.id]));
      } else if (pc.e.type === 'arc') {
        sk.entities.push({ id: guide, type: 'line', p1: pc.e.c, p2: srcEnd, construction: true });
        sk.constraints.push(K('pointOnLine', [offEnd, guide]));
      }
    }
  }
  if (pairs.length) sk.constraints.push(K('offset', pairs, { value: fmt(d), name, sides }));
  if (moved.some((m) => m.kind === 'fit')) notes.push('Splines and ellipses are offset once (as splines): they do not follow their source');
  return { sketch: sk, ids: made, notes };
}

// ------------------------------------------------------------ chamfer

/**
 * Cut the corner where two lines meet by a line d1 along the first and d2 along the second.
 * The corner stays as a construction "virtual sharp" on both lines, and the two distances
 * are dimensions from it, so the chamfer keeps its size.
 */
export function chamfer(sk0: CadSketch, P: Map<string, Vec2>, cornerId: string, d1: number, d2 = d1): ToolResult | string {
  const lines = sk0.entities.filter((e): e is Extract<CadEntity, { type: 'line' }> => e.type === 'line' && !e.construction && (e.p1 === cornerId || e.p2 === cornerId));
  const others = sk0.entities.filter((e) => !e.construction && e.type !== 'line' && e.type !== 'point' && entityPoints(e).includes(cornerId));
  if (lines.length !== 2 || others.length) return 'Pick a corner where exactly two lines meet';
  if (!(d1 > 0 && d2 > 0)) return 'The chamfer distance must be positive';
  const V = P.get(cornerId)!;
  const far = lines.map((l) => (l.p1 === cornerId ? l.p2 : l.p1));
  const A = P.get(far[0])!, B = P.get(far[1])!;
  if (d1 >= len(sub(A, V)) - 1e-9 || d2 >= len(sub(B, V)) - 1e-9) return 'The chamfer is too large for these lines';
  if (abs(cross(unit(sub(A, V)), unit(sub(B, V)))) < 1e-6) return 'The lines are parallel at that corner';
  const sk = cloneSketch(sk0);
  const t1 = pointFor(sk, { p: add(V, mul(unit(sub(A, V)), d1)) }), t2 = pointFor(sk, { p: add(V, mul(unit(sub(B, V)), d2)) });
  sk.entities = sk.entities.map((e) => {
    if (e.id === lines[0].id) return { ...lines[0], ...(lines[0].p1 === cornerId ? { p1: t1 } : { p2: t1 }) };
    if (e.id === lines[1].id) return { ...lines[1], ...(lines[1].p1 === cornerId ? { p1: t2 } : { p2: t2 }) };
    return e;
  });
  const id = cadId('e');
  sk.entities.push({ id, type: 'line', p1: t1, p2: t2, construction: lines[0].construction && lines[1].construction ? true : undefined });
  // lengths of the two lines measure to the virtual sharp from now on
  sk.constraints = sk.constraints.map((k) => {
    const i = lines.findIndex((l) => k.refs.includes(l.id));
    return i >= 0 && k.type === 'length' ? { ...k, type: 'distance', refs: [cornerId, far[i]] } : k;
  });
  sk.entities.push({ id: cadId('e'), type: 'point', p: cornerId, construction: true });
  const n1 = nextDimName(sk);
  sk.constraints.push(K('pointOnLine', [cornerId, lines[0].id]), K('pointOnLine', [cornerId, lines[1].id]), K('distance', [cornerId, t1], { value: fmt(d1), name: n1 }));
  sk.constraints.push(K('distance', [cornerId, t2], { value: fmt(d2), name: nextDimName(sk) }));
  return { sketch: sk, ids: [id], notes: [] };
}

// ------------------------------------------------------------ extend and break

/** The curve of every other entity (for crossings). */
function othersSegs(sk: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, skip: string): { id: string; seg: Seg }[] {
  return sk.entities.filter((e) => e.id !== skip && e.type !== 'point' && e.type !== 'text').flatMap((e) => entitySegs(e, (id) => P.get(id), (id) => R.get(id)).map((seg) => ({ id: e.id, seg })));
}

/** Constraint that keeps a new point on an entity's curve. */
function onCurve(e: CadEntity | undefined, p: string): CadConstraint | null {
  if (!e) return null;
  if (e.type === 'line') return K('pointOnLine', [p, e.id]);
  if (e.type === 'circle' || e.type === 'arc') return K('pointOnCircle', [p, e.id]);
  if (e.type === 'ellipse' || e.type === 'spline') return K('pointOnCurve', [p, e.id]);
  return null;
}

/**
 * Lengthen a line or arc from its end nearer to `at` to the first curve it meets. The end
 * moves (a new point when others share it) and stays on that curve.
 */
export function extend(sk0: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, entityId: string, at: Vec2): ToolResult | string {
  const e = sk0.entities.find((x) => x.id === entityId);
  if (e?.type !== 'line' && e?.type !== 'arc') return 'Pick a line or an arc near the end to extend';
  const ends = [e.p1, e.p2];
  const k = len(sub(at, P.get(ends[1])!)) < len(sub(at, P.get(ends[0])!)) ? 1 : 0;
  const endP = P.get(ends[k])!;
  let size = sizeOf(P);
  for (const o of othersSegs(sk0, P, R, entityId)) for (const q of segPolyline(o.seg, PI / 16)) size = max(size, abs(q.x), abs(q.y));
  // the curve the end runs on beyond it: the line onwards, or the arc's circle the way it goes
  let ray: Seg, where: (p: Vec2) => number;
  if (e.type === 'line') {
    const u = unit(k ? sub(P.get(e.p2)!, P.get(e.p1)!) : sub(P.get(e.p1)!, P.get(e.p2)!));
    ray = { kind: 'line', a: endP, b: add(endP, mul(u, 4 * size)) };
    where = (p) => dot(sub(p, endP), u);
  } else {
    const c = P.get(e.c)!, r = len(sub(P.get(e.p1)!, c));
    const a0 = atan2(endP.y - c.y, endP.x - c.x);
    // beyond p2 the arc goes on counter-clockwise; before p1 clockwise
    const dir = k ? 1 : -1;
    const a1 = atan2(P.get(ends[1 - k])!.y - c.y, P.get(ends[1 - k])!.x - c.x);
    const room = 2 * PI - sweepCCW(k ? a1 : a0, k ? a0 : a1);
    ray = { kind: 'arc', c, r, a0, a1: a0 + dir * room };
    where = (p) => sweepCCW(dir > 0 ? a0 : atan2(p.y - c.y, p.x - c.x), dir > 0 ? atan2(p.y - c.y, p.x - c.x) : a0) % (2 * PI);
  }
  let best: { p: Vec2; by: string; at: number } | null = null;
  for (const o of othersSegs(sk0, P, R, entityId)) {
    for (const x of segCrossings(ray, o.seg)) {
      const w = where(x.p);
      if (!(w > 1e-7 * size)) continue;
      if (!best || w < best.at) best = { p: x.p, by: o.id, at: w };
    }
  }
  if (!best) return 'Nothing to extend to: no curve lies beyond that end';
  const sk = cloneSketch(sk0);
  const shared = sk.entities.some((x) => x.id !== entityId && entityPoints(x).includes(ends[k]));
  const notes: string[] = [];
  let pid = ends[k];
  if (shared) {
    pid = pointFor(sk, { p: best.p });
    sk.entities = sk.entities.map((x) => (x.id === entityId ? { ...(x as typeof e), ...(k ? { p2: pid } : { p1: pid }) } : x));
  } else sk.points = sk.points.map((q) => (q.id === pid ? { ...q, x: best!.p.x, y: best!.p.y } : q));
  const on = onCurve(sk.entities.find((x) => x.id === best!.by), pid);
  if (on) sk.constraints.push(on);
  sk.constraints = sk.constraints.filter((c) => {
    if (c.type === 'length' && c.refs[0] === entityId) {
      notes.push('A length dimension on the extended line was removed');
      return false;
    }
    return true;
  });
  return { sketch: sk, ids: [entityId], notes };
}

/**
 * Split a curve in two at the point on it nearest to `at` (at a crossing with another curve
 * when one is that close). Lines stay collinear, arcs on their circle, elliptical arcs on
 * their ellipse; a fit spline becomes two fit splines through its points on either side
 * (close to the original, not on it exactly), a control spline two exact pieces.
 */
export function breakCurve(sk0: CadSketch, P: Map<string, Vec2>, R: Map<string, number>, entityId: string, at: Vec2, tol = 0): ToolResult | string {
  const e = sk0.entities.find((x) => x.id === entityId);
  if (!e || e.type === 'point' || e.type === 'text') return 'Pick a line, arc, ellipse or spline to break';
  if (e.type === 'circle' || (e.type === 'ellipse' && !(e.p1 && e.p2)) || (e.type === 'spline' && e.closed)) return 'A closed curve is broken at two points: trim it, or break it after trimming it open';
  const seg = entitySegs(e, (id) => P.get(id), (id) => R.get(id))[0];
  if (!seg) return 'The curve has no size';
  // the nearest point on it, or a crossing within tol
  let t = 0, bd = Infinity;
  const pts = segPolyline(seg, PI / 360);
  pts.forEach((q, i) => {
    const dd = len(sub(q, at));
    if (dd < bd) [bd, t] = [dd, i / (pts.length - 1)];
  });
  // refine on the curve (the polyline's spacing is not uniform in t: Newton from the nearest sample)
  t = closestT(seg, at, t);
  let by: string | null = null;
  for (const o of othersSegs(sk0, P, R, entityId)) for (const x of segCrossings(seg, o.seg)) {
    if (len(sub(x.p, at)) <= max(tol, 1e-9) && len(sub(x.p, at)) <= len(sub(segPoint(seg, t), at)) + tol) [t, by] = [x.s, o.id];
  }
  if (!(t > 1e-6 && t < 1 - 1e-6)) return 'Pick the curve away from its ends';
  const X = segPoint(seg, t);
  let sk = cloneSketch(sk0);
  const x = pointFor(sk, { p: X });
  const piece = cadId('e');
  const notes: string[] = [];
  if (e.type === 'line') {
    sk.entities = sk.entities.map((q) => (q.id === entityId ? { ...e, p2: x } : q));
    sk.entities.push({ id: piece, type: 'line', p1: x, p2: e.p2, construction: e.construction });
    sk.constraints.push(K('collinear', [entityId, piece]));
  } else if (e.type === 'arc') {
    sk.entities = sk.entities.map((q) => (q.id === entityId ? { ...e, p2: x } : q));
    sk.entities.push({ id: piece, type: 'arc', c: e.c, p1: x, p2: e.p2, construction: e.construction });
    sk.constraints.push(K('equal', [entityId, piece]));
  } else if (e.type === 'ellipse') {
    sk.entities = sk.entities.map((q) => (q.id === entityId ? { ...e, p2: x } : q));
    sk.entities.push({ id: piece, type: 'ellipse', c: e.c, a: e.a, r: R.get(e.id) ?? e.r, p1: x, p2: e.p2!, construction: e.construction });
    sk.constraints.push(K('equal', [entityId, piece]));
  } else if (e.mode === 'control') {
    const cv = splineOf(e, (id) => P.get(id))!;
    const [u0, u1] = bsDomain(cv);
    const [a, b] = bsSplit(cv, u0 + (u1 - u0) * t);
    const poleIds = (s: BSpline, first: string, last: string) => s.poles.map((q, i) => (i === 0 ? first : i === s.poles.length - 1 ? last : pointFor(sk, { p: q })));
    sk.entities = sk.entities.map((q) => (q.id === entityId ? { ...e, pts: poleIds(a, e.pts[0], x), knots: a.knots } : q));
    sk.entities.push({ id: piece, type: 'spline', mode: 'control', pts: poleIds(b, x, e.pts[e.pts.length - 1]), knots: b.knots, construction: e.construction });
    sk.constraints = sk.constraints.filter((c) => !e.pts.slice(1, -1).some((p) => c.refs.includes(p)));
    sk = removeFromSketch(sk, new Set());
  } else {
    // the fit points on either side of the break
    const cv = splineOf(e, (id) => P.get(id))!;
    const u = bsDomain(cv)[0] + (bsDomain(cv)[1] - bsDomain(cv)[0]) * t;
    const params = e.pts.map((p) => bsClosest(cv, P.get(p)!));
    const k = params.findIndex((q) => q > u);
    sk.entities = sk.entities.map((q) => (q.id === entityId ? { ...e, pts: [...e.pts.slice(0, k), x], h2: undefined } : q));
    sk.entities.push({ id: piece, type: 'spline', pts: [x, ...e.pts.slice(k)], ...(e.h2 ? { h2: e.h2 } : {}), construction: e.construction });
    notes.push('A fit spline is broken into two fit splines through its points: they follow the original closely, not exactly');
  }
  if (by) {
    const on = onCurve(sk.entities.find((q) => q.id === by), x);
    if (on) sk.constraints.push(on);
  }
  sk.constraints = sk.constraints.filter((c) => {
    if (!c.refs.includes(entityId) || (c.type !== 'length' && c.type !== 'midpoint')) return true;
    notes.push(`A ${c.type === 'length' ? 'length dimension' : 'midpoint constraint'} on the broken curve was removed`);
    return false;
  });
  return { sketch: sk, ids: [entityId, piece], notes };
}

/** The parameter of the point of a segment nearest to q, from a start t (Newton on the distance). */
function closestT(s: Seg, q: Vec2, t: number): number {
  for (let it = 0; it < 40; it++) {
    const p = segPoint(s, t), d1 = segDeriv(s, t);
    const h = 1e-6;
    const d2 = mul(sub(segDeriv(s, min(1, t + h)), segDeriv(s, max(0, t - h))), 1 / (min(1, t + h) - max(0, t - h)));
    const f = dot(sub(p, q), d1), fp = dot(d1, d1) + dot(sub(p, q), d2);
    if (!(abs(fp) > 0)) break;
    const next = max(0, min(1, t - f / fp));
    if (abs(next - t) < 1e-14) return next;
    t = next;
  }
  return t;
}

// ------------------------------------------------------------ patterns

export interface PatternSpec {
  kind: 'rect' | 'circ';
  /** rect: copies along the first direction (the original counts) and the distance between them … */
  count: number;
  spacing: number;
  /** … the first direction a line (else the sketch's x axis), and an optional second direction (sketch y, or a line). */
  along?: string;
  count2?: number;
  spacing2?: number;
  along2?: string;
  /** circ: about this point, `angle` degrees in all (360: evenly round). */
  about?: string;
  angle?: number;
}

/**
 * Copies of the selected entities in a row (and columns) or round a point. A pattern
 * constraint per direction holds every copied point where the move puts its source's, so
 * the copies follow the source; its spacing (or total angle) is a dimension. The count is
 * the pattern's own number (repattern makes the copies again for another count).
 */
export function pattern(sk0: CadSketch, P: Map<string, Vec2>, ids: string[], spec: PatternSpec, group = cadId('g')): ToolResult | string {
  const ents = sk0.entities.filter((e) => ids.includes(e.id) && !e.ref);
  if (!ents.length) return 'Select the geometry to pattern first';
  const n1 = Math.round(spec.count), n2 = Math.round(spec.count2 ?? 1);
  if (!(n1 >= 1 && n1 <= 200 && n2 >= 1 && n2 <= 200) || n1 * n2 < 2) return 'A pattern needs 2 to 200 copies in each direction';
  if (spec.kind === 'circ' && !spec.about) return 'Pick the centre point of the circular pattern';
  if (spec.kind === 'circ' && !(abs(spec.angle ?? 360) > 0)) return 'The pattern angle must not be 0';
  const sk = cloneSketch(sk0);
  const src = [...new Set(ents.flatMap(entityPoints))];
  const notes: string[] = [];
  const made: string[] = [];
  /** Copies of the entities with their points moved by `to`; returns the new point ids in source order. */
  const copy = (pts: string[], to: (p: Vec2) => Vec2, turn: number): string[] => {
    const map = new Map(pts.map((p) => [p, pointFor(sk, { p: to(P.get(p) ?? sk.points.find((q) => q.id === p)!) })]));
    for (const e of ents) {
      const id = cadId('e');
      made.push(id);
      const m = (p: string) => map.get(p)!;
      switch (e.type) {
        case 'line': sk.entities.push({ ...e, id, p1: m(e.p1), p2: m(e.p2) }); break;
        case 'circle': sk.entities.push({ ...e, id, c: m(e.c) }); sk.constraints.push(K('equal', [e.id, id])); break;
        case 'arc': sk.entities.push({ ...e, id, c: m(e.c), p1: m(e.p1), p2: m(e.p2) }); break;
        case 'point': sk.entities.push({ ...e, id, p: m(e.p) }); break;
        case 'ellipse':
          sk.entities.push({ ...e, id, c: m(e.c), a: m(e.a), ...(e.p1 && e.p2 ? { p1: m(e.p1), p2: m(e.p2) } : {}) });
          sk.constraints.push(K('equal', [e.id, id]));
          break;
        case 'spline': sk.entities.push({ ...e, id, pts: e.pts.map(m), ...(e.h1 ? { h1: m(e.h1) } : {}), ...(e.h2 ? { h2: m(e.h2) } : {}) }); break;
        case 'text': sk.entities.push({ ...e, id, p: m(e.p), ...(turn ? { angle: (e.angle ?? 0) + (turn * 180) / PI } : {}) }); break;
      }
    }
    return pts.map((p) => map.get(p)!);
  };
  const dirOf = (line: string | undefined, fallback: Vec2): Vec2 => {
    const l = line ? sk.entities.find((e) => e.id === line) : undefined;
    return l?.type === 'line' ? unit(sub(P.get(l.p2)!, P.get(l.p1)!)) : fallback;
  };
  const name = nextDimName(sk);
  if (spec.kind === 'circ') {
    const c = P.get(spec.about!)!, total = ((spec.angle ?? 360) * PI) / 180;
    const full = abs(abs(spec.angle ?? 360) - 360) < 1e-9;
    const step = total / (full ? n1 : n1 - 1);
    const refs = [...src];
    for (let k = 1; k < n1; k++) {
      const a = k * step;
      refs.push(...copy(src, (p) => ({ x: c.x + (p.x - c.x) * cos(a) - (p.y - c.y) * sin(a), y: c.y + (p.x - c.x) * sin(a) + (p.y - c.y) * cos(a) }), a));
    }
    sk.constraints.push(K('pattern', refs, { value: `${fmt(spec.angle ?? 360)} deg`, name, pattern: { kind: 'circ', n: src.length, count: n1, about: spec.about, group, of: ents.map((e) => e.id), made } }));
    return { sketch: sk, ids: made, notes };
  }
  // rows along the first direction, then the rows copied along the second
  const u = dirOf(spec.along, { x: 1, y: 0 });
  const row = [...src];
  for (let k = 1; k < n1; k++) row.push(...copy(src, (p) => add(p, mul(u, k * spec.spacing)), 0));
  sk.constraints.push(K('pattern', row, {
    value: fmt(spec.spacing), name,
    pattern: { kind: 'rect', n: src.length, count: n1, ...(spec.along ? { along: spec.along } : { dir: 'x' as const }), group, of: ents.map((e) => e.id), made: [...made] },
  }));
  if (n2 > 1) {
    const v = dirOf(spec.along2, { x: 0, y: 1 });
    const rowEnts = [...ents.map((e) => e.id), ...made];
    const all = [...row];
    const madeBefore = made.length;
    // the second direction copies the whole first row
    const rowSrc = [...new Set(sk.entities.filter((e) => rowEnts.includes(e.id)).flatMap(entityPoints))];
    const ents2 = sk.entities.filter((e) => rowEnts.includes(e.id));
    ents.splice(0, ents.length, ...ents2);
    for (let k = 1; k < n2; k++) all.push(...copy(rowSrc, (p) => add(p, mul(v, k * spec.spacing2!)), 0));
    sk.constraints.push(K('pattern', [...rowSrc, ...all.slice(row.length)], {
      value: fmt(spec.spacing2 ?? spec.spacing), name: nextDimName(sk),
      pattern: { kind: 'rect', n: rowSrc.length, count: n2, ...(spec.along2 ? { along: spec.along2 } : { dir: 'y' as const }), group, of: rowEnts, made: made.slice(madeBefore) },
    }));
  }
  return { sketch: sk, ids: made, notes };
}

/** The pattern a constraint belongs to, made again with other counts (the spacings and names kept). */
export function repattern(sk0: CadSketch, P: Map<string, Vec2>, cid: string, count: number, count2?: number): ToolResult | string {
  const c = sk0.constraints.find((k) => k.id === cid);
  const g = c?.pattern?.group;
  if (!c?.pattern || !g) return 'Not a pattern';
  const parts = sk0.constraints.filter((k) => k.pattern?.group === g);
  const first = parts[0], second = parts[1];
  const of = first.pattern!.of ?? [];
  const made = parts.flatMap((k) => k.pattern!.made ?? []);
  const base = removeFromSketch(sk0, new Set([...made, ...parts.map((k) => k.id)]));
  const num = (k: CadConstraint) => {
    const v = parseFloat(k.value ?? '');
    return Number.isFinite(v) ? v : 0;
  };
  const spec: PatternSpec = first.pattern!.kind === 'circ'
    ? { kind: 'circ', count, spacing: 0, about: first.pattern!.about, angle: num(first) }
    : { kind: 'rect', count, spacing: num(first), along: first.pattern!.along, count2: count2 ?? second?.pattern?.count ?? 1, spacing2: second ? num(second) : 10, along2: second?.pattern?.along };
  const r = pattern(base, P, of, spec, g);
  if (typeof r === 'string') return r;
  // the dimensions keep their expressions and names
  const next = r.sketch.constraints.filter((k) => k.pattern?.group === g);
  r.sketch.constraints = r.sketch.constraints.map((k) => {
    const i = next.indexOf(k);
    const old = parts[i];
    return i >= 0 && old ? { ...k, id: old.id, value: old.value, name: old.name, driving: old.driving } : k;
  });
  return r;
}
