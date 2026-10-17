// The model on the paper of a drawing view: the named vertices, edges and cylinder faces
// of the drawn occurrences projected as the view sees them (BuildResult topology, the
// same names the 3-D picks use), so annotations can pick them, follow them through
// edits by their persistent names, and say when they are gone. Values are measured on
// the model's own geometry in model units: true size whatever the sheet's scale.
import type { BodyResult, BuildResult, EdgeInfo } from './buildResult';
import type { CadDesign } from './design';
import type { DrawView, Prim } from './drawing2d';
import { refTo, resolveRef, type BodyTopology, type TopoKind } from './topology';
import { add3, cross3, dot3, len3, m4Dir, m4Point, norm3, scale3, sub3, type M4, type Vec3 } from './solid';
import type { DimAnnotation, DrawPick, PickSnap, Shape2, XY } from './annotations';

const { abs, acos, atan2, cos, sin, hypot, min, max, PI } = Math;
const TAU = 2 * PI;

/** The axes of a view in assembly coordinates; a section's plane point. */
export interface ViewFrame {
  right: Vec3;
  up: Vec3;
  dir: Vec3;
  cut?: Vec3;
}

export function viewFrame(v: { dir: Vec3; up: Vec3; cut?: Vec3 }): ViewFrame {
  const dir = norm3(v.dir);
  const right = norm3(cross3(dir, v.up));
  return { right, up: cross3(right, dir), dir, ...(v.cut ? { cut: v.cut } : {}) };
}

/** An occurrence as drawn: its placement and visible bodies. */
export interface DrawnPart {
  occ: string;
  component: string;
  M: M4;
  bodies: BodyResult[];
}

/** The occurrences a drawing shows (not hidden, placed), with their visible bodies. */
export function drawnParts(build: BuildResult, design: CadDesign): DrawnPart[] {
  const out: DrawnPart[] = [];
  for (const o of design.occurrences) {
    const comp = design.components.find((c) => c.id === o.component);
    const M = build.placements[o.id]?.matrix;
    if (o.hidden || !comp || !M) continue;
    const bodies = (build.components[comp.id]?.bodies ?? []).filter((b) => !comp.hiddenBodies?.includes(b.id));
    if (bodies.length) out.push({ occ: o.id, component: comp.id, M, bodies });
  }
  return out;
}

/** A model entity on the paper of a view. */
export interface ViewEntity {
  occ: string;
  body: string;
  kind: TopoKind;
  index: number;
  shape: Shape2;
  /** Along the direction of view (smaller: nearer the viewer). */
  depth: number;
  /** Assembly points: a vertex, a line's ends, a circle's centre. */
  p3: Vec3[];
  /** Keys of the faces it bounds (an edge) or its own (a face). */
  faces: string[];
  /** A round face (or an edge of one) that looks towards its axis: a hole. */
  hole?: boolean;
  /** Where an edge goes through a section's plane: the first or second crossing (a corner of the cut face). */
  cut?: 0 | 1;
}

/** Edges of each face of a body, worked out once. */
const faceEdgeCache = new WeakMap<BodyResult, number[][]>();
function faceEdges(b: BodyResult): number[][] {
  let fe = faceEdgeCache.get(b);
  if (!fe) {
    fe = b.faces.map(() => []);
    for (const e of b.edges) for (const f of new Set(e.faces)) if (f >= 0) fe[f]?.push(e.index);
    faceEdgeCache.set(b, fe);
  }
  return fe;
}

const isSeam = (e: EdgeInfo) => e.faces[0] === e.faces[1];
const closedEdge = (e: EdgeInfo) => e.v[0] === e.v[1];
const ccw = (from: number, to: number) => ((((to - from) % TAU) + TAU) % TAU);

/** A body's size (its box diagonal), the scale of the tolerances. */
const bodySize = (b: BodyResult) => (b.box ? len3(sub3(b.box.max, b.box.min)) || 1 : 1);

/**
 * Whether the round faces of a cylinder (the face and any others of the body on the same
 * surface: OpenCascade may split one at its seam) go round far enough to show both of its
 * outlines seen along `dir`: a shaft or a hole does, a fillet's quarter round does not.
 */
function bothOutlines(part: DrawnPart, body: BodyResult, index: number, dir: Vec3): boolean {
  const face = body.faces[index];
  const P = (q: Vec3) => m4Point(part.M, q);
  const d = norm3(m4Dir(part.M, face.axis!.d)), o = P(face.axis!.p), r = face.radius!;
  const tol = bodySize(body) * 1e-6;
  const s = norm3(cross3(d, dir)), t = cross3(d, s);
  const same = body.faces.filter((g) => g.type === 'cylinder' && g.axis && abs(g.radius! - r) <= tol && len3(cross3(norm3(m4Dir(part.M, g.axis.d)), d)) < 1e-6
    && len3(cross3(sub3(P(g.axis.p), o), d)) <= tol);
  // the angles each face's boundary reaches round the axis; the face lies outside its largest gap
  const covered: [number, number][] = [];
  for (const g of same) {
    const angles: number[] = [];
    for (const ei of faceEdges(body)[g.index] ?? []) {
      const e = body.edges[ei];
      if (e.circle && closedEdge(e)) return true;
      const add = (q: Vec3) => {
        const w = sub3(P(q), o);
        angles.push(atan2(dot3(w, t), dot3(w, s)));
      };
      for (let i = 0; i + 2 < e.points.length; i += 3) add([e.points[i], e.points[i + 1], e.points[i + 2]]);
      add(e.mid);
    }
    if (angles.length < 2) continue;
    angles.sort((a, b) => a - b);
    let gap = angles[0] + TAU - angles[angles.length - 1], at = angles[angles.length - 1];
    for (let i = 1; i < angles.length; i++) if (angles[i] - angles[i - 1] > gap) [gap, at] = [angles[i] - angles[i - 1], angles[i - 1]];
    covered.push([at + gap, at + TAU]);
  }
  const inside = (a: number) => covered.some(([a0, a1]) => ccw(a0, a) <= a1 - a0 + 1e-3);
  return inside(0) && inside(PI);
}

