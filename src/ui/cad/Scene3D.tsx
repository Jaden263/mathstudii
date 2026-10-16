// Multi-object 3-D scene for the CAD workspace: several meshes with their own colour and
// world transform, sketch lines, construction planes, CPU picking and a ViewCube.
// Bodies come as B-rep display meshes (triangles in one run per face, the exact edges as
// lines), so single faces and edges can be hovered, picked and highlighted.
// Same camera as Cad3DView: orthographic, world X right / Y up / Z towards the viewer at
// yaw 0 / pitch 0, zoom 1 fits the scene bounds, pan in half the shorter canvas side.
// The view belongs to the caller; a gesture only previews it locally and reports it once it ends.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { Mesh } from '../../cad/mesh';
import type { DisplayMesh } from '../../cad/display';
import { clampPitch, clampZoom, panBy, viewRotation as yUpRotation, zoomAt, type Display } from './Cad3DView';

/**
 * The modeller works Z up (as Fusion and most CAD programs do); the camera of the page
 * viewer is Y up. World (x, y, z) is shown as (x, z, −y), so the standard views keep
 * their meaning: front looks along +Y at the XZ plane, top looks down −Z at XY.
 */
export function viewRotation(view: { yaw: number; pitch: number }): number[] {
  const R = yUpRotation(view);
  return [0, 1, 2].flatMap((i) => [R[3 * i], -R[3 * i + 2], R[3 * i + 1]]);
}
import { ViewCube } from './ViewCube';

export type Vec3 = [number, number, number];
type RGB = [number, number, number];
type Pan = { x: number; y: number };

export interface SceneMesh {
  key: string;
  /** A plain triangle soup (profiles), or a body's display mesh with faces and edges. */
  mesh: Mesh | DisplayMesh;
  color: [number, number, number];
  /** column-major 4×4 world transform, default identity */
  matrix?: Float32Array | number[];
  opacity?: number;
  /** drawn with an accent tint + stronger edges */
  highlight?: boolean;
  /** dimmed (e.g. other components while editing one) */
  ghost?: boolean;
  /** false: never returned by picking (default true) */
  pickable?: boolean;
  /** Display meshes: faces and edges drawn in the accent colour (selected) … */
  selFaces?: number[];
  selEdges?: number[];
  /** … and lighter (under the pointer). */
  hoverFace?: number;
  hoverEdge?: number;
  /** Faces painted another colour (the cut faces of a section). */
  paint?: { faces: number[]; color: [number, number, number] };
}

export const isDisplayMesh = (m: Mesh | DisplayMesh): m is DisplayMesh => 'indices' in m;

export interface SceneLines {
  key: string;
  /** world-space segment endpoints, xyz pairs (6 floats per segment) */
  segments: Float32Array;
  color: [number, number, number];
  highlight?: boolean;
  /** always drawn on top (no depth test), e.g. the sketch being edited */
  overlay?: boolean;
  /** left out of the framing (construction axes reach well past the model) */
  unframed?: boolean;
}

export interface ScenePlane {
  key: string;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** half-size of the square, world units */
  size: number;
  color: [number, number, number];
  opacity?: number;
  highlight?: boolean;
  label?: string;
  /** false: never returned by picking (default true) */
  pickable?: boolean;
  /** left out of the framing (a construction plane far off the model) */
  unframed?: boolean;
}

export interface PickHit {
  kind: 'mesh' | 'plane' | 'none';
  key?: string;
  point?: Vec3;
  /** world-space face normal (mesh: triangle normal, plane: u×v) */
  normal?: Vec3;
  triangle?: number;
  /** Display meshes: the face hit, or the edge passed close to (edges win over faces). */
  face?: number;
  edge?: number;
}

export interface SceneView { yaw: number; pitch: number; zoom: number; pan: { x: number; y: number } }

export type Bounds = { min: Vec3; max: Vec3 };

interface Theme {
  dark: boolean;
  text: string;
  muted: string;
  accent: RGB;
  accentCss: string;
}

// ------------------------------------------------------------ small linear algebra

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: ArrayLike<number>): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Row-major 3×3 times vector. */
const mul3 = (m: ArrayLike<number>, v: ArrayLike<number>): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

/** A column-major 4×4 affine transform split up: linear part A (row-major), translation, and what normals and rays need. */
interface Affine {
  m: ArrayLike<number>;
  A: number[];
  t: Vec3;
  det: number;
  /** A⁻¹, row-major */
  inv: number[];
  /** (A⁻¹)ᵀ, row-major: transforms normals */
  nrm: number[];
}

function affine(matrix?: ArrayLike<number>): Affine {
  const m = matrix && matrix.length >= 16 ? matrix : IDENTITY;
  const A = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  // cofactors
  const c = [
    A[4] * A[8] - A[5] * A[7], A[5] * A[6] - A[3] * A[8], A[3] * A[7] - A[4] * A[6],
    A[2] * A[7] - A[1] * A[8], A[0] * A[8] - A[2] * A[6], A[1] * A[6] - A[0] * A[7],
    A[1] * A[5] - A[2] * A[4], A[2] * A[3] - A[0] * A[5], A[0] * A[4] - A[1] * A[3],
  ];
  const det = A[0] * c[0] + A[1] * c[1] + A[2] * c[2];
  const k = det ? 1 / det : 0;
  const nrm = c.map((x) => x * k);
  const inv = [nrm[0], nrm[3], nrm[6], nrm[1], nrm[4], nrm[7], nrm[2], nrm[5], nrm[8]];
  return { m, A, t: [m[12], m[13], m[14]], det, inv, nrm };
}

const applyPoint = (f: Affine, p: ArrayLike<number>): Vec3 => {
  const q = mul3(f.A, p);
  return [q[0] + f.t[0], q[1] + f.t[1], q[2] + f.t[2]];
};

/** Column-major a · b. */
function mul4(a: ArrayLike<number>, b: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = s;
  }
  return out;
}

// ------------------------------------------------------------ camera

/** Framing: the bounding sphere of the bounds (as Cad3DView), plus the depth range that must not clip. */
interface Frame { c: Vec3; r: number; depth: number }

function frameOf(b: Bounds, content?: Bounds | null): Frame {
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 || 1;
  let reach = r;
  if (content) {
    // explicit framing bounds may be smaller than what is drawn: keep all of it inside the depth range
    const cc: Vec3 = [(content.min[0] + content.max[0]) / 2, (content.min[1] + content.max[1]) / 2, (content.min[2] + content.max[2]) / 2];
    const cr = Math.hypot(content.max[0] - content.min[0], content.max[1] - content.min[1], content.max[2] - content.min[2]) / 2;
    reach = Math.max(r, Math.hypot(cc[0] - c[0], cc[1] - c[1], cc[2] - c[2]) + cr);
  }
  return { c, r, depth: reach * 1.05 };
}

