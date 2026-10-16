// Extrusion extras and lofts, built exactly from 2-D geometry:
//  · thin extrude (a shell): the wall is the profile minus its offset, with optional caps
//  · rounded or chamfered start / end edges: the profile offset into the material in
//    layers (a quarter circle for a fillet, one step for a chamfer) joined vertex to vertex
//  · loft: two profiles on different planes, resampled to the same number of points and
//    joined by a ruled surface
// The kernel's Minkowski operations can do general roundings, but they take 15–50 s on a
// small part; these take milliseconds.
import earcut from 'earcut';
import { loopPolygon, type ProfileRegion, type Vec2 } from './profile';
import {
  crossSection, dot3, frameMatrix, framePoint, len3, m4Mul, m4Translate, norm3, regionPolygons, sub3, toMat4,
  type Arena, type Frame, type Manifold, type ManifoldToplevel, type Vec3,
} from './solid';

const ARC_STEP = Math.PI / 36;

export interface ThinOptions {
  t: number;
  side: 'inside' | 'outside' | 'center';
  cap: 'none' | 'start' | 'end' | 'both';
}

/** A thin-walled prism between z0 and z1 (in the frame): the shell of an extrusion. */
export function thinExtrude(K: ManifoldToplevel, arena: Arena, regions: ProfileRegion[], f: Frame, z0: number, z1: number, o: ThinOptions): Manifold {
  const cs = crossSection(K, arena, regionPolygons(regions));
  if (cs.isEmpty()) throw new Error('the profile is empty');
  const h = z1 - z0;
  if (!(o.t > 0)) throw new Error('the wall thickness must be positive');
  const off = (d: number) => arena.add(cs.offset(d, 'Miter', 4));
  const outer = o.side === 'inside' ? cs : o.side === 'outside' ? off(o.t) : off(o.t / 2);
  const inner = o.side === 'inside' ? off(-o.t) : o.side === 'outside' ? cs : off(-o.t / 2);
  const wall = arena.add(outer.subtract(inner));
  if (wall.isEmpty()) throw new Error('the wall is thicker than the profile');
  const caps = o.cap === 'both' ? 2 : o.cap === 'none' ? 0 : 1;
  if (caps * o.t >= h) throw new Error('the caps are thicker than the extrusion');
  let solid = arena.add(K.Manifold.extrude(wall, h));
  const cap = (z: number) => arena.add(arena.add(K.Manifold.extrude(outer, o.t)).translate([0, 0, z]));
  if (o.cap === 'start' || o.cap === 'both') solid = arena.add(solid.add(cap(0)));
  if (o.cap === 'end' || o.cap === 'both') solid = arena.add(solid.add(cap(h - o.t)));
  return arena.add(solid.transform(toMat4(m4Mul(frameMatrix(f), m4Translate([0, 0, z0])))));
}

export interface EdgeOptions {
  type: 'fillet' | 'chamfer';
  r: number;
}

function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[i], r = p[(i + 1) % p.length];
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
}

/** Drop repeated and collinear points (they would give degenerate miters). */
function clean(p: Vec2[], tol: number): Vec2[] {
  let pts = p.filter((q, i) => Math.hypot(q.x - p[(i + 1) % p.length].x, q.y - p[(i + 1) % p.length].y) > tol);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const l = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y);
      if (Math.abs(cr) < 1e-10 * l && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) > 0) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * Every point moved by d to the left of the loop's direction (into the material when
 * outer loops run counter-clockwise and holes clockwise), keeping one point per corner.
 */
function offsetLoop(p: Vec2[], d: number): Vec2[] {
  const n = p.length;
  return p.map((b, i) => {
    const a = p[(i + n - 1) % n], c = p[(i + 1) % n];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const n1 = { x: -(b.y - a.y) / l1, y: (b.x - a.x) / l1 }, n2 = { x: -(c.y - b.y) / l2, y: (c.x - b.x) / l2 };
    const m = { x: n1.x + n2.x, y: n1.y + n2.y };
    const ml = Math.hypot(m.x, m.y);
    if (ml < 1e-9) throw new Error('the profile turns back on itself: it cannot be rounded');
    const cosHalf = (m.x * n1.x + m.y * n1.y) / ml;
    if (cosHalf < 0.15) throw new Error('a corner of the profile is too sharp to round (under ~17°)');
    const k = d / cosHalf / ml;
    return { x: b.x + m.x * k, y: b.y + m.y * k };
  });
}

