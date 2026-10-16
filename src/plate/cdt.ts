// Constrained Delaunay triangulation with quality refinement (Ruppert), for meshing plates
// of any outline: points go in one at a time by Lawson flips (no cavity to go wrong in
// floating point), the constraint segments are recovered by splitting them where they are
// missing (a conforming triangulation: each piece is then a Delaunay edge), and bad
// triangles are refined by inserting their circumcentres, or by splitting the segments
// those would encroach on. The result keeps every outline, opening, wall and column edge
// as a chain of triangle edges, with angles of at least about 25° away from sharp input
// corners and edges no longer than the target size.

export type Pt = [number, number];

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** > 0 when d lies inside the circumcircle of the counter-clockwise triangle a, b, c. */
function incircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const adx = ax - dx, ady = ay - dy, bdx = bx - dx, bdy = by - dy, cdx = cx - dx, cdy = cy - dy;
  const ad = adx * adx + ady * ady, bd = bdx * bdx + bdy * bdy, cd = cdx * cdx + cdy * cdy;
  return adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
}

export function circumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): Pt {
  const bx_ = bx - ax, by_ = by - ay, cx_ = cx - ax, cy_ = cy - ay;
  const d = 2 * (bx_ * cy_ - by_ * cx_);
  const b2 = bx_ * bx_ + by_ * by_, c2 = cx_ * cx_ + cy_ * cy_;
  return [ax + (cy_ * b2 - by_ * c2) / d, ay + (bx_ * c2 - cx_ * b2) / d];
}

/** A triangulation with adjacency: triangle t has vertices v[3t..3t+2] (counter-clockwise), edge k from v[k] to v[k+1]. */
export class Triangulation {
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly v: number[] = [];
  /** Neighbour across edge k (−1 at the outer boundary). */
  readonly nb: number[] = [];
  /** Edge k is a constraint segment. */
  readonly con: boolean[] = [];
  /** The triangle lies in the domain (inside the outline, outside the openings). */
  readonly inside: boolean[] = [];
  /** A triangle at each vertex, to start walks and edge searches from. */
  readonly vt: number[] = [];
  /** Triangles changed by the last insertion (for the refinement queue). */
  touched: number[] = [];
  /** Distance below which two points are the same. */
  readonly tol: number;
  private last = 0;
  private seed = 12345;

