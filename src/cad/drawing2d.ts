// The line work of a drawing view as exact 2-D geometry: lines, circular and elliptical
// arcs, and polylines only where the curve is a B-spline, in view coordinates (model
// units, x right and y up on the paper). Hidden-line removal reports a back edge under a
// front one and splits curves where their visibility changes: overlayPrims merges them
// again. A detail view clips the parent's geometry exactly at its circle, and the cut
// faces of a section view are hatched here (the spacing is paper millimetres, so it
// follows the sheet's scale).

import type { Vec3 } from './solid';

/** A view the drawing asks the kernel for. */
export interface DrawViewRequest {
  key: string;
  name: string;
  /** Direction the viewer looks in, and what is up on the paper. */
  dir: Vec3;
  up: Vec3;
  hidden: boolean;
  /** A section view: only what lies beyond the plane through this point, square to `dir`, is kept. */
  cut?: Vec3;
  /** Occurrences placed elsewhere than the build has them (an exploded drawing): id → column-major 4×4. */
  placements?: Record<string, number[]>;
}

export type Prim =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number }
  /** Counter-clockwise from a0 to a1 (radians, a0 < a1 ≤ a0 + 2π; 2π: the whole circle). */
  | { k: 'arc'; cx: number; cy: number; r: number; a0: number; a1: number }
  /** c + rx·cos t·u + ry·sin t·v with u at angle rot and v a quarter turn on; t0 < t1. */
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rot: number; t0: number; t1: number }
  /** x0, y0, x1, y1 … */
  | { k: 'poly'; pts: number[] };

/** Axes of holes and shafts: a centre mark where one is seen end-on, a centre line where it is seen side-on. */
export type ViewAxis =
  | { kind: 'mark'; x: number; y: number; r: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number };

/** One cut face region of a section view: the closed outlines of a body in the plane. */
export interface ViewCut {
  /** Occurrence and body, `${occ}/${body}`. */
  body: string;
  /** The body's place among the drawing's bodies: neighbouring parts get different hatching. */
  index: number;
  /** Closed polylines x0, y0, x1, y1 … (even–odd: a hole is a loop inside a loop). */
  loops: number[][];
}

export interface DrawView {
  name: string;
  /** Visible sharp edges and outlines (ISO 128 wide continuous). */
  visible: Prim[];
  /** Hidden edges, outlines and hidden thread lines (narrow dashed). */
  hidden: Prim[];
  /** Visible edges between faces that meet smoothly (narrow continuous). */
  tangent: Prim[];
  /** Thread roots (ISO 6410: narrow continuous; ¾ circles in end views). */
  thin: Prim[];
  axes: ViewAxis[];
  cuts?: ViewCut[];
  box: { x0: number; y0: number; x1: number; y1: number };
  /** Drawn from the display mesh: every body (no B-rep kernel), or only some (coils and modeled threads). */
  mesh?: 'all' | 'some';
  note?: string;
}

const TAU = 2 * Math.PI;
const { cos, sin, atan2, hypot, abs, min, max, sqrt, PI } = Math;

export const emptyBox = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

// ------------------------------------------------------------ points, boxes, samples

export function ellipsePoint(p: Extract<Prim, { k: 'ellipse' }>, t: number): [number, number] {
  const c = cos(p.rot), s = sin(p.rot), x = p.rx * cos(t), y = p.ry * sin(t);
  return [p.cx + x * c - y * s, p.cy + x * s + y * c];
}