function segmentsCross(p: Vec2[]): boolean {
  const n = p.length;
  const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = p[j], d = p[(j + 1) % n];
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x)) continue;
      if (Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) continue;
      const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** Closed mesh from rings of points (same count per loop in every layer) and two capped ends. */
function layeredSolid(K: ManifoldToplevel, arena: Arena, layers: { z: number; loops: Vec2[][] }[], M: number[]): Manifold {
  const verts: number[] = [];
  const tris: number[] = [];
  const nLoops = layers[0].loops.length;
  const base: number[][] = []; // base[layer][loop] = first vertex index
  layers.forEach((L, li) => {
    base.push([]);
    L.loops.forEach((loop) => {
      base[li].push(verts.length / 3);
      for (const q of loop) verts.push(q.x, q.y, L.z);
    });
  });
  // walls: loops run with the material on their left, so (i, i+1, up) faces outwards
  for (let li = 0; li + 1 < layers.length; li++) {
    for (let k = 0; k < nLoops; k++) {
      const n = layers[li].loops[k].length;
      for (let i = 0; i < n; i++) {
        const a = base[li][k] + i, b = base[li][k] + ((i + 1) % n), c = base[li + 1][k] + ((i + 1) % n), d = base[li + 1][k] + i;
        tris.push(a, b, c, a, c, d);
      }
    }
  }
  // caps: earcut each end (outer first, then holes), bottom facing down, top up
  const cap = (li: number, up: boolean) => {
    const flat: number[] = [];
    const holes: number[] = [];
    const idx: number[] = [];
    layers[li].loops.forEach((loop, k) => {
      if (k) holes.push(flat.length / 2);
      loop.forEach((q, i) => {
        flat.push(q.x, q.y);
        idx.push(base[li][k] + i);
      });
    });
    const t = earcut(flat, holes);
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [idx[t[i]], idx[t[i + 1]], idx[t[i + 2]]];
      // the top faces +z, the bottom −z (counter-clockwise seen from outside)
      const cz = (verts[3 * b] - verts[3 * a]) * (verts[3 * c + 1] - verts[3 * a + 1]) - (verts[3 * b + 1] - verts[3 * a + 1]) * (verts[3 * c] - verts[3 * a]);
      if (cz > 0 === up) tris.push(a, b, c);
      else tris.push(a, c, b);
    }
  };
  cap(0, false);
  cap(layers.length - 1, true);
  // earcut's winding depends on the input; make every triangle face out by the signed volume
  let vol = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]].map((v) => [verts[3 * v], verts[3 * v + 1], verts[3 * v + 2]]);
    vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const out = vol < 0 ? tris.map((_, i) => tris[i - (i % 3) + [0, 2, 1][i % 3]]) : tris;
  const mesh = new K.Mesh({ numProp: 3, vertProperties: Float32Array.from(verts), triVerts: Uint32Array.from(out) });
  let m: Manifold;
  try {
    m = arena.add(new K.Manifold(mesh));
  } catch {
    throw new Error('the rounding does not fit this profile — try a smaller radius');
  }
  if (m.status() !== 'NoError' || m.isEmpty()) throw new Error('the rounding does not fit this profile — try a smaller radius');
  return arena.add(m.transform(toMat4(M)));
}

/**
 * A prism between z0 and z1 whose start and/or end edges are rounded or chamfered by
 * offsetting the profile into the material in layers.
 */
