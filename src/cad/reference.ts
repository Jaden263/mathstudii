// Reference geometry in a sketch: body edges, the outer loop of a face, construction points
// and axes, and the section of the bodies with the sketch plane, projected square onto the
// plane as fixed sketch entities that can be constrained against. The timeline projects
// them again every time it builds the sketch (design.ts), on the bodies built before it,
// so they follow model edits.
//
// Projection is exact where it can be: lines stay lines, a circle in a parallel plane a
// circle, a circle in a tilted plane an ellipse (its axes r along the line both planes
// share and r·|cos θ| across it), a section's ellipses ellipses; other curves become fit
// splines through points along them (close, not exact). Every entity and point of a
// source has an id made from the source's (`${source}.e3`, `${source}.p7`), so constraints
// on them survive a rebuild that finds the same edges.
import type { CadEntity, CadPoint, CadSketch, SketchSource } from './model';
import type { Vec2 } from './profile';
import type { BodyTopology } from './topology';
import { resolveRef, resolvedEntity } from './topology';
import { add3, cross3, dot3, norm3, scale3, sub3, type Frame, type Vec3 } from './solid';
import { fitCircle } from './project';

const { abs, atan2, max, PI, hypot } = Math;

/** A curve in component coordinates, as a kernel describes it. */
export type RefCurve3 =
  | { kind: 'line'; a: Vec3; b: Vec3 }
  /** A circle (an arc anticlockwise about axis from a to b when they are given). */
  | { kind: 'circle'; c: Vec3; axis: Vec3; r: number; a?: Vec3; b?: Vec3 }
  /** An ellipse c + ra cos t·x + rb sin t·y (an arc from t0 to t1 when given). */
  | { kind: 'ellipse'; c: Vec3; x: Vec3; y: Vec3; ra: number; rb: number; t0?: number; t1?: number }
  /** Any other curve: points along it. */
  | { kind: 'poly'; pts: Vec3[]; closed?: boolean }
  | { kind: 'point'; p: Vec3 };

/** What projecting needs of the bodies built before the sketch. */
export interface ReferenceContext {
  bodies: BodyTopology[];
  /** Point and unit tangent at fraction t along an edge of body `body` (index into bodies). */
  edgeAt(body: number, edge: number, t: number): { p: Vec3; d: Vec3 };
  /** The curves the sketch plane cuts from the bodies (all, or those listed). */
  section(f: Frame, bodies?: string[]): RefCurve3[];
  datums: Record<string, { kind: string; p?: Vec3; d?: Vec3 }>;
  /** A size for lines along construction axes (they have no ends). */
  size: number;
}

// ------------------------------------------------------------ edges and faces as curves

type Edge = BodyTopology['edges'][number];

/** An edge as a curve: lines and circles exactly (arcs from their end vertices), others by points. */
export function edgeCurve(b: BodyTopology, e: Edge, at: (t: number) => { p: Vec3 }): RefCurve3 {
  if (e.line) return { kind: 'line', a: e.line.a, b: e.line.b };
  const [v0, v1] = e.v.map((i) => b.vertices[i]?.p);
  if (e.circle) {
    const { c, axis, r } = e.circle;
    if (!v0 || !v1 || e.v[0] === e.v[1] || e.length >= 2 * PI * r * (1 - 1e-9)) return { kind: 'circle', c, axis, r };
    // anticlockwise about the axis from one end to the other, through the edge's middle
    const ang = (q: Vec3) => {
      const x = norm3(sub3(v0, c)), y = cross3(norm3(axis), x), d = sub3(q, c);
      return (atan2(dot3(d, y), dot3(d, x)) + 2 * PI) % (2 * PI);
    };
    return ang(e.mid) < ang(v1) ? { kind: 'circle', c, axis, r, a: v0, b: v1 } : { kind: 'circle', c, axis, r, a: v1, b: v0 };
  }
  const n = 24;
  return { kind: 'poly', pts: Array.from({ length: n + 1 }, (_, i) => at(i / n).p), closed: e.v[0] === e.v[1] };
}