/** The point at s ∈ [0, 1] along the primitive's parameter. */
export function primAt(p: Prim, s: number): [number, number] {
  switch (p.k) {
    case 'line':
      return [p.x1 + (p.x2 - p.x1) * s, p.y1 + (p.y2 - p.y1) * s];
    case 'arc': {
      const a = p.a0 + (p.a1 - p.a0) * s;
      return [p.cx + p.r * cos(a), p.cy + p.r * sin(a)];
    }
    case 'ellipse':
      return ellipsePoint(p, p.t0 + (p.t1 - p.t0) * s);
    case 'poly': {
      const n = p.pts.length / 2 - 1;
      if (n <= 0) return [p.pts[0], p.pts[1]];
      const f = s * n, i = min(n - 1, Math.floor(f)), u = f - i;
      return [p.pts[2 * i] + (p.pts[2 * i + 2] - p.pts[2 * i]) * u, p.pts[2 * i + 1] + (p.pts[2 * i + 3] - p.pts[2 * i + 1]) * u];
    }
  }
}

/** Is angle a inside the counter-clockwise range a0 … a1? */
const within = (a: number, a0: number, a1: number) => {
  const d = (((a - a0) % TAU) + TAU) % TAU;
  return d <= a1 - a0 + 1e-12;
};

/** Grow a box by the primitive's exact extent (arcs and ellipses by their extreme points). */
export function growBox(b: DrawView['box'], p: Prim): void {
  const add = (x: number, y: number) => {
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  };
  switch (p.k) {
    case 'line':
      add(p.x1, p.y1);
      add(p.x2, p.y2);
      return;
    case 'arc':
      add(...primAt(p, 0));
      add(...primAt(p, 1));
      for (let q = 0; q < 4; q++) if (within((q * PI) / 2, p.a0, p.a1)) add(p.cx + p.r * cos((q * PI) / 2), p.cy + p.r * sin((q * PI) / 2));
      return;
    case 'ellipse': {
      add(...ellipsePoint(p, p.t0));
      add(...ellipsePoint(p, p.t1));
      // dx/dt = 0 and dy/dt = 0
      const c = cos(p.rot), s = sin(p.rot);
      const tx = atan2(-p.ry * s, p.rx * c), ty = atan2(p.ry * c, p.rx * s);
      for (const t of [tx, tx + PI, ty, ty + PI]) if (within(t, p.t0, p.t1)) add(...ellipsePoint(p, t));
      return;
    }
    case 'poly':
      for (let i = 0; i + 1 < p.pts.length; i += 2) add(p.pts[i], p.pts[i + 1]);
  }
}

export function primsBox(...groups: Prim[][]): DrawView['box'] {
  const b = emptyBox();
  for (const g of groups) for (const p of g) growBox(b, p);
  return b;
}

/** Length of the primitive (an ellipse's by its polygon of 64 sides per turn). */
export function primLength(p: Prim): number {
  switch (p.k) {
    case 'line':
      return hypot(p.x2 - p.x1, p.y2 - p.y1);
    case 'arc':
      return p.r * (p.a1 - p.a0);
    case 'ellipse':
    case 'poly':
      return polyLength(samplePrim(p, 64));
  }
}

const polyLength = (pts: number[]) => {
  let s = 0;
  for (let i = 2; i + 1 < pts.length; i += 2) s += hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
};

/** Points along the primitive: `perTurn` sides for a whole circle or ellipse, two for a line. */
export function samplePrim(p: Prim, perTurn = 96): number[] {
  if (p.k === 'line') return [p.x1, p.y1, p.x2, p.y2];
  if (p.k === 'poly') return p.pts;
  const span = p.k === 'arc' ? p.a1 - p.a0 : p.t1 - p.t0;
  const n = max(2, Math.ceil((span / TAU) * perTurn));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(...primAt(p, i / n));
  return out;
}