/**
 * Where an edge goes through a section's plane (assembly points, ordered across the paper
 * and then up it): a line once, a circle or arc up to twice. Edges of other shapes are not
 * followed (their facets are no exact place to measure from).
 */
function crossings(part: DrawnPart, body: BodyResult, e: EdgeInfo, f: ViewFrame): Vec3[] {
  const o = f.cut!, n = f.dir;
  const P = (q: Vec3) => m4Point(part.M, q);
  const side = (q: Vec3) => dot3(sub3(q, o), n);
  const tol = bodySize(body) * 1e-7;
  const out: Vec3[] = [];
  if (e.line) {
    const a = P(e.line.a), b = P(e.line.b), sa = side(a), sb = side(b);
    if ((sa < -tol && sb > tol) || (sa > tol && sb < -tol)) out.push(add3(a, scale3(sub3(b, a), sa / (sa - sb))));
  } else if (e.circle) {
    // c + r (cos θ e1 + sin θ e2) on the plane: s0 + R cos(θ − φ) = 0
    const c = P(e.circle.c), ax = norm3(m4Dir(part.M, e.circle.axis)), r = e.circle.r;
    const e1 = norm3(abs(dot3(ax, n)) < 1 - 1e-9 ? cross3(ax, n) : cross3(ax, f.right)), e2 = cross3(ax, e1);
    const s0 = side(c), A = r * dot3(e1, n), B = r * dot3(e2, n), R = hypot(A, B);
    if (!(R > tol) || abs(s0) >= R - tol) return out;
    const phi = atan2(B, A), w = acos(-s0 / R);
    const at = (th: number) => add3(c, add3(scale3(e1, r * cos(th)), scale3(e2, r * sin(th))));
    const ang = (q: Vec3) => atan2(dot3(sub3(q, c), e2), dot3(sub3(q, c), e1));
    let span: [number, number] | null = null;
    if (!closedEdge(e)) {
      const s = ang(P(body.vertices[e.v[0]]?.p ?? e.mid)), t = ang(P(body.vertices[e.v[1]]?.p ?? e.mid)), m = ang(P(e.mid));
      span = ccw(s, m) <= ccw(s, t) ? [s, ccw(s, t)] : [t, ccw(t, s)];
    }
    for (const th of [phi + w, phi - w]) if (!span || ccw(span[0], th) <= span[1] + 1e-9) out.push(at(th));
  }
  const x = (q: Vec3) => dot3(q, f.right), y = (q: Vec3) => dot3(q, f.up);
  return out.sort((a, b) => (abs(x(a) - x(b)) > tol ? x(a) - x(b) : y(a) - y(b)));
}

/**
 * The paper geometry of one entity of a part in a view, or null when the view does not
 * show it as something to pick: seams, edges seen end-on, circles seen at an angle,
 * round faces seen end-on (their edges are the circles) or not round enough to have both
 * outlines. `cut` asks for where an edge goes through a section's plane.
 */
export function entityShape(part: DrawnPart, body: BodyResult, kind: TopoKind, index: number, f: ViewFrame, cut?: 0 | 1): Omit<ViewEntity, 'occ' | 'body' | 'kind' | 'index'> | null {
  const P = (q: Vec3) => m4Point(part.M, q);
  const to2 = (q: Vec3): XY => [dot3(q, f.right), dot3(q, f.up)];
  const depth = (q: Vec3) => dot3(q, f.dir);
  const tol = bodySize(body) * 1e-7;
  const keysOf = (fs: number[]) => [...new Set(fs.filter((i) => i >= 0).map((i) => body.faces[i]?.key ?? ''))];
  if (kind === 'vertex') {
    const v = body.vertices[index];
    if (!v) return null;
    // the one vertex of a closed curve (a circle's seam) is no corner
    if (v.edges.length && v.edges.every((ei) => isSeam(body.edges[ei]) || closedEdge(body.edges[ei]))) return null;
    const q = P(v.p), [x, y] = to2(q);
    return { shape: { k: 'point', x, y }, depth: depth(q), p3: [q], faces: [] };
  }
  if (kind === 'edge') {
    const e = body.edges[index];
    if (!e || isSeam(e)) return null;
    const faces = keysOf(e.faces);
    const hole = e.faces.some((i) => body.faces[i]?.outward === false);
    if (cut !== undefined) {
      if (!f.cut) return null;
      const q = crossings(part, body, e, f)[cut];
      if (!q) return null;
      const [x, y] = to2(q);
      return { shape: { k: 'point', x, y }, depth: depth(q), p3: [q], faces, cut };
    }
    if (e.line) {
      const a = P(e.line.a), b = P(e.line.b);
      const [x1, y1] = to2(a), [x2, y2] = to2(b);
      if (hypot(x2 - x1, y2 - y1) < tol) return null;
      return { shape: { k: 'line', x1, y1, x2, y2 }, depth: min(depth(a), depth(b)), p3: [a, b], faces };
    }
    if (e.circle) {
      const c = P(e.circle.c), ax = norm3(m4Dir(part.M, e.circle.axis)), r = e.circle.r;
      const cosine = abs(dot3(ax, f.dir));
      const [cx, cy] = to2(c);
      if (cosine > 1 - 1e-6) {
        const full = closedEdge(e) || e.length >= TAU * r * (1 - 1e-6);
        let a0 = 0, a1 = TAU;
        if (!full) {
          const ang = (q: Vec3) => {
            const [x, y] = to2(P(q));
            return atan2(y - cy, x - cx);
          };
          const s = ang(body.vertices[e.v[0]]?.p ?? e.mid), t = ang(body.vertices[e.v[1]]?.p ?? e.mid), m = ang(e.mid);
          if (ccw(s, m) <= ccw(s, t)) [a0, a1] = [s, s + ccw(s, t)];
          else [a0, a1] = [t, t + ccw(t, s)];
        }
        return { shape: { k: 'circle', cx, cy, r, a0, a1 }, depth: depth(c), p3: [c], faces, hole };
      }
      if (cosine < 1e-6 && closedEdge(e)) {
        // a circle seen edge-on: a line across it, square to its axis on the paper
        const s = norm3(cross3(ax, f.dir));
        const a = add3(c, scale3(s, r)), b = add3(c, scale3(s, -r));
        const [x1, y1] = to2(a), [x2, y2] = to2(b);
        return { shape: { k: 'line', x1, y1, x2, y2 }, depth: depth(c), p3: [a, b], faces, hole };
      }
    }
    return null;
  }
  const face = body.faces[index];
  if (!face || face.type !== 'cylinder' || !face.axis || !(face.radius! > 0)) return null;
  const d = norm3(m4Dir(part.M, face.axis.d));
  if (abs(dot3(d, f.dir)) > 1e-6 || !bothOutlines(part, body, index, f.dir)) return null;
  // its extent along the axis from the edges around it
  const o = P(face.axis.p);
  let t0 = Infinity, t1 = -Infinity;
  for (const ei of faceEdges(body)[index] ?? []) {
    const e = body.edges[ei];
    const pts = e.points;
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const t = dot3(sub3(P([pts[i], pts[i + 1], pts[i + 2]]), o), d);
      t0 = min(t0, t);
      t1 = max(t1, t);
    }
    for (const q of [e.mid, ...(e.line ? [e.line.a, e.line.b] : []), ...(e.circle ? [e.circle.c] : [])]) {
      const t = dot3(sub3(P(q), o), d);
      t0 = min(t0, t);
      t1 = max(t1, t);
    }
  }
  if (!(t1 - t0 > tol)) return null;
  const A = add3(o, scale3(d, t0)), B = add3(o, scale3(d, t1));
  const [x1, y1] = to2(A), [x2, y2] = to2(B);
  return { shape: { k: 'cyl', x1, y1, x2, y2, r: face.radius! }, depth: depth(A), p3: [A, B], faces: [face.key], hole: face.outward === false };
}