  constructor(lo: Pt, hi: Pt) {
    const w = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6);
    this.tol = 1e-9 * w;
    // a box well outside the domain holds every point; its triangles are outside
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, r = 4 * w;
    for (const [x, y] of [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]) this.addVertex(x, y);
    this.v.push(0, 1, 2, 0, 2, 3);
    this.nb.push(-1, -1, 1, 0, -1, -1);
    this.con.push(false, false, false, false, false, false);
    this.inside.push(false, false);
    this.vt[0] = 0;
    this.vt[1] = 0;
    this.vt[2] = 0;
    this.vt[3] = 1;
  }

  get triangles(): number {
    return this.v.length / 3;
  }

  private addVertex(x: number, y: number): number {
    this.px.push(x);
    this.py.push(y);
    this.vt.push(-1);
    return this.px.length - 1;
  }

  private rand(n: number): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed % n;
  }

  /** Index (0–2) of the edge of t from a to b, or −1. */
  edgeIndex(t: number, a: number, b: number): number {
    const v = this.v;
    for (let k = 0; k < 3; k++) if (v[3 * t + k] === a && v[3 * t + ((k + 1) % 3)] === b) return k;
    return -1;
  }

  /** Point t2's edge back at t (the one sharing t's edge k). */
  private link(t: number, k: number, t2: number) {
    this.nb[3 * t + k] = t2;
    if (t2 < 0) return;
    const a = this.v[3 * t + k], b = this.v[3 * t + ((k + 1) % 3)];
    const k2 = this.edgeIndex(t2, b, a);
    if (k2 >= 0) this.nb[3 * t2 + k2] = t;
  }

  private setTri(t: number, a: number, b: number, c: number) {
    const v = this.v;
    v[3 * t] = a;
    v[3 * t + 1] = b;
    v[3 * t + 2] = c;
    this.vt[a] = this.vt[b] = this.vt[c] = t;
  }

  private newTri(inside: boolean): number {
    const t = this.triangles;
    this.v.push(0, 0, 0);
    this.nb.push(-1, -1, -1);
    this.con.push(false, false, false);
    this.inside.push(inside);
    return t;
  }

  /**
   * The triangle containing (x, y), by a visibility walk (edges tried in a random order, so
   * it cannot cycle), with the position: inside, on edge k, or at vertex.
   */
  locate(x: number, y: number, start = this.last): { t: number; edge: number; vertex: number } {
    const { px, py, v, nb } = this;
    let t = start >= 0 && start < this.triangles ? start : 0;
    for (let steps = 0; steps < 1e6; steps++) {
      const r = this.rand(3);
      let moved = false;
      for (let q = 0; q < 3; q++) {
        const k = (q + r) % 3;
        const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)];
        if (orient(px[a], py[a], px[b], py[b], x, y) < 0 && nb[3 * t + k] >= 0) {
          // only step when clearly outside this edge (else it is on it)
          const len = Math.hypot(px[b] - px[a], py[b] - py[a]);
          if (orient(px[a], py[a], px[b], py[b], x, y) < -this.tol * len) {
            t = nb[3 * t + k];
            moved = true;
            break;
          }
        }
      }
      if (!moved) break;
    }
    for (let k = 0; k < 3; k++) {
      const a = v[3 * t + k];
      if (Math.hypot(px[a] - x, py[a] - y) <= this.tol) return { t, edge: -1, vertex: a };
    }
    for (let k = 0; k < 3; k++) {
      const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)];
      const len = Math.hypot(px[b] - px[a], py[b] - py[a]);
      if (Math.abs(orient(px[a], py[a], px[b], py[b], x, y)) <= this.tol * len) return { t, edge: k, vertex: -1 };
    }
    return { t, edge: -1, vertex: -1 };
  }

  /** Insert a point and restore the Delaunay property; returns its vertex (an existing one when it is there already). */
  insert(x: number, y: number, start?: number): number {
    const at = this.locate(x, y, start);
    this.touched = [];
    if (at.vertex >= 0) return at.vertex;
    const p = this.addVertex(x, y);
    const stack: [number, number][] = [];
    if (at.edge >= 0) this.splitEdge(at.t, at.edge, p, stack);
    else this.splitTriangle(at.t, p, stack);
    this.legalize(stack);
    this.last = this.vt[p];
    return p;
  }

  private splitTriangle(t: number, p: number, stack: [number, number][]) {
    const { v, nb, con, inside } = this;
    const a = v[3 * t], b = v[3 * t + 1], c = v[3 * t + 2];
    const nab = nb[3 * t], nbc = nb[3 * t + 1], nca = nb[3 * t + 2];
    const cab = con[3 * t], cbc = con[3 * t + 1], cca = con[3 * t + 2];
    const t1 = this.newTri(inside[t]), t2 = this.newTri(inside[t]);
    this.setTri(t, a, b, p);
    this.setTri(t1, b, c, p);
    this.setTri(t2, c, a, p);
    con[3 * t] = cab; con[3 * t + 1] = false; con[3 * t + 2] = false;
    con[3 * t1] = cbc; con[3 * t1 + 1] = false; con[3 * t1 + 2] = false;
    con[3 * t2] = cca; con[3 * t2 + 1] = false; con[3 * t2 + 2] = false;
    this.link(t, 0, nab);
    this.link(t1, 0, nbc);
    this.link(t2, 0, nca);
    nb[3 * t + 1] = t1; nb[3 * t + 2] = t2;
    nb[3 * t1 + 1] = t2; nb[3 * t1 + 2] = t;
    nb[3 * t2 + 1] = t; nb[3 * t2 + 2] = t1;
    this.touched.push(t, t1, t2);
    stack.push([t, 0], [t1, 0], [t2, 0]);
  }

  /** Split the edge k of t (and its neighbour) at p; a constraint stays one in both halves. */
  private splitEdge(t: number, k: number, p: number, stack: [number, number][]) {
    const { v, nb, con, inside } = this;
    const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)], c = v[3 * t + ((k + 2) % 3)];
    const u = nb[3 * t + k], isCon = con[3 * t + k];
    const nbc = nb[3 * t + ((k + 1) % 3)], nca = nb[3 * t + ((k + 2) % 3)];
    const cbc = con[3 * t + ((k + 1) % 3)], cca = con[3 * t + ((k + 2) % 3)];
    const t3 = this.newTri(inside[t]);
    this.setTri(t, a, p, c);
    this.setTri(t3, p, b, c);
    con[3 * t] = isCon; con[3 * t + 1] = false; con[3 * t + 2] = cca;
    con[3 * t3] = isCon; con[3 * t3 + 1] = cbc; con[3 * t3 + 2] = false;
    this.link(t, 2, nca);
    this.link(t3, 1, nbc);
    nb[3 * t + 1] = t3;
    nb[3 * t3 + 2] = t;
    this.touched.push(t, t3);
    stack.push([t, 2], [t3, 1]);
    if (u < 0) {
      nb[3 * t] = -1;
      nb[3 * t3] = -1;
      return;
    }
    const k2 = this.edgeIndex(u, b, a);
    const d = v[3 * u + ((k2 + 2) % 3)];
    const nad = nb[3 * u + ((k2 + 1) % 3)], ndb = nb[3 * u + ((k2 + 2) % 3)];
    const cad = con[3 * u + ((k2 + 1) % 3)], cdb = con[3 * u + ((k2 + 2) % 3)];
    const u3 = this.newTri(inside[u]);
    this.setTri(u, b, p, d);
    this.setTri(u3, p, a, d);
    con[3 * u] = isCon; con[3 * u + 1] = false; con[3 * u + 2] = cdb;
    con[3 * u3] = isCon; con[3 * u3 + 1] = cad; con[3 * u3 + 2] = false;
    this.link(u, 2, ndb);
    this.link(u3, 1, nad);
    nb[3 * u + 1] = u3;
    nb[3 * u3 + 2] = u;
    // across the split edge: t (a, p) faces u3 (p, a); t3 (p, b) faces u (b, p)
    nb[3 * t] = u3; nb[3 * u3] = t;
    nb[3 * t3] = u; nb[3 * u] = t3;
    this.touched.push(u, u3);
    stack.push([u, 2], [u3, 1]);
  }

  /** Flip the edge k of t; returns the two triangles (t is now c, a, d; u is d, b, c). */
  private flip(t: number, k: number): number {
    const { v, nb, con } = this;
    const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)], c = v[3 * t + ((k + 2) % 3)];
    const u = nb[3 * t + k];
    const k2 = this.edgeIndex(u, b, a);
    const d = v[3 * u + ((k2 + 2) % 3)];
    const nbc = nb[3 * t + ((k + 1) % 3)], nca = nb[3 * t + ((k + 2) % 3)];
    const nad = nb[3 * u + ((k2 + 1) % 3)], ndb = nb[3 * u + ((k2 + 2) % 3)];
    const cbc = con[3 * t + ((k + 1) % 3)], cca = con[3 * t + ((k + 2) % 3)];
    const cad = con[3 * u + ((k2 + 1) % 3)], cdb = con[3 * u + ((k2 + 2) % 3)];
    this.setTri(t, c, a, d);
    this.setTri(u, d, b, c);
    con[3 * t] = cca; con[3 * t + 1] = cad; con[3 * t + 2] = false;
    con[3 * u] = cdb; con[3 * u + 1] = cbc; con[3 * u + 2] = false;
    this.link(t, 0, nca);
    this.link(t, 1, nad);
    this.link(u, 0, ndb);
    this.link(u, 1, nbc);
    nb[3 * t + 2] = u;
    nb[3 * u + 2] = t;
    this.touched.push(t, u);
    return u;
  }

  /** Lawson: flip every edge whose opposite vertex lies in the circumcircle (the new point is opposite each stacked edge). */
  private legalize(stack: [number, number][]) {
    const { px, py, v, nb, con } = this;
    let guard = 0;
    while (stack.length && guard++ < 1e6) {
      const [t, k] = stack.pop()!;
      const u = nb[3 * t + k];
      if (u < 0 || con[3 * t + k]) continue;
      const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)], p = v[3 * t + ((k + 2) % 3)];
      const k2 = this.edgeIndex(u, b, a);
      if (k2 < 0) continue;
      const d = v[3 * u + ((k2 + 2) % 3)];
      // scale the test to the triangle so that "inside" means clearly inside
      const s = (px[b] - px[a]) ** 2 + (py[b] - py[a]) ** 2;
      if (incircle(px[a], py[a], px[b], py[b], px[p], py[p], px[d], py[d]) <= 1e-12 * s * s) continue;
      // the quad must be convex for the flip (it is, unless round-off says otherwise)
      if (orient(px[p], py[p], px[a], py[a], px[d], py[d]) <= 0 || orient(px[d], py[d], px[b], py[b], px[p], py[p]) <= 0) continue;
      const u2 = this.flip(t, k);
      // t is now (p, a, d), u2 is (d, b, p): the edges opposite p
      stack.push([t, 1], [u2, 0]);
    }
  }

  /** The triangle and edge index of the edge from a to b (that orientation), or null. */
  findEdge(a: number, b: number): [number, number] | null {
    const start = this.vt[a];
    if (start < 0) return null;
    // turn around a both ways (one way stops at the outer boundary)
    for (const dir of [1, -1]) {
      let t = start;
      for (let guard = 0; guard < 1000 && t >= 0; guard++) {
        const v = this.v;
        let ka = -1;
        for (let k = 0; k < 3; k++) if (v[3 * t + k] === a) ka = k;
        if (ka < 0) break;
        if (v[3 * t + ((ka + 1) % 3)] === b) return [t, ka];
        // next triangle round a: across the edge (a, next) one way, (prev, a) the other
        t = dir === 1 ? this.nb[3 * t + ka] : this.nb[3 * t + ((ka + 2) % 3)];
        if (t === start) break;
      }
    }
    return null;
  }

  /** Mark the edge a–b (both sides) as a constraint; false when it is not an edge. */
  constrain(a: number, b: number): boolean {
    const e = this.findEdge(a, b) ?? this.findEdge(b, a);
    if (!e) return false;
    const [t, k] = e;
    this.con[3 * t + k] = true;
    const u = this.nb[3 * t + k];
    if (u >= 0) {
      const p = this.v[3 * t + k], q = this.v[3 * t + ((k + 1) % 3)];
      const k2 = this.edgeIndex(u, q, p);
      if (k2 >= 0) this.con[3 * u + k2] = true;
    }
    return true;
  }

  /** Vertex from which the walk to a point can start: the one of triangle t nearest it. */
  centroid(t: number): Pt {
    const { px, py, v } = this;
    const a = v[3 * t], b = v[3 * t + 1], c = v[3 * t + 2];
    return [(px[a] + px[b] + px[c]) / 3, (py[a] + py[b] + py[c]) / 3];
  }

  /**
   * Walk the straight line from inside t to the point; the first constraint edge crossed
   * (as [t, k]), or the triangle reached.
   */
  walkTo(t: number, x: number, y: number): { blocked?: [number, number]; t: number } {
    const { px, py, v, nb, con } = this;
    const [sx, sy] = this.centroid(t);
    let prev = -1;
    for (let guard = 0; guard < 1e5; guard++) {
      let next = -1, kk = -1;
      for (let k = 0; k < 3; k++) {
        const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)];
        // the target lies beyond this edge, and the segment from the start crosses it
        if (orient(px[a], py[a], px[b], py[b], x, y) >= 0) continue;
        const o1 = orient(sx, sy, x, y, px[a], py[a]), o2 = orient(sx, sy, x, y, px[b], py[b]);
        if (o1 * o2 > 0) continue;
        if (nb[3 * t + k] === prev && prev >= 0) continue;
        next = nb[3 * t + k];
        kk = k;
        break;
      }
      if (kk < 0) return { t };
      if (con[3 * t + kk] || next < 0) return { blocked: [t, kk], t };
      prev = t;
      t = next;
    }
    return { t };
  }

  /** Triangles whose circumcircle holds (x, y), grown from t without crossing constraints; and the constraint edges met. */
  cavity(t: number, x: number, y: number): { tris: number[]; segments: [number, number][] } {
    const { px, py, v, nb, con } = this;
    const seen = new Set<number>([t]), tris = [t], segments: [number, number][] = [];
    for (let h = 0; h < tris.length; h++) {
      const q = tris[h];
      for (let k = 0; k < 3; k++) {
        const a = v[3 * q + k], b = v[3 * q + ((k + 1) % 3)];
        if (con[3 * q + k]) {
          segments.push([a, b]);
          continue;
        }
        const u = nb[3 * q + k];
        if (u < 0 || seen.has(u)) continue;
        const [i, j, l] = [v[3 * u], v[3 * u + 1], v[3 * u + 2]];
        if (incircle(px[i], py[i], px[j], py[j], px[l], py[l], x, y) > 0) {
          seen.add(u);
          tris.push(u);
        }
      }
    }
    return { tris, segments };
  }
}