/** The edges of a face's outer loop (the loop enclosing the most area in the plane f), in order. */
export function outerLoop(b: BodyTopology, face: number, f: Frame): number[] {
  const mine = b.edges.filter((e) => e.faces.includes(face)).map((e) => e.index);
  const loops: number[][] = [];
  const left = new Set(mine);
  while (left.size) {
    const first = [...left][0];
    left.delete(first);
    const loop = [first];
    let v = b.edges[first].v[1];
    const start = b.edges[first].v[0];
    while (v !== start) {
      const next = [...left].find((i) => b.edges[i].v.includes(v));
      if (next === undefined) break;
      left.delete(next);
      loop.push(next);
      v = b.edges[next].v[0] === v ? b.edges[next].v[1] : b.edges[next].v[0];
    }
    loops.push(loop);
  }
  // the area of each loop's points (vertices and edge middles) seen in the plane
  const area = (loop: number[]) => {
    const pts = loop.flatMap((i) => [b.vertices[b.edges[i].v[0]]?.p, b.edges[i].mid].filter(Boolean) as Vec3[]).map((q) => toPlane(f, q));
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    // a circle alone has one vertex: its radius tells its size
    return abs(a) + loop.reduce((s, i) => s + (b.edges[i].circle ? PI * b.edges[i].circle!.r ** 2 * abs(dot3(norm3(b.edges[i].circle!.axis), f.n)) : 0), 0);
  };
  return loops.sort((p, q) => area(q) - area(p))[0] ?? [];
}

// ------------------------------------------------------------ projection

const toPlane = (f: Frame, q: Vec3): Vec2 => {
  const d = sub3(q, f.o);
  return { x: dot3(d, f.u), y: dot3(d, f.v) };
};

/** A curve in the sketch plane (sketch coordinates). */
export type RefCurve2 =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'circle'; c: Vec2; r: number; a?: Vec2; b?: Vec2 }
  | { kind: 'ellipse'; c: Vec2; ax: Vec2; rb: number; a?: Vec2; b?: Vec2 }
  | { kind: 'spline'; pts: Vec2[]; closed?: boolean }
  | { kind: 'point'; p: Vec2 };

/** A curve projected square onto the plane f. */
export function projectCurve(c: RefCurve3, f: Frame, tol: number): RefCurve2 | null {
  switch (c.kind) {
    case 'point': return { kind: 'point', p: toPlane(f, c.p) };
    case 'line': {
      const a = toPlane(f, c.a), b = toPlane(f, c.b);
      return hypot(b.x - a.x, b.y - a.y) > tol ? { kind: 'line', a, b } : { kind: 'point', p: a };
    }
    case 'circle': {
      const ax = norm3(c.axis), cos = dot3(ax, f.n);
      const cc = toPlane(f, c.c);
      if (abs(abs(cos) - 1) < 1e-9) {
        // in a parallel plane: a circle (an arc runs the other way seen from behind)
        if (!c.a || !c.b) return { kind: 'circle', c: cc, r: c.r };
        const [a, b] = cos > 0 ? [c.a, c.b] : [c.b, c.a];
        return { kind: 'circle', c: cc, r: c.r, a: toPlane(f, a), b: toPlane(f, b) };
      }
      if (abs(cos) < 1e-9) {
        // edge on: the circle is seen as a line across its diameter (an arc as the line between its extremes)
        const w = norm3(cross3(ax, f.n));
        const ends = c.a && c.b ? arcExtremes(c, w) : [add3(c.c, scale3(w, -c.r)), add3(c.c, scale3(w, c.r))];
        return { kind: 'line', a: toPlane(f, ends[0]), b: toPlane(f, ends[1]) };
      }
      // tilted: an ellipse, r along the line both planes share, r·|cos θ| across it
      const w = norm3(cross3(ax, f.n));
      const axEnd = toPlane(f, add3(c.c, scale3(w, c.r)));
      if (!c.a || !c.b) return { kind: 'ellipse', c: cc, ax: axEnd, rb: c.r * abs(cos) };
      const [a, b] = cos > 0 ? [c.a, c.b] : [c.b, c.a];
      return { kind: 'ellipse', c: cc, ax: axEnd, rb: c.r * abs(cos), a: toPlane(f, a), b: toPlane(f, b) };
    }
    case 'ellipse': {
      // in the plane (a section): exact; tilted out of it: points along it
      const n = norm3(cross3(c.x, c.y));
      if (abs(abs(dot3(n, f.n)) - 1) < 1e-9 && (c.t0 === undefined || c.t1 === undefined)) {
        const cc = toPlane(f, c.c);
        return { kind: 'ellipse', c: cc, ax: toPlane(f, add3(c.c, scale3(c.x, c.ra))), rb: c.rb };
      }
      const t0 = c.t0 ?? 0, t1 = c.t1 ?? 2 * PI, closed = c.t0 === undefined;
      const pts = Array.from({ length: closed ? 32 : 25 }, (_, i) => {
        const t = t0 + ((t1 - t0) * i) / (closed ? 32 : 24);
        return toPlane(f, add3(c.c, add3(scale3(c.x, c.ra * Math.cos(t)), scale3(c.y, c.rb * Math.sin(t)))));
      });
      return { kind: 'spline', pts, closed };
    }
    case 'poly': {
      let pts = c.pts.map((q) => toPlane(f, q));
      if (c.closed && pts.length > 1 && hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tol) pts = pts.slice(0, -1);
      // points that fall on each other (an edge seen end on) say nothing
      pts = pts.filter((p, i) => i === 0 || hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > tol);
      if (pts.length < 2) return pts.length ? { kind: 'point', p: pts[0] } : null;
      if (pts.length === 2 && !c.closed) return { kind: 'line', a: pts[0], b: pts[1] };
      const circ = c.closed ? fitCircle(pts) : null;
      if (circ && pts.length >= 12) return { kind: 'circle', c: circ.c, r: circ.r };
      return { kind: 'spline', pts: thin(pts, c.closed ? 32 : 25), closed: c.closed && pts.length >= 3 };
    }
  }
}