/** Whether an entity lies on the side a section keeps (the cut takes away what is in front of the plane). */
function kept(e: { p3: Vec3[] }, f: ViewFrame, eps: number): boolean {
  if (!f.cut) return true;
  const d0 = dot3(f.cut, f.dir);
  return e.p3.every((q) => dot3(q, f.dir) >= d0 - eps);
}

/** Every pickable entity of the drawn parts in a view; in a section, also the corners of the cut faces. */
export function viewEntities(parts: DrawnPart[], f: ViewFrame): ViewEntity[] {
  const out: ViewEntity[] = [];
  for (const part of parts) {
    for (const body of part.bodies) {
      const eps = bodySize(body) * 1e-6;
      const add = (kind: TopoKind, index: number, cut?: 0 | 1) => {
        const g = entityShape(part, body, kind, index, f, cut);
        if (g && (cut !== undefined || kept(g, f, eps))) out.push({ occ: part.occ, body: body.id, kind, index, ...g });
      };
      body.vertices.forEach((_, i) => add('vertex', i));
      body.edges.forEach((_, i) => add('edge', i));
      body.faces.forEach((fc, i) => fc.type === 'cylinder' && add('face', i));
      if (f.cut) body.edges.forEach((e, i) => !isSeam(e) && crossings(part, body, e, f).forEach((_, k) => add('edge', i, k as 0 | 1)));
    }
  }
  return out;
}

// ------------------------------------------------------------ what the paper shows

/**
 * The entities the view draws a line for (visible, and hidden when hidden lines are on):
 * a vertex at an end of a line, an edge along a line or on an arc of the line work, a
 * cylinder with an outline drawn. A pick should be of something on the paper; the corners
 * of a section's cut faces always are.
 */
export function drawnEntities(ents: ViewEntity[], v: DrawView, hidden: boolean): ViewEntity[] {
  const size = max(v.box.x1 - v.box.x0, v.box.y1 - v.box.y0, 1e-9);
  const tol = size * 1e-6;
  const prims: Prim[] = [...v.visible, ...v.tangent, ...v.thin, ...(hidden ? v.hidden : [])];
  const lines = prims.filter((p): p is Extract<Prim, { k: 'line' }> => p.k === 'line');
  const arcs = prims.filter((p): p is Extract<Prim, { k: 'arc' }> => p.k === 'arc');
  const ends: XY[] = [];
  for (const p of prims) {
    if (p.k === 'line') ends.push([p.x1, p.y1], [p.x2, p.y2]);
    else if (p.k === 'arc' && p.a1 - p.a0 < TAU - 1e-9) ends.push([p.cx + p.r * cos(p.a0), p.cy + p.r * sin(p.a0)], [p.cx + p.r * cos(p.a1), p.cy + p.r * sin(p.a1)]);
    else if (p.k === 'poly' && p.pts.length >= 4) ends.push([p.pts[0], p.pts[1]], [p.pts[p.pts.length - 2], p.pts[p.pts.length - 1]]);
  }
  // a line of the line work along a segment, overlapping it by more than a point
  const alongLine = (x1: number, y1: number, x2: number, y2: number) => {
    const l = hypot(x2 - x1, y2 - y1);
    if (!(l > tol)) return false;
    const ux = (x2 - x1) / l, uy = (y2 - y1) / l;
    return lines.some((p) => {
      const off = (x: number, y: number) => abs((x - x1) * uy - (y - y1) * ux);
      if (off(p.x1, p.y1) > tol || off(p.x2, p.y2) > tol) return false;
      const s = (p.x1 - x1) * ux + (p.y1 - y1) * uy, t = (p.x2 - x1) * ux + (p.y2 - y1) * uy;
      return min(max(s, t), l) - max(min(s, t), 0) > tol;
    });
  };
  return ents.filter((e) => {
    const s = e.shape;
    if (e.cut !== undefined) return true;
    switch (s.k) {
      case 'point':
        return ends.some(([x, y]) => hypot(x - s.x, y - s.y) <= tol);
      case 'line':
        return alongLine(s.x1, s.y1, s.x2, s.y2);
      case 'circle':
        return arcs.some((p) => hypot(p.cx - s.cx, p.cy - s.cy) <= tol && abs(p.r - s.r) <= tol);
      case 'cyl':
        return cylOutlines(s).some(([ax, ay, bx, by]) => alongLine(ax, ay, bx, by));
    }
  });
}