// ---------------------------------------------------------------- domain geometry

export function insidePolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

/** Distance from p to the segment a–b, and the parameter of the nearest point. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): { d: number; s: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const s = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return { d: Math.hypot(p[0] - a[0] - s * dx, p[1] - a[1] - s * dy), s };
}

/** Proper intersection of two segments (not at an end of both): the parameters along each. */
function intersect(a: Pt, b: Pt, c: Pt, d: Pt, tol: number): { s: number; t: number } | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  const L = Math.hypot(rx, ry) * Math.hypot(sx, sy);
  if (Math.abs(den) <= 1e-12 * L) return null;
  const s = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, t = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  const ea = tol / Math.hypot(rx, ry), ec = tol / Math.hypot(sx, sy);
  if (s < -ea || s > 1 + ea || t < -ec || t > 1 + ec) return null;
  return { s: Math.min(1, Math.max(0, s)), t: Math.min(1, Math.max(0, t)) };
}

export interface DomainInput {
  outline: Pt[];
  openings: Pt[][];
  /** Segments the triangulation must follow (walls, the edges of column heads and patch loads, line loads). */
  lines: [Pt, Pt][];
  /** Points that must be vertices. */
  points: Pt[];
  /** Longest triangle edge wanted. */
  size: number;
  /** Smallest angle aimed for (degrees, default 25; Ruppert's algorithm reaches about 30). */
  minAngle?: number;
  /** Upper bound on the number of vertices. */
  maxVertices?: number;
}

