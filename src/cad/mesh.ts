// Triangle meshes of the 3-D feature (extrude / revolve) for display and STL export.
//
// Meshes are non-indexed (three vertices per triangle) so flat caps and smooth walls
// can carry their own normals without splitting logic. Triangles are counter-clockwise
// seen from outside. Curved walls get smooth normals; walls meet caps and each other
// at sharp corners with their own face normals, which is also where feature edges go.
import earcut from 'earcut';
import { loopPolygon, type ProfileRegion, type Vec2 } from './profile';

export interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  /** feature edges as line-segment pairs */
  edges: Float32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Arc discretisation for display, and the revolve sweep step. */
const STEP = Math.PI / 48;
const MAX_TRIANGLES = 200_000;
/** Polyline turns sharper than this get a feature edge and a normal crease. */
const SHARP = (20 * Math.PI) / 180;

/** A discretised loop with what the walls need: outward edge normals and creases. */
interface Ring {
  pts: Vec2[];
  /** Outward normal of edge i (pts[i] → pts[i+1]). */
  en: Vec2[];
  /** Smoothed normal at vertex i (meaningful where not sharp). */
  vn: Vec2[];
  sharp: boolean[];
}

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y;
  return a / 2;
}

/** Discretise and orient a loop: ccw = true for outlines, false for holes (solid stays on the left). */
function ring(loop: ProfileRegion['outer'], ccw: boolean, tol: number): Ring | null {
  const raw = loopPolygon(loop, STEP);
  // drop repeated points (zero-length segments, a closing vertex)
  const pts: Vec2[] = [];
  for (const p of raw) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > tol) pts.push(p);
  }
  while (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= tol) pts.pop();
  if (pts.length < 3) return null;
  if (signedArea(pts) > 0 !== ccw) pts.reverse();
  const n = pts.length;
  const en = pts.map((a, i) => {
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; // right of travel = outside
  });
  const vn: Vec2[] = [];
  const sharp: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const p = en[(i + n - 1) % n], q = en[i];
    sharp.push(Math.acos(Math.max(-1, Math.min(1, p.x * q.x + p.y * q.y))) > SHARP);
    const l = Math.hypot(p.x + q.x, p.y + q.y) || 1;
    vn.push({ x: (p.x + q.x) / l, y: (p.y + q.y) / l });
  }
  return { pts, en, vn, sharp };
}

/** Normals at both ends of wall edge i: smooth across gentle turns, creased at corners. */
function wallNormals(r: Ring, i: number): [Vec2, Vec2] {
  const j = (i + 1) % r.pts.length;
  return [r.sharp[i] ? r.en[i] : r.vn[i], r.sharp[j] ? r.en[i] : r.vn[j]];
}

interface Shape {
  rings: Ring[][]; // per region: outer, then holes
  /** Cap triangles in the XY plane, counter-clockwise. */
  caps: Vec2[];
}

function shapes(regions: ProfileRegion[]): Shape {
  let size = 0;
  for (const r of regions) for (const p of loopPolygon(r.outer, STEP)) size = Math.max(size, Math.abs(p.x), Math.abs(p.y));
  const tol = 1e-9 * Math.max(size, 1);
  const rings: Ring[][] = [];
  const caps: Vec2[] = [];
  for (const reg of regions) {
    const outer = ring(reg.outer, true, tol);
    if (!outer) continue;
    const rs = [outer, ...reg.holes.map((h) => ring(h, false, tol)).filter((h): h is Ring => !!h)];
    rings.push(rs);
    const flat: number[] = [];
    const holes: number[] = [];
    const all: Vec2[] = [];
    rs.forEach((r, k) => {
      if (k) holes.push(all.length);
      for (const p of r.pts) { flat.push(p.x, p.y); all.push(p); }
    });
    const idx = earcut(flat, holes, 2);
    for (let t = 0; t < idx.length; t += 3) {
      const a = all[idx[t]], b = all[idx[t + 1]], c = all[idx[t + 2]];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (cross === 0) continue;
      if (cross > 0) caps.push(a, b, c);
      else caps.push(a, c, b);
    }
  }
  return { rings, caps };
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  edges: number[] = [];
  tri(a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]) {
    this.pos.push(...a, ...b, ...c);
    this.nrm.push(...na, ...nb, ...nc);
  }
  edge(a: number[], b: number[]) {
    this.edges.push(...a, ...b);
  }
  done(): Mesh {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i++) {
      const k = i % 3;
      min[k] = Math.min(min[k], this.pos[i]);
      max[k] = Math.max(max[k], this.pos[i]);
    }
    if (!this.pos.length) min.fill(0), max.fill(0);
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), edges: new Float32Array(this.edges), bounds: { min, max } };
  }
}

/** Profile in the XY plane extruded along +Z: z ∈ [0, depth], or centred on z = 0 if symmetric. */
export function extrudeMesh(regions: ProfileRegion[], depth: number, symmetric = false): Mesh {
  const z0 = symmetric ? -Math.abs(depth) / 2 : Math.min(0, depth);
  const z1 = symmetric ? Math.abs(depth) / 2 : Math.max(0, depth);
  const m = new Builder();
  if (!(z1 > z0)) return m.done();
  const { rings, caps } = shapes(regions);
  const up = [0, 0, 1], down = [0, 0, -1];
  for (let t = 0; t < caps.length; t += 3) {
    const [a, b, c] = [caps[t], caps[t + 1], caps[t + 2]];
    m.tri([a.x, a.y, z1], [b.x, b.y, z1], [c.x, c.y, z1], up, up, up);
    m.tri([a.x, a.y, z0], [c.x, c.y, z0], [b.x, b.y, z0], down, down, down);
  }
  for (const r of rings.flat()) {
    const n = r.pts.length;
    for (let i = 0; i < n; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % n];
      const [na, nb] = wallNormals(r, i);
      const NA = [na.x, na.y, 0], NB = [nb.x, nb.y, 0];
      const a0 = [a.x, a.y, z0], b0 = [b.x, b.y, z0], a1 = [a.x, a.y, z1], b1 = [b.x, b.y, z1];
      m.tri(a0, b0, b1, NA, NB, NB);
      m.tri(a0, b1, a1, NA, NB, NA);
      m.edge(a0, b0);
      m.edge(a1, b1);
      if (r.sharp[i]) m.edge(a0, a1);
    }
  }
  return m.done();
}