/** Points of the line work itself (ends and middles of lines, centres of arcs, corners of cut faces): what a pick that is no model entity snaps to. */
export function viewSnapPoints(v: DrawView, hidden: boolean): XY[] {
  const out: XY[] = [];
  for (const p of [...v.visible, ...v.thin, ...(hidden ? v.hidden : [])]) {
    if (p.k === 'line') out.push([p.x1, p.y1], [p.x2, p.y2], [(p.x1 + p.x2) / 2, (p.y1 + p.y2) / 2]);
    else if (p.k === 'arc') out.push([p.cx, p.cy]);
  }
  for (const c of v.cuts ?? []) for (const l of c.loops) for (let i = 0; i + 1 < l.length; i += 2) out.push([l[i], l[i + 1]]);
  return out;
}

// ------------------------------------------------------------ picking

/** Points of an entity worth snapping to: a vertex, an edge's middle, a circle's centre and quadrants, a cut corner. */
export function entitySnaps(e: ViewEntity): { snap: PickSnap; x: number; y: number }[] {
  const s = e.shape;
  if (s.k === 'point') return [{ snap: e.cut !== undefined ? (`cut${e.cut}` as PickSnap) : 'vertex', x: s.x, y: s.y }];
  // a line's ends too: an edge seen edge-on (a circle) has no vertices there
  if (s.k === 'line') return [{ snap: 'mid', x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 }, { snap: 'end0', x: s.x1, y: s.y1 }, { snap: 'end1', x: s.x2, y: s.y2 }];
  if (s.k === 'circle') {
    const out: { snap: PickSnap; x: number; y: number }[] = [{ snap: 'centre', x: s.cx, y: s.cy }];
    for (let q = 0; q < 4; q++) if (onArc(s, (q * PI) / 2)) out.push({ snap: `q${q}` as PickSnap, x: s.cx + s.r * cos((q * PI) / 2), y: s.cy + s.r * sin((q * PI) / 2) });
    if (s.a1 - s.a0 < TAU - 1e-9) out.push({ snap: 'mid', x: s.cx + s.r * cos((s.a0 + s.a1) / 2), y: s.cy + s.r * sin((s.a0 + s.a1) / 2) });
    return out;
  }
  return [];
}

const onArc = (s: Extract<Shape2, { k: 'circle' }>, a: number) => s.a1 - s.a0 >= TAU - 1e-9 || ccw(s.a0, a) <= s.a1 - s.a0 + 1e-9;

function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return hypot(x - ax - t * dx, y - ay - t * dy);
}

/** The two outlines of a cylinder seen side-on. */
export function cylOutlines(s: Extract<Shape2, { k: 'cyl' }>): [number, number, number, number][] {
  const l = hypot(s.x2 - s.x1, s.y2 - s.y1) || 1, nx = -(s.y2 - s.y1) / l, ny = (s.x2 - s.x1) / l;
  return [1, -1].map((g) => [s.x1 + g * s.r * nx, s.y1 + g * s.r * ny, s.x2 + g * s.r * nx, s.y2 + g * s.r * ny]);
}

/** How far a point is from an entity's line work (view units). */
export function curveDistance(s: Shape2, x: number, y: number): number {
  switch (s.k) {
    case 'point':
      return hypot(x - s.x, y - s.y);
    case 'line':
      return segDist(x, y, s.x1, s.y1, s.x2, s.y2);
    case 'circle':
      return onArc(s, atan2(y - s.cy, x - s.cx)) ? abs(hypot(x - s.cx, y - s.cy) - s.r) : Infinity;
    case 'cyl':
      return min(...cylOutlines(s).map(([ax, ay, bx, by]) => segDist(x, y, ax, ay, bx, by)));
  }
}

export interface PickHit {
  e: ViewEntity;
  snap: PickSnap;
  /** The snapped point (a curve pick: the nearest point of the curve). */
  x: number;
  y: number;
}

/**
 * What the pointer is on: a snap point within `tolPoint` (the nearest; at the same place,
 * the entity nearest the viewer), else a line, circle or cylinder outline within
 * `tolCurve` (the nearest; at the same distance, the nearer to the viewer). `points` /
 * `curves` leave either kind out; `accept` narrows the entities.
 */
export function pickAt(ents: ViewEntity[], x: number, y: number, tolPoint: number, tolCurve: number, o: { points?: boolean; curves?: boolean; accept?: (e: ViewEntity, snap: PickSnap) => boolean } = {}): PickHit | null {
  let best: PickHit | null = null, bd = Infinity, bz = Infinity;
  const ok = (e: ViewEntity, s: PickSnap) => !o.accept || o.accept(e, s);
  if (o.points !== false) {
    for (const e of ents) {
      for (const s of entitySnaps(e)) {
        const d = hypot(s.x - x, s.y - y);
        if (d > tolPoint || !ok(e, s.snap)) continue;
        if (d < bd - tolPoint * 1e-3 || (d < bd + tolPoint * 1e-3 && e.depth < bz)) [best, bd, bz] = [{ e, snap: s.snap, x: s.x, y: s.y }, d, e.depth];
      }
    }
    if (best) return best;
  }
  if (o.curves === false) return null;
  for (const e of ents) {
    if (e.shape.k === 'point') continue;
    const snap: PickSnap = e.shape.k === 'line' ? 'line' : e.shape.k === 'circle' ? 'circle' : 'cyl';
    const d = curveDistance(e.shape, x, y);
    if (d > tolCurve || !ok(e, snap)) continue;
    if (d < bd - tolCurve * 1e-3 || (d < bd + tolCurve * 1e-3 && e.depth < bz)) [best, bd, bz] = [{ e, snap, x, y }, d, e.depth];
  }
  return best;
}

/** A pick of what the pointer hit: the entity by its persistent name and what of it. */
export function pickOf(hit: PickHit, parts: DrawnPart[]): DrawPick {
  const part = parts.find((p) => p.occ === hit.e.occ)!;
  const body = part.bodies.find((b) => b.id === hit.e.body)!;
  const ent = hit.e.kind === 'vertex' ? body.vertices[hit.e.index] : hit.e.kind === 'edge' ? body.edges[hit.e.index] : body.faces[hit.e.index];
  const shape = snapShape(hit.e.shape, hit.snap) ?? { k: 'point', x: hit.x, y: hit.y };
  return { occ: hit.e.occ, ref: refTo(hit.e.kind, body.id, ent), snap: hit.snap, shape };
}