/** The piece of a primitive between parameters s0 < s1 in [0, 1] (as primAt measures them). */
export function subPrim(p: Prim, s0: number, s1: number): Prim {
  if (s0 <= 0 && s1 >= 1) return p;
  switch (p.k) {
    case 'line': {
      const [x1, y1] = primAt(p, s0), [x2, y2] = primAt(p, s1);
      return { k: 'line', x1, y1, x2, y2 };
    }
    case 'arc':
      return { ...p, a0: p.a0 + (p.a1 - p.a0) * s0, a1: p.a0 + (p.a1 - p.a0) * s1 };
    case 'ellipse':
      return { ...p, t0: p.t0 + (p.t1 - p.t0) * s0, t1: p.t0 + (p.t1 - p.t0) * s1 };
    case 'poly': {
      const n = p.pts.length / 2 - 1;
      const out = [...primAt(p, s0)];
      for (let i = Math.floor(s0 * n) + 1; i < s1 * n; i++) out.push(p.pts[2 * i], p.pts[2 * i + 1]);
      out.push(...primAt(p, s1));
      return { k: 'poly', pts: out };
    }
  }
}

/** The primitive moved and scaled: x → ox + k·x, y → oy + k·y (k > 0). */
export function placePrim(p: Prim, ox: number, oy: number, k: number): Prim {
  switch (p.k) {
    case 'line':
      return { k: 'line', x1: ox + k * p.x1, y1: oy + k * p.y1, x2: ox + k * p.x2, y2: oy + k * p.y2 };
    case 'arc':
      return { ...p, cx: ox + k * p.cx, cy: oy + k * p.cy, r: k * p.r };
    case 'ellipse':
      return { ...p, cx: ox + k * p.cx, cy: oy + k * p.cy, rx: k * p.rx, ry: k * p.ry };
    case 'poly':
      return { k: 'poly', pts: p.pts.map((v, i) => (i % 2 ? oy : ox) + k * v) };
  }
}

// ------------------------------------------------------------ curves recognised

/**
 * A sampled curve (a B-spline from the hidden-line removal) as what it really is: a line
 * when every point is on its chord (a circle seen edge-on comes out as a flat B-spline,
 * and may run back over itself), an arc when every point is on one circle, else a polyline.
 */
export function recognise(pts: number[], tol: number): Prim {
  const n = pts.length / 2;
  const x0 = pts[0], y0 = pts[1];
  // the two points furthest apart span the line (a curve folded back on itself has its ends inside)
  let fx = x0, fy = y0, far = 0;
  for (let i = 0; i < n; i++) {
    const d = hypot(pts[2 * i] - x0, pts[2 * i + 1] - y0);
    if (d > far) [far, fx, fy] = [d, pts[2 * i], pts[2 * i + 1]];
  }
  if (far > tol) {
    const ux = (fx - x0) / far, uy = (fy - y0) / far;
    let lo = 0, hi = 0, off = 0;
    for (let i = 0; i < n; i++) {
      const dx = pts[2 * i] - x0, dy = pts[2 * i + 1] - y0;
      const t = dx * ux + dy * uy;
      lo = min(lo, t);
      hi = max(hi, t);
      off = max(off, abs(dx * uy - dy * ux));
    }
    if (off <= tol) return { k: 'line', x1: x0 + ux * lo, y1: y0 + uy * lo, x2: x0 + ux * hi, y2: y0 + uy * hi };
  }
  if (n >= 5) {
    // the circle through three points spread along the curve
    const [ax, ay] = [pts[0], pts[1]], m = Math.floor(n / 3), q = Math.floor((2 * n) / 3);
    const c = circleThrough(ax, ay, pts[2 * m], pts[2 * m + 1], pts[2 * q], pts[2 * q + 1]);
    if (c && c.r < 1e6 * (far || 1)) {
      let ok = true;
      for (let i = 0; i < n && ok; i++) ok = abs(hypot(pts[2 * i] - c.x, pts[2 * i + 1] - c.y) - c.r) <= tol;
      if (ok) {
        // the swept angle, step by step (the curve's own direction)
        let a = atan2(ay - c.y, ax - c.x), sweep = 0;
        const a0 = a;
        for (let i = 1; i < n; i++) {
          const b = atan2(pts[2 * i + 1] - c.y, pts[2 * i] - c.x);
          let d = b - a;
          if (d > PI) d -= TAU;
          if (d < -PI) d += TAU;
          sweep += d;
          a = b;
        }
        const s = min(abs(sweep), TAU);
        if (s > 1e-9) return sweep > 0 ? { k: 'arc', cx: c.x, cy: c.y, r: c.r, a0, a1: a0 + s } : { k: 'arc', cx: c.x, cy: c.y, r: c.r, a0: a0 - s, a1: a0 };
      }
    }
  }
  return { k: 'poly', pts };
}