/** Column-major view-projection: centre the framing sphere, rotate, fit it to the shorter side, then pan and zoom. */
function viewProjection(f: Frame, R: number[], w: number, h: number, zoom: number, pan: Pan): Float32Array {
  const k = Math.min(w, h), fit = (0.92 / f.r) * zoom;
  const s = [(fit * k) / w, (fit * k) / h, -1 / f.depth]; // nearer = smaller depth
  const off = [(zoom * pan.x * k) / w, (zoom * pan.y * k) / h, 0];
  const out = new Float32Array(16);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) out[col * 4 + row] = R[row * 3 + col] * s[row];
    out[12 + row] = -(R[row * 3] * f.c[0] + R[row * 3 + 1] * f.c[1] + R[row * 3 + 2] * f.c[2]) * s[row] + off[row];
  }
  out[15] = 1;
  return out;
}

function rayFor(view: SceneView, f: Frame, width: number, height: number, px: number, py: number): { origin: Vec3; dir: Vec3 } {
  const R = viewRotation(view);
  const k = Math.min(width, height) / 2 || 1;
  const zoom = clampZoom(view.zoom);
  // screen units → fitted model point q (screen = zoom · (q + pan)) → view coordinates
  const ux = (px - width / 2) / k, uy = (height / 2 - py) / k;
  const vx = (ux / zoom - view.pan.x) * (f.r / 0.92), vy = (uy / zoom - view.pan.y) * (f.r / 0.92);
  const back = 2 * f.depth; // in front of everything that is drawn
  const origin: Vec3 = [0, 1, 2].map((i) => f.c[i] + R[i] * vx + R[3 + i] * vy + R[6 + i] * back) as Vec3;
  return { origin, dir: [-R[6], -R[7], -R[8]] };
}

/**
 * The pick ray through canvas pixel (px, py) (CSS pixels from the top-left) for an orthographic
 * camera framed on bounds: origin in front of the bounds, dir the unit viewing direction.
 */
export function cameraRay(view: SceneView, bounds: Bounds, width: number, height: number, px: number, py: number): { origin: Vec3; dir: Vec3 } {
  return rayFor(view, frameOf(bounds), width, height, px, py);
}

/** World point to canvas pixels (CSS, from the top-left): the inverse of cameraRay. */
export function worldToScreen(view: SceneView, bounds: Bounds, width: number, height: number, p: Vec3): [number, number] {
  return project(view, frameOf(bounds), width, height, p);
}

function project(view: SceneView, f: Frame, width: number, height: number, p: ArrayLike<number>): [number, number] {
  const R = viewRotation(view);
  const k = Math.min(width, height) / 2;
  const zoom = clampZoom(view.zoom);
  const v = mul3(R, sub(p, f.c));
  const ux = zoom * ((v[0] * 0.92) / f.r + view.pan.x), uy = zoom * ((v[1] * 0.92) / f.r + view.pan.y);
  return [width / 2 + ux * k, height / 2 - uy * k];
}

/** Möller–Trumbore, two-sided: the ray parameter t ≥ 0 of the hit, or null (miss, behind, parallel or degenerate). */
export function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = dot(e1, p);
  const scale = Math.hypot(...e1) * Math.hypot(...e2) * Math.hypot(...d);
  if (!(Math.abs(det) > 1e-12 * scale)) return null;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = dot(s, p) * inv;
  if (u < 0 || u > 1) return null;
  const q = cross(s, e1);
  const v = dot(d, q) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = dot(e2, q) * inv;
  return t >= 0 ? t : null;
}

