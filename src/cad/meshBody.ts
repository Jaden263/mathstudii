// Mesh bodies: triangle meshes imported from STL, OBJ or 3MF, kept as they are. They are
// shown, measured, placed in assemblies, checked for interference and drawn from their
// facets, but they have no exact faces for the B-rep features to work on (Convert to solid
// sews a small closed one into a B-rep instead).
//
// Their volume properties come from the divergence theorem over the triangles, which is
// exact for the polyhedron the mesh is, and only means anything when the mesh is closed:
// every edge shared by exactly two triangles that run along it in opposite directions.
import type { BodyResult } from './buildResult';
import { triangleParts } from './meshTopology';
import type { Mass3, Vec3 } from './solid';
import type { BodyTopology } from './topology';

/** A triangle mesh as a file holds it. */
export interface TriMesh {
  name: string;
  /** #rrggbb */
  color?: string;
  /** x, y, z per vertex. */
  positions: Float32Array | Float64Array;
  /** Three vertex indices per triangle, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

/** What the closed-mesh check found. */
export interface MeshCheck {
  /** Edges with only one triangle (the borders of holes). */
  open: number;
  /** Edges with more than two triangles. */
  nonManifold: number;
  /** Edges whose two triangles run along it the same way (one of them is turned over). */
  flipped: number;
}

export interface MeshBody {
  id: string;
  name: string;
  feature: string;
  /** Welded vertices in part units. */
  positions: Float64Array;
  indices: Uint32Array;
  check: MeshCheck;
  /** Volume properties (part units); only for a closed mesh. */
  mass?: Mass3;
  color?: string;
}

export const isClosed = (c: MeshCheck) => !c.open && !c.nonManifold && !c.flipped;

/** Vertices with exactly the same coordinates made one (STL repeats every vertex for each triangle). */
export function weldMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, scale = 1): { positions: Float64Array; indices: Uint32Array } {
  const index = new Map<string, number>();
  const pos: number[] = [];
  const map = new Uint32Array(positions.length / 3);
  for (let v = 0; v < map.length; v++) {
    const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
    const k = `${x},${y},${z}`;
    let i = index.get(k);
    if (i === undefined) {
      i = pos.length / 3;
      index.set(k, i);
      pos.push(x * scale, y * scale, z * scale);
    }
    map[v] = i;
  }
  // triangles that lost a corner to the welding have no area
  const tri: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = map[indices[t]], b = map[indices[t + 1]], c = map[indices[t + 2]];
    if (a !== b && b !== c && c !== a) tri.push(a, b, c);
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(tri) };
}

/** Whether a welded mesh is closed: each edge between two triangles that run along it in opposite directions. */
export function checkMesh(indices: ArrayLike<number>, nv: number): MeshCheck {
  // directed edges a → b, counted
  const directed = new Map<number, number>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t + k], b = indices[t + ((k + 1) % 3)];
      const key = a * nv + b;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0, nonManifold = 0, flipped = 0;
  const seen = new Set<number>();
  for (const [key, n] of directed) {
    const a = Math.floor(key / nv), b = key % nv;
    const lo = Math.min(a, b) * nv + Math.max(a, b);
    if (seen.has(lo)) continue;
    seen.add(lo);
    const back = directed.get(b * nv + a) ?? 0;
    const total = n + back;
    if (total === 1) open++;
    else if (total > 2) nonManifold++;
    else if (n === 2 || back === 2) flipped++;
  }
  return { open, nonManifold, flipped };
}

/**
 * Volume, centroid and covariance of a closed triangle mesh by the divergence theorem: each
 * triangle with the origin spans a tetrahedron whose signed integrals add up to the solid's
 * (taken about the middle of the box, so far-off meshes keep their digits).
 */
