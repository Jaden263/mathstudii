// Closed profiles of a CAD sketch and their exact area properties.
//
// Loops are found from topology: edges meet at shared points (or points joined by a
// coincident constraint, or points that the solver put on top of each other). Every
// loop is integrated exactly with Green's theorem: arcs and ellipses use Gauss–Legendre
// quadrature on short pieces, which is exact to rounding for these smooth integrands, and
// B-splines span by span, where they are polynomials (so the quadrature is exact).
import type { SectionProps } from '../engine/geometry';
import type { CadSketch, CadPoint } from './model';
import { bsBreaks, bsDomain, bsEval, bsReverse, ellipseDeriv, ellipsePoint, piecesFor } from './curves';
import { entityEnds, entityLoops, entitySegs } from './sketchCurves';

export interface Vec2 {
  x: number;
  y: number;
}

export type Seg =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  /** Arc around c with radius r from angle a0 to a1 (a1 < a0 runs clockwise). */
  | { kind: 'arc'; c: Vec2; r: number; a0: number; a1: number }
  /** Elliptical arc about c, semi-axis ra along the angle rot and rb across it, parameter t0 to t1 (t1 < t0 runs clockwise). */
  | { kind: 'ellipse'; c: Vec2; ra: number; rb: number; rot: number; t0: number; t1: number }
  /** A clamped B-spline (curves.ts), run over its knots' domain. */
  | { kind: 'bspline'; deg: number; poles: Vec2[]; knots: number[] };

/** A closed boundary, counter-clockwise. */
export interface Loop {
  segs: Seg[];
  /** Entity ids along the loop. */
  entities: string[];
}

export interface ProfileRegion {
  outer: Loop;
  holes: Loop[];
}

export interface ProfileResult {
  regions: ProfileRegion[];
  /** Problems that keep part of the sketch out of the profile. */
  issues: string[];
}

// ------------------------------------------------------------ segment helpers

const bsAt = (s: Extract<Seg, { kind: 'bspline' }>, t: number) => {
  const [u0, u1] = bsDomain(s);
  return u0 + (u1 - u0) * t;
};

export function segPoint(s: Seg, t: number): Vec2 {
  switch (s.kind) {
    case 'line': return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
    case 'arc': {
      const a = s.a0 + (s.a1 - s.a0) * t;
      return { x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) };
    }
    case 'ellipse': return ellipsePoint(s, s.t0 + (s.t1 - s.t0) * t);
    case 'bspline': {
      // the ends are the end poles exactly, so loops close on them
      if (t <= 0) return s.poles[0];
      if (t >= 1) return s.poles[s.poles.length - 1];
      return bsEval(s, bsAt(s, t))[0];
    }
  }
}

/** d/dt of segPoint. */
export function segDeriv(s: Seg, t: number): Vec2 {
  switch (s.kind) {
    case 'line': return { x: s.b.x - s.a.x, y: s.b.y - s.a.y };
    case 'arc': {
      const a = s.a0 + (s.a1 - s.a0) * t;
      const k = (s.a1 - s.a0) * s.r;
      return { x: -k * Math.sin(a), y: k * Math.cos(a) };
    }
    case 'ellipse': {
      const d = ellipseDeriv(s, s.t0 + (s.t1 - s.t0) * t), k = s.t1 - s.t0;
      return { x: d.x * k, y: d.y * k };
    }
    case 'bspline': {
      const [u0, u1] = bsDomain(s);
      const d = bsEval(s, bsAt(s, t), 1)[1];
      return { x: d.x * (u1 - u0), y: d.y * (u1 - u0) };
    }
  }
}

export function reverseSeg(s: Seg): Seg {
  switch (s.kind) {
    case 'line': return { kind: 'line', a: s.b, b: s.a };
    case 'arc': return { ...s, a0: s.a1, a1: s.a0 };
    case 'ellipse': return { ...s, t0: s.t1, t1: s.t0 };
    case 'bspline': return { kind: 'bspline', ...bsReverse(s) };
  }
}

/**
 * Where a segment is cut into pieces for quadrature and polylines (t in [0, 1]): arcs and
 * ellipses every 22.5° at most, B-splines at their knots (and arcs and ellipses longer
 * than `step` radians into more pieces when asked for).
 */
export function segBreaks(s: Seg, step = Math.PI / 8): number[] {
  if (s.kind === 'line') return [0, 1];
  if (s.kind === 'bspline') {
    const [u0, u1] = bsDomain(s);
    return bsBreaks(s).map((u) => (u - u0) / (u1 - u0));
  }
  const n = piecesFor(s.kind === 'arc' ? s.a1 - s.a0 : s.t1 - s.t0, step);
  return Array.from({ length: n + 1 }, (_, i) => i / n);
}