function circleThrough(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): { x: number; y: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (abs(d) < 1e-300) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const x = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const y = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { x, y, r: hypot(ax - x, ay - y) };
}

// ------------------------------------------------------------ merging line work

type Iv = [number, number];

function union(iv: Iv[], tol: number): Iv[] {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const out: Iv[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + tol) last[1] = max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function minus(iv: Iv[], cut: Iv[], tol: number): Iv[] {
  let cur = iv;
  for (const [ca, cb] of cut) {
    const next: Iv[] = [];
    for (const [a, b] of cur) {
      if (cb <= a + tol || ca >= b - tol) {
        next.push([a, b]);
        continue;
      }
      if (ca > a + tol) next.push([a, ca]);
      if (cb < b - tol) next.push([cb, b]);
    }
    cur = next;
  }
  return cur;
}

/** A periodic range a0 … a1 as pieces of [0, 2π]. */
function periodic(a0: number, a1: number): Iv[] {
  if (a1 - a0 >= TAU - 1e-12) return [[0, TAU]];
  const s = ((a0 % TAU) + TAU) % TAU, e = s + (a1 - a0);
  return e <= TAU ? [[s, e]] : [[s, TAU], [0, e - TAU]];
}

/** Pieces of [0, 2π] as ranges again, the ones meeting at 0 joined. */
function ranges(iv: Iv[], tol: number): Iv[] {
  if (iv.length === 1 && iv[0][1] - iv[0][0] >= TAU - tol) return [[0, TAU]];
  if (iv.length > 1 && iv[0][0] <= tol && iv[iv.length - 1][1] >= TAU - tol) {
    const first = iv[0], last = iv[iv.length - 1];
    return [[last[0], first[1] + TAU], ...iv.slice(1, -1)];
  }
  return iv;
}

interface Group {
  /** Line: angle in [0, π) and distance; arc: centre and radius; ellipse: centre, radii, angle in [0, π). */
  key: number[];
  kind: 'line' | 'arc' | 'ellipse';
  iv: Iv[][];
}

/**
 * The line work of a view cleaned up: each class keeps what no class before it covers
 * (visible over tangent over hidden, so a hidden back edge under a front one goes), and
 * collinear lines, arcs of one circle and arcs of one ellipse are merged into the fewest
 * pieces. Polylines are kept, less the runs that lie on line work of a class before theirs.
 */
export function overlayPrims(classes: Prim[][], size: number): Prim[][] {
  const tol = size * 1e-6, aTol = 1e-6;
  const groups: Group[] = [];
  const polys: { cls: number; p: Extract<Prim, { k: 'poly' }> }[] = [];
  // groups filed by their first key, so a lookup scans its neighbourhood only
  const buckets = new Map<string, Group[]>();
  const find = (kind: Group['kind'], key: number[], tols: number[]): Group => {
    const w = tols[0] * 4, b = Math.floor(key[0] / w);
    for (const k of [b - 1, b, b + 1]) {
      for (const g of buckets.get(`${kind}${k}`) ?? []) if (key.every((v, i) => abs(g.key[i] - v) <= tols[i])) return g;
    }
    const g: Group = { key, kind, iv: classes.map(() => []) };
    groups.push(g);
    const id = `${kind}${b}`;
    buckets.set(id, [...(buckets.get(id) ?? []), g]);
    return g;
  };
  /** An angle of a direction or an axis in [−aTol, π − aTol), and the half turns it was moved by. */
  const halfTurn = (a: number): [number, number] => {
    let r = ((a % PI) + PI) % PI;
    if (r >= PI - aTol) r -= PI;
    return [r, Math.round((r - a) / PI)];
  };
  classes.forEach((prims, cls) => {
    for (const p of prims) {
      if (p.k === 'line') {
        if (hypot(p.x2 - p.x1, p.y2 - p.y1) < tol) continue;
        const [th] = halfTurn(atan2(p.y2 - p.y1, p.x2 - p.x1));
        const ux = cos(th), uy = sin(th);
        const g = find('line', [th, -uy * p.x1 + ux * p.y1], [aTol, tol]);
        // positions along the group's own direction, so lines found later line up with it
        const gx = cos(g.key[0]), gy = sin(g.key[0]);
        const t1 = gx * p.x1 + gy * p.y1, t2 = gx * p.x2 + gy * p.y2;
        g.iv[cls].push([min(t1, t2), max(t1, t2)]);
      } else if (p.k === 'arc' || (p.k === 'ellipse' && abs(p.rx - p.ry) <= tol)) {
        const a = p.k === 'arc' ? p : { cx: p.cx, cy: p.cy, r: (p.rx + p.ry) / 2, a0: p.t0 + p.rot, a1: p.t1 + p.rot };
        if (a.r < tol) continue;
        const g = find('arc', [a.cx, a.cy, a.r], [tol, tol, tol]);
        g.iv[cls].push(...periodic(a.a0, a.a1));
      } else if (p.k === 'ellipse') {
        // axes turned by π run the parameter half a turn on
        const [rot, turns] = halfTurn(p.rot);
        const dt = turns % 2 ? PI : 0;
        const g = find('ellipse', [p.cx, p.cy, p.rx, p.ry, rot], [tol, tol, tol, tol, aTol]);
        g.iv[cls].push(...periodic(p.t0 + dt, p.t1 + dt));
      } else if (p.pts.length >= 4) polys.push({ cls, p });
    }
  });
  const out: Prim[][] = classes.map(() => []);
  for (const g of groups) {
    const period = g.kind !== 'line';
    const t = g.kind === 'line' ? tol : g.kind === 'arc' ? tol / g.key[2] : tol / g.key[3];
    let above: Iv[] = [];
    g.iv.forEach((iv, cls) => {
      const own = minus(union(iv, t), above, t);
      above = union([...above, ...own], t);
      for (const [a, b] of period ? ranges(own, t) : own) {
        if (b - a < t) continue;
        if (g.kind === 'line') {
          const ux = cos(g.key[0]), uy = sin(g.key[0]), c = g.key[1];
          out[cls].push({ k: 'line', x1: ux * a - uy * c, y1: uy * a + ux * c, x2: ux * b - uy * c, y2: uy * b + ux * c });
        } else if (g.kind === 'arc') out[cls].push({ k: 'arc', cx: g.key[0], cy: g.key[1], r: g.key[2], a0: a, a1: b });
        else out[cls].push({ k: 'ellipse', cx: g.key[0], cy: g.key[1], rx: g.key[2], ry: g.key[3], rot: g.key[4], t0: a, t1: b });
      }
    });
  }
  // polylines: drop the runs lying on line work of a class before theirs
  if (polys.length) {
    const near = coverage(out, size * 2e-4);
    for (const { cls, p } of polys) {
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 4) out[cls].push({ k: 'poly', pts: run });
        run = [];
      };
      for (let i = 0; i + 1 < p.pts.length; i += 2) {
        const x = p.pts[i], y = p.pts[i + 1];
        if (near(x, y, cls)) {
          if (run.length) run.push(x, y);
          flush();
        } else {
          if (!run.length && i) run.push(p.pts[i - 2], p.pts[i - 1]);
          run.push(x, y);
        }
      }
      flush();
    }
    for (let c = 0; c < out.length; c++) out[c] = dedupePolys(out[c], size * 1e-6);
  }
  return out;
}

