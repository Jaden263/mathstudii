// 2-D drawings from 3-D parts: orthographic views with visible and hidden lines.
//
// The lines of a view are the mesh edges a draughtsman would draw: sharp edges (faces
// meeting at more than ~20°), open boundaries, and silhouettes of curved walls (edges
// between a face turned to the viewer and one turned away). Each line is cut into short
// pieces and every piece is tested against all triangles in front of it (a 2-D grid
// keeps that fast), so lines come out split into visible and hidden runs.
import type { M4, Vec3 } from './solid';

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

/** The visible and hidden lines of meshes seen in one direction. */
export function projectView(meshes: DrawMesh[], spec: ViewSpec, opts: { hidden?: boolean } = {}): ViewLines {
  const dir = norm(spec.dir);
  const right = norm(cross(dir, spec.up));
  const up = cross(right, dir);
  const tris: ProjTri[] = [];
  const triOwner: number[] = [];
  // candidate edges: [mesh, a, b, tri1, tri2]
  const edges: { m: number; a: number; b: number; t: number[] }[] = [];
  let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let base = 0;
  meshes.forEach((mesh, mi) => {
    const { pos, tri } = mesh;
    const nt = tri.length / 3;
    const nrm: Vec3[] = [];
    const P = (i: number): Vec3 => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    for (let t = 0; t < nt; t++) {
      const a = P(tri[3 * t]), b = P(tri[3 * t + 1]), c = P(tri[3 * t + 2]);
      const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
      nrm.push(norm(n));
      const xs = [dot(a, right), dot(b, right), dot(c, right)] as [number, number, number];
      const ys = [dot(a, up), dot(b, up), dot(c, up)] as [number, number, number];
      const ds = [dot(a, dir), dot(b, dir), dot(c, dir)] as [number, number, number];
      tris.push({ x: xs, y: ys, d: ds, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
      triOwner.push(mi);
      box = { x0: Math.min(box.x0, ...xs), y0: Math.min(box.y0, ...ys), x1: Math.max(box.x1, ...xs), y1: Math.max(box.y1, ...ys) };
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
    base += nt;
  });
  if (!tris.length) return { name: spec.name, visible: [], hidden: [], box: { x0: 0, y0: 0, x1: 0, y1: 0 } };

  // grid of triangles over the view
  const G = 96;
  const w = box.x1 - box.x0 || 1, h = box.y1 - box.y0 || 1;
  const size = Math.max(w, h);
  const cell = (x: number, y: number) => {
    const i = Math.min(G - 1, Math.max(0, Math.floor(((x - box.x0) / w) * G)));
    const j = Math.min(G - 1, Math.max(0, Math.floor(((y - box.y0) / h) * G)));
    return j * G + i;
  };
  const grid: number[][] = Array.from({ length: G * G }, () => []);
  tris.forEach((t, k) => {
    const i0 = Math.max(0, Math.floor(((t.x0 - box.x0) / w) * G)), i1 = Math.min(G - 1, Math.floor(((t.x1 - box.x0) / w) * G));
    const j0 = Math.max(0, Math.floor(((t.y0 - box.y0) / h) * G)), j1 = Math.min(G - 1, Math.floor(((t.y1 - box.y0) / h) * G));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) grid[j * G + i].push(k);
  });
  const eps = size * 1e-6;

  /** Is the point (x, y) at depth d behind some triangle (other than the edge's own)? */
  const hiddenAt = (x: number, y: number, d: number, own: number[]): boolean => {
    for (const k of grid[cell(x, y)]) {
      if (own.includes(k)) continue;
      const t = tris[k];
      if (x < t.x0 - eps || x > t.x1 + eps || y < t.y0 - eps || y > t.y1 + eps) continue;
      const [x1, x2, x3] = t.x, [y1, y2, y3] = t.y;
      const den = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
      if (Math.abs(den) < 1e-18 * size * size) continue; // edge-on triangle
      const l1 = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / den;
      const l2 = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / den;
      const l3 = 1 - l1 - l2;
      // strictly inside: a line along a triangle's border is not behind it
      const tol = 1e-7;
      if (l1 <= tol || l2 <= tol || l3 <= tol) continue;
      const dt = l1 * t.d[0] + l2 * t.d[1] + l3 * t.d[2];
      if (dt < d - eps * 10) return true;
    }
    return false;
  };

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
      const hid = hiddenAt(ax + (bx - ax) * t, ay + (by - ay) * t, ad + (bd - ad) * t, e.t);
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
  return { name: spec.name, visible: vis, hidden: opts.hidden === false ? [] : hid, box };
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