/** Entry / exit of a ray through a padded box, or null. */
function slab(o: ArrayLike<number>, d: ArrayLike<number>, b: Mesh['bounds']): [number, number] | null {
  let t0 = -Infinity, t1 = Infinity;
  const pad = 1e-6 * (Math.abs(b.max[0] - b.min[0]) + Math.abs(b.max[1] - b.min[1]) + Math.abs(b.max[2] - b.min[2]) + 1e-9);
  for (let i = 0; i < 3; i++) {
    const lo = b.min[i] - pad, hi = b.max[i] + pad;
    if (d[i] === 0) {
      if (o[i] < lo || o[i] > hi) return null;
      continue;
    }
    let a = (lo - o[i]) / d[i], c = (hi - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : [t0, t1];
}

/** Corner k (0…2) of triangle t of a mesh, in its model space. */
function corner(m: Mesh | DisplayMesh, t: number, k: number): Vec3 {
  const P = m.positions;
  const i = isDisplayMesh(m) ? 3 * m.indices[3 * t + k] : 9 * t + 3 * k;
  return [P[i], P[i + 1], P[i + 2]];
}

/**
 * Nearest hit along a ray among mesh triangles (each with its world matrix) and plane squares.
 * The ray is taken into each mesh's model space instead of transforming its triangles, so
 * nothing needs caching; an affine map keeps the ray parameter, so hits compare directly.
 * A plane only wins when it is nearer than every mesh hit (planes behind meshes are not picked).
 * With `edgeTol` (world units) the edges of display meshes are picked too when the ray
 * passes within it, unless they lie behind the face hit; an edge wins over its faces.
 */
export function pickScene(ray: { origin: Vec3; dir: Vec3 }, meshes: SceneMesh[], planes: ScenePlane[] = [], edgeTol = 0): PickHit {
  const { origin: o, dir: d } = ray;
  let best = Infinity, bestMesh: SceneMesh | null = null, bestTri = -1, bestAff: Affine | null = null;
  for (const sm of meshes) {
    if (sm.pickable === false) continue;
    const m = sm.mesh, P = m.positions;
    if (!P.length) continue;
    const f = affine(sm.matrix);
    if (!f.det) continue;
    const lo = mul3(f.inv, sub(o, f.t)), ld = mul3(f.inv, d);
    const span = slab(lo, ld, m.bounds);
    if (!span || span[0] > best) continue;
    const [ox, oy, oz] = lo, [dx, dy, dz] = ld;
    const I = isDisplayMesh(m) ? m.indices : null;
    const nt = I ? I.length / 3 : Math.floor(P.length / 9);
    let found = -1, tBest = best;
    for (let t = 0; t < nt; t++) {
      const ia = I ? 3 * I[3 * t] : 9 * t, ib = I ? 3 * I[3 * t + 1] : 9 * t + 3, ic = I ? 3 * I[3 * t + 2] : 9 * t + 6;
      const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
      const e1x = P[ib] - ax, e1y = P[ib + 1] - ay, e1z = P[ib + 2] - az;
      const e2x = P[ic] - ax, e2y = P[ic + 1] - ay, e2z = P[ic + 2] - az;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det === 0) continue; // near-parallel ones fall out of the u, v range
      const inv = 1 / det;
      const sx = ox - ax, sy = oy - ay, sz = oz - az;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt >= 0 && tt < tBest) { tBest = tt; found = t; }
    }
    if (found >= 0) { best = tBest; bestMesh = sm; bestTri = found; bestAff = f; }
  }

  // edges near the ray, not behind the face it hits
  let edge: { sm: SceneMesh; e: number; dist: number; t: number } | null = null;
  if (edgeTol > 0) {
    const behind = Number.isFinite(best) ? best + 3 * edgeTol : Infinity;
    for (const sm of meshes) {
      const m = sm.mesh;
      if (sm.pickable === false || !isDisplayMesh(m) || !m.lines.length) continue;
      const f = affine(sm.matrix);
      if (!f.det) continue;
      const lo = mul3(f.inv, sub(o, f.t)), ld = mul3(f.inv, d);
      const span = slab(lo, ld, { min: m.bounds.min.map((x) => x - edgeTol) as Vec3, max: m.bounds.max.map((x) => x + edgeTol) as Vec3 });
      if (!span) continue;
      const L = m.lines;
      for (let e = 0; e + 1 < m.edgeStart.length; e++) {
        for (let s = m.edgeStart[e]; s < m.edgeStart[e + 1]; s++) {
          const hit = raySegment(lo, ld, L, 6 * s);
          if (!hit || hit.dist > edgeTol || hit.t > behind) continue;
          if (!edge || hit.dist < edge.dist - 1e-12 * edgeTol || (Math.abs(hit.dist - edge.dist) <= 1e-12 * edgeTol && hit.t < edge.t)) edge = { sm, e, dist: hit.dist, t: hit.t };
        }
      }
    }
  }

  // a plane exactly on a face (a sketch plane on it) leaves the face picked
  const tol = 1e-7 * (Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(o[2]) + 1);
  let plane: ScenePlane | null = null, pt = best - tol;
  for (const pl of planes) {
    if (pl.pickable === false) continue;
    const n = cross(pl.u, pl.v);
    const den = dot(d, n);
    if (!(Math.abs(den) > 1e-12 * Math.hypot(...n))) continue;
    const t = dot(sub(pl.origin, o), n) / den;
    if (!(t >= 0 && t < pt)) continue;
    const w = sub([o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]], pl.origin);
    // in-plane coordinates (u and v need not be unit or exactly orthogonal)
    const guu = dot(pl.u, pl.u), guv = dot(pl.u, pl.v), gvv = dot(pl.v, pl.v);
    const g = guu * gvv - guv * guv;
    if (!(g > 0)) continue;
    const a = dot(w, pl.u), b = dot(w, pl.v);
    const s = (a * gvv - b * guv) / g, r = (b * guu - a * guv) / g;
    if (Math.abs(s) * Math.sqrt(guu) <= pl.size && Math.abs(r) * Math.sqrt(gvv) <= pl.size) { plane = pl; pt = t; }
  }
  const at = (t: number): Vec3 => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]];
  if (plane && !edge) return { kind: 'plane', key: plane.key, point: at(pt), normal: norm(cross(plane.u, plane.v)) };
  if (edge) {
    const m = edge.sm.mesh as DisplayMesh;
    const sameMesh = bestMesh === edge.sm && bestTri >= 0;
    return { kind: 'mesh', key: edge.sm.key, point: at(edge.t), edge: edge.e, ...(sameMesh ? { face: m.faceOf[bestTri], triangle: bestTri } : {}) };
  }
  if (bestMesh && bestAff) {
    const m = bestMesh.mesh;
    const a = corner(m, bestTri, 0);
    // counter-clockwise seen from outside, so the side cross product points out; normals take (A⁻¹)ᵀ
    const local = cross(sub(corner(m, bestTri, 1), a), sub(corner(m, bestTri, 2), a));
    const hit: PickHit = { kind: 'mesh', key: bestMesh.key, point: at(best), normal: norm(mul3(bestAff.nrm, local)), triangle: bestTri };
    if (isDisplayMesh(m)) hit.face = m.faceOf[bestTri];
    return hit;
  }
  return { kind: 'none' };
}

/**
 * Closest approach of a ray (o + t·d, d not necessarily unit) and segment s of a line list:
 * the distance and the ray parameter there.
 */
export function raySegment(o: ArrayLike<number>, d: ArrayLike<number>, L: ArrayLike<number>, at: number): { dist: number; t: number } | null {
  const ax = L[at], ay = L[at + 1], az = L[at + 2];
  const ux = L[at + 3] - ax, uy = L[at + 4] - ay, uz = L[at + 5] - az;
  const wx = o[0] - ax, wy = o[1] - ay, wz = o[2] - az;
  const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = d[0] * ux + d[1] * uy + d[2] * uz, c = ux * ux + uy * uy + uz * uz;
  const dd = d[0] * wx + d[1] * wy + d[2] * wz, e = ux * wx + uy * wy + uz * wz;
  const den = a * c - b * b;
  // the segment parameter of the closest point, clamped to the segment
  let s = den > 1e-12 * a * c ? (a * e - b * dd) / den : 0;
  s = Math.max(0, Math.min(1, s));
  const t = (b * s - dd) / a;
  if (t < 0) return null;
  const px = o[0] + t * d[0] - (ax + s * ux), py = o[1] + t * d[1] - (ay + s * uy), pz = o[2] + t * d[2] - (az + s * uz);
  return { dist: Math.hypot(px, py, pz), t };
}

/**
 * Union of the transformed mesh boxes, line endpoints and plane squares; null when empty.
 * Lines and planes marked unframed count only when there is nothing else, or with `all`.
 */
export function sceneBounds(meshes: SceneMesh[], lines: SceneLines[] = [], planes: ScenePlane[] = [], all = false): Bounds | null {
  if (!all && (lines.some((l) => l.unframed) || planes.some((p) => p.unframed))) {
    const b = sceneBounds(meshes, lines.filter((l) => !l.unframed), planes.filter((p) => !p.unframed));
    if (b) return b;
  }
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const add = (p: ArrayLike<number>) => {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(p[k])) return;
    }
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  };
  for (const sm of meshes) {
    if (!sm.mesh.positions.length) continue;
    const f = affine(sm.matrix), { min: a, max: b } = sm.mesh.bounds;
    for (let c = 0; c < 8; c++) add(applyPoint(f, [c & 1 ? b[0] : a[0], c & 2 ? b[1] : a[1], c & 4 ? b[2] : a[2]]));
  }
  for (const l of lines) for (let i = 0; i + 2 < l.segments.length; i += 3) add(l.segments.subarray(i, i + 3));
  for (const p of planes) for (const corner of planeCorners(p)) add(corner);
  return min[0] <= max[0] ? { min, max } : null;
}

