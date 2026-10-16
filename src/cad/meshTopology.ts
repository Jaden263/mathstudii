// The mesh kernel's faces, edges and vertices: its "faces" are the smooth patches of a
// Manifold's triangle mesh and its edges the creases between them. They look right but
// carry no exact geometry beyond planes, and no names: references find them by their
// geometry only (topology.ts).
import type { BodyMesh, BodyResult, EdgeInfo, FaceInfo } from './buildResult';
import type { Body } from './design';
import { cross3, frameFromNormal, len3, solidMass, sub3, type Manifold, type Vec3 } from './solid';
import type { BodyTopology } from './topology';

/** Neighbouring triangles whose normals differ by less than this belong to one face. */
const SMOOTH = Math.cos((25 * Math.PI) / 180);

/** Point halfway along a polyline (by length). */
export function polylineMid(p: Float32Array): Vec3 {
  const n = p.length / 3;
  if (!n) return [0, 0, 0];
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2], p[3 * i + 2] - p[3 * i - 1]);
  let left = total / 2;
  for (let i = 1; i < n; i++) {
    const l = Math.hypot(p[3 * i] - p[3 * i - 3], p[3 * i + 1] - p[3 * i - 2], p[3 * i + 2] - p[3 * i - 1]);
    if (l >= left && l > 0) {
      const t = left / l;
      return [0, 1, 2].map((k) => p[3 * i - 3 + k] + (p[3 * i + k] - p[3 * i - 3 + k]) * t) as Vec3;
    }
    left -= l;
  }
  return [p[0], p[1], p[2]];
}

type MeshParts = Pick<BodyResult, 'mesh' | 'faces' | 'edges' | 'vertices' | 'area' | 'box'>;

/** Faces, edges, vertices and an indexed mesh of a Manifold solid: smooth patches and the creases between them. */
export function meshBody(body: Body): BodyResult {
  const out: BodyResult = { id: body.id, name: body.name, feature: body.feature, mass: body.exact ?? solidMass(body.solid), ...emptyParts() };
  return body.solid.isEmpty() ? out : { ...out, ...meshParts(body.solid) };
}

const emptyParts = (): MeshParts => ({ mesh: emptyMesh(), faces: [], edges: [], vertices: [], area: 0, box: null });

const topologies = new WeakMap<Manifold, Omit<BodyTopology, 'id'>>();

/**
 * The mesh kernel's faces, edges and vertices of a solid, without names: references find
 * them by their geometry only, so only where they have not moved.
 */
export function meshTopology(m: Manifold, id: string): BodyTopology {
  let t = topologies.get(m);
  if (!t) {
    const { faces, edges, vertices, box } = m.isEmpty() ? emptyParts() : meshParts(m);
    // the polylines are for display only
    topologies.set(m, (t = { faces, edges: edges.map(({ points: _, ...e }) => e), vertices, box, named: false }));
  }
  return { id, ...t };
}