/** Whether a point lies on the line work of a class before `cls` (within tol), by a grid of segments. */
function coverage(classes: Prim[][], tol: number): (x: number, y: number, cls: number) => boolean {
  const segs: number[] = [], owner: number[] = [];
  classes.forEach((ps, cls) => ps.forEach((p) => {
    const s = samplePrim(p, 720);
    for (let i = 2; i + 1 < s.length; i += 2) {
      segs.push(s[i - 2], s[i - 1], s[i], s[i + 1]);
      owner.push(cls);
    }
  }));
  const cell = tol * 64;
  const grid = new Map<string, number[]>();
  for (let k = 0; k < owner.length; k++) {
    const [ax, ay, bx, by] = segs.slice(4 * k, 4 * k + 4);
    for (let i = Math.floor((min(ax, bx) - tol) / cell); i <= Math.floor((max(ax, bx) + tol) / cell); i++) {
      for (let j = Math.floor((min(ay, by) - tol) / cell); j <= Math.floor((max(ay, by) + tol) / cell); j++) {
        const key = `${i},${j}`;
        const l = grid.get(key);
        if (l) l.push(k);
        else if (grid.size < 2e6) grid.set(key, [k]);
      }
    }
  }
  return (x, y, cls) => {
    for (const k of grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []) {
      if (owner[k] < cls && segDist(x, y, segs[4 * k], segs[4 * k + 1], segs[4 * k + 2], segs[4 * k + 3]) <= tol) return true;
    }
    return false;
  };
}

