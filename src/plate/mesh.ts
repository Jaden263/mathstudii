// Meshes of plates, all four-node quads for the MITC4 element. A rectangle with
// rectangular openings and walls along the axes gets a structured grid (lines through
// every edge, wall, column and support, intervals cut to the size); any other outline is
// triangulated (constrained Delaunay, refined to near-equilateral triangles) and every
// triangle split into three quads at its centroid and edge midpoints, which keeps the
// constraint lines as element edges. Interior nodes are then smoothed. Where the outline is
// a polygon standing for a curve (vertices turning by less than 20°, segments of similar
// length), the boundary nodes between its vertices are moved from the chords onto that
// curve and keep its tangent: a simply supported edge made of straight chords behaves as a
// polygon, whose plate tends to another limit than the circle's (Babuška's paradox: a
// 48-gon came out 27 % too stiff).
import { insidePolygon, polygonArea, segmentDistance, triangulateDomain, type Pt } from './cdt';

export type { Pt };

export interface PlateMesh {
  /** Node coordinates, m. */
  x: Float64Array;
  y: Float64Array;
  /** Four nodes per element, counter-clockwise. */
  quads: Int32Array;
  structured: boolean;
  /** Smallest and largest corner angle of the elements, degrees. */
  minAngle: number;
  maxAngle: number;
  /** Boundary nodes on a curved run of the outline: the curve's unit tangent (2 per node, 0 elsewhere). */
  tangent?: Float64Array;
  /** Where those nodes were on the chord before they moved onto the curve (2 per node, NaN elsewhere). */
  chord?: Float64Array;
}

export interface MeshFeatures {
  /** Outline and openings (any orientation). */
  outline: Pt[];
  openings: Pt[][];
  /** Lines and points the mesh must follow: walls, column heads, point supports. */
  lines: [Pt, Pt][];
  points: Pt[];
  /** Lines and points it should follow where that costs nothing: loads. */
  softLines: [Pt, Pt][];
  softPoints: Pt[];
  /** Element size wanted, m. */
  size: number;
  /** Force the unstructured mesher (tests). */
  unstructured?: boolean;
}

/** The outline without repeated points or collinear vertices, counter-clockwise. */
export function cleanPolygon(poly: Pt[]): Pt[] {
  let p = poly.filter((q, i) => {
    const r = poly[(i + 1) % poly.length];
    return Math.hypot(r[0] - q[0], r[1] - q[1]) > 1e-9;
  });
  p = p.filter((q, i) => {
    const a = p[(i + p.length - 1) % p.length], b = p[(i + 1) % p.length];
    const cross = (q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cross) > 1e-12 * Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2;
  });
  return polygonArea(p) < 0 ? p.reverse() : p;
}

const axisAligned = (a: Pt, b: Pt, tol: number) => Math.abs(a[0] - b[0]) <= tol || Math.abs(a[1] - b[1]) <= tol;
const isRect = (p: Pt[], tol: number) => p.length === 4 && p.every((q, i) => axisAligned(q, p[(i + 1) % 4], tol));

export function meshPlate(f: MeshFeatures): PlateMesh {
  const outline = cleanPolygon(f.outline), openings = f.openings.map(cleanPolygon).filter((h) => h.length >= 3);
  if (outline.length < 3) throw new Error('The outline needs at least three corners');
  const span = Math.max(...outline.map((p) => p[0])) - Math.min(...outline.map((p) => p[0])) + Math.max(...outline.map((p) => p[1])) - Math.min(...outline.map((p) => p[1]));
  if (!(f.size > 0)) throw new Error('The element size must be positive');
  if (span / f.size > 2000) throw new Error('The element size is too small for the plate');
  const tol = 1e-9 * span;
  const structured = !f.unstructured && isRect(outline, tol) && openings.every((h) => isRect(h, tol)) && f.lines.every(([a, b]) => axisAligned(a, b, tol));
  const m = structured ? gridMesh(outline, openings, f, tol) : splitMesh(outline, openings, f);
  const curve = structured ? null : curveBoundary(m, [outline, ...openings], tol * 100);
  return { ...m, structured, ...angles(m.x, m.y, m.quads), ...(curve ?? {}) };
}

/** Turning angle at each vertex of a closed polygon (radians, left positive). */
function turning(p: Pt[]): number[] {
  return p.map((q, k) => {
    const a = p[(k + p.length - 1) % p.length], b = p[(k + 1) % p.length];
    const ux = q[0] - a[0], uy = q[1] - a[1], vx = b[0] - q[0], vy = b[1] - q[1];
    return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  });
}

const SMOOTH_TURN = (20 * Math.PI) / 180;

/**
 * Move the boundary nodes of curved runs from the chords onto the curve (a cubic Hermite
 * between each pair of vertices, tangents along the bisectors), and record its tangent.
 */