/** The two points of an arc farthest apart along w (its extent seen edge on). */
function arcExtremes(c: Extract<RefCurve3, { kind: 'circle' }>, w: Vec3): [Vec3, Vec3] {
  const x = norm3(sub3(c.a!, c.c)), y = cross3(norm3(c.axis), x);
  const end = ((atan2(dot3(sub3(c.b!, c.c), y), dot3(sub3(c.b!, c.c), x)) + 2 * PI) % (2 * PI)) || 2 * PI;
  let lo = Infinity, hi = -Infinity, pl = c.a!, ph = c.a!;
  for (let i = 0; i <= 64; i++) {
    const t = (end * i) / 64, q = add3(c.c, add3(scale3(x, c.r * Math.cos(t)), scale3(y, c.r * Math.sin(t))));
    const s = dot3(q, w);
    if (s < lo) [lo, pl] = [s, q];
    if (s > hi) [hi, ph] = [s, q];
  }
  return [pl, ph];
}

/** At most n points of a polyline, evenly by length (its ends kept). */
function thin(pts: Vec2[], n: number): Vec2[] {
  if (pts.length <= n) return pts;
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const out: Vec2[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (L[L.length - 1] * k) / (n - 1);
    while (j + 1 < L.length - 1 && L[j + 1] < s) j++;
    const t = (s - L[j]) / (L[j + 1] - L[j] || 1);
    out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * t, y: pts[j].y + (pts[j + 1].y - pts[j].y) * t });
  }
  return out;
}

// ------------------------------------------------------------ sketch entities

/**
 * Sketch entities of a source's curves: ids from the source, ends that meet one point
 * (so a projected loop is a closed chain), all marked as references to the source.
 */
