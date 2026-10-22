// 2-D drawings from 3-D parts: orthographic views with visible and hidden lines.
//
// The lines of a view are the mesh edges a draughtsman would draw: sharp edges (faces
// meeting at more than ~20°), open boundaries, and silhouettes of curved walls (edges
// between a face turned to the viewer and one turned away). Each line is cut into short
// pieces and every piece is tested against all triangles in front of it (a 2-D grid
// keeps that fast), so lines come out split into visible and hidden runs.
import earcut from 'earcut';
import { cross3, dot3, type M4, type Vec3 } from './solid';
import { overlayPrims, pointInLoop, primsBox, type DrawView, type DrawViewRequest, type Prim } from './drawing2d';
import { chainLoops } from './outline';

/** A closed triangle mesh with shared vertices, in drawing coordinates. */
export interface DrawMesh {
  pos: Float64Array;
  tri: Uint32Array;
}

export interface ViewSpec {
  name: string;
  /** Direction the viewer looks in. */
  dir: Vec3;
  /** What is up on the paper. */
  up: Vec3;
}

export interface ViewLines {
  name: string;
  /** Segments x1, y1, x2, y2 … in model units (paper x right, y up). */
  visible: number[];
  hidden: number[];
  box: { x0: number; y0: number; x1: number; y1: number };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Mesh of a solid (vertProperties / triVerts as Manifold gives them), moved by a placement. */
export function drawMesh(vertProperties: ArrayLike<number>, numProp: number, triVerts: ArrayLike<number>, M?: M4): DrawMesh {
  const nv = vertProperties.length / numProp;
  const pos = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const x = vertProperties[i * numProp], y = vertProperties[i * numProp + 1], z = vertProperties[i * numProp + 2];
    if (M) {
      pos[3 * i] = M[0] * x + M[4] * y + M[8] * z + M[12];
      pos[3 * i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      pos[3 * i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    } else {
      pos[3 * i] = x; pos[3 * i + 1] = y; pos[3 * i + 2] = z;
    }
  }
  return { pos, tri: Uint32Array.from(triVerts) };
}

/** First-angle (ISO, Europe) or third-angle (ANSI) standard views. */
export const STANDARD_VIEWS: Record<'front' | 'top' | 'left' | 'right' | 'iso', ViewSpec> = {
  front: { name: 'Front', dir: [0, 1, 0], up: [0, 0, 1] },
  top: { name: 'Top', dir: [0, 0, -1], up: [0, 1, 0] },
  left: { name: 'Left', dir: [1, 0, 0], up: [0, 0, 1] },
  right: { name: 'Right', dir: [-1, 0, 0], up: [0, 0, 1] },
  iso: { name: 'Isometric', dir: norm([-1, 1, -1]), up: [0, 0, 1] },
};

const SHARP = Math.cos((20 * Math.PI) / 180);

interface ProjTri {
  x: [number, number, number];
  y: [number, number, number];
  d: [number, number, number];
  x0: number; x1: number; y0: number; y1: number;
}

/** The axes of a view: across the paper, up it, and the direction looked in. */
export function viewAxes(spec: ViewSpec): { right: Vec3; up: Vec3; dir: Vec3 } {
  const dir = norm(spec.dir);
  const right = norm(cross(dir, spec.up));
  return { right, up: cross(right, dir), dir };
}

/**
 * The triangles of meshes seen along a view, on a grid over the paper: what lies in front
 * of a point (hidden lines) and how deep the nearest surface is there.
 */
export class Occluder {
  readonly tris: ProjTri[] = [];
  /** First triangle of each mesh (and the end). */
  readonly starts: number[] = [];
  box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  private grid: number[][] = [];
  private G = 96;
  private w = 1;
  private h = 1;
  readonly size: number;
  private eps: number;

  constructor(meshes: DrawMesh[], spec: ViewSpec) {
    const { right, up, dir } = viewAxes(spec);
    const box = this.box;
    for (const { pos, tri } of meshes) {
      this.starts.push(this.tris.length);
      const P = (i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
      for (let t = 0; t < tri.length / 3; t++) {
        const a = P(tri[3 * t]), b = P(tri[3 * t + 1]), c = P(tri[3 * t + 2]);
        const xs = [dot(a, right), dot(b, right), dot(c, right)] as [number, number, number];
        const ys = [dot(a, up), dot(b, up), dot(c, up)] as [number, number, number];
        const ds = [dot(a, dir), dot(b, dir), dot(c, dir)] as [number, number, number];
        const tr = { x: xs, y: ys, d: ds, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
        this.tris.push(tr);
        box.x0 = Math.min(box.x0, tr.x0); box.y0 = Math.min(box.y0, tr.y0); box.x1 = Math.max(box.x1, tr.x1); box.y1 = Math.max(box.y1, tr.y1);
      }
    }
    this.starts.push(this.tris.length);
    this.w = box.x1 - box.x0 || 1;
    this.h = box.y1 - box.y0 || 1;
    this.size = Math.max(this.w, this.h);
    this.eps = this.size * 1e-6;
    const G = this.G;
    this.grid = Array.from({ length: G * G }, () => []);
    if (!this.tris.length) return;
    this.tris.forEach((t, k) => {
      const i0 = Math.max(0, Math.floor(((t.x0 - box.x0) / this.w) * G)), i1 = Math.min(G - 1, Math.floor(((t.x1 - box.x0) / this.w) * G));
      const j0 = Math.max(0, Math.floor(((t.y0 - box.y0) / this.h) * G)), j1 = Math.min(G - 1, Math.floor(((t.y1 - box.y0) / this.h) * G));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * G + i].push(k);
    });
  }

  private cell(x: number, y: number): number[] {
    const { box, G } = this;
    if (!this.tris.length || x < box.x0 - this.eps || x > box.x1 + this.eps || y < box.y0 - this.eps || y > box.y1 + this.eps) return [];
    const i = Math.min(G - 1, Math.max(0, Math.floor(((x - box.x0) / this.w) * G)));
    const j = Math.min(G - 1, Math.max(0, Math.floor(((y - box.y0) / this.h) * G)));
    return this.grid[j * G + i];
  }

  /** Barycentric coordinates of (x, y) in triangle t, or null for an edge-on triangle. */
  private bary(t: ProjTri, x: number, y: number): [number, number, number] | null {
    const [x1, x2, x3] = t.x, [y1, y2, y3] = t.y;
    const den = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
    if (Math.abs(den) < 1e-18 * this.size * this.size) return null;
    const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / den;
    const l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / den;
    return [l1, l2, 1 - l1 - l2];
  }

  /** Is the point (x, y) at depth d behind some triangle (other than those listed)? */
  hiddenAt(x: number, y: number, d: number, own: number[] = []): boolean {
    const eps = this.eps;
    for (const k of this.cell(x, y)) {
      if (own.includes(k)) continue;
      const t = this.tris[k];
      if (x < t.x0 - eps || x > t.x1 + eps || y < t.y0 - eps || y > t.y1 + eps) continue;
      const l = this.bary(t, x, y);
      // strictly inside: a line along a triangle's border is not behind it
      const tol = 1e-7;
      if (!l || l[0] <= tol || l[1] <= tol || l[2] <= tol) continue;
      const dt = l[0] * t.d[0] + l[1] * t.d[1] + l[2] * t.d[2];
      if (dt < d - eps * 10) return true;
    }
    return false;
  }

  /**
   * Depth of the nearest surface at (x, y), Infinity where there is none; triangles within
   * `reach` of the point count too (a curve's outline lies a chord's height outside its facets).
   */
  frontDepth(x: number, y: number, reach = 0): number {
    let best = Infinity;
    for (const k of this.cell(x, y)) {
      const t = this.tris[k];
      if (x < t.x0 - reach || x > t.x1 + reach || y < t.y0 - reach || y > t.y1 + reach) continue;
      const l = this.bary(t, x, y);
      if (!l) continue;
      const inside = l[0] >= -1e-9 && l[1] >= -1e-9 && l[2] >= -1e-9;
      if (!inside) {
        if (!(reach > 0)) continue;
        let dmin = Infinity;
        for (let e = 0; e < 3; e++) dmin = Math.min(dmin, segDist2(x, y, t.x[e], t.y[e], t.x[(e + 1) % 3], t.y[(e + 1) % 3]));
        if (dmin > reach) continue;
      }
      // the plane of the triangle there (just outside it, its extension)
      const dt = l[0] * t.d[0] + l[1] * t.d[1] + l[2] * t.d[2];
      if (dt < best) best = dt;
    }
    return best;
  }
}

const segDist2 = (x: number, y: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
};

/**
 * The visible and hidden lines of meshes seen in one direction. `drawn` picks the meshes
 * whose lines are drawn (all by default); the others only hide.
 */
export function projectView(meshes: DrawMesh[], spec: ViewSpec, opts: { hidden?: boolean; drawn?: (mesh: number) => boolean } = {}): ViewLines {
  const { right, up, dir } = viewAxes(spec);
  const occ = new Occluder(meshes, spec);
  // candidate edges: [mesh, a, b, tri1, tri2]
  const edges: { m: number; a: number; b: number; t: number[] }[] = [];
  meshes.forEach((mesh, mi) => {
    if (opts.drawn && !opts.drawn(mi)) return;
    const { pos, tri } = mesh;
    const base = occ.starts[mi];
    const nt = tri.length / 3;
    const nrm: Vec3[] = [];
    const P = (i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    for (let t = 0; t < nt; t++) {
      const a = P(tri[3 * t]), b = P(tri[3 * t + 1]), c = P(tri[3 * t + 2]);
      nrm.push(norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])));
    }
    const map = new Map<string, number[]>();
    for (let t = 0; t < nt; t++) {
      for (let k = 0; k < 3; k++) {
        const a = tri[3 * t + k], b = tri[3 * t + ((k + 1) % 3)];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const l = map.get(key);
        if (l) l.push(t);
        else map.set(key, [t]);
      }
    }
    for (const [key, ts] of map) {
      let draw = ts.length !== 2;
      if (!draw) {
        const n1 = nrm[ts[0]], n2 = nrm[ts[1]];
        if (dot(n1, n2) < SHARP) draw = true;
        // silhouette of a curved wall: one face towards the viewer, one away
        else if (Math.sign(dot(n1, dir)) !== Math.sign(dot(n2, dir)) && Math.abs(dot(n1, dir)) + Math.abs(dot(n2, dir)) > 1e-9) draw = true;
      }
      if (!draw) continue;
      const [a, b] = key.split(',').map(Number);
      edges.push({ m: mi, a, b, t: ts.map((q) => q + base) });
    }
  });
  const box = occ.box;
  if (!occ.tris.length) return { name: spec.name, visible: [], hidden: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 } };
  const size = occ.size;