function curveBoundary(m: { x: Float64Array; y: Float64Array; quads: Int32Array }, polys: Pt[][], tol: number): { tangent: Float64Array; chord: Float64Array } | null {
  const nn = m.x.length;
  const tangent = new Float64Array(2 * nn), chord = new Float64Array(2 * nn).fill(NaN);
  let any = false;
  const boundary = boundaryNodes(m.x.length, m.quads);
  for (const p of polys) {
    const n = p.length, turn = turning(p);
    const len = p.map((q, k) => Math.hypot(p[(k + 1) % n][0] - q[0], p[(k + 1) % n][1] - q[1]));
    const smooth = turn.map((a) => Math.abs(a) < SMOOTH_TURN);
    // unit tangent at each vertex: the bisector of its two segments
    const tv = p.map((q, k) => {
      const a = p[(k + n - 1) % n], b = p[(k + 1) % n];
      const ux = (q[0] - a[0]) / len[(k + n - 1) % n] + (b[0] - q[0]) / len[k], uy = (q[1] - a[1]) / len[(k + n - 1) % n] + (b[1] - q[1]) / len[k];
      const l = Math.hypot(ux, uy);
      return [ux / l, uy / l] as Pt;
    });
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const curved = smooth[k] && smooth[k1] && len[k] <= 2 * Math.min(len[(k + n - 1) % n], len[k1]);
      if (!curved) continue;
      const A = p[k], B = p[k1], L = len[k], t0 = tv[k], t1 = tv[k1];
      for (const q of boundary) {
        const { d, s } = segmentDistance([m.x[q], m.y[q]], A, B);
        if (d > tol || !Number.isNaN(chord[2 * q])) continue;
        any = true;
        chord[2 * q] = m.x[q];
        chord[2 * q + 1] = m.y[q];
        const h00 = 2 * s ** 3 - 3 * s * s + 1, h10 = s ** 3 - 2 * s * s + s, h01 = -2 * s ** 3 + 3 * s * s, h11 = s ** 3 - s * s;
        const d00 = 6 * s * s - 6 * s, d10 = 3 * s * s - 4 * s + 1, d01 = -6 * s * s + 6 * s, d11 = 3 * s * s - 2 * s;
        m.x[q] = h00 * A[0] + h10 * L * t0[0] + h01 * B[0] + h11 * L * t1[0];
        m.y[q] = h00 * A[1] + h10 * L * t0[1] + h01 * B[1] + h11 * L * t1[1];
        const tx = d00 * A[0] + d10 * L * t0[0] + d01 * B[0] + d11 * L * t1[0], ty = d00 * A[1] + d10 * L * t0[1] + d01 * B[1] + d11 * L * t1[1];
        const tl = Math.hypot(tx, ty);
        tangent[2 * q] = tx / tl;
        tangent[2 * q + 1] = ty / tl;
      }
    }
  }
  return any ? { tangent, chord } : null;
}

/** Nodes on an edge of one element only. */
export function boundaryNodes(nn: number, quads: Int32Array): number[] {
  const edges = new Map<number, number>();
  for (let e = 0; e < quads.length / 4; e++) for (let k = 0; k < 4; k++) {
    const a = quads[4 * e + k], b = quads[4 * e + ((k + 1) % 4)];
    const key = Math.min(a, b) * nn + Math.max(a, b);
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  const out = new Set<number>();
  for (const [key, count] of edges) if (count === 1) out.add(Math.floor(key / nn)).add(key % nn);
  return [...out];
}

// ---------------------------------------------------------------- structured grid

function gridMesh(outline: Pt[], openings: Pt[][], f: MeshFeatures, tol: number) {
  const h = f.size;
  const lines = (c: 0 | 1) => {
    const hard: number[] = [];
    for (const p of [...outline, ...openings.flat(), ...f.lines.flat(), ...f.points]) hard.push(p[c]);
    const lo = Math.min(...outline.map((p) => p[c])), hi = Math.max(...outline.map((p) => p[c]));
    const soft = [...f.softLines.filter(([a, b]) => axisAligned(a, b, tol)).flat(), ...f.softPoints].map((p) => p[c]);
    let at = [...new Set(hard.filter((v) => v >= lo - tol && v <= hi + tol).map((v) => +v.toPrecision(12)))].sort((a, b) => a - b);
    // loads get a line of their own where that leaves no sliver (h/3 from the others)
    for (const v of soft) if (v > lo && v < hi && at.every((q) => Math.abs(q - v) >= h / 3)) at.push(v);
    at = at.sort((a, b) => a - b);
    const out: number[] = [];
    for (let i = 0; i + 1 < at.length; i++) {
      const n = Math.max(1, Math.round((at[i + 1] - at[i]) / h));
      for (let k = 0; k < n; k++) out.push(at[i] + ((at[i + 1] - at[i]) * k) / n);
    }
    out.push(at[at.length - 1]);
    return out;
  };
  const xs = lines(0), ys = lines(1);
  const nx = xs.length, ny = ys.length;
  const id = new Int32Array(nx * ny).fill(-1);
  const x: number[] = [], y: number[] = [], quads: number[] = [];
  const node = (i: number, j: number) => {
    const k = j * nx + i;
    if (id[k] < 0) {
      id[k] = x.length;
      x.push(xs[i]);
      y.push(ys[j]);
    }
    return id[k];
  };
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (openings.some((o) => insidePolygon(cx, cy, o))) continue;
      quads.push(node(i, j), node(i + 1, j), node(i + 1, j + 1), node(i, j + 1));
    }
  }
  return { x: Float64Array.from(x), y: Float64Array.from(y), quads: Int32Array.from(quads) };
}