/** Polyline of a loop; curves get a vertex at least every maxStep radians of turning. Closing vertex omitted. */
export function loopPolygon(loop: Loop, maxStep = Math.PI / 90): Vec2[] {
  const out: Vec2[] = [];
  for (const s of loop.segs) out.push(...segPolyline(s, maxStep).slice(0, -1));
  return out;
}

/** Points along a segment from its start to its end, the tangent turning at most maxStep between them. */
export function segPolyline(s: Seg, maxStep = Math.PI / 90): Vec2[] {
  if (s.kind === 'line') return [s.a, s.b];
  if (s.kind === 'arc' || s.kind === 'ellipse') {
    // an ellipse turns fastest at the ends of its major axis: step by the parameter, finer by its eccentricity
    const sweep = s.kind === 'arc' ? s.a1 - s.a0 : s.t1 - s.t0;
    const k = s.kind === 'ellipse' ? Math.max(s.ra, s.rb) / Math.max(Math.min(s.ra, s.rb), 1e-12) : 1;
    const n = piecesFor(sweep * Math.min(k, 50), maxStep);
    return Array.from({ length: n + 1 }, (_, i) => segPoint(s, i / n));
  }
  const br = segBreaks(s);
  const out: Vec2[] = [segPoint(s, 0)];
  for (let k = 0; k + 1 < br.length; k++) {
    // the turning on this span from eight samples of the tangent
    let turn = 0, prev: Vec2 | null = null;
    for (let j = 0; j <= 8; j++) {
      const d = segDeriv(s, br[k] + ((br[k + 1] - br[k]) * j) / 8);
      if (prev && (d.x || d.y)) turn += Math.abs(Math.atan2(prev.x * d.y - prev.y * d.x, prev.x * d.x + prev.y * d.y));
      if (d.x || d.y) prev = d;
    }
    const n = Math.max(4, piecesFor(turn, maxStep));
    for (let i = 1; i <= n; i++) out.push(segPoint(s, br[k] + ((br[k + 1] - br[k]) * i) / n));
  }
  return out;
}

// ------------------------------------------------------------ boundary integrals

// 16-point Gauss–Legendre on [0, 1]
const GL_X = [-0.9894009349916499, -0.9445750230732326, -0.8656312023878318, -0.755404408355003, -0.6178762444026438, -0.4580167776572274, -0.2816035507792589, -0.0950125098376374];
const GL_W = [0.0271524594117541, 0.0622535239386479, 0.0951585116824928, 0.1246289712555339, 0.1495959888165767, 0.1691565193950025, 0.1826034150449236, 0.1894506104550685];
const NODES: [number, number][] = [];
for (let i = 0; i < 8; i++) {
  NODES.push([(1 + GL_X[i]) / 2, GL_W[i] / 2], [(1 - GL_X[i]) / 2, GL_W[i] / 2]);
}

/** ∮ f(x, y) dy along a segment (pieces of at most 22.5° for arcs and ellipses, knot spans for B-splines). */
function integrateDy(s: Seg, f: (x: number, y: number) => number): number {
  const br = segBreaks(s);
  let sum = 0;
  for (let k = 0; k + 1 < br.length; k++) {
    const h = br[k + 1] - br[k];
    for (const [t0, w] of NODES) {
      const t = br[k] + h * t0;
      const p = segPoint(s, t);
      sum += w * h * f(p.x, p.y) * segDeriv(s, t).y;
    }
  }
  return sum;
}

/** ∫∫ xᵃ yᵇ dA over the area a loop encloses (signed by orientation). */
export function loopMoment(loop: Loop, a: number, b: number): number {
  let sum = 0;
  for (const s of loop.segs) sum += integrateDy(s, (x, y) => (x ** (a + 1) * y ** b) / (a + 1));
  return sum;
}

/** ∫∫ xᵃ yᵇ dA over a set of regions (solid minus holes). */
export function regionMoment(regions: ProfileRegion[], a: number, b: number): number {
  let sum = 0;
  for (const r of regions) {
    sum += loopMoment(r.outer, a, b);
    for (const h of r.holes) sum += loopMoment(h, a, b); // holes run clockwise: negative
  }
  return sum;
}