function planeCorners(p: ScenePlane): Vec3[] {
  const u = norm(p.u), v = norm(p.v), s = p.size;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [0, 1, 2].map((k) => p.origin[k] + s * (a * u[k] + b * v[k])) as Vec3);
}

// ------------------------------------------------------------ GL renderer

const TRI_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uMvp;
uniform mat3 uRot;
varying vec3 vNrm;
void main() {
  vNrm = uRot * aNrm;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

// Cad3DView's lighting, with an alpha for see-through bodies
const TRI_FS = `
precision mediump float;
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vNrm;
void main() {
  vec3 n = normalize(vNrm);
  if (!gl_FrontFacing) n = -n;
  float key = max(dot(n, normalize(vec3(-0.35, 0.55, 1.0))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.3, 0.5))), 0.0);
  gl_FragColor = vec4(uColor * (0.32 + 0.62 * key + 0.12 * fill), uAlpha);
}`;

// uShift nudges the whole line by a fraction of a pixel: drawn a few times it makes a thick line
const LINE_VS = `
attribute vec3 aPos;
uniform mat4 uMvp;
uniform vec2 uShift;
void main() {
  vec4 p = uMvp * vec4(aPos, 1.0);
  p.xy += uShift * p.w;
  gl_Position = p;
}`;

const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

function program(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error('createShader failed');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

const TRI_SIDES = [[0, 3], [3, 6], [6, 0]] as const;

function triangleEdges(p: Float32Array): Float32Array {
  const out = new Float32Array(p.length * 2);
  let o = 0;
  for (let t = 0; t + 8 < p.length; t += 9) {
    for (const [a, b] of TRI_SIDES) {
      out.set(p.subarray(t + a, t + a + 3), o);
      out.set(p.subarray(t + b, t + b + 3), o + 3);
      o += 6;
    }
  }
  return out;
}

interface MeshBufs {
  pos: WebGLBuffer | null; nrm: WebGLBuffer | null; edge: WebGLBuffer | null; wire: WebGLBuffer | null;
  /** Display meshes: the triangle indices (null: drawn unindexed, without 32-bit index support). */
  idx: WebGLBuffer | null;
  count: number; edges: number; wires: number;
}
interface LineBufs { buf: WebGLBuffer | null; count: number }

interface DrawInput {
  w: number; // device pixels
  h: number;
  dpr: number;
  R: number[];
  frame: Frame;
  zoom: number;
  pan: Pan;
  display: Display;
  theme: Theme;
  meshes: SceneMesh[];
  lines: SceneLines[];
  planes: ScenePlane[];
}

interface Renderer {
  draw(o: DrawInput): void;
  dispose(): void;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];

/** A display mesh without indices: three vertices per triangle, in the same (face-sorted) order. */
function unindexed(m: DisplayMesh): { positions: Float32Array; normals: Float32Array } {
  const n = m.indices.length;
  const positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    positions.set(m.positions.subarray(3 * m.indices[k], 3 * m.indices[k] + 3), 3 * k);
    normals.set(m.normals.subarray(3 * m.indices[k], 3 * m.indices[k] + 3), 3 * k);
  }
  return { positions, normals };
}

function createRenderer(gl: WebGLRenderingContext): Renderer {
  // 32-bit indices: everywhere in practice; without them display meshes are drawn unindexed
  const uint32 = !!gl.getExtension('OES_element_index_uint');
  const tri = program(gl, TRI_VS, TRI_FS);
  const line = program(gl, LINE_VS, LINE_FS);
  const tPos = gl.getAttribLocation(tri, 'aPos'), tNrm = gl.getAttribLocation(tri, 'aNrm');
  const lPos = gl.getAttribLocation(line, 'aPos');
  const u = {
    tMvp: gl.getUniformLocation(tri, 'uMvp'), tRot: gl.getUniformLocation(tri, 'uRot'), tColor: gl.getUniformLocation(tri, 'uColor'), tAlpha: gl.getUniformLocation(tri, 'uAlpha'),
    lMvp: gl.getUniformLocation(line, 'uMvp'), lColor: gl.getUniformLocation(line, 'uColor'), lShift: gl.getUniformLocation(line, 'uShift'),
  };
  // uploaded once per mesh / segment array object, swept when no longer drawn
  const meshBufs = new Map<Mesh | DisplayMesh, MeshBufs>();
  const lineBufs = new Map<Float32Array, LineBufs>();
  const planeFill = gl.createBuffer(), planeEdge = gl.createBuffer();

  const upload = (data: Float32Array) => {
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  };
  const meshOf = (m: Mesh | DisplayMesh): MeshBufs => {
    let b = meshBufs.get(m);
    if (b) return b;
    if (isDisplayMesh(m)) {
      const flat = uint32 ? m : unindexed(m);
      let idx: WebGLBuffer | null = null;
      if (uint32) {
        idx = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
      }
      b = { pos: upload(flat.positions), nrm: upload(flat.normals), idx, edge: m.lines.length ? upload(m.lines) : null, wire: null, count: m.indices.length, edges: m.lines.length / 3, wires: 0 };
    } else {
      b = { pos: upload(m.positions), nrm: upload(m.normals), idx: null, edge: m.edges.length ? upload(m.edges) : null, wire: null, count: m.positions.length / 3, edges: m.edges.length / 3, wires: -1 };
    }
    meshBufs.set(m, b);
    return b;
  };
  const wiresOf = (m: Mesh, b: MeshBufs) => {
    // triangle sides only on first use: twice the vertex data, and only wireframe needs them
    if (b.wires < 0) {
      const segs = triangleEdges(m.positions);
      b.wire = upload(segs);
      b.wires = segs.length / 3;
    }
  };
  const linesOf = (s: Float32Array): LineBufs => {
    let b = lineBufs.get(s);
    if (!b) {
      b = { buf: upload(s), count: Math.floor(s.length / 3) & ~1 };
      lineBufs.set(s, b);
    }
    return b;
  };
  const sweep = (meshes: SceneMesh[], lines: SceneLines[]) => {
    const keepM = new Set(meshes.map((m) => m.mesh)), keepL = new Set(lines.map((l) => l.segments));
    for (const [m, b] of meshBufs) {
      if (keepM.has(m)) continue;
      for (const x of [b.pos, b.nrm, b.edge, b.wire, b.idx]) if (x) gl.deleteBuffer(x);
      meshBufs.delete(m);
    }
    for (const [s, b] of lineBufs) {
      if (keepL.has(s)) continue;
      gl.deleteBuffer(b.buf);
      lineBufs.delete(s);
    }
  };

  return {
    draw(o) {
      const { w, h, R, frame, display, theme } = o;
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0); // transparent: the page shows through
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      sweep(o.meshes, o.lines);
      const VP = viewProjection(frame, R, w, h, o.zoom, o.pan);
      const ink: RGB = theme.dark ? [0.86, 0.89, 0.94] : [0.12, 0.14, 0.18];
      const edgeInk: RGB = theme.dark ? [0.05, 0.06, 0.08] : [0.12, 0.14, 0.18];
      const accent = theme.accent;
      const accentEdge: RGB = theme.dark ? accent : scale(accent, 0.7);
      const px = 0.75 * o.dpr; // thick lines: about 2.5 CSS px across
      const thick: [number, number][] = [[0, 0], [px, 0], [-px, 0], [0, px], [0, -px]];
      const thin: [number, number][] = [[0, 0]];

      // ---- helpers
      const blend = (on: boolean) => {
        if (on) {
          gl.enable(gl.BLEND);
          // the canvas is premultiplied: colour times alpha, alpha itself kept as is
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        } else gl.disable(gl.BLEND);
      };
      const drawLines = (mvp: Float32Array, buf: WebGLBuffer | null, count: number, color: RGB, alpha: number, bold: boolean, mode: number = gl.LINES, first = 0) => {
        if (!count) return;
        gl.useProgram(line);
        gl.uniformMatrix4fv(u.lMvp, false, mvp);
        gl.uniform4fv(u.lColor, [...color, alpha]);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(lPos);
        gl.vertexAttribPointer(lPos, 3, gl.FLOAT, false, 0, 0);
        for (const [sx, sy] of bold ? thick : thin) {
          gl.uniform2f(u.lShift, (2 * sx) / w, (2 * sy) / h);
          gl.drawArrays(mode, first, count);
        }
      };

      interface Item { sm: SceneMesh; b: MeshBufs; mvp: Float32Array; rot: number[]; det: number; color: RGB; alpha: number; depth: number }
      const items: Item[] = [];
      for (const sm of o.meshes) {
        if (!sm.mesh.positions.length) continue;
        const f = affine(sm.matrix);
        if (!f.det) continue;
        const b = meshOf(sm.mesh);
        const mvp = mul4(VP, f.m);
        // view rotation times the normal matrix, column-major for GL
        const n = [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => R[r * 3] * f.nrm[c] + R[r * 3 + 1] * f.nrm[3 + c] + R[r * 3 + 2] * f.nrm[6 + c]));
        const rot = [n[0], n[3], n[6], n[1], n[4], n[7], n[2], n[5], n[8]];
        const bb = sm.mesh.bounds;
        const centre = applyPoint(f, [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2]);
        const op = Math.max(0, Math.min(1, sm.opacity ?? 1));
        const alpha = sm.ghost ? Math.min(op, 0.25) : op;
        let color = sm.color;
        if (sm.highlight) color = mix(color, accent, 0.6);
        if (sm.ghost) color = mix(color, theme.dark ? [0.5, 0.52, 0.56] : [0.72, 0.74, 0.78], 0.4);
        items.push({ sm, b, mvp, rot, det: f.det, color, alpha, depth: dot([R[6], R[7], R[8]], centre) });
      }
      /** Triangles first … first + count − 1 (all of them by default) in a colour. */
      const faces = (it: Item, color: RGB = it.color, first = 0, count = it.b.count) => {
        if (!count) return;
        gl.frontFace(it.det < 0 ? gl.CW : gl.CCW); // a mirroring matrix turns the winding over
        gl.useProgram(tri);
        gl.uniformMatrix4fv(u.tMvp, false, it.mvp);
        gl.uniformMatrix3fv(u.tRot, false, it.rot);
        gl.uniform3fv(u.tColor, color);
        gl.uniform1f(u.tAlpha, it.alpha);
        gl.bindBuffer(gl.ARRAY_BUFFER, it.b.pos);
        gl.enableVertexAttribArray(tPos);
        gl.vertexAttribPointer(tPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, it.b.nrm);
        gl.enableVertexAttribArray(tNrm);
        gl.vertexAttribPointer(tNrm, 3, gl.FLOAT, false, 0, 0);
        if (it.b.idx) {
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, it.b.idx);
          gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
        } else gl.drawArrays(gl.TRIANGLES, first, count);
        gl.disableVertexAttribArray(tNrm);
      };
      /** One face of a display mesh drawn again on top of itself (same depth) in a colour. */
      const face = (it: Item, f: number, color: RGB) => {
        const m = it.sm.mesh;
        if (!isDisplayMesh(m) || f < 0 || f + 1 >= m.faceStart.length) return;
        faces(it, color, m.faceStart[f] * 3, (m.faceStart[f + 1] - m.faceStart[f]) * 3);
      };
      const marks = (it: Item) => {
        const { sm } = it;
        if (sm.paint) for (const f of sm.paint.faces) face(it, f, sm.paint.color);
        for (const f of sm.selFaces ?? []) face(it, f, mix(it.color, accent, 0.65));
        if (sm.hoverFace !== undefined && !sm.selFaces?.includes(sm.hoverFace)) face(it, sm.hoverFace, mix(it.color, accent, 0.35));
      };
      /** One edge of a display mesh, bold. */
      const edgeRun = (it: Item, e: number, color: RGB) => {
        const m = it.sm.mesh;
        if (!isDisplayMesh(m) || e < 0 || e + 1 >= m.edgeStart.length) return;
        drawLines(it.mvp, it.b.edge, (m.edgeStart[e + 1] - m.edgeStart[e]) * 2, color, 1, true, gl.LINES, m.edgeStart[e] * 2);
      };
      const featureEdges = (it: Item) => {
        const { sm, b } = it;
        if (!b.edges) return;
        if (sm.highlight) drawLines(it.mvp, b.edge, b.edges, accentEdge, 1, true);
        else if (display === 'shaded') { /* no edges */ } else if (sm.ghost) drawLines(it.mvp, b.edge, b.edges, edgeInk, 0.15, false);
        else drawLines(it.mvp, b.edge, b.edges, edgeInk, it.alpha, false);
        for (const e of sm.selEdges ?? []) edgeRun(it, e, accentEdge);
        if (sm.hoverEdge !== undefined) edgeRun(it, sm.hoverEdge, mix(accentEdge, [1, 1, 1], theme.dark ? 0.3 : 0.25));
      };
      const sceneLines = (overlay: boolean) => {
        for (const l of o.lines) {
          if (!!l.overlay !== overlay) continue;
          const b = linesOf(l.segments);
          drawLines(VP, b.buf, b.count, l.highlight ? accentEdge : l.color, 1, !!l.highlight);
        }
      };

      // planes: one small dynamic buffer for all of them
      const fill = new Float32Array(o.planes.length * 18), outline = new Float32Array(o.planes.length * 24);
      o.planes.forEach((p, i) => {
        const [a, b, c, d] = planeCorners(p);
        fill.set([...a, ...b, ...c, ...a, ...c, ...d], i * 18);
        outline.set([...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a], i * 24);
      });
      if (o.planes.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, planeFill);
        gl.bufferData(gl.ARRAY_BUFFER, fill, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, planeEdge);
        gl.bufferData(gl.ARRAY_BUFFER, outline, gl.DYNAMIC_DRAW);
      }
      const plane = (p: ScenePlane, i: number) => {
        const color = p.highlight ? mix(p.color, accent, 0.5) : p.color;
        const op = p.opacity ?? 0.15;
        drawLines(VP, planeFill, 6, color, p.highlight ? Math.min(1, Math.max(0.3, op * 2)) : op, false, gl.TRIANGLES, i * 6);
        drawLines(VP, planeEdge, 8, p.highlight ? accentEdge : color, p.highlight ? 1 : 0.6, !!p.highlight, gl.LINES, i * 8);
      };
      const planeDepth = (p: ScenePlane) => dot([R[6], R[7], R[8]], p.origin);

      if (display === 'wireframe') {
        // see-through, as Cad3DView: no faces to hide anything, so no depth test
        gl.disable(gl.DEPTH_TEST);
        blend(true);
        for (const it of items) {
          const tone = it.sm.highlight ? accentEdge : mix(it.sm.color, ink, 0.55);
          const k = it.sm.ghost ? 0.3 : Math.max(0.15, it.alpha);
          // a B-rep body is its edges; a plain mesh shows its triangles faintly as well
          if (!isDisplayMesh(it.sm.mesh)) {
            wiresOf(it.sm.mesh, it.b);
            drawLines(it.mvp, it.b.wire, it.b.wires, ink, 0.18 * k, false);
          }
          drawLines(it.mvp, it.b.edge, it.b.edges, tone, k, !!it.sm.highlight);
          for (const e of it.sm.selEdges ?? []) edgeRun(it, e, accentEdge);
          if (it.sm.hoverEdge !== undefined) edgeRun(it, it.sm.hoverEdge, accentEdge);
        }
        o.planes.forEach(plane);
        sceneLines(false);
        sceneLines(true);
        blend(false);
        return;
      }

      // ---- opaque bodies, their edges, and depth-tested lines
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      blend(false);
      const opaque = items.filter((it) => it.alpha >= 1);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1); // faces pushed back a little so coplanar edges win the depth test
      for (const it of opaque) faces(it);
      // highlighted faces: the same triangles again at the same depth (LEQUAL lets them through)
      for (const it of opaque) marks(it);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      for (const it of opaque) featureEdges(it);
      sceneLines(false);

      // ---- see-through things back to front, without writing depth
      gl.depthMask(false);
      blend(true);
      const glass: ({ depth: number; run: () => void })[] = [
        ...items.filter((it) => it.alpha < 1 && it.alpha > 0).map((it) => ({
          depth: it.depth,
          run: () => {
            // closed bodies: their back half would double the tint
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
            gl.enable(gl.POLYGON_OFFSET_FILL);
            faces(it);
            marks(it);
            gl.disable(gl.POLYGON_OFFSET_FILL);
            gl.disable(gl.CULL_FACE);
            featureEdges(it);
          },
        })),
        ...o.planes.map((p, i) => ({ depth: planeDepth(p), run: () => plane(p, i) })),
      ];
      glass.sort((a, b) => a.depth - b.depth);
      for (const g of glass) g.run();
      gl.frontFace(gl.CCW);

      // ---- overlays on top of everything
      gl.disable(gl.DEPTH_TEST);
      sceneLines(true);
      gl.depthMask(true);
      blend(false);
    },
    dispose() {
      if (gl.isContextLost()) return; // everything is gone already
      sweep([], []);
      gl.deleteBuffer(planeFill);
      gl.deleteBuffer(planeEdge);
      gl.deleteProgram(tri);
      gl.deleteProgram(line);
    },
  };
}