/** A fixed point of a view (line work that is not a model entity). */
export const freePick = (x: number, y: number): DrawPick => ({ snap: 'free', shape: { k: 'point', x, y } });

/** The paper shape a snap takes of an entity's: its point, or the whole curve. */
function snapShape(s: Shape2, snap: PickSnap | 'free'): Shape2 | null {
  if (snap === 'line') return s.k === 'line' ? s : null;
  if (snap === 'circle') return s.k === 'circle' ? s : null;
  if (snap === 'cyl') return s.k === 'cyl' ? s : null;
  if (snap === 'vertex' || snap === 'cut0' || snap === 'cut1') return s.k === 'point' ? s : null;
  if (snap === 'end0' || snap === 'end1') return s.k === 'line' ? (snap === 'end0' ? { k: 'point', x: s.x1, y: s.y1 } : { k: 'point', x: s.x2, y: s.y2 }) : null;
  if (snap === 'mid') {
    if (s.k === 'line') return { k: 'point', x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
    if (s.k === 'circle') return { k: 'point', x: s.cx + s.r * cos((s.a0 + s.a1) / 2), y: s.cy + s.r * sin((s.a0 + s.a1) / 2) };
    return null;
  }
  if (s.k !== 'circle') return null;
  if (snap === 'centre') return { k: 'point', x: s.cx, y: s.cy };
  const q = Number(snap.slice(1));
  return { k: 'point', x: s.cx + s.r * cos((q * PI) / 2), y: s.cy + s.r * sin((q * PI) / 2) };
}

// ------------------------------------------------------------ following the model

export type Resolved =
  | { ok: true; shape: Shape2; /** True 3-D points where the pick is one (a vertex, a line's ends). */ p3?: Vec3[]; e?: ViewEntity }
  | { ok: false; why: string };

/**
 * Where a pick is now: its entity found again by name (or, from the mesh kernel, where it
 * was) on the occurrence as built, seen in the view. Lost when the occurrence, the entity
 * or the way the view sees it (a circle now seen at an angle) is gone. A point of the
 * line work that is no model entity is checked against the view's line work (`snaps`):
 * lost when nothing is there any more.
 */
export function resolvePick(pick: DrawPick, parts: DrawnPart[], f: ViewFrame, snaps?: XY[]): Resolved {
  if (pick.snap === 'free' || !pick.ref) {
    if (snaps && pick.shape.k === 'point') {
      const { x, y } = pick.shape;
      const size = max(1e-9, ...snaps.map(([a, b]) => max(abs(a), abs(b))));
      if (!snaps.some(([a, b]) => hypot(a - x, b - y) <= size * 1e-6)) return { ok: false, why: 'the line work it was on has moved' };
    }
    return { ok: true, shape: pick.shape };
  }
  const part = parts.find((p) => p.occ === pick.occ);
  if (!part) return { ok: false, why: 'its part is not drawn any more' };
  const r = resolveRef(pick.ref, part.bodies as BodyTopology[]);
  if (!r.ok) return { ok: false, why: `the ${pick.ref.kind} it was on is gone` };
  const body = part.bodies.find((b) => b.id === r.body)!;
  const cut = pick.snap === 'cut0' ? 0 : pick.snap === 'cut1' ? 1 : undefined;
  const g = entityShape(part, body, pick.ref.kind, r.index, f, cut);
  const shape = g && snapShape(g.shape, pick.snap);
  if (!g || !shape) return { ok: false, why: cut !== undefined ? 'its edge no longer goes through the cutting plane' : `the view no longer shows its ${pick.ref.kind} that way` };
  const e: ViewEntity = { occ: part.occ, body: body.id, kind: pick.ref.kind, index: r.index, ...g };
  const p3 = pick.snap === 'vertex' || pick.snap === 'line' || cut !== undefined ? g.p3 : pick.snap === 'centre' || pick.snap === 'end0' ? g.p3.slice(0, 1) : pick.snap === 'end1' ? g.p3.slice(1, 2)
    : pick.snap === 'mid' && g.shape.k === 'line' && g.p3.length === 2 ? [scale3(add3(g.p3[0], g.p3[1]), 0.5)] : undefined;
  return { ok: true, shape, e, ...(p3 ? { p3 } : {}) };
}

// ------------------------------------------------------------ measuring

/** A linear measure: the two points it runs between, the direction measured along (unit) and the value. */
export interface LinearMeasure {
  p1: XY;
  p2: XY;
  u: XY;
  value: number;
}

const pointOf = (s: Shape2): XY | null => (s.k === 'point' ? [s.x, s.y] : null);

/** The foot of a point on the infinite line through a segment. */
function foot(p: XY, s: { x1: number; y1: number; x2: number; y2: number }): XY {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - s.x1) * dx + (p[1] - s.y1) * dy) / l2;
  return [s.x1 + t * dx, s.y1 + t * dy];
}

const unit = (x: number, y: number): XY => {
  const l = hypot(x, y) || 1;
  return [x / l, y / l];
};