/** Polylines met twice (either way round) are kept once. */
function dedupePolys(ps: Prim[], tol: number): Prim[] {
  const seen: number[][] = [];
  const same = (a: number[], b: number[]) => {
    if (a.length !== b.length) return false;
    const n = a.length / 2;
    let fwd = true, back = true;
    for (let i = 0; i < n && (fwd || back); i++) {
      fwd &&= abs(a[2 * i] - b[2 * i]) <= tol && abs(a[2 * i + 1] - b[2 * i + 1]) <= tol;
      back &&= abs(a[2 * i] - b[2 * (n - 1 - i)]) <= tol && abs(a[2 * i + 1] - b[2 * (n - 1 - i) + 1]) <= tol;
    }
    return fwd || back;
  };
  return ps.filter((p) => {
    if (p.k !== 'poly') return true;
    if (seen.some((q) => same(q, p.pts))) return false;
    seen.push(p.pts);
    return true;
  });
}

export function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return hypot(x - ax - t * dx, y - ay - t * dy);
}

// ------------------------------------------------------------ detail views: clipping at a circle

/** The parts of a primitive inside the circle about (cx, cy), exact for lines, arcs and ellipses. */
export function clipToCircle(p: Prim, cx: number, cy: number, r: number): Prim[] {
  const inside = (x: number, y: number) => hypot(x - cx, y - cy) <= r;
  switch (p.k) {
    case 'line': {
      const ts = lineCircle(p.x1, p.y1, p.x2, p.y2, cx, cy, r);
      const out: Prim[] = [];
      const cuts = [0, ...ts.filter((t) => t > 0 && t < 1), 1];
      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = primAt(p, cuts[i]), b = primAt(p, cuts[i + 1]), m = primAt(p, (cuts[i] + cuts[i + 1]) / 2);
        if (cuts[i + 1] - cuts[i] > 1e-12 && inside(m[0], m[1])) out.push({ k: 'line', x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      }
      return out;
    }
    case 'arc': {
      const d = hypot(p.cx - cx, p.cy - cy);
      // no crossing: all inside or all outside
      if (d >= r + p.r || d <= abs(r - p.r)) return inside(...primAt(p, 0.5)) && d + p.r <= r + 1e-12 * r ? [p] : [];
      // the angles (about the arc's centre) where the circles cross
      const base = atan2(cy - p.cy, cx - p.cx);
      const h = Math.acos(max(-1, min(1, (p.r * p.r + d * d - r * r) / (2 * p.r * d))));
      return splitPeriodic(p.a0, p.a1, [base - h, base + h], (a0, a1) => ({ ...p, a0, a1 }), (a) => inside(p.cx + p.r * cos(a), p.cy + p.r * sin(a)));
    }
    case 'ellipse': {
      const f = (t: number) => {
        const [x, y] = ellipsePoint(p, t);
        return (x - cx) ** 2 + (y - cy) ** 2 - r * r;
      };
      // sign changes on a fine grid, refined by bisection to the last bit
      const roots: number[] = [];
      const N = 720;
      let ta = p.t0, fa = f(ta);
      for (let i = 1; i <= N; i++) {
        const tb = p.t0 + ((p.t1 - p.t0) * i) / N, fb = f(tb);
        if (fa === 0) roots.push(ta);
        else if (fa * fb < 0) {
          let lo = ta, hi = tb, flo = fa;
          for (let k = 0; k < 80 && hi - lo > 1e-15; k++) {
            const m = (lo + hi) / 2, fm = f(m);
            if (flo * fm <= 0) hi = m;
            else [lo, flo] = [m, fm];
          }
          roots.push((lo + hi) / 2);
        }
        [ta, fa] = [tb, fb];
      }
      const cuts = [p.t0, ...roots.filter((t) => t > p.t0 && t < p.t1), p.t1];
      const out: Prim[] = [];
      for (let i = 0; i + 1 < cuts.length; i++) {
        if (cuts[i + 1] - cuts[i] < 1e-12) continue;
        const m = ellipsePoint(p, (cuts[i] + cuts[i + 1]) / 2);
        if (inside(m[0], m[1])) out.push({ ...p, t0: cuts[i], t1: cuts[i + 1] });
      }
      return out;
    }
    case 'poly': {
      const out: Prim[] = [];
      let run: number[] = [];
      const flush = () => {
        if (run.length >= 4) out.push({ k: 'poly', pts: run });
        run = [];
      };
      for (let i = 2; i + 1 < p.pts.length; i += 2) {
        const seg = clipToCircle({ k: 'line', x1: p.pts[i - 2], y1: p.pts[i - 1], x2: p.pts[i], y2: p.pts[i + 1] }, cx, cy, r) as Extract<Prim, { k: 'line' }>[];
        for (const s of seg) {
          const n = run.length;
          if (n && (abs(run[n - 2] - s.x1) > 1e-12 * r || abs(run[n - 1] - s.y1) > 1e-12 * r)) flush();
          if (!run.length) run.push(s.x1, s.y1);
          run.push(s.x2, s.y2);
        }
        if (!seg.length) flush();
      }
      flush();
      return out;
    }
  }
}

/** Parameters t ∈ ℝ where the segment a + t(b − a) meets the circle. */
function lineCircle(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, r: number): number[] {
  const dx = x2 - x1, dy = y2 - y1, fx = x1 - cx, fy = y1 - cy;
  const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (!(a > 0) || disc <= 0) return [];
  const s = sqrt(disc);
  // the stable pair of roots
  const q = -0.5 * (b + Math.sign(b || 1) * s);
  return [q / a, c / q].sort((u, v) => u - v);
}

/** Split a counter-clockwise range at angles (taken modulo 2π) and keep the pieces whose middle passes `keep`. */
function splitPeriodic(a0: number, a1: number, at: number[], make: (a0: number, a1: number) => Prim, keep: (a: number) => boolean): Prim[] {
  const cuts = [a0, a1];
  for (const c of at) {
    let a = a0 + ((((c - a0) % TAU) + TAU) % TAU);
    for (; a < a1; a += TAU) if (a > a0 + 1e-12 && a < a1 - 1e-12) cuts.push(a);
  }
  cuts.sort((u, v) => u - v);
  const whole = a1 - a0 >= TAU - 1e-12;
  const out: Prim[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] > 1e-12 && keep((cuts[i] + cuts[i + 1]) / 2)) out.push(make(cuts[i], cuts[i + 1]));
  // a whole circle cut twice: the piece across its start is one arc
  if (whole && out.length > 1) {
    const f = out[0] as { a0: number; a1: number }, l = out[out.length - 1] as { a0: number; a1: number };
    if (f.a0 <= a0 + 1e-12 && l.a1 >= a1 - 1e-12) {
      out.splice(out.length - 1, 1);
      out[0] = make(l.a0, f.a1 + TAU);
    }
  }
  return out;
}