// ------------------------------------------------------------ theme and 2-D overlay

function parseColor(color: string): RGB | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
  }
  const n = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return n.length === 3 && n.every(Number.isFinite) ? (n.map((x) => x / 255) as RGB) : null;
}

/** Same detection as Cad3DView: a light --text means a dark theme. */
function readTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  const text = v('--text', '#1c1d21');
  const t = parseColor(text) ?? [0, 0, 0];
  const dark = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2] > 0.5;
  const fallback = dark ? '#6d9cff' : '#2f6fdf';
  const accentCss = v('--accent', fallback);
  return { dark, text, muted: v('--text-muted', '#686b75'), accent: parseColor(accentCss) ?? parseColor(fallback)!, accentCss };
}

const css = (c: RGB, k = 1) => `rgb(${c.map((x) => Math.round(Math.max(0, Math.min(1, x * k)) * 255)).join(',')})`;

function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, view: SceneView, frame: Frame, planes: ScenePlane[], theme: Theme, triad: boolean) {
  ctx.clearRect(0, 0, w, h);
  const rot = viewRotation(view);
  // plane names beside their +u +v corner
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const p of planes) {
    if (!p.label) continue;
    const [x, y] = project(view, frame, w, h, planeCorners(p)[2]);
    if (!(x > -50 && x < w + 50 && y > -20 && y < h + 20)) continue;
    ctx.font = `${p.highlight ? '600 ' : ''}11px system-ui, sans-serif`;
    ctx.fillStyle = p.highlight ? theme.accentCss : theme.dark ? css(p.color, 1.25) : css(p.color, 0.7);
    ctx.fillText(p.label, x + 4, y - 2);
  }
  if (!triad) return;
  // axis triad, back to front so the nearest axis is on top
  const L = 18, ox = 14 + L, oy = h - 14 - L;
  const axes = [
    { name: 'X', color: '#e03131', v: [rot[0], rot[3], rot[6]] },
    { name: 'Y', color: '#2f9e44', v: [rot[1], rot[4], rot[7]] },
    { name: 'Z', color: '#1c7ed6', v: [rot[2], rot[5], rot[8]] },
  ].sort((a, b) => a.v[2] - b.v[2]);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const a of axes) {
    const x = ox + a.v[0] * L, y = oy - a.v[1] * L;
    ctx.strokeStyle = ctx.fillStyle = a.color;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(x, y);
    ctx.stroke();
    const len = Math.hypot(a.v[0], a.v[1]);
    const [dx, dy] = len > 0.2 ? [a.v[0] / len, -a.v[1] / len] : [0.7, -0.7];
    ctx.fillText(a.name, x + dx * 7, y + dy * 7);
  }
}