export interface TriMesh {
  x: number[];
  y: number[];
  /** Three vertices per triangle, counter-clockwise. */
  tris: number[];
  /** Vertices on a constraint (outline, openings, lines) or given as points: they must not move. */
  fixed: boolean[];
  /** Edges a–b (a < b) that are constraint pieces. */
  constrained: Set<string>;
}

const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** Triangulate a plate's domain with the constraint lines and points, refined to the size and quality asked. */
export function triangulateDomain(input: DomainInput): TriMesh {
  const { outline, openings, size } = input;
  const minAngle = ((input.minAngle ?? 25) * Math.PI) / 180;
  const maxVertices = input.maxVertices ?? 60000;
  const all = [outline, ...openings].flat();
  const lo: Pt = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))];
  const hi: Pt = [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  const tr = new Triangulation(lo, hi);
  const tol = tr.tol * 10;

  // every segment, split where others cross or touch it, then into pieces of the size
  const segs: { a: Pt; b: Pt; boundary: boolean }[] = [];
  for (const poly of [outline, ...openings]) poly.forEach((p, i) => segs.push({ a: p, b: poly[(i + 1) % poly.length], boundary: true }));
  for (const [a, b] of input.lines) if (Math.hypot(b[0] - a[0], b[1] - a[1]) > tol) segs.push({ a, b, boundary: false });
  const cuts: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const x = intersect(segs[i].a, segs[i].b, segs[j].a, segs[j].b, tol);
      if (x) {
        cuts[i].push(x.s);
        cuts[j].push(x.t);
      }
    }
  }
  // ends of other segments and the points that lie on a segment split it too (overlaps, T-junctions)
  const ends = [...segs.flatMap((s) => [s.a, s.b]), ...input.points];
  segs.forEach((s, i) => {
    const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    for (const p of ends) {
      const { d, s: t } = segmentDistance(p, s.a, s.b);
      if (d <= tol && t * L > tol && (1 - t) * L > tol) cuts[i].push(t);
    }
  });
  const piecePts: Pt[][] = segs.map((s, i) => {
    const ts = [...new Set(cuts[i].map((t) => +t.toFixed(12)))].sort((p, q) => p - q);
    const out: Pt[] = [];
    const at = (t: number): Pt => [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
    for (let k = 0; k + 1 < ts.length; k++) {
      const L = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) * (ts[k + 1] - ts[k]);
      if (L <= tol) continue;
      const n = Math.max(1, Math.ceil(L / size - 1e-9));
      for (let q = 0; q < n; q++) out.push(at(ts[k] + ((ts[k + 1] - ts[k]) * q) / n));
    }
    out.push(at(ts[ts.length - 1]));
    return out;
  });

  // insert the vertices in a shuffled order (the walks stay short), then each piece
  const order: Pt[] = [...piecePts.flat(), ...input.points];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(((i * 7919) % 104729) / 104729 * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const p of order) tr.insert(p[0], p[1]);
  const pieces: { a: number; b: number; boundary: boolean }[] = [];
  segs.forEach((s, i) => {
    const pts = piecePts[i];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = tr.insert(pts[k][0], pts[k][1]), b = tr.insert(pts[k + 1][0], pts[k + 1][1]);
      if (a !== b) pieces.push({ a, b, boundary: s.boundary });
    }
  });
  // recover the pieces: a missing one is split at its middle until its halves are edges
  const isInputVertex = new Set<number>();
  for (const p of [...all, ...input.points, ...input.lines.flat()]) isInputVertex.add(tr.insert(p[0], p[1]));
  const constrained: { a: number; b: number }[] = [];
  const queue = [...pieces];
  for (let guard = 0; queue.length && guard < 1e6; guard++) {
    const { a, b, boundary } = queue.pop()!;
    if (tr.constrain(a, b)) {
      constrained.push({ a, b });
      continue;
    }
    if (tr.px.length > maxVertices) throw new Error('The mesh needs too many points: make the element size larger, or move features apart');
    const m = tr.insert((tr.px[a] + tr.px[b]) / 2, (tr.py[a] + tr.py[b]) / 2);
    if (m === a || m === b) continue;
    queue.push({ a, b: m, boundary }, { a: m, b, boundary });
  }
  // flips while recovering may have undone earlier pieces: constrain them again
  for (const { a, b } of constrained) tr.constrain(a, b);

  // classify by the centroid, once: refinement keeps each triangle's side
  const inDomain = (x: number, y: number) => insidePolygon(x, y, outline) && !openings.some((h) => insidePolygon(x, y, h));
  for (let t = 0; t < tr.triangles; t++) {
    const [x, y] = tr.centroid(t);
    tr.inside[t] = inDomain(x, y);
  }

  refine(tr, size, minAngle, maxVertices, isInputVertex);

  // the domain's triangles, renumbered
  const map = new Map<number, number>();
  const x: number[] = [], y: number[] = [], tris: number[] = [];
  const use = (q: number) => {
    let i = map.get(q);
    if (i === undefined) {
      i = x.length;
      map.set(q, i);
      x.push(tr.px[q]);
      y.push(tr.py[q]);
    }
    return i;
  };
  const con = new Set<string>();
  const onCon = new Set<number>();
  for (let t = 0; t < tr.triangles; t++) {
    if (!tr.inside[t]) continue;
    const vs = [tr.v[3 * t], tr.v[3 * t + 1], tr.v[3 * t + 2]].map(use);
    tris.push(...vs);
    for (let k = 0; k < 3; k++) {
      // a boundary piece is a constraint between an inside and an outside triangle
      const u = tr.nb[3 * t + k];
      if (tr.con[3 * t + k] || u < 0 || !tr.inside[u]) {
        con.add(key(vs[k], vs[(k + 1) % 3]));
        onCon.add(vs[k]);
        onCon.add(vs[(k + 1) % 3]);
      }
    }
  }
  for (const q of isInputVertex) {
    const i = map.get(q);
    if (i !== undefined) onCon.add(i);
  }
  return { x, y, tris, fixed: x.map((_, i) => onCon.has(i)), constrained: con };
}