export function shapedExtrude(K: ManifoldToplevel, arena: Arena, regions: ProfileRegion[], f: Frame, z0: number, z1: number, start?: EdgeOptions, end?: EdgeOptions): Manifold {
  const h = z1 - z0;
  const rs = start?.r ?? 0, re = end?.r ?? 0;
  if (rs < 0 || re < 0) throw new Error('the edge size must be positive');
  if (rs + re >= h - 1e-9) throw new Error('the roundings are larger than the extrusion');
  // layer list: (offset, z) from the start face to the end face
  const steps = (o: EdgeOptions | undefined): [number, number][] => {
    if (!o || !(o.r > 0)) return [[0, 0]];
    if (o.type === 'chamfer') return [[o.r, 0], [0, o.r]];
    const n = 8;
    return Array.from({ length: n + 1 }, (_, j) => {
      const th = (j * Math.PI) / (2 * n);
      return [o.r * (1 - Math.sin(th)), o.r * (1 - Math.cos(th))] as [number, number];
    });
  };
  const bottom = steps(start); // offset falls from r to 0 while z rises from 0 to r
  const top = steps(end).map(([d, z]) => [d, h - z] as [number, number]).reverse();
  const layerDefs: [number, number][] = [...bottom, ...top].filter((q, i, a) => i === 0 || Math.abs(q[1] - a[i - 1][1]) > 1e-12 || Math.abs(q[0] - a[i - 1][0]) > 1e-12);
  const M = m4Mul(frameMatrix(f), m4Translate([0, 0, z0]));
  const solids: Manifold[] = [];
  for (const r of regions) {
    let size = 0;
    const loops = [r.outer, ...r.holes].map((loop, k) => {
      const pts = loopPolygon(loop, ARC_STEP);
      for (const q of pts) size = Math.max(size, Math.abs(q.x), Math.abs(q.y));
      const c = clean(pts, 1e-9 * Math.max(size, 1));
      // material on the left: outer counter-clockwise, holes clockwise
      const ccw = signedArea(c) > 0;
      return (k === 0) === ccw ? c : [...c].reverse();
    });
    const layers = layerDefs.map(([d, z]) => {
      const ls = loops.map((l) => (d > 0 ? offsetLoop(l, d) : l));
      // an edge that turned round (the offset passed through the profile) or loops that cross
      const flipped = (l: Vec2[], k: number) => l.some((q, i) => {
        const o = loops[k], j = (i + 1) % l.length;
        return (l[j].x - q.x) * (o[j].x - o[i].x) + (l[j].y - q.y) * (o[j].y - o[i].y) <= 0;
      });
      if (d > 0 && ls.some((l, k) => flipped(l, k) || segmentsCross(l) || (k === 0 ? signedArea(l) <= 0 : signedArea(l) >= 0))) {
        throw new Error('the rounding is too large for this profile — try a smaller radius');
      }
      return { z, loops: ls };
    });
    solids.push(layeredSolid(K, arena, layers, M));
  }
  return solids.length === 1 ? solids[0] : arena.add(K.Manifold.union(solids));
}