/** What a curve stands for in a measure between two picks: a circle its centre, a cylinder its axis. */
function measured(s: Shape2): Shape2 {
  if (s.k === 'circle') return { k: 'point', x: s.cx, y: s.cy };
  if (s.k === 'cyl') return { k: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
  return s;
}

/**
 * A linear dimension between what two picks are (a point and a point, a line alone, a
 * point and a line, two parallel lines; a circle counts as its centre and a cylinder as
 * its axis) or across a cylinder seen side-on: horizontal, vertical or aligned, as the
 * paper has it (a pictorial view's true lengths: measureTrue).
 */
export function measureLinear(a0: Shape2, b0: Shape2 | undefined, orient: DimAnnotation['orient'], text: XY): LinearMeasure | null {
  if (a0.k === 'cyl' && !b0) {
    // across the outlines, square to the axis, where the text is along it (within the face)
    const a = a0;
    const ax = unit(a.x2 - a.x1, a.y2 - a.y1), n: XY = [-ax[1], ax[0]];
    const L = hypot(a.x2 - a.x1, a.y2 - a.y1);
    const t = max(0, min(L, (text[0] - a.x1) * ax[0] + (text[1] - a.y1) * ax[1]));
    const c: XY = [a.x1 + ax[0] * t, a.y1 + ax[1] * t];
    return { p1: [c[0] + n[0] * a.r, c[1] + n[1] * a.r], p2: [c[0] - n[0] * a.r, c[1] - n[1] * a.r], u: n, value: 2 * a.r };
  }
  if (a0.k === 'circle' && !b0) return null;
  const a = b0 ? measured(a0) : a0, b = b0 && measured(b0);
  if (a.k === 'line' && b?.k === 'line') {
    const d1 = unit(a.x2 - a.x1, a.y2 - a.y1), d2 = unit(b.x2 - b.x1, b.y2 - b.y1);
    if (abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-6) return null;
    // across both where they lie side by side, as near the text as that allows
    const along = (x: number, y: number) => (x - a.x1) * d1[0] + (y - a.y1) * d1[1];
    const [sa0, sa1] = [0, along(a.x2, a.y2)].sort((p, q) => p - q), [sb0, sb1] = [along(b.x1, b.y1), along(b.x2, b.y2)].sort((p, q) => p - q);
    const lo = max(sa0, sb0), hi = min(sa1, sb1), want = along(text[0], text[1]);
    const t = lo <= hi ? max(lo, min(hi, want)) : max(sa0, min(sa1, (sb0 + sb1) / 2));
    const p1: XY = [a.x1 + d1[0] * t, a.y1 + d1[1] * t], p2 = foot(p1, b);
    const value = hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (!(value > 1e-12)) return null;
    return { p1, p2, u: unit(p2[0] - p1[0], p2[1] - p1[1]), value };
  }
  if (a.k === 'line' && b?.k === 'point') {
    const m = measureLinear(b, a, orient, text);
    return m && { ...m, p1: m.p2, p2: m.p1, u: [-m.u[0], -m.u[1]] };
  }
  if (a.k === 'point' && b?.k === 'line') {
    const p1: XY = [a.x, a.y], p2 = foot(p1, b);
    const d = hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (d < 1e-12) return null;
    return { p1, p2, u: unit(p2[0] - p1[0], p2[1] - p1[1]), value: d };
  }
  let p1: XY | null, p2: XY | null;
  if (a.k === 'line' && !b) {
    p1 = [a.x1, a.y1];
    p2 = [a.x2, a.y2];
  } else {
    p1 = pointOf(a);
    p2 = b ? pointOf(b) : null;
  }
  if (!p1 || !p2) return null;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  if (orient === 'h') return abs(dx) > 1e-12 ? { p1, p2, u: [1, 0], value: abs(dx) } : null;
  if (orient === 'v') return abs(dy) > 1e-12 ? { p1, p2, u: [0, 1], value: abs(dy) } : null;
  const value = hypot(dx, dy);
  if (!(value > 0)) return null;
  return { p1, p2, u: unit(dx, dy), value };
}

/** A pick with its places in space where it has them (resolvePick). */
type Placed = { shape: Shape2; p3?: Vec3[] };

/**
 * A linear dimension measured in space, for a pictorial view (it foreshortens every
 * direction, so nothing on its paper is true length): between two model points, along an
 * edge, from a point square to an edge, or between two parallel edges, drawn between
 * where those places are on the paper (the projection is affine: a point a fraction along
 * an edge in space is that fraction along it on the paper). Null when a pick has no place
 * in space (line work that is no model entity, a circle seen at an angle).
 */
export function measureTrue(a: Placed, b: Placed | undefined, text: XY): LinearMeasure | null {
  const point = (q: Placed) => (q.shape.k === 'point' && q.p3?.length === 1 ? q.p3[0] : null);
  const edge = (q: Placed) => (q.shape.k === 'line' && q.p3?.length === 2 ? q.p3 : null);
  const done = (p1: XY, p2: XY, value: number): LinearMeasure | null =>
    value > 1e-12 && hypot(p2[0] - p1[0], p2[1] - p1[1]) > 1e-12 ? { p1, p2, u: unit(p2[0] - p1[0], p2[1] - p1[1]), value } : null;
  // the foot of a point on an edge's line, in space and on the paper
  const footOn = (P: Vec3, s: Extract<Shape2, { k: 'line' }>, L: Vec3[]): { F: Vec3; f: XY } => {
    const d = sub3(L[1], L[0]), t = dot3(sub3(P, L[0]), d) / (dot3(d, d) || 1);
    return { F: add3(L[0], scale3(d, t)), f: [s.x1 + t * (s.x2 - s.x1), s.y1 + t * (s.y2 - s.y1)] };
  };
  const at = (q: Placed): XY => (q.shape.k === 'point' ? [q.shape.x, q.shape.y] : [0, 0]);
  const Pa = point(a), La = edge(a);
  if (!b) return La && a.shape.k === 'line' ? done([a.shape.x1, a.shape.y1], [a.shape.x2, a.shape.y2], len3(sub3(La[1], La[0]))) : null;
  const Pb = point(b), Lb = edge(b);
  if (Pa && Pb) return done(at(a), at(b), len3(sub3(Pb, Pa)));
  if (La && Pb) {
    const m = measureTrue(b, a, text);
    return m && { ...m, p1: m.p2, p2: m.p1, u: [-m.u[0], -m.u[1]] };
  }
  if (Pa && Lb && b.shape.k === 'line') {
    const { F, f } = footOn(Pa, b.shape, Lb);
    return done(at(a), f, len3(sub3(F, Pa)));
  }
  if (La && Lb && a.shape.k === 'line' && b.shape.k === 'line') {
    if (len3(cross3(norm3(sub3(La[1], La[0])), norm3(sub3(Lb[1], Lb[0])))) > 1e-6) return null;
    // where the paper's measure stands along the first edge, the same fraction along it in space
    const m = measureLinear(a.shape, b.shape, 'aligned', text);
    if (!m) return null;
    const s = a.shape, l2 = (s.x2 - s.x1) ** 2 + (s.y2 - s.y1) ** 2 || 1;
    const t = ((m.p1[0] - s.x1) * (s.x2 - s.x1) + (m.p1[1] - s.y1) * (s.y2 - s.y1)) / l2;
    const P = add3(La[0], scale3(sub3(La[1], La[0]), t));
    const { F, f } = footOn(P, b.shape, Lb);
    return done(m.p1, f, len3(sub3(F, P)));
  }
  return null;
}

/**
 * The angle in space between two edges (a pictorial view), on the sides of their crossing
 * the angle on the paper (`m`, measureAngle) takes: each edge's direction turned to point
 * the way its ray on the paper does.
 */
function trueAngle(a: Placed, b: Placed, m: { r1: XY; r2: XY }): number | null {
  if (a.shape.k !== 'line' || b.shape.k !== 'line' || a.p3?.length !== 2 || b.p3?.length !== 2) return null;
  const way = (s: Extract<Shape2, { k: 'line' }>, r: XY) => Math.sign((s.x2 - s.x1) * r[0] + (s.y2 - s.y1) * r[1]) || 1;
  const u1 = scale3(norm3(sub3(a.p3[1], a.p3[0])), way(a.shape, m.r1)), u2 = scale3(norm3(sub3(b.p3[1], b.p3[0])), way(b.shape, m.r2));
  return acos(max(-1, min(1, dot3(u1, u2))));
}

/**
 * Which way a dimension between two points reads when its text is put at `text`: beside
 * them (left or right of both) vertical, above or below both horizontal, between them aligned.
 */
export function inferOrient(p1: XY, p2: XY, text: XY): 'h' | 'v' | 'aligned' {
  const [x0, x1] = [min(p1[0], p2[0]), max(p1[0], p2[0])], [y0, y1] = [min(p1[1], p2[1]), max(p1[1], p2[1])];
  const out = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  const ox = out(text[0], x0, x1), oy = out(text[1], y0, y1);
  // a horizontal or vertical pair is measured along itself
  if (abs(p2[1] - p1[1]) < 1e-9 * (1 + abs(p2[0] - p1[0]))) return 'h';
  if (abs(p2[0] - p1[0]) < 1e-9 * (1 + abs(p2[1] - p1[1]))) return 'v';
  if (ox > 0 && ox >= oy) return 'v';
  if (oy > 0) return 'h';
  return 'aligned';
}

/**
 * An angle between two lines: their crossing, the rays along each (r1 on a, r2 on b)
 * bounding the angle that holds `text`, and the angle (radians), counter-clockwise from r1
 * to r2 (or from r2 to r1 when `flip`).
 */
export function measureAngle(a: Shape2, b: Shape2, text: XY): { V: XY; r1: XY; r2: XY; value: number; flip?: boolean } | null {
  if (a.k !== 'line' || b.k !== 'line') return null;
  const d1 = unit(a.x2 - a.x1, a.y2 - a.y1), d2 = unit(b.x2 - b.x1, b.y2 - b.y1);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (abs(den) < 1e-9) return null;
  // a.p + s d1 = b.p + t d2
  const s = ((b.x1 - a.x1) * d2[1] - (b.y1 - a.y1) * d2[0]) / den;
  const V: XY = [a.x1 + d1[0] * s, a.y1 + d1[1] * s];
  const phi = atan2(text[1] - V[1], text[0] - V[0]);
  for (const g1 of [1, -1]) for (const g2 of [1, -1]) {
    const r1: XY = [g1 * d1[0], g1 * d1[1]], r2: XY = [g2 * d2[0], g2 * d2[1]];
    const a1 = atan2(r1[1], r1[0]), a2 = atan2(r2[1], r2[0]);
    // the sector between the rays, under half a turn, holding the text
    const span = ccw(a1, a2);
    if (span < PI && ccw(a1, phi) <= span) return { V, r1, r2, value: span };
    if (span > PI && ccw(a2, phi) <= TAU - span) return { V, r1, r2, value: TAU - span, flip: true };
  }
  return null;
}

/** The centre of a pick that is round or a point: a circle's centre, the point itself. */
export const centreOf = (s: Shape2): XY | null => (s.k === 'point' ? [s.x, s.y] : s.k === 'circle' ? [s.cx, s.cy] : null);

/**
 * The measured value of a dimension from its picks' shapes (model units; angles in
 * radians), or null when they do not make one. `trueLength` (a pictorial view): lengths
 * and angles measured in space from the picks' places there.
 */
export function dimensionValue(d: DimAnnotation, a: Placed, b: Placed | undefined, trueLength = false): number | null {
  const s = a.shape;
  switch (d.type) {
    case 'radius':
      return s.k === 'circle' ? s.r : null;
    case 'diameter':
      return s.k === 'circle' || s.k === 'cyl' ? 2 * s.r : null;
    case 'arc':
      return s.k === 'circle' && s.a1 - s.a0 < TAU - 1e-9 ? s.r * (s.a1 - s.a0) : null;
    case 'angle': {
      const m = b && measureAngle(s, b.shape, d.text);
      return !m ? null : trueLength ? trueAngle(a, b!, m) : m.value;
    }
    case 'pitch': {
      const p = centreOf(s), c = b && centreOf(b.shape);
      return p && c && hypot(p[0] - c[0], p[1] - c[1]) > 0 ? 2 * hypot(p[0] - c[0], p[1] - c[1]) : null;
    }
    case 'linear':
      return (trueLength ? measureTrue(a, b, d.text) : measureLinear(s, b?.shape, d.orient, d.text))?.value ?? null;
  }
}

// ------------------------------------------------------------ keeping beside the geometry

/**
 * Where a dimension's text goes when its geometry moves from `was` to `now` (the same
 * measure before and after an edit): a linear one keeps its place along the dimension
 * (the fraction between the ends, or its distance past them) and its distance outside the
 * measured points; a round one its angle and its distance outside the circle; an angle its
 * offset from the vertex. Distances off the geometry are multiplied by `ratio` (the old
 * scale of the view over the new one, so they stay the same on the paper).
 */
export function followText(d: DimAnnotation, was: { a: Shape2; b?: Shape2 }, now: { a: Shape2; b?: Shape2 }, ratio = 1): XY {
  const T = d.text;
  if (d.type === 'linear') {
    const mo = measureLinear(was.a, was.b, d.orient, T), mn = measureLinear(now.a, now.b, d.orient, T);
    if (!mo || !mn) return T;
    const dot = (p: XY, u: XY) => p[0] * u[0] + p[1] * u[1];
    // the measured direction keeps its sense (an aligned one may turn a little)
    const u1: XY = dot(mn.u, mo.u) < 0 ? [-mn.u[0], -mn.u[1]] : mn.u;
    const n0: XY = [-mo.u[1], mo.u[0]], n1: XY = [-u1[1], u1[0]];
    // along the dimension
    const a0 = dot(mo.p1, mo.u), L0 = dot(mo.p2, mo.u) - a0, t = dot(T, mo.u) - a0;
    const a1 = dot(mn.p1, u1), L1 = dot(mn.p2, u1) - a1;
    const [lo0, hi0] = [min(0, L0), max(0, L0)], [lo1, hi1] = [min(0, L1), max(0, L1)];
    const along = t < lo0 ? lo1 - (lo0 - t) * ratio : t > hi0 ? hi1 + (t - hi0) * ratio : abs(L0) > 1e-12 ? (t / L0) * L1 : t;
    // across it: beyond the outermost measured point on the text's side
    const c = dot(T, n0), c0 = [dot(mo.p1, n0), dot(mo.p2, n0)], c1 = [dot(mn.p1, n1), dot(mn.p2, n1)];
    const across = c >= max(...c0) ? max(...c1) + (c - max(...c0)) * ratio : c <= min(...c0) ? min(...c1) - (min(...c0) - c) * ratio : c - c0[0] + c1[0];
    return [u1[0] * (a1 + along) + n1[0] * across, u1[1] * (a1 + along) + n1[1] * across];
  }
  if (d.type === 'angle') {
    const mo = was.b && measureAngle(was.a, was.b, T), mn = now.b && measureAngle(now.a, now.b, T);
    return mo && mn ? [mn.V[0] + (T[0] - mo.V[0]) * ratio, mn.V[1] + (T[1] - mo.V[1]) * ratio] : T;
  }
  // round: about the circle's centre (a pitch circle's: the centre picked)
  const ring = (g: { a: Shape2; b?: Shape2 }): { c: XY; r: number } | null => {
    if (d.type === 'pitch') {
      const p = centreOf(g.a), c = g.b && centreOf(g.b);
      return p && c ? { c, r: hypot(p[0] - c[0], p[1] - c[1]) } : null;
    }
    if (g.a.k === 'circle') return { c: [g.a.cx, g.a.cy], r: g.a.r };
    return null;
  };
  const ro = ring(was), rn = ring(now);
  if (!ro || !rn) {
    // a cylinder's Ø: along with its axis
    if (was.a.k === 'cyl' && now.a.k === 'cyl') return followPoint(was.a, now.a, T, ratio);
    return T;
  }
  const v: XY = [T[0] - ro.c[0], T[1] - ro.c[1]], l = hypot(v[0], v[1]);
  if (!(l > 0)) return [rn.c[0], rn.c[1]];
  const k = max(0, (l - ro.r) * ratio + rn.r) / l;
  return [rn.c[0] + v[0] * k, rn.c[1] + v[1] * k];
}

/**
 * Where a leader meets a pick's geometry from a point `p`: a point itself, the nearest
 * point of a line (and how far along it), a circle where the direction to `p` crosses it,
 * the nearer outline of a cylinder.
 */
export function anchorOn(s: Shape2, p: XY): { at: XY; t: number; side?: number } {
  switch (s.k) {
    case 'point':
      return { at: [s.x, s.y], t: 0 };
    case 'line': {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1, l2 = dx * dx + dy * dy || 1;
      const t = max(0, min(1, ((p[0] - s.x1) * dx + (p[1] - s.y1) * dy) / l2));
      return { at: [s.x1 + t * dx, s.y1 + t * dy], t };
    }
    case 'circle': {
      let a = atan2(p[1] - s.cy, p[0] - s.cx);
      // an arc's leader stays on the arc
      if (!onArc(s, a)) a = ccw(s.a1, a) < ccw(a, s.a0) ? s.a1 : s.a0;
      return { at: [s.cx + s.r * cos(a), s.cy + s.r * sin(a)], t: a };
    }
    case 'cyl': {
      const outs = cylOutlines(s);
      const ds = outs.map(([ax, ay, bx, by]) => segDist(p[0], p[1], ax, ay, bx, by));
      const side = ds[0] <= ds[1] ? 0 : 1;
      const [x1, y1, x2, y2] = outs[side];
      const r = anchorOn({ k: 'line', x1, y1, x2, y2 }, p);
      return { ...r, side };
    }
  }
}

/** The same place on a pick's geometry after it moved: a line's point at the same fraction, a circle's at the same angle. */
export function anchorAgain(s: Shape2, a: { t: number; side?: number }): XY {
  switch (s.k) {
    case 'point':
      return [s.x, s.y];
    case 'line':
      return [s.x1 + a.t * (s.x2 - s.x1), s.y1 + a.t * (s.y2 - s.y1)];
    case 'circle':
      return [s.cx + s.r * cos(a.t), s.cy + s.r * sin(a.t)];
    case 'cyl': {
      const [x1, y1, x2, y2] = cylOutlines(s)[a.side ?? 0];
      return [x1 + a.t * (x2 - x1), y1 + a.t * (y2 - y1)];
    }
  }
}

/** A point placed by a pick (a leader's text, a symbol) moved with the place it points at, its offset from there times `ratio`. */
export function followPoint(was: Shape2, now: Shape2, p: XY, ratio = 1): XY {
  if (was.k !== now.k) return p;
  const a = anchorOn(was, p), b = anchorAgain(now, a);
  return [b[0] + (p[0] - a.at[0]) * ratio, b[1] + (p[1] - a.at[1]) * ratio];
}