// ------------------------------------------------------------ section views: hatching

/** Area of polygon loops by the even–odd rule (a loop inside one loop is a hole). */
export function loopsArea(loops: number[][]): number {
  let A = 0;
  loops.forEach((l, i) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) if (j !== i && pointInLoop(l[0], l[1], loops[j])) depth++;
    A += (depth % 2 ? -1 : 1) * abs(shoelace(l));
  });
  return A;
}

export function shoelace(l: number[]): number {
  let s = 0;
  const n = l.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += l[2 * i] * l[2 * j + 1] - l[2 * j] * l[2 * i + 1];
  }
  return s / 2;
}

export function pointInLoop(x: number, y: number, l: number[]): boolean {
  let inside = false;
  const n = l.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = l[2 * i], yi = l[2 * i + 1], xj = l[2 * j], yj = l[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * ISO 128-50 hatching of loops: parallel lines at `angle` (radians from the paper's x),
 * `spacing` apart (view units), through the origin's family so neighbouring views agree.
 * Returns segments x1, y1, x2, y2 … inside the loops by the even–odd rule.
 */
export function hatch(loops: number[][], angle: number, spacing: number): number[] {
  const ux = cos(angle), uy = sin(angle), vx = -uy, vy = ux;
  let lo = Infinity, hi = -Infinity;
  for (const l of loops) for (let i = 0; i + 1 < l.length; i += 2) {
    const v = vx * l[i] + vy * l[i + 1];
    lo = min(lo, v);
    hi = max(hi, v);
  }
  const out: number[] = [];
  if (!(spacing > 0) || !(hi > lo) || (hi - lo) / spacing > 1e5) return out;
  for (let k = Math.ceil(lo / spacing); k * spacing <= hi; k++) {
    const c = k * spacing;
    const us: number[] = [];
    for (const l of loops) {
      const n = l.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = l[2 * i], ay = l[2 * i + 1], bx = l[2 * j], by = l[2 * j + 1];
        const va = vx * ax + vy * ay, vb = vx * bx + vy * by;
        // half-open, so a vertex on the line counts once
        if ((va <= c && c < vb) || (vb <= c && c < va)) {
          const t = (c - va) / (vb - va);
          us.push(ux * (ax + (bx - ax) * t) + uy * (ay + (by - ay) * t));
        }
      }
    }
    us.sort((a, b) => a - b);
    for (let i = 0; i + 1 < us.length; i += 2) {
      if (us[i + 1] - us[i] <= 0) continue;
      out.push(ux * us[i] + vx * c, uy * us[i] + vy * c, ux * us[i + 1] + vx * c, uy * us[i + 1] + vy * c);
    }
  }
  return out;
}

/**
 * Hatching of the n-th body of a section (ISO 128-50: neighbouring parts differ in angle
 * or spacing): 45°, 135°, then the same at 1.6× and 0.6× the spacing, then 30° and 60°.
 */
export function hatchStyle(n: number, spacing: number): { angle: number; spacing: number } {
  const styles: [number, number][] = [[45, 1], [135, 1], [45, 1.6], [135, 1.6], [45, 0.6], [135, 0.6], [30, 1], [60, 1]];
  const [a, f] = styles[n % styles.length];
  return { angle: (a * PI) / 180, spacing: spacing * f };
}
