// A built design as the display, picking, drawings and exports see it, whichever kernel
// made it: plain objects and typed arrays (safe to postMessage between a worker and the
// UI). Each body has a display mesh whose triangles know their face, a face table, an
// edge table and its mass properties.
//
// The B-rep kernel fills this exactly (occ/result.ts). The mesh kernel is the fallback:
// its "faces" are smooth patches of the triangle mesh and its edges the creases between
// them, so they look right but carry no exact geometry beyond planes.
import {
  bodyMass, buildDesign, type Body, type CadDesign, type DesignNumbers, type Placement,
} from './design';
import { cross3, frameFromNormal, len3, sub3, type Frame, type Manifold, type ManifoldToplevel, type Mass3, type Vec3 } from './solid';

export type SurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'bspline' | 'other';
export type CurveKind = 'line' | 'circle' | 'ellipse' | 'bspline' | 'other';

export interface FaceInfo {
  index: number;
  /**
   * Preliminary stable key from the feature history, `${feature}/${role}`: f1/side:l3 (the
   * side swept by sketch line l3), f1/start, f1/end, f2/hole0:wall, f3.2.f2/hole0:wall (a
   * pattern copy). Not unique once a boolean splits a face; '' when unknown.
   */
  key: string;
  /** Feature that made the face ('' when unknown). */
  feature: string;
  type: SurfaceKind;
  area: number;
  /** Planar faces: a frame at the face centroid, n pointing out of the material. */
  frame?: Frame;
  /** Cylinders, cones and tori (and spheres, through the centre). */
  axis?: { p: Vec3; d: Vec3 };
  /** Cylinder and sphere radius; a cone's radius where its axis starts; a torus' distance from its axis to the tube's centre. */
  radius?: number;
  /** Torus tube radius. */
  minorRadius?: number;
  /** Cone half angle (radians). */
  angle?: number;
}

export interface EdgeInfo {
  index: number;
  /** The keys of the two faces it joins, sorted, as `a|b` ('' when one is unknown). */
  key: string;
  type: CurveKind;
  /** Polyline for display and picking: x, y, z, x, y, z … */
  points: Float32Array;
  length: number;
  circle?: { c: Vec3; axis: Vec3; r: number };
  line?: { a: Vec3; b: Vec3 };
  /** The faces on either side (-1: none; a seam has the same face twice). */
  faces: [number, number];
}

export interface BodyMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Face index of every triangle. */
  faceOf: Uint32Array;
}

export interface BodyResult {
  id: string;
  name: string;
  feature: string;
  mesh: BodyMesh;
  faces: FaceInfo[];
  edges: EdgeInfo[];
  /** Volume properties (component coordinates, part units): exact from the B-rep kernel. */
  mass: Mass3;
  area: number;
  box: { min: Vec3; max: Vec3 } | null;
}

export interface BuildResult {
  kernel: 'brep' | 'mesh';
  components: Record<string, { bodies: BodyResult[]; errors: Record<string, string> }>;
  placements: Record<string, Placement>;
  /** Joint and occurrence problems. */
  errors: Record<string, string>;
}

/** Key of an edge from the keys of its faces. */
export function edgeKey(a: string | undefined, b: string | undefined): string {
  if (!a || !b) return '';
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ------------------------------------------------------------ the mesh kernel's fallback

/** Neighbouring triangles whose normals differ by less than this belong to one face. */
const SMOOTH = Math.cos((25 * Math.PI) / 180);

/** Faces, edges and an indexed mesh of a Manifold solid: smooth patches and the creases between them. */
export function meshBody(body: Body): BodyResult {
  const out: BodyResult = { id: body.id, name: body.name, feature: body.feature, mesh: emptyMesh(), faces: [], edges: [], mass: bodyMass(body), area: 0, box: null };
  const m: Manifold = body.solid;
  if (m.isEmpty()) return out;
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
    const info: FaceInfo = { index, key: '', feature: '', type: f.flat ? 'plane' : 'other', area: f.area };
    if (f.flat && f.area > 0) {
      const c: Vec3 = [f.c[0] / f.area, f.c[1] / f.area, f.c[2] / f.area];
      info.frame = frameFromNormal(c, f.n);
    }
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
  for (const [key, list] of segs) {
    const [fa, fb] = key.split(',').map(Number) as [number, number];
    for (const chain of chains(list)) {
      const pts = chain.flatMap(P);
      let length = 0;
      for (let i = 3; i < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
      const e: EdgeInfo = { index: out.edges.length, key: '', type: chain.length === 2 ? 'line' : 'other', points: new Float32Array(pts), length, faces: [fa, fb] };
      if (chain.length === 2) e.line = { a: P(chain[0]), b: P(chain[1]) };
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

/** The design built with the mesh kernel, as a BuildResult. */
export function meshBuildResult(K: ManifoldToplevel, design: CadDesign, numbers: DesignNumbers): BuildResult {
  const built = buildDesign(K, design, numbers);
  try {
    const out: BuildResult = { kernel: 'mesh', components: {}, placements: built.placements, errors: built.errors };
    for (const [cid, cb] of built.components) out.components[cid] = { bodies: cb.bodies.map(meshBody), errors: cb.errors };
    return out;
  } finally {
    built.free();
  }
}