  const visible: number[] = [], hidden: number[] = [];
  const step = size / 300;
  for (const e of edges) {
    const pos = meshes[e.m].pos;
    const A: Vec3 = [pos[3 * e.a], pos[3 * e.a + 1], pos[3 * e.a + 2]], B: Vec3 = [pos[3 * e.b], pos[3 * e.b + 1], pos[3 * e.b + 2]];
    const ax = dot(A, right), ay = dot(A, up), ad = dot(A, dir);
    const bx = dot(B, right), by = dot(B, up), bd = dot(B, dir);
    const len = Math.hypot(bx - ax, by - ay);
    if (len < size * 1e-7) continue; // seen end-on
    const n = Math.max(1, Math.min(400, Math.ceil(len / step)));
    let runStart = 0;
    let runHidden: boolean | null = null;
    const flush = (t0: number, t1: number, hid: boolean) => {
      const seg = [ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1];
      (hid ? hidden : visible).push(...seg);
    };
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const hid = occ.hiddenAt(ax + (bx - ax) * t, ay + (by - ay) * t, ad + (bd - ad) * t, e.t);
      if (runHidden === null) runHidden = hid;
      else if (hid !== runHidden) {
        flush(runStart, i / n, runHidden);
        runStart = i / n;
        runHidden = hid;
      }
    }
    if (runHidden !== null) flush(runStart, 1, runHidden);
  }
  const [vis, hid] = overlay(visible, hidden, size);
  return { name: spec.name, visible: vis, hidden: opts.hidden === false ? [] : hid, box: { ...box } };
}