/** Area properties in the same form as the drawing sections (engine/geometry). */
export function profileProperties(regions: ProfileRegion[]): SectionProps | null {
  if (!regions.length) return null;
  const A = regionMoment(regions, 0, 0);
  if (!(A > 0)) return null;
  const xc = regionMoment(regions, 1, 0) / A;
  const yc = regionMoment(regions, 0, 1) / A;
  const Ix = regionMoment(regions, 0, 2) - A * yc * yc;
  const Iy = regionMoment(regions, 2, 0) - A * xc * xc;
  const Ixyc = regionMoment(regions, 1, 1) - A * xc * yc;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const r of regions) {
    for (const p of loopPolygon(r.outer, Math.PI / 720)) {
      xmin = Math.min(xmin, p.x); xmax = Math.max(xmax, p.x);
      ymin = Math.min(ymin, p.y); ymax = Math.max(ymax, p.y);
    }
  }
  const size = Math.max(xmax - xmin, ymax - ymin, 1e-300);
  const tiny = (v: number, ref: number) => (Math.abs(v) < 1e-12 * ref ? 0 : v);
  const Iref = Math.abs(Ix) + Math.abs(Iy);
  const Ixy = tiny(Ixyc, Iref);
  const avg = (Ix + Iy) / 2;
  const R = Math.hypot((Ix - Iy) / 2, Ixy);
  const theta = tiny((0.5 * Math.atan2(-2 * Ixy, Ix - Iy) * 180) / Math.PI, 1);
  return {
    A, xc: tiny(xc, size), yc: tiny(yc, size), Ix, Iy, Ixy, I1: avg + R, I2: avg - R, theta, J: Ix + Iy,
    Wx: Ix / Math.max(ymax - yc, yc - ymin), Wy: Iy / Math.max(xmax - xc, xc - xmin),
    rx: Math.sqrt(Ix / A), ry: Math.sqrt(Iy / A), xmin, xmax, ymin, ymax,
  };
}

// ------------------------------------------------------------ loop finding

function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

interface Edge {
  id: string;
  a: string;
  b: string;
  seg: Seg; // from node a to node b
}

/**
 * Closed profiles from the sketch's non-construction lines, arcs and circles.
 * `pos` overrides point positions (solver output); defaults to the stored ones.
 */