function meshParts(m: Manifold): MeshParts {
  const out = emptyParts();
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const nt = tv.length / 3;
  const P = (i: number): Vec3 => [vp[i * np], vp[i * np + 1], vp[i * np + 2]];
  const tn = new Float64Array(nt * 3), ta = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const c = cross3(sub3(P(tv[3 * t + 1]), P(tv[3 * t])), sub3(P(tv[3 * t + 2]), P(tv[3 * t])));
    const l = len3(c);
    ta[t] = l / 2;
    if (l > 0) tn.set([c[0] / l, c[1] / l, c[2] / l], 3 * t);
  }
  // the triangle across each half edge
  const nv = vp.length / np;
  const across = new Int32Array(nt * 3).fill(-1);
  const open = new Map<number, number>();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const a = tv[3 * t + k], b = tv[3 * t + ((k + 1) % 3)];
    const twin = open.get(b * nv + a);
    if (twin === undefined) open.set(a * nv + b, 3 * t + k);
    else {
      across[3 * t + k] = (twin / 3) | 0;
      across[twin] = t;
      open.delete(b * nv + a);
    }
  }
  const dotN = (s: number, t: number) => tn[3 * s] * tn[3 * t] + tn[3 * s + 1] * tn[3 * t + 1] + tn[3 * s + 2] * tn[3 * t + 2];
  // smooth patches by flood fill
  const faceOf = new Uint32Array(nt).fill(0xffffffff);
  let nf = 0;
  for (let s = 0; s < nt; s++) {
    if (faceOf[s] !== 0xffffffff) continue;
    const stack = [s];
    faceOf[s] = nf;
    while (stack.length) {
      const t = stack.pop()!;
      for (let k = 0; k < 3; k++) {
        const u = across[3 * t + k];
        if (u >= 0 && faceOf[u] === 0xffffffff && dotN(t, u) >= SMOOTH) {
          faceOf[u] = nf;
          stack.push(u);
        }
      }
    }
    nf++;
  }
  // per face: area, mean normal, centroid; planar when every normal agrees
  const acc = Array.from({ length: nf }, () => ({ area: 0, n: [0, 0, 0] as Vec3, c: [0, 0, 0] as Vec3, flat: true, first: -1 }));
  for (let t = 0; t < nt; t++) {
    const f = acc[faceOf[t]];
    if (f.first < 0) f.first = t;
    else if (dotN(f.first, t) < 1 - 1e-9) f.flat = false;
    f.area += ta[t];
    for (let d = 0; d < 3; d++) {
      f.n[d] += tn[3 * t + d] * ta[t];
      f.c[d] += ((P(tv[3 * t])[d] + P(tv[3 * t + 1])[d] + P(tv[3 * t + 2])[d]) / 3) * ta[t];
    }
  }
  out.faces = acc.map((f, index) => {
    const c: Vec3 = f.area > 0 ? [f.c[0] / f.area, f.c[1] / f.area, f.c[2] / f.area] : [0, 0, 0];
    const info: FaceInfo = { index, key: '', feature: '', type: f.flat ? 'plane' : 'other', area: f.area, c };
    if (f.flat && f.area > 0) info.frame = frameFromNormal(c, f.n);
    out.area += f.area;
    return info;
  });
  // indexed mesh: vertices shared within a face (smooth normals there), split between faces
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const vertex = new Map<number, number>();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tv[3 * t + k], key = v * nf + faceOf[t];
      let i = vertex.get(key);
      if (i === undefined) {
        i = positions.length / 3;
        vertex.set(key, i);
        positions.push(...P(v));
        normals.push(0, 0, 0);
      }
      for (let d = 0; d < 3; d++) normals[3 * i + d] += tn[3 * t + d] * ta[t];
      indices.push(i);
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  out.mesh = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), faceOf };
  // edges: creases between two faces, chained into polylines per face pair
  const segs = new Map<string, [number, number][]>();
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
    const u = across[3 * t + k];
    if (u < t || faceOf[u] === faceOf[t]) continue;
    const fa = Math.min(faceOf[t], faceOf[u]), fb = Math.max(faceOf[t], faceOf[u]);
    const key = `${fa},${fb}`;
    if (!segs.has(key)) segs.set(key, []);
    segs.get(key)!.push([tv[3 * t + k], tv[3 * t + ((k + 1) % 3)]]);
  }
  const corners = new Map<number, number>();
  const corner = (mv: number) => {
    let i = corners.get(mv);
    if (i === undefined) {
      corners.set(mv, (i = out.vertices.length));
      out.vertices.push({ index: i, key: '', p: P(mv), edges: [] });
    }
    return i;
  };
  for (const [key, list] of segs) {
    const [fa, fb] = key.split(',').map(Number) as [number, number];
    for (const chain of chains(list)) {
      const pts = chain.flatMap(P);
      let length = 0;
      for (let i = 3; i < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
      const points = new Float32Array(pts);
      // open chains end at vertices, where creases meet; loops (rims) have none
      const ends = chain[0] !== chain[chain.length - 1];
      const v: [number, number] = ends ? [corner(chain[0]), corner(chain[chain.length - 1])] : [-1, -1];
      const e: EdgeInfo = { index: out.edges.length, key: '', type: chain.length === 2 ? 'line' : 'other', points, length, faces: [fa, fb], mid: polylineMid(points), v };
      if (chain.length === 2) e.line = { a: P(chain[0]), b: P(chain[1]) };
      if (ends) for (const k of new Set(v)) out.vertices[k].edges.push(e.index);
      out.edges.push(e);
    }
  }
  const bb = m.boundingBox();
  out.box = { min: [...bb.min] as Vec3, max: [...bb.max] as Vec3 };
  return out;
}

/** Segments joined end to end into vertex chains (a closed loop repeats its first vertex). */
function chains(segs: [number, number][]): number[][] {
  const next = new Map<number, number[]>();
  const link = (a: number, b: number) => next.set(a, [...(next.get(a) ?? []), b]);
  for (const [a, b] of segs) {
    link(a, b);
    link(b, a);
  }
  const used = new Set<string>();
  const take = (a: number, b: number) => used.add(a < b ? `${a},${b}` : `${b},${a}`);
  const isUsed = (a: number, b: number) => used.has(a < b ? `${a},${b}` : `${b},${a}`);
  const out: number[][] = [];
  // open chains start at a vertex with one neighbour, loops anywhere
  const starts = [...next.keys()].sort((p, q) => (next.get(p)!.length === 1 ? 0 : 1) - (next.get(q)!.length === 1 ? 0 : 1));
  for (const s of starts) {
    for (const n0 of next.get(s)!) {
      if (isUsed(s, n0)) continue;
      const chain = [s, n0];
      take(s, n0);
      let prev = s, cur = n0;
      for (;;) {
        const nb = (next.get(cur) ?? []).filter((v) => v !== prev && !isUsed(cur, v));
        if (nb.length !== 1 || (next.get(cur)?.length ?? 0) > 2) break;
        take(cur, nb[0]);
        chain.push(nb[0]);
        prev = cur;
        cur = nb[0];
      }
      out.push(chain);
    }
  }
  return out;
}

const emptyMesh = (): BodyMesh => ({ positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), faceOf: new Uint32Array(0) });