export function meshMass(positions: ArrayLike<number>, indices: ArrayLike<number>): Mass3 {
  let lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    lo = [Math.min(lo[0], positions[i]), Math.min(lo[1], positions[i + 1]), Math.min(lo[2], positions[i + 2])];
    hi = [Math.max(hi[0], positions[i]), Math.max(hi[1], positions[i + 1]), Math.max(hi[2], positions[i + 2])];
  }
  const r: Vec3 = positions.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] : [0, 0, 0];
  let V = 0;
  const F = [0, 0, 0], S = new Array<number>(9).fill(0);
  const p = (i: number) => [positions[3 * i] - r[0], positions[3 * i + 1] - r[1], positions[3 * i + 2] - r[2]];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = p(indices[t]), b = p(indices[t + 1]), c = p(indices[t + 2]);
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    V += det / 6;
    const sum = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
    for (let i = 0; i < 3; i++) {
      F[i] += (det / 24) * sum[i];
      for (let j = 0; j < 3; j++) S[3 * i + j] += (det / 120) * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + sum[i] * sum[j]);
    }
  }
  if (!(Math.abs(V) > 0)) return { V: 0, c: r, C: new Array(9).fill(0) };
  const g = [F[0] / V, F[1] / V, F[2] / V];
  return { V, c: [r[0] + g[0], r[1] + g[1], r[2] + g[2]], C: S.map((s, k) => s - V * g[(k / 3) | 0] * g[k % 3]) };
}

/** The triangles turned the other way round (a closed mesh that came inside out). */
function turned(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) out.set([indices[t], indices[t + 2], indices[t + 1]], t);
  return out;
}

/** A mesh body from a file's mesh, welded and checked, numbers times `scale` (file units to part units). */
export function meshBodyOf(id: string, feature: string, m: TriMesh, scale: number): MeshBody {
  const w = weldMesh(m.positions, m.indices, scale);
  const check = checkMesh(w.indices, w.positions.length / 3);
  const body: MeshBody = { id, name: m.name, feature, positions: w.positions, indices: w.indices, check, ...(m.color ? { color: m.color } : {}) };
  if (isClosed(check)) {
    let mass = meshMass(w.positions, w.indices);
    // wound clockwise throughout: the same solid seen from inside
    if (mass.V < 0) {
      body.indices = turned(w.indices);
      mass = meshMass(w.positions, body.indices);
    }
    if (mass.V > 0) body.mass = mass;
  }
  return body;
}

/** Why a mesh body has no volume, or '' when it has one. */
export function meshWords(b: MeshBody): string {
  const c = b.check;
  if (isClosed(c)) return b.mass ? '' : 'the mesh encloses no volume';
  const bits = [
    c.open ? `${c.open} edge${c.open > 1 ? 's' : ''} with one triangle` : '',
    c.nonManifold ? `${c.nonManifold} edge${c.nonManifold > 1 ? 's' : ''} with more than two` : '',
    c.flipped ? `${c.flipped} edge${c.flipped > 1 ? 's' : ''} between triangles turned the other way` : '',
  ].filter(Boolean);
  return `the mesh is not closed (${bits.join(', ')}): it has no volume, mass or inertia`;
}

function boxOfPositions(p: ArrayLike<number>): { min: Vec3; max: Vec3 } | null {
  if (!p.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]);
    max[k] = Math.max(max[k], p[i + k]);
  }
  return { min, max };
}

// by its triangles: the timeline hands out renamed copies of the same body
const shown = new WeakMap<Uint32Array, BodyResult>();

/** A mesh body as the display, picking and drawings see it: smooth patches as faces, creases as edges. */
export function meshBodyResult(b: MeshBody): BodyResult {
  let r = shown.get(b.indices);
  if (!r) {
    const parts = triangleParts(b.positions, 3, b.indices, boxOfPositions(b.positions));
    r = { id: b.id, name: b.name, feature: b.feature, ...parts, mass: b.mass ?? { V: 0, c: [0, 0, 0], C: new Array(9).fill(0) }, meshOnly: true };
    shown.set(b.indices, r);
  }
  return { ...r, id: b.id, name: b.name, feature: b.feature } as BodyResult;
}

/** Its faces and edges for references (joint origins on it): no names, found by their geometry, which never moves. */
export function meshBodyTopology(b: MeshBody): BodyTopology {
  const r = meshBodyResult(b);
  return { id: b.id, faces: r.faces, edges: r.edges.map(({ points: _, ...e }) => e), vertices: r.vertices, box: r.box, named: true };
}