export function findProfiles(sketch: CadSketch, pos?: Map<string, Vec2>, radii?: Map<string, number>): ProfileResult {
  const P = (id: string): Vec2 => pos?.get(id) ?? (sketch.points.find((p) => p.id === id) as CadPoint);
  const issues: string[] = [];
  const pts = sketch.points.map((p) => ({ id: p.id, ...P(p.id) }));
  let size = 0;
  for (const p of pts) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const eps = 1e-7 * Math.max(size, 1);

  // nodes: points joined by coincident constraints or by position
  const parent = new Map<string, string>(pts.map((p) => [p.id, p.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  for (const c of sketch.constraints) if (c.type === 'coincident' && parent.has(c.refs[0]) && parent.has(c.refs[1])) join(c.refs[0], c.refs[1]);
  const sorted = [...pts].sort((p, q) => p.x - q.x);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x <= eps; j++) {
      if (Math.abs(sorted[j].y - sorted[i].y) <= eps) join(sorted[i].id, sorted[j].id);
    }
  }

  const loops: Loop[] = [];
  const edges: Edge[] = [];
  const R = (id: string) => radii?.get(id);
  let degenerate = 0;
  for (const e of sketch.entities) {
    if (e.construction || e.type === 'point') continue;
    if (e.type === 'line') {
      const a = P(e.p1), b = P(e.p2);
      if (Math.hypot(b.x - a.x, b.y - a.y) <= eps) continue;
      edges.push({ id: e.id, a: find(e.p1), b: find(e.p2), seg: { kind: 'line', a, b } });
      continue;
    }
    // circles, ellipses, closed splines and text close by themselves; the rest run end to end
    const own = entityLoops(e, P, R);
    if (own) {
      for (const l of own) if (l.segs.length > 1 || segBreaks(l.segs[0]).length > 1) loops.push(l);
      if (!own.length && e.type !== 'text') degenerate++;
      continue;
    }
    const ends = entityEnds(e);
    const seg = entitySegs(e, P, R)[0];
    if (!ends || !seg) {
      degenerate++;
      continue;
    }
    edges.push({ id: e.id, a: find(ends[0]), b: find(ends[1]), seg });
  }
  if (degenerate) issues.push(`${degenerate} curve${degenerate > 1 ? 's have' : ' has'} no size (two of its points on one spot)`);

  // walk loops through nodes of degree 2
  const at = new Map<string, Edge[]>();
  for (const e of edges) {
    at.set(e.a, [...(at.get(e.a) ?? []), e]);
    at.set(e.b, [...(at.get(e.b) ?? []), e]);
  }
  const used = new Set<string>();
  const nodePos = (node: string) => {
    const p = pts.find((q) => find(q.id) === node)!;
    return `(${+p.x.toPrecision(4)}, ${+p.y.toPrecision(4)})`;
  };
  let open = 0, branching = 0;
  for (const start of edges) {
    if (used.has(start.id)) continue;
    const segs: Seg[] = [];
    const ids: string[] = [];
    let ok = true;
    let node = start.a;
    let edge: Edge | undefined = start;
    const visited: Edge[] = [];
    while (edge && !used.has(edge.id)) {
      used.add(edge.id);
      visited.push(edge);
      const forward = edge.a === node;
      segs.push(forward ? edge.seg : reverseSeg(edge.seg));
      ids.push(edge.id);
      node = forward ? edge.b : edge.a;
      const next: Edge[] = (at.get(node) ?? []).filter((e) => e !== edge);
      if (next.length !== 1) {
        ok = false;
        if (next.length === 0) open++;
        else {
          branching++;
          if (branching === 1) issues.push(`More than two edges meet at ${nodePos(node)}, so that outline is not a profile`);
        }
        break;
      }
      edge = next[0];
      if (edge === start) break;
    }
    if (!ok || node !== start.a) {
      // mark the rest of this chain used so it is reported once
      const stack = [...visited];
      while (stack.length) {
        const e = stack.pop()!;
        for (const n of [e.a, e.b]) for (const f of at.get(n) ?? []) if (!used.has(f.id)) { used.add(f.id); stack.push(f); }
      }
      if (ok) open++;
      continue;
    }
    loops.push({ segs, entities: ids });
  }
  if (open) issues.push(`${open} outline${open > 1 ? 's are' : ' is'} not closed`);

  // orient counter-clockwise, then nest: even depth = solid, odd = hole
  const polys = loops.map((l) => {
    if (loopMoment(l, 0, 0) < 0) {
      l.segs = l.segs.map(reverseSeg).reverse();
      l.entities.reverse();
    }
    return loopPolygon(l, Math.PI / 36);
  });
  const areas = loops.map((l) => loopMoment(l, 0, 0));
  const parentOf = loops.map((_, i) => {
    let best = -1;
    for (let j = 0; j < loops.length; j++) {
      if (j === i || areas[j] <= areas[i]) continue;
      const probe = segPoint(loops[i].segs[0], 0.5);
      if (pointInPolygon(probe, polys[j]) && (best < 0 || areas[j] < areas[best])) best = j;
    }
    return best;
  });
  const depth = (i: number): number => (parentOf[i] < 0 ? 0 : 1 + depth(parentOf[i]));
  const regions: ProfileRegion[] = [];
  const regionOf = new Map<number, ProfileRegion>();
  loops.forEach((l, i) => {
    if (depth(i) % 2 === 0) {
      const r = { outer: l, holes: [] as Loop[] };
      regionOf.set(i, r);
      regions.push(r);
    }
  });
  loops.forEach((l, i) => {
    if (depth(i) % 2 === 1) {
      const host = regionOf.get(parentOf[i]);
      host?.holes.push({ segs: l.segs.map(reverseSeg).reverse(), entities: [...l.entities].reverse() });
    }
  });
  return { regions, issues };
}

/**
 * ∫∫ uⁱ wʲ dA in a frame with origin o, u along the unit vector a and w along its
 * left normal (a right-handed frame, so loop orientation is kept).
 */
export function frameMoment(regions: ProfileRegion[], o: Vec2, a: Vec2, i: number, j: number): number {
  let sum = 0;
  const loopSum = (loop: Loop) => {
    for (const s of loop.segs) {
      const br = segBreaks(s);
      for (let k = 0; k + 1 < br.length; k++) {
        const h = br[k + 1] - br[k];
        for (const [t0, wt] of NODES) {
          const t = br[k] + h * t0;
          const p = segPoint(s, t), d = segDeriv(s, t);
          const u = (p.x - o.x) * a.x + (p.y - o.y) * a.y;
          const w = -(p.x - o.x) * a.y + (p.y - o.y) * a.x;
          const dw = -d.x * a.y + d.y * a.x;
          sum += wt * h * ((u ** (i + 1) * w ** j) / (i + 1)) * dw;
        }
      }
    }
  };
  for (const r of regions) {
    loopSum(r.outer);
    r.holes.forEach(loopSum);
  }
  return sum;
}