/** Ruppert's refinement: split encroached pieces first, then bad or large triangles at their circumcentres. */
function refine(tr: Triangulation, size: number, minAngle: number, maxVertices: number, inputVertex: Set<number>) {
  const { px, py, v, con, nb } = tr;
  const ratio = 1 / (2 * Math.sin(minAngle));
  // angles at input vertices between constraint edges: a sharp one (< 60°) cannot be fixed by refining
  const sharp = sharpVertices(tr, inputVertex);
  // vertices on constraint pieces (the pieces' ends, and every split point)
  const onSeg = new Set<number>(inputVertex);
  for (let t = 0; t < tr.triangles; t++) for (let k = 0; k < 3; k++) if (con[3 * t + k]) onSeg.add(v[3 * t + k]).add(v[3 * t + ((k + 1) % 3)]);
  const encroached = (a: number, b: number, x: number, y: number) => {
    const mx = (px[a] + px[b]) / 2, my = (py[a] + py[b]) / 2;
    return (x - mx) ** 2 + (y - my) ** 2 < ((px[b] - px[a]) ** 2 + (py[b] - py[a]) ** 2) / 4 * (1 - 1e-9);
  };
  const queue: number[] = [];
  const segQueue: [number, number][] = [];
  const checkEncroach = (ts: number[]) => {
    for (const t of ts) {
      if (!tr.inside[t]) continue;
      for (let k = 0; k < 3; k++) {
        if (!con[3 * t + k]) continue;
        const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)], p = v[3 * t + ((k + 2) % 3)];
        if (encroached(a, b, px[p], py[p])) segQueue.push([a, b]);
      }
    }
  };
  /** Split a constraint piece: at its middle, or on a power-of-two shell round a sharp end (concentric shells). */
  const splitPiece = (t: number, k: number) => {
    const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)];
    const L = Math.hypot(px[b] - px[a], py[b] - py[a]);
    let f = 0.5;
    const end = sharp.has(a) && !sharp.has(b) ? a : sharp.has(b) && !sharp.has(a) ? b : -1;
    if (end >= 0) {
      const d = 2 ** Math.round(Math.log2(L / 2));
      f = end === a ? d / L : 1 - d / L;
    }
    const m = tr.insert(px[a] + (px[b] - px[a]) * f, py[a] + (py[b] - py[a]) * f, t);
    onSeg.add(m);
    const touched = tr.touched;
    queue.push(...touched.filter((x) => tr.inside[x]));
    checkEncroach(touched);
  };
  for (let t = 0; t < tr.triangles; t++) if (tr.inside[t]) queue.push(t);
  checkEncroach(queue);
  let guard = 0;
  while ((segQueue.length || queue.length) && guard++ < 4 * maxVertices) {
    if (px.length > maxVertices) throw new Error('The mesh needs too many points: make the element size larger, or move features apart');
    if (segQueue.length) {
      const [a, b] = segQueue.pop()!;
      const e = tr.findEdge(a, b);
      if (!e || !con[3 * e[0] + e[1]]) continue;
      const [t, k] = e;
      // still encroached by a vertex next to it?
      const p = v[3 * t + ((k + 2) % 3)], u = nb[3 * t + k];
      const k2 = u >= 0 ? tr.edgeIndex(u, b, a) : -1;
      const q = k2 >= 0 ? v[3 * u + ((k2 + 2) % 3)] : -1;
      if ((tr.inside[t] && encroached(a, b, px[p], py[p])) || (q >= 0 && tr.inside[u] && encroached(a, b, px[q], py[q]))) splitPiece(t, k);
      continue;
    }
    const t = queue.pop()!;
    if (!tr.inside[t]) continue;
    const a = v[3 * t], b = v[3 * t + 1], c = v[3 * t + 2];
    const la = Math.hypot(px[c] - px[b], py[c] - py[b]), lb = Math.hypot(px[a] - px[c], py[a] - py[c]), lc = Math.hypot(px[b] - px[a], py[b] - py[a]);
    const lmin = Math.min(la, lb, lc), lmax = Math.max(la, lb, lc);
    const area = Math.abs(orient(px[a], py[a], px[b], py[b], px[c], py[c])) / 2;
    if (!(area > 0)) continue;
    const R = (la * lb * lc) / (4 * area);
    const tooBig = lmax > size * 1.0001;
    let bad = R / lmin > ratio;
    if (bad && !tooBig) {
      // the smallest angle sits opposite the shortest edge: at a sharp input corner, between its two segments, it has to stay
      const apex = lmin === la ? a : lmin === lb ? b : c;
      if (sharp.has(apex) && [a, b, c].every((q) => onSeg.has(q))) bad = false;
    }
    if (!bad && !tooBig) continue;
    const [cx, cy] = circumcenter(px[a], py[a], px[b], py[b], px[c], py[c]);
    const walk = tr.walkTo(t, cx, cy);
    if (walk.blocked) {
      // beyond a constraint: split that instead (the circumcentre encroaches on it)
      const [bt, bk] = walk.blocked;
      if (!con[3 * bt + bk]) continue;
      splitPiece(bt, bk);
      queue.push(t);
      continue;
    }
    const cav = tr.cavity(walk.t, cx, cy);
    const hit = cav.segments.filter(([p, q]) => encroached(p, q, cx, cy));
    if (hit.length) {
      for (const [p, q] of hit) {
        const e = tr.findEdge(p, q);
        if (e && con[3 * e[0] + e[1]]) splitPiece(e[0], e[1]);
      }
      queue.push(t);
      continue;
    }
    if (!tr.inside[walk.t]) continue;
    tr.insert(cx, cy, walk.t);
    const touched = tr.touched;
    queue.push(...touched.filter((x) => tr.inside[x]));
    checkEncroach(touched);
  }
}

/** Input vertices where two constraint edges meet at less than 60° inside the domain. */
function sharpVertices(tr: Triangulation, inputVertex: Set<number>): Set<number> {
  const out = new Set<number>();
  const { px, py, v, con } = tr;
  const dirs = new Map<number, number[]>();
  for (let t = 0; t < tr.triangles; t++) {
    for (let k = 0; k < 3; k++) {
      if (!con[3 * t + k]) continue;
      const a = v[3 * t + k], b = v[3 * t + ((k + 1) % 3)];
      for (const [p, q] of [[a, b], [b, a]]) {
        if (!inputVertex.has(p)) continue;
        const list = dirs.get(p) ?? [];
        list.push(Math.atan2(py[q] - py[p], px[q] - px[p]));
        dirs.set(p, list);
      }
    }
  }
  for (const [p, angles] of dirs) {
    const s = [...new Set(angles.map((x) => +x.toFixed(9)))].sort((x, y) => x - y);
    for (let i = 0; i < s.length; i++) {
      const gap = i + 1 < s.length ? s[i + 1] - s[i] : s[0] + 2 * Math.PI - s[i];
      if (s.length > 1 && gap < Math.PI / 3 - 1e-9) out.add(p);
    }
  }
  return out;
}