/** Points along a loop at equal arc-length spacing. */
function resample(p: Vec2[], n: number): Vec2[] {
  const L: number[] = [0];
  for (let i = 0; i < p.length; i++) L.push(L[i] + Math.hypot(p[(i + 1) % p.length].x - p[i].x, p[(i + 1) % p.length].y - p[i].y));
  const total = L[p.length];
  const out: Vec2[] = [];
  let k = 0;
  for (let j = 0; j < n; j++) {
    const s = (j / n) * total;
    while (k < p.length - 1 && L[k + 1] < s) k++;
    const a = p[k], b = p[(k + 1) % p.length], t = (s - L[k]) / (L[k + 1] - L[k] || 1);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/**
 * Whether the second end of a loft must run the other way round: both loops (normals na,
 * nb by the right-hand rule, centres ca, cb) have to turn the same way about the loft's
 * path from ca to cb, which each normal's side of that path tells. Comparing the normals
 * alone cannot tell for ends at right angles (a floor to a wall on either side). Ends whose
 * path lies in one of their planes fall back to that.
 */
export function loftTurned(na: Vec3, ca: Vec3, nb: Vec3, cb: Vec3): boolean {
  const a = norm3(na), b = norm3(nb), d = sub3(cb, ca);
  const sa = dot3(a, d), sb = dot3(b, d), tol = 1e-6 * len3(d);
  return Math.abs(sa) > tol && Math.abs(sb) > tol ? sa * sb < 0 : dot3(a, b) < 0;
}

/** A solid joining a profile on one sketch to a profile on another (outer loops). */
export function loftSolid(K: ManifoldToplevel, arena: Arena, a: { region: ProfileRegion; frame: Frame }, b: { region: ProfileRegion; frame: Frame }): Manifold {
  const loop3 = (s: { region: ProfileRegion; frame: Frame }) => {
    const p = clean(loopPolygon(s.region.outer, ARC_STEP), 1e-9);
    const ccw = signedArea(p) > 0;
    return (ccw ? p : [...p].reverse()).map((q) => framePoint(s.frame, q));
  };
  const A = loop3(a), B0 = loop3(b);
  const n = Math.max(48, A.length, B0.length);
  const rs = (pts: Vec3[], f: Frame) => {
    // resample in the sketch plane, then back to 3-D
    const to2 = (q: Vec3): Vec2 => {
      const d: Vec3 = [q[0] - f.o[0], q[1] - f.o[1], q[2] - f.o[2]];
      return { x: d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], y: d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2] };
    };
    return resample(pts.map(to2), n).map((q) => framePoint(f, q));
  };
  const PA = rs(A, a.frame);
  let PB = rs(B0, b.frame);
  // both loops must run the same way round the loft axis: compare their normals
  const ctr = (P: Vec3[]) => P.reduce((s, q) => [s[0] + q[0] / P.length, s[1] + q[1] / P.length, s[2] + q[2] / P.length] as Vec3, [0, 0, 0] as Vec3);
  const nrm = (P: Vec3[]) => {
    const c = ctr(P);
    const s: Vec3 = [0, 0, 0];
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      const u: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]], v: Vec3 = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
      s[0] += u[1] * v[2] - u[2] * v[1]; s[1] += u[2] * v[0] - u[0] * v[2]; s[2] += u[0] * v[1] - u[1] * v[0];
    }
    return s;
  };
  if (loftTurned(nrm(PA), ctr(PA), nrm(PB), ctr(PB))) PB = [...PB].reverse();
  // start where the two loops are closest, so the ruled surface does not twist
  const cA = ctr(PA), cB = ctr(PB);
  let best = 0, bestD = Infinity;
  for (let s = 0; s < n; s++) {
    let d = 0;
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 24))) {
      const p = PA[i], q = PB[(i + s) % n];
      d += (p[0] - cA[0] - q[0] + cB[0]) ** 2 + (p[1] - cA[1] - q[1] + cB[1]) ** 2 + (p[2] - cA[2] - q[2] + cB[2]) ** 2;
    }
    if (d < bestD) { bestD = d; best = s; }
  }
  PB = PB.map((_, i) => PB[(i + best) % n]);
  const verts: number[] = [];
  for (const q of [...PA, ...PB]) verts.push(q[0], q[1], q[2]);
  const tris: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(i, j, n + j, i, n + j, n + i);
  }
  // caps, each triangulated in its own plane
  const capIdx = (P: Vec3[], f: Frame, off: number, flip: boolean) => {
    const flat: number[] = [];
    for (const q of P) {
      const d: Vec3 = [q[0] - f.o[0], q[1] - f.o[1], q[2] - f.o[2]];
      flat.push(d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2], d[0] * f.v[0] + d[1] * f.v[1] + d[2] * f.v[2]);
    }
    const t = earcut(flat);
    for (let i = 0; i < t.length; i += 3) tris.push(...(flip ? [off + t[i], off + t[i + 2], off + t[i + 1]] : [off + t[i], off + t[i + 1], off + t[i + 2]]));
  };
  capIdx(PA, a.frame, 0, false);
  capIdx(PB, b.frame, n, true);
  // the caps came out of earcut in whatever winding: fix each cap against the walls by volume
  const volume = (T: number[]) => {
    let v = 0;
    for (let i = 0; i < T.length; i += 3) {
      const [p, q, r] = [T[i], T[i + 1], T[i + 2]].map((x) => [verts[3 * x], verts[3 * x + 1], verts[3 * x + 2]]);
      v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
    }
    return v;
  };
  const wall = tris.slice(0, 6 * n);
  const capA = tris.slice(6 * n, 6 * n + (tris.length - 6 * n) / 2);
  const capB = tris.slice(6 * n + (tris.length - 6 * n) / 2);
  const flipT = (T: number[]) => T.map((_, i) => T[i - (i % 3) + [0, 2, 1][i % 3]]);
  // try the four winding combinations of the caps; the closed one has a consistent volume sign
  let tri: number[] | null = null;
  for (const fa of [false, true]) for (const fb of [false, true]) {
    if (tri) continue;
    const T = [...wall, ...(fa ? flipT(capA) : capA), ...(fb ? flipT(capB) : capB)];
    const mesh = new K.Mesh({ numProp: 3, vertProperties: Float32Array.from(verts), triVerts: Uint32Array.from(volume(T) < 0 ? flipT(T) : T) });
    let m: Manifold;
    try {
      m = new K.Manifold(mesh);
    } catch {
      continue;
    }
    if (m.status() === 'NoError' && !m.isEmpty() && m.volume() > 0) {
      arena.add(m);
      return m;
    }
    m.delete();
  }
  throw new Error('the two profiles cannot be lofted (they may cross each other)');
}