export function referenceEntities(src: string, curves: RefCurve2[], tol: number): { points: CadPoint[]; entities: CadEntity[] } {
  const points: CadPoint[] = [], entities: CadEntity[] = [];
  const pt = (p: Vec2, share = true): string => {
    const hit = share ? points.find((q) => hypot(q.x - p.x, q.y - p.y) <= tol) : undefined;
    if (hit) return hit.id;
    const id = `${src}.p${points.length}`;
    points.push({ id, x: p.x, y: p.y });
    return id;
  };
  curves.forEach((c, k) => {
    const id = `${src}.e${k}`, base = { id, ref: src, construction: true as const };
    switch (c.kind) {
      case 'point': entities.push({ ...base, type: 'point', p: pt(c.p) }); break;
      case 'line': entities.push({ ...base, type: 'line', p1: pt(c.a), p2: pt(c.b) }); break;
      case 'circle':
        if (c.a && c.b) entities.push({ ...base, type: 'arc', c: pt(c.c, false), p1: pt(c.a), p2: pt(c.b) });
        else entities.push({ ...base, type: 'circle', c: pt(c.c, false), r: c.r });
        break;
      case 'ellipse':
        entities.push({ ...base, type: 'ellipse', c: pt(c.c, false), a: pt(c.ax, false), r: c.rb, ...(c.a && c.b ? { p1: pt(c.a), p2: pt(c.b) } : {}) });
        break;
      case 'spline': {
        const ids = c.pts.map((p, i) => pt(p, i === 0 || i === c.pts.length - 1));
        entities.push({ ...base, type: 'spline', pts: ids, ...(c.closed ? { closed: true } : {}) });
        break;
      }
    }
  });
  return { points, entities };
}

/** Why a source could not be projected (the timeline warns), or its curves. */
export function sourceCurves(src: SketchSource, f: Frame, cx: ReferenceContext): RefCurve3[] | string {
  if (src.kind === 'section') {
    const cs = cx.section(f, src.bodies);
    return cs.length ? cs : 'the sketch plane cuts no body';
  }
  if (src.kind === 'datum') {
    const d = cx.datums[src.datum];
    if (d?.kind === 'point' && d.p) return [{ kind: 'point', p: d.p }];
    if (d?.kind === 'axis' && d.p && d.d) {
      const u = norm3(d.d), L = cx.size;
      return [{ kind: 'line', a: add3(d.p, scale3(u, -L)), b: add3(d.p, scale3(u, L)) }];
    }
    return 'its construction point or axis is gone or failed';
  }
  const r = resolveRef(src.ref, cx.bodies);
  const kind = src.kind === 'edge' ? 'edge' : 'face';
  const hit = r.ok ? resolvedEntity(cx.bodies, kind, r) : null;
  if (!hit || !r.ok) return `reference lost: the ${kind} it was projected from is gone`;
  const bi = cx.bodies.findIndex((b) => b.id === r.body), b = cx.bodies[bi];
  const curveOf = (e: Edge) => edgeCurve(b, e, (t) => cx.edgeAt(bi, e.index, t));
  if (src.kind === 'edge') return [curveOf(hit as Edge)];
  return outerLoop(b, (hit as { index: number }).index, f).map((i) => curveOf(b.edges[i]));
}

/**
 * The sketch with the geometry of its sources projected again: each source's entities
 * replaced (construction or not as the user left them), points no entity uses any more
 * and constraints on entities that are gone dropped. Sources that cannot be projected keep
 * their old geometry and say why in `lost`.
 */
export function reproject(sk: CadSketch, f: Frame, cx: ReferenceContext): { sketch: CadSketch; lost: string[] } {
  const sources = sk.sources ?? [];
  if (!sources.length) return { sketch: sk, lost: [] };
  let size = cx.size;
  for (const p of sk.points) size = max(size, abs(p.x), abs(p.y));
  const tol = 1e-9 * size;
  const lost: string[] = [];
  const fresh = new Map<string, { points: CadPoint[]; entities: CadEntity[] }>();
  for (const src of sources) {
    const cs = sourceCurves(src, f, cx);
    if (typeof cs === 'string') {
      lost.push(`${src.label ?? 'a projected reference'}: ${cs}`);
      continue;
    }
    const c2 = cs.map((c) => projectCurve(c, f, tol)).filter((c): c is RefCurve2 => !!c);
    fresh.set(src.id, referenceEntities(src.id, c2, tol));
  }
  const old = new Map(sk.entities.map((e) => [e.id, e]));
  const entities: CadEntity[] = [];
  for (const e of sk.entities) if (!e.ref || !fresh.has(e.ref)) entities.push(e);
  const pos = new Map<string, CadPoint>();
  for (const g of fresh.values()) {
    for (const e of g.entities) entities.push({ ...e, construction: old.get(e.id)?.construction ?? true } as CadEntity);
    for (const p of g.points) pos.set(p.id, p);
  }
  // a projection with fewer points than before leaves some of its old ones over; the
  // sketch's own points stay, used by a curve or only by constraints
  const used = new Set(entities.flatMap(entityPts));
  const stale = (id: string) => !used.has(id) && [...fresh.keys()].some((s) => id.startsWith(`${s}.`));
  const points = [...sk.points.filter((p) => !stale(p.id)).map((p) => pos.get(p.id) ?? p), ...[...pos.values()].filter((p) => !sk.points.some((q) => q.id === p.id))];
  const alive = new Set([...entities.map((e) => e.id), ...points.map((p) => p.id)]);
  const constraints = sk.constraints.filter((c) => c.refs.every((r) => alive.has(r)));
  return { sketch: { ...sk, points, entities, constraints }, lost };
}