// ---------------------------------------------------------------- triangles split into quads

function splitMesh(outline: Pt[], openings: Pt[][], f: MeshFeatures) {
  // each triangle becomes three quads; with Ruppert's refinement keeping every edge under
  // the limit the triangles' edges average about half of it, so a limit of 3.6 h gives
  // quads whose sides average h (measured: 0.93 – 0.99 h)
  const tm = triangulateDomain({ outline, openings, lines: [...f.lines, ...f.softLines], points: [...f.points, ...f.softPoints], size: 3.6 * f.size });
  const x = [...tm.x], y = [...tm.y], fixed = [...tm.fixed];
  const mid = new Map<string, number>();
  const midpoint = (a: number, b: number) => {
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    let m = mid.get(k);
    if (m === undefined) {
      m = x.length;
      x.push((x[a] + x[b]) / 2);
      y.push((y[a] + y[b]) / 2);
      fixed.push(tm.constrained.has(k));
      mid.set(k, m);
    }
    return m;
  };
  const quads: number[] = [];
  for (let t = 0; t < tm.tris.length; t += 3) {
    const [a, b, c] = [tm.tris[t], tm.tris[t + 1], tm.tris[t + 2]];
    const g = x.length;
    x.push((x[a] + x[b] + x[c]) / 3);
    y.push((y[a] + y[b] + y[c]) / 3);
    fixed.push(false);
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    quads.push(a, ab, g, ca, b, bc, g, ab, c, ca, g, bc);
  }
  const X = Float64Array.from(x), Y = Float64Array.from(y), Q = Int32Array.from(quads);
  smooth(X, Y, Q, fixed);
  return { x: X, y: Y, quads: Q };
}

/** Corner angles of a quad (degrees), and whether it is strictly convex. */
function quadAngles(x: ArrayLike<number>, y: ArrayLike<number>, q: ArrayLike<number>, e: number): { min: number; max: number; convex: boolean } {
  let min = 180, max = 0, convex = true;
  for (let k = 0; k < 4; k++) {
    const p = q[4 * e + k], a = q[4 * e + ((k + 3) % 4)], b = q[4 * e + ((k + 1) % 4)];
    const ux = x[a] - x[p], uy = y[a] - y[p], vx = x[b] - x[p], vy = y[b] - y[p];
    const cross = vx * uy - vy * ux;
    if (!(cross > 0)) convex = false;
    const ang = (Math.atan2(Math.abs(cross), ux * vx + uy * vy) * 180) / Math.PI;
    min = Math.min(min, ang);
    max = Math.max(max, cross > 0 ? ang : 360 - ang);
  }
  return { min, max, convex };
}

function angles(x: Float64Array, y: Float64Array, q: Int32Array) {
  let minAngle = 180, maxAngle = 0;
  for (let e = 0; e < q.length / 4; e++) {
    const a = quadAngles(x, y, q, e);
    minAngle = Math.min(minAngle, a.min);
    maxAngle = Math.max(maxAngle, a.max);
  }
  return { minAngle, maxAngle };
}

/** Laplacian smoothing of the free nodes; a move that would make a quad worse than 20°–160° is undone. */
function smooth(x: Float64Array, y: Float64Array, q: Int32Array, fixed: boolean[], passes = 4) {
  const n = x.length;
  const nbr: Set<number>[] = Array.from({ length: n }, () => new Set());
  const elems: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < q.length / 4; e++) {
    for (let k = 0; k < 4; k++) {
      const a = q[4 * e + k], b = q[4 * e + ((k + 1) % 4)];
      nbr[a].add(b);
      nbr[b].add(a);
      elems[a].push(e);
    }
  }
  const worst = (p: number) => {
    let w = Infinity;
    for (const e of elems[p]) {
      const a = quadAngles(x, y, q, e);
      if (!a.convex) return -Infinity;
      w = Math.min(w, a.min, 180 - a.max);
    }
    return w;
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let p = 0; p < n; p++) {
      if (fixed[p] || !nbr[p].size) continue;
      let sx = 0, sy = 0;
      for (const r of nbr[p]) {
        sx += x[r];
        sy += y[r];
      }
      const ox = x[p], oy = y[p], before = worst(p);
      x[p] = sx / nbr[p].size;
      y[p] = sy / nbr[p].size;
      if (worst(p) < Math.min(before, 20)) {
        x[p] = ox;
        y[p] = oy;
      }
    }
  }
}