/**
 * Clean the line work: segments on one line are merged (front and back edges of a box
 * project onto each other, tessellation splits lines), and hidden pieces that lie under
 * a visible line are dropped.
 */
export function overlay(visible: number[], hidden: number[], size: number): [number[], number[]] {
  const tol = size * 2e-6;
  type Line = { ux: number; uy: number; nx: number; ny: number; c: number; vis: [number, number][]; hid: [number, number][] };
  const lines = new Map<string, Line>();
  const add = (segs: number[], kind: 'vis' | 'hid') => {
    for (let i = 0; i < segs.length; i += 4) {
      let x1 = segs[i], y1 = segs[i + 1], x2 = segs[i + 2], y2 = segs[i + 3];
      let dx = x2 - x1, dy = y2 - y1;
      const l = Math.hypot(dx, dy);
      if (l < tol) continue;
      dx /= l; dy /= l;
      // one direction per line: angle in [0, π)
      if (dy < -1e-12 || (Math.abs(dy) <= 1e-12 && dx < 0)) { dx = -dx; dy = -dy; [x1, y1, x2, y2] = [x2, y2, x1, y1]; }
      const nx = -dy, ny = dx;
      const c = nx * x1 + ny * y1;
      const key = `${Math.round(Math.atan2(dy, dx) * 1e5)}|${Math.round(c / (tol * 50))}`;
      let L = lines.get(key);
      if (!L) {
        L = { ux: dx, uy: dy, nx, ny, c, vis: [], hid: [] };
        lines.set(key, L);
      }
      const t1 = L.ux * x1 + L.uy * y1, t2 = L.ux * x2 + L.uy * y2;
      L[kind].push([Math.min(t1, t2), Math.max(t1, t2)]);
    }
  };
  add(visible, 'vis');
  add(hidden, 'hid');
  const union = (iv: [number, number][]) => {
    iv.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const [a, b] of iv) {
      const last = out[out.length - 1];
      if (last && a <= last[1] + tol) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const minus = (iv: [number, number][], cut: [number, number][]) => {
    let cur = iv;
    for (const [ca, cb] of cut) {
      const next: [number, number][] = [];
      for (const [a, b] of cur) {
        if (cb <= a + tol || ca >= b - tol) { next.push([a, b]); continue; }
        if (ca > a + tol) next.push([a, ca]);
        if (cb < b - tol) next.push([cb, b]);
      }
      cur = next;
    }
    return cur;
  };
  const outV: number[] = [], outH: number[] = [];
  for (const L of lines.values()) {
    const v = union(L.vis);
    const h = minus(union(L.hid), v);
    const emit = (iv: [number, number][], out: number[]) => {
      for (const [a, b] of iv) {
        if (b - a < tol) continue;
        out.push(L.ux * a + L.nx * L.c, L.uy * a + L.ny * L.c, L.ux * b + L.nx * L.c, L.uy * b + L.ny * L.c);
      }
    };
    emit(v, outV);
    emit(h, outH);
  }
  return [outV, outH];
}

// ------------------------------------------------------------ the mesh's drawing views

/**
 * A drawing view from triangle meshes (when OpenCascade is not there): the hidden-line
 * lines above as line primitives. A section clips the meshes at the plane and closes them
 * with caps on the cut faces, whose outlines are the hatched loops.
 */
export function meshDrawView(meshes: DrawMesh[], req: DrawViewRequest): DrawView {
  const spec: ViewSpec = { name: req.name, dir: req.dir, up: req.up };
  let cuts: DrawView['cuts'];
  let drawn = meshes;
  if (req.cut) {
    const { right, up, dir } = viewAxes(spec);
    cuts = [];
    drawn = [];
    meshes.forEach((m, index) => {
      const c = clipMesh(m, req.cut!, dir, right, up);
      if (!c) return;
      drawn.push(c.mesh);
      if (c.loops.length) cuts!.push({ body: String(index), index, loops: c.loops });
    });
  }
  const v = projectView(drawn, spec, { hidden: req.hidden });
  const lines = (s: number[]): Prim[] => {
    const out: Prim[] = [];
    for (let i = 0; i + 3 < s.length; i += 4) out.push({ k: 'line', x1: s[i], y1: s[i + 1], x2: s[i + 2], y2: s[i + 3] });
    return out;
  };
  const size = Math.max(v.box.x1 - v.box.x0, v.box.y1 - v.box.y0, 1e-9);
  const [visible, hidden] = overlayPrims([lines(v.visible), lines(v.hidden)], size);
  const box = primsBox(visible, hidden);
  return {
    name: req.name, visible, hidden, tangent: [], thin: [], axes: [], ...(cuts ? { cuts } : {}),
    box: box.x1 >= box.x0 ? box : { x0: 0, y0: 0, x1: 0, y1: 0 }, mesh: 'all',
  };
}

/**
 * The part of a mesh beyond the plane through o square to n, closed by caps where the
 * plane cut it; the caps' outlines in view coordinates. Null when nothing is left.
 */
export function clipMesh(m: DrawMesh, o: Vec3, n: Vec3, right: Vec3, up: Vec3): { mesh: DrawMesh; loops: number[][] } | null {
  const { pos, tri } = m;
  const nv = pos.length / 3;
  const side = new Float64Array(nv);
  let size = 0;
  for (let i = 0; i < nv; i++) {
    side[i] = (pos[3 * i] - o[0]) * n[0] + (pos[3 * i + 1] - o[1]) * n[1] + (pos[3 * i + 2] - o[2]) * n[2];
    size = Math.max(size, Math.abs(side[i]));
  }
  const tol = size * 1e-9;
  const out: number[] = Array.from(pos);
  const tris: number[] = [];
  // a point where an edge crosses the plane, made once for both triangles on the edge
  const crossing = new Map<string, number>();
  const at = (a: number, b: number) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    let k = crossing.get(key);
    if (k === undefined) {
      const s = side[a] / (side[a] - side[b]);
      k = out.length / 3;
      for (let c = 0; c < 3; c++) out.push(pos[3 * a + c] + (pos[3 * b + c] - pos[3 * a + c]) * s);
      crossing.set(key, k);
    }
    return k;
  };
  const cut: [number, number][] = [];
  for (let t = 0; t < tri.length; t += 3) {
    const v = [tri[t], tri[t + 1], tri[t + 2]];
    const keep = v.map((i) => side[i] >= -tol);
    if (keep.every(Boolean)) {
      tris.push(...v);
      continue;
    }
    if (!keep.some(Boolean)) continue;
    // Sutherland–Hodgman on one triangle, keeping its turn
    const poly: number[] = [], onPlane: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      if (keep[k]) poly.push(a);
      if (keep[k] !== keep[(k + 1) % 3]) {
        const c = at(a, b);
        poly.push(c);
        onPlane.push(c);
      }
    }
    for (let k = 1; k + 1 < poly.length; k++) tris.push(poly[0], poly[k], poly[k + 1]);
    if (onPlane.length === 2) cut.push([onPlane[0], onPlane[1]]);
  }
  if (!tris.length) return null;
  // the cut's outline, chained into loops in the view's coordinates
  const P2 = (i: number) => ({ x: out[3 * i] * right[0] + out[3 * i + 1] * right[1] + out[3 * i + 2] * right[2], y: out[3 * i] * up[0] + out[3 * i + 1] * up[1] + out[3 * i + 2] * up[2] });
  const loops = chainLoops(cut.map(([a, b]) => [P2(a), P2(b)]), size * 1e-7 + 1e-12).filter((l) => l.length >= 3).map((l) => l.flatMap((q) => [q.x, q.y]));
  // caps: each outer loop with the loops right inside it as holes (even–odd), at the plane
  const depth = o[0] * n[0] + o[1] * n[1] + o[2] * n[2];
  const within = loops.map((l, i) => loops.filter((q, j) => j !== i && pointInLoop(l[0], l[1], q)).length);
  loops.forEach((l, i) => {
    if (within[i] % 2) return;
    const holes = loops.filter((q, j) => within[j] === within[i] + 1 && pointInLoop(q[0], q[1], l));
    const flat = [...l, ...holes.flat()];
    const starts: number[] = [];
    let s = l.length / 2;
    for (const h of holes) {
      starts.push(s);
      s += h.length / 2;
    }
    const base = out.length / 3;
    for (let k = 0; k < flat.length; k += 2) {
      const x = flat[k], y = flat[k + 1];
      for (let c = 0; c < 3; c++) out.push(x * right[c] + y * up[c] + depth * n[c]);
    }
    // turned to face the side cut away, as the outside of what is kept
    const cap = earcut(flat, starts, 2);
    const [a, b, c] = cap.slice(0, 3).map((q) => [flat[2 * q], flat[2 * q + 1]]);
    const facesN = a && ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * dot3(cross3(right, up), n) > 0;
    for (let k = 0; k < cap.length; k += 3) tris.push(base + cap[k], base + cap[facesN ? k + 2 : k + 1], base + cap[facesN ? k + 1 : k + 2]);
  });
  return { mesh: { pos: new Float64Array(out), tri: Uint32Array.from(tris) }, loops };
}

/** The largest standard scale (1:1, 1:2, 1:5 … or 2:1, 5:1 …) at which a size fits. */
export function standardScale(modelSize: number, paperSize: number): number {
  const steps = [100, 50, 20, 10, 5, 2, 1, 1 / 2, 1 / 2.5, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000];
  for (const s of steps) if (modelSize * s <= paperSize) return s;
  return steps[steps.length - 1];
}

export function scaleText(s: number): string {
  if (s >= 1) return `${+s.toFixed(2)}:1`;
  return `1:${+(1 / s).toFixed(2)}`;
}