/**
 * Profile revolved about the in-plane line through p along d, by angle radians
 * (right-hand rule about d; a negative angle turns the other way). Partial
 * revolutions get end caps. A profile crossing the axis is built as given.
 */
export function revolveMesh(regions: ProfileRegion[], axis: { p: Vec2; d: Vec2 }, angle: number): Mesh {
  const m = new Builder();
  const dl = Math.hypot(axis.d.x, axis.d.y);
  if (!(dl > 0) || !(Math.abs(angle) > 0)) return m.done();
  const sg = Math.sign(angle);
  const D = { x: (sg * axis.d.x) / dl, y: (sg * axis.d.y) / dl };
  const full = Math.abs(angle) >= 2 * Math.PI - 1e-9;
  const sweep = full ? 2 * Math.PI : Math.abs(angle);
  const P = axis.p;
  // frame: D along the axis, N in-plane to its right, M = D × N = −Z
  const N = { x: D.y, y: -D.x };
  const { rings, caps } = shapes(regions);
  const edgesTotal = rings.flat().reduce((s, r) => s + r.pts.length, 0);
  let steps = Math.max(1, Math.ceil(sweep / STEP));
  const capTris = full ? 0 : caps.length / 3 * 2;
  if (2 * edgesTotal * steps + capTris > MAX_TRIANGLES) steps = Math.max(full ? 8 : 2, Math.floor((MAX_TRIANGLES - capTris) / (2 * edgesTotal)));
  // stations share exact values at the seam of a full revolution
  const cs = Array.from({ length: steps + 1 }, (_, i) => {
    const t = full && i === steps ? 0 : (sweep * i) / steps;
    return [Math.cos(t), Math.sin(t)];
  });

  // point / vector (x, y in the plane, z) rotated by station k
  const rotV = (x: number, y: number, z: number, k: number): number[] => {
    const [c, s] = cs[k];
    const a = x * D.x + y * D.y, n = x * N.x + y * N.y, mm = -z;
    const nr = n * c - mm * s, mr = n * s + mm * c;
    return [a * D.x + nr * N.x, a * D.y + nr * N.y, -mr];
  };
  const rotP = (q: Vec2, k: number): number[] => {
    const v = rotV(q.x - P.x, q.y - P.y, 0, k);
    return [v[0] + P.x, v[1] + P.y, v[2]];
  };
  const radius = (q: Vec2) => (q.x - P.x) * N.x + (q.y - P.y) * N.y;

  // The sweep moves points with positive radius towards −Z, the opposite of an
  // extrusion, so the winding follows the side of the axis the profile lies on.
  let area = 0, moment = 0;
  for (let t = 0; t < caps.length; t += 3) {
    const [a, b, c] = [caps[t], caps[t + 1], caps[t + 2]];
    const A = ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    area += A;
    moment += (A * (radius(a) + radius(b) + radius(c))) / 3;
  }
  const flip = moment < 0;
  const tri = (a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[]) =>
    flip ? m.tri(a, b, c, na, nb, nc) : m.tri(a, c, b, na, nc, nb);
  const onAxis = (q: Vec2) => Math.abs(radius(q)) <= 1e-12 * Math.max(1, Math.sqrt(Math.abs(area)));

  for (const r of rings.flat()) {
    const n = r.pts.length;
    for (let i = 0; i < n; i++) {
      const a = r.pts[i], b = r.pts[(i + 1) % n];
      const [na, nb] = wallNormals(r, i);
      const za = onAxis(a), zb = onAxis(b);
      for (let k = 0; k < steps; k++) {
        const a0 = rotP(a, k), b0 = rotP(b, k), a1 = rotP(a, k + 1), b1 = rotP(b, k + 1);
        const NA0 = rotV(na.x, na.y, 0, k), NB0 = rotV(nb.x, nb.y, 0, k), NA1 = rotV(na.x, na.y, 0, k + 1), NB1 = rotV(nb.x, nb.y, 0, k + 1);
        // a point on the axis stays put: its triangle of the quad collapses
        if (!zb) tri(a0, b0, b1, NA0, NB0, NB1);
        if (!za) tri(a0, b1, a1, NA0, NB1, NA1);
      }
      if (!full) {
        m.edge(rotP(a, 0), rotP(b, 0));
        m.edge(rotP(a, steps), rotP(b, steps));
      }
      if (r.sharp[i] && !za) for (let k = 0; k < steps; k++) m.edge(rotP(a, k), rotP(a, k + 1));
    }
  }
  if (!full) {
    // start cap faces against the sweep, end cap with it
    const n0 = rotV(0, 0, flip ? -1 : 1, 0), n1 = rotV(0, 0, flip ? 1 : -1, steps);
    for (let t = 0; t < caps.length; t += 3) {
      const [a, b, c] = [caps[t], caps[t + 1], caps[t + 2]];
      // tri() reverses unless flipped, so pass the end cap as is and the start cap reversed
      tri(rotP(a, 0), rotP(c, 0), rotP(b, 0), n0, n0, n0);
      tri(rotP(a, steps), rotP(b, steps), rotP(c, steps), n1, n1, n1);
    }
  }
  return m.done();
}