// ------------------------------------------------------------ component

type Gesture =
  | { kind: 'orbit' | 'pan'; id: number; x: number; y: number; moved: boolean; shift: boolean; start: SceneView; view: SceneView }
  | { kind: 'pinch'; ids: [number, number]; d0: number; m0: Pan; base: SceneView; start: SceneView; view: SceneView };

const same = (a: SceneView, b: SceneView) => a.yaw === b.yaw && a.pitch === b.pitch && a.zoom === b.zoom && a.pan.x === b.pan.x && a.pan.y === b.pan.y;
const CLICK_SLOP = 4; // px a click may wander before it becomes a drag
const EDGE_PX = 5; // px from an edge that still picks it

function toUnits(el: Element, x: number, y: number): Pan {
  const r = el.getBoundingClientRect(), k = Math.min(r.width, r.height) / 2 || 1;
  return { x: (x - r.left - r.width / 2) / k, y: (r.top + r.height / 2 - y) / k };
}

function wrap(deg: number): number {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

const NONE: PickHit = { kind: 'none' };

export function Scene3D(props: {
  width: number;
  height: number;
  meshes: SceneMesh[];
  lines?: SceneLines[];
  planes?: ScenePlane[];
  view: SceneView;
  onView: (v: SceneView) => void;
  /** world bounds used for framing (zoom 1); default = union of mesh bounds (transformed), lines and planes */
  bounds?: { min: Vec3; max: Vec3 };
  /** 'orbit': left-drag orbits, nothing else. 'full': also pan, wheel / pinch zoom, double-click fit. */
  navigation?: 'orbit' | 'full';
  display?: Display;
  /** left click without drag */
  onPick?: (hit: PickHit, e: { shiftKey: boolean; button: number; clientX: number; clientY: number }) => void;
  /** throttled to animation frames */
  onHover?: (hit: PickHit) => void;
  /** Picks and hovers find the edges of display meshes too (within a few pixels). */
  pickEdges?: boolean;
  /** show the ViewCube (default true in 'full' navigation) */
  viewCube?: boolean;
  showTriad?: boolean;
  /** centered text when nothing to show / no WebGL */
  message?: string;
}): JSX.Element {
  const { width, height, meshes, navigation = 'orbit', display = 'shadedEdges', showTriad = true } = props;
  const lines = props.lines ?? EMPTY_LINES, planes = props.planes ?? EMPTY_PLANES;
  const full = navigation === 'full';
  const cube = props.viewCube ?? full;
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [gl, setGl] = useState<'ok' | 'none' | 'lost'>('ok');
  const [generation, setGeneration] = useState(0);
  const [live, setLive] = useState<{ view: SceneView; kind: Gesture['kind'] | 'wheel' } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Pan>());
  const wheel = useRef<{ start: SceneView; view: SceneView; timer: number } | null>(null);
  const hover = useRef<{ raf: number; x: number; y: number; none: boolean }>({ raf: 0, x: 0, y: 0, none: true });
  const [themeTick, setThemeTick] = useState(0);

  const given: SceneView = { yaw: props.view.yaw, pitch: props.view.pitch, zoom: clampZoom(props.view.zoom ?? 1), pan: { x: props.view.pan?.x ?? 0, y: props.view.pan?.y ?? 0 } };
  const view = live?.view ?? given;

  const content = useMemo(() => sceneBounds(meshes, lines, planes), [meshes, lines, planes]);
  // everything drawn, unframed construction geometry too: it must stay inside the depth range
  const drawn = useMemo(() => sceneBounds(meshes, lines, planes, true), [meshes, lines, planes]);
  const pb = props.bounds;
  const frame = useMemo(
    () => (pb ? frameOf(pb, drawn) : content ? frameOf(content, drawn) : null),
    // the framing bounds come as a fresh object easily: key them by value
    [pb?.min[0], pb?.min[1], pb?.min[2], pb?.max[0], pb?.max[1], pb?.max[2], content, drawn],
  );
  const hasContent = !!content;
  const active = hasContent && gl === 'ok' && !!frame;

  // for listeners, timers and frames, which outlive a render
  const latest = useRef({ view, active, frame, meshes, planes, width, height, onView: props.onView, onHover: props.onHover, edges: !!props.pickEdges });
  useEffect(() => { latest.current = { view, active, frame, meshes, planes, width, height, onView: props.onView, onHover: props.onHover, edges: !!props.pickEdges }; });

  const flushWheel = (): SceneView | null => {
    const w = wheel.current;
    if (!w) return null;
    clearTimeout(w.timer);
    wheel.current = null;
    setLive(null);
    if (!same(w.view, w.start)) latest.current.onView(w.view);
    return w.view;
  };

  /** Pick under a client position, against what is on screen now. */
  const pickAt = (clientX: number, clientY: number): PickHit => {
    const c = canvas.current, L = latest.current;
    if (!c || !L.frame || !L.active) return NONE;
    const r = c.getBoundingClientRect();
    const px = ((clientX - r.left) * L.width) / (r.width || L.width), py = ((clientY - r.top) * L.height) / (r.height || L.height);
    // EDGE_PX screen pixels in world units: screen = zoom · (q · 0.92 / r + pan), in half the shorter side
    const edgeTol = L.edges ? (EDGE_PX * L.frame.r) / (0.92 * clampZoom(L.view.zoom) * (Math.min(L.width, L.height) / 2 || 1)) : 0;
    return pickScene(rayFor(L.view, L.frame, L.width, L.height, px, py), L.meshes, L.planes, edgeTol);
  };

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const obs = new MutationObserver(() => setThemeTick((t) => t + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const onMq = () => setThemeTick((t) => t + 1);
    mq?.addEventListener('change', onMq);
    return () => { obs.disconnect(); mq?.removeEventListener('change', onMq); };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    let ctx: WebGLRenderingContext | null = null;
    try {
      const attrs: WebGLContextAttributes = { antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true };
      ctx = (c.getContext('webgl', attrs) ?? c.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null;
    } catch {
      ctx = null;
    }
    if (!ctx) return setGl('none');
    const init = () => {
      try {
        renderer.current = createRenderer(ctx);
        setGl('ok');
        setGeneration((g) => g + 1);
      } catch {
        renderer.current = null;
        setGl(ctx.isContextLost() ? 'lost' : 'none');
      }
    };
    const onLost = (e: Event) => {
      e.preventDefault(); // lets the browser restore it
      renderer.current = null; // its buffers died with the context
      setGl('lost');
    };
    c.addEventListener('webglcontextlost', onLost);
    c.addEventListener('webglcontextrestored', init);
    init();
    return () => {
      c.removeEventListener('webglcontextlost', onLost);
      c.removeEventListener('webglcontextrestored', init);
      renderer.current?.dispose();
      renderer.current = null;
      cancelAnimationFrame(hover.current.raf);
    };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !full) return;
    const onWheel = (e: WheelEvent) => {
      if (!latest.current.active) return;
      e.preventDefault();
      if (gesture.current) return;
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      const w = wheel.current ?? { start: latest.current.view, view: latest.current.view, timer: 0 };
      clearTimeout(w.timer);
      w.view = zoomAt(w.view, toUnits(c, e.clientX, e.clientY), factor);
      w.timer = window.setTimeout(flushWheel, 250);
      wheel.current = w;
      setLive({ view: w.view, kind: 'wheel' });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => { c.removeEventListener('wheel', onWheel); flushWheel(); };
  }, [full]); // flushWheel reads refs only

  useEffect(() => {
    const c = canvas.current, o = overlay.current;
    if (!c || !o) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    for (const el of [c, o]) {
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
    }
    const theme = readTheme(c);
    const g = o.getContext('2d');
    if (!frame || gl !== 'ok' || !renderer.current) {
      g?.clearRect(0, 0, w, h);
      return;
    }
    const R = viewRotation(view);
    renderer.current.draw({ w, h, dpr, R, frame, zoom: view.zoom, pan: view.pan, display, theme, meshes, lines, planes });
    if (g) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawOverlay(g, width, height, view, frame, planes, theme, showTriad);
    }
  }, [meshes, lines, planes, frame, view.yaw, view.pitch, view.zoom, view.pan.x, view.pan.y, width, height, display, showTriad, themeTick, generation, gl]);

  const end = (g: Gesture, el: Element, id: number) => {
    gesture.current = null;
    el.releasePointerCapture?.(id);
    setLive(null);
    if (!same(g.view, g.start)) props.onView(g.view);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const el = e.currentTarget;
    const touch = full && e.pointerType === 'touch';
    if (touch) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (touch && g && g.kind !== 'pinch' && touches.current.size === 2) {
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      const [a, b] = [...touches.current.values()];
      const m0 = toUnits(el, (a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = { kind: 'pinch', ids: [g.id, e.pointerId], d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), m0, base: g.view, start: g.start, view: g.view };
      return;
    }
    if (touch && touches.current.size > 1) return;
    const pan = full && (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey));
    if (e.button !== 0 && !pan) return;
    e.stopPropagation();
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    cancelAnimationFrame(hover.current.raf);
    hover.current.raf = 0;
    const start = flushWheel() ?? view;
    gesture.current = { kind: pan ? 'pan' : 'orbit', id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, shift: e.shiftKey && e.button === 0, start, view: start };
  };

  const scheduleHover = (x: number, y: number) => {
    const hv = hover.current;
    hv.x = x;
    hv.y = y;
    if (hv.raf) return;
    hv.raf = requestAnimationFrame(() => {
      hv.raf = 0;
      const cb = latest.current.onHover;
      if (!cb || gesture.current) return;
      const hit = pickAt(hv.x, hv.y);
      // a miss after a miss tells nothing new
      if (hit.kind === 'none' && hv.none) return;
      hv.none = hit.kind === 'none';
      cb(hit);
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) {
      if (props.onHover && active && e.pointerType !== 'touch') scheduleHover(e.clientX, e.clientY);
      return;
    }
    if (g.kind === 'pinch') {
      if (!g.ids.includes(e.pointerId)) return;
      const [a, b] = g.ids.map((id) => touches.current.get(id) ?? { x: 0, y: 0 });
      const m = toUnits(e.currentTarget, (a.x + b.x) / 2, (a.y + b.y) / 2);
      g.view = zoomAt(panBy(g.base, { x: m.x - g.m0.x, y: m.y - g.m0.y }), m, Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) / g.d0);
    } else {
      if (g.id !== e.pointerId) return;
      // a click may wobble a little before it counts as a drag
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) <= CLICK_SLOP) return;
      g.moved = true;
      if (g.kind === 'pan') {
        const p = toUnits(e.currentTarget, e.clientX, e.clientY), p0 = toUnits(e.currentTarget, g.x, g.y);
        g.view = panBy(g.start, { x: p.x - p0.x, y: p.y - p0.y });
      } else {
        g.view = { ...g.start, yaw: wrap(g.start.yaw + (e.clientX - g.x) * 0.5), pitch: clampPitch(g.start.pitch + (e.clientY - g.y) * 0.5) };
      }
    }
    setLive({ view: g.view, kind: g.kind });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    touches.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g || (g.kind === 'pinch' ? !g.ids.includes(e.pointerId) : g.id !== e.pointerId)) return;
    end(g, e.currentTarget, e.pointerId);
    // pressed and released in place with the left button: a pick, not an orbit
    if (g.kind !== 'pinch' && !g.moved && e.type === 'pointerup' && (g.kind === 'orbit' || g.shift) && props.onPick) {
      props.onPick(pickAt(e.clientX, e.clientY), { shiftKey: e.shiftKey, button: 0, clientX: e.clientX, clientY: e.clientY });
    }
  };

  const onPointerLeave = () => {
    cancelAnimationFrame(hover.current.raf);
    hover.current.raf = 0;
    if (props.onHover && !hover.current.none && !gesture.current) {
      hover.current.none = true;
      props.onHover(NONE);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !active) return;
    e.preventDefault();
    const fit: SceneView = { ...view, zoom: 1, pan: { x: 0, y: 0 } };
    if (!same(fit, view)) props.onView(fit);
  };

  const onCube = (o: { yaw: number; pitch: number }) => {
    // orientation only: zoom and pan stay where they are
    const base = flushWheel() ?? given;
    const next = { ...base, yaw: o.yaw, pitch: clampPitch(o.pitch) };
    if (!same(next, base)) props.onView(next);
  };

  const text = !hasContent
    ? props.message ?? 'Nothing to show'
    : gl === 'none'
      ? props.message ?? 'No 3-D view (WebGL is not available)'
      : gl === 'lost'
        ? '3-D view paused (graphics context lost)'
        : null;
  const idle = props.onPick ? 'default' : 'grab';
  const cursor = !active ? 'default' : live?.kind === 'pan' ? 'move' : live && live.kind !== 'wheel' ? 'grabbing' : idle;
  const layer = { position: 'absolute', inset: 0, width, height } as const;
  return (
    <div style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <canvas
        ref={canvas}
        style={{ ...layer, touchAction: 'none', cursor, visibility: text ? 'hidden' : 'visible' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={full ? onDoubleClick : undefined}
        onContextMenu={full ? (e) => e.preventDefault() : undefined}
      />
      <canvas ref={overlay} style={{ ...layer, pointerEvents: 'none' }} />
      {cube && !text && (
        <div style={{ position: 'absolute', top: 6, right: 6 }}>
          <ViewCube view={view} onView={onCube} />
        </div>
      )}
      {text && (
        <div style={{ ...layer, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 12, boxSizing: 'border-box', color: 'var(--text-muted)', fontSize: 13 }}>
          {text}
        </div>
      )}
    </div>
  );
}

const EMPTY_LINES: SceneLines[] = [];
const EMPTY_PLANES: ScenePlane[] = [];