const entityPts = (e: CadEntity): string[] => {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'circle': return [e.c];
    case 'arc': return [e.c, e.p1, e.p2];
    case 'point':
    case 'text': return [e.p];
    case 'ellipse': return [e.c, e.a, ...(e.p1 ? [e.p1] : []), ...(e.p2 ? [e.p2] : [])];
    case 'spline': return [...e.pts, ...(e.h1 ? [e.h1] : []), ...(e.h2 ? [e.h2] : [])];
  }
};

/** Whether the reference geometry of two versions of a sketch is the same (to rounding). */
export function sameReferences(a: CadSketch, b: CadSketch, tol: number): boolean {
  const refs = (s: CadSketch) => s.entities.filter((e) => e.ref);
  const ra = refs(a), rb = refs(b);
  if (ra.length !== rb.length || JSON.stringify(ra.map((e) => ({ ...e, r: undefined }))) !== JSON.stringify(rb.map((e) => ({ ...e, r: undefined })))) return false;
  const pa = new Map(a.points.map((p) => [p.id, p]));
  for (const e of rb) {
    if ((e.type === 'circle' || e.type === 'ellipse') && abs(e.r - (ra.find((x) => x.id === e.id) as { r: number }).r) > tol) return false;
    for (const id of entityPts(e)) {
      const p = pa.get(id), q = b.points.find((x) => x.id === id);
      if (!p || !q || hypot(p.x - q.x, p.y - q.y) > tol) return false;
    }
  }
  return true;
}

/**
 * The stored sketch with the reference geometry a build projected (its other entities and
 * constraints as they are now); the same object when nothing moved.
 */
export function withReferencesOf(stored: CadSketch, built: CadSketch): CadSketch {
  let size = 1;
  for (const p of built.points) size = max(size, abs(p.x), abs(p.y));
  const live = new Set((stored.sources ?? []).map((q) => q.id));
  const refs = built.entities.filter((e) => e.ref && live.has(e.ref));
  const mine = (e: CadEntity) => !!e.ref && live.has(e.ref);
  const candidate: CadSketch = { ...stored, entities: [...stored.entities.filter((e) => !mine(e)), ...refs.map((e) => ({ ...e, construction: stored.entities.find((x) => x.id === e.id)?.construction ?? e.construction }))] };
  const pos = new Map(built.points.map((p) => [p.id, p]));
  const used = new Set(candidate.entities.flatMap(entityPts));
  // as in reproject: only reference points no curve uses any more go
  const stale = (id: string) => !used.has(id) && [...live].some((s) => id.startsWith(`${s}.`));
  const points = [...stored.points.filter((p) => !stale(p.id)).map((p) => (refs.some((e) => entityPts(e).includes(p.id)) ? pos.get(p.id) ?? p : p))];
  for (const id of used) if (!points.some((p) => p.id === id) && pos.has(id)) points.push(pos.get(id)!);
  const alive = new Set([...candidate.entities.map((e) => e.id), ...points.map((p) => p.id)]);
  const next: CadSketch = { ...candidate, points, constraints: stored.constraints.filter((c) => c.refs.every((r) => alive.has(r))) };
  return sameReferences(stored, next, 1e-9 * size) ? stored : next;
}