// ---------------------------------------------------------------- finding things in a mesh

/** Nodes on the segment a–b (within tol), sorted along it, with their parameter s (0 … 1). */
export function nodesOnSegment(m: PlateMesh, a: Pt, b: Pt, tol: number): { node: number; s: number }[] {
  const out: { node: number; s: number }[] = [];
  const x0 = Math.min(a[0], b[0]) - tol, x1 = Math.max(a[0], b[0]) + tol, y0 = Math.min(a[1], b[1]) - tol, y1 = Math.max(a[1], b[1]) + tol;
  for (let i = 0; i < m.x.length; i++) {
    // a node moved onto a curve is found where it was on its chord
    const moved = m.chord && !Number.isNaN(m.chord[2 * i]);
    const px = moved ? m.chord![2 * i] : m.x[i], py = moved ? m.chord![2 * i + 1] : m.y[i];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    const { d, s } = segmentDistance([px, py], a, b);
    if (d <= tol) out.push({ node: i, s });
  }
  return out.sort((p, q) => p.s - q.s);
}

/** The node nearest a point. */
export function nearestNode(m: PlateMesh, p: Pt): { node: number; d: number } {
  let best = -1, bd = Infinity;
  for (let i = 0; i < m.x.length; i++) {
    const d = Math.hypot(m.x[i] - p[0], m.y[i] - p[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { node: best, d: bd };
}

/**
 * A uniform grid of buckets over the elements' bounding boxes, to find the element holding
 * a point (section cuts, worksheet functions, loads).
 */
export class ElementIndex {
  private readonly cells: number[][];
  private readonly x0: number;
  private readonly y0: number;
  private readonly cs: number;
  private readonly nx: number;
  private readonly ny: number;

  constructor(readonly m: PlateMesh) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < m.x.length; i++) {
      x0 = Math.min(x0, m.x[i]); x1 = Math.max(x1, m.x[i]);
      y0 = Math.min(y0, m.y[i]); y1 = Math.max(y1, m.y[i]);
    }
    const ne = m.quads.length / 4;
    const cs = Math.max(Math.sqrt(((x1 - x0) * (y1 - y0)) / Math.max(1, ne)) * 1.5, 1e-9);
    this.x0 = x0;
    this.y0 = y0;
    this.cs = cs;
    this.nx = Math.max(1, Math.ceil((x1 - x0) / cs) + 1);
    this.ny = Math.max(1, Math.ceil((y1 - y0) / cs) + 1);
    this.cells = Array.from({ length: this.nx * this.ny }, () => []);
    for (let e = 0; e < ne; e++) {
      let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
      for (let k = 0; k < 4; k++) {
        const n = m.quads[4 * e + k];
        ex0 = Math.min(ex0, m.x[n]); ex1 = Math.max(ex1, m.x[n]);
        ey0 = Math.min(ey0, m.y[n]); ey1 = Math.max(ey1, m.y[n]);
      }
      for (let j = this.cy(ey0); j <= this.cy(ey1); j++) for (let i = this.cx(ex0); i <= this.cx(ex1); i++) this.cells[j * this.nx + i].push(e);
    }
  }

  private cx(x: number) {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cs)));
  }

  private cy(y: number) {
    return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.y0) / this.cs)));
  }

  /** Elements whose bounding box may hold the point. */
  candidates(x: number, y: number): number[] {
    return this.cells[this.cy(y) * this.nx + this.cx(x)];
  }

  /** Elements whose bounding boxes meet the box. */
  inBox(x0: number, y0: number, x1: number, y1: number): number[] {
    const out = new Set<number>();
    for (let j = this.cy(y0); j <= this.cy(y1); j++) for (let i = this.cx(x0); i <= this.cx(x1); i++) for (const e of this.cells[j * this.nx + i]) out.add(e);
    return [...out];
  }
}

/** The corner coordinates of element e (x0, y0, … x3, y3). */
export function elementXY(m: PlateMesh, e: number): Float64Array {
  const xy = new Float64Array(8);
  for (let k = 0; k < 4; k++) {
    const n = m.quads[4 * e + k];
    xy[2 * k] = m.x[n];
    xy[2 * k + 1] = m.y[n];
  }
  return xy;
}
