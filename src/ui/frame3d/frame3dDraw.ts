// The 3-D view of a frame region: an orbit camera (orthographic, world Z up), projection
// to the SVG, and the geometry of diagrams, deformed shapes and load glyphs in world
// coordinates (m), so the view only projects and draws.
import type { Frame3DRegion } from '../../model/types';
import type { Frame3DResult } from '../../frame3d/evaluate';
import type { Axes, ForceKey, FrameSolution, Vec3 } from '../../frame3d/solve';
import type { Frame3DCamera } from '../../frame3d/model';
import { LENGTH_M } from '../beam/beamDraw';

export interface Basis {
  /** Screen right, screen up, towards the viewer (world). */
  r: Vec3;
  u: Vec3;
  e: Vec3;
}

/** yaw turns the eye about Z (0: in front, looking along +Y), pitch lifts it. */
export function basisOf(cam: Frame3DCamera): Basis {
  const y = (cam.yaw * Math.PI) / 180, p = (cam.pitch * Math.PI) / 180;
  const r: Vec3 = [Math.cos(y), Math.sin(y), 0];
  const e: Vec3 = [Math.sin(y) * Math.cos(p), -Math.cos(y) * Math.cos(p), Math.sin(p)];
  const u: Vec3 = [-Math.sin(p) * Math.sin(y), Math.sin(p) * Math.cos(y), Math.cos(p)];
  return { r, u, e };
}

export interface View3 {
  basis: Basis;
  /** World point at the screen centre, pixels per metre, and that centre in pixels. */
  c: Vec3;
  scale: number;
  sx: number;
  sy: number;
}

export interface P3 {
  x: number;
  y: number;
  /** Larger is nearer the viewer. */
  depth: number;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Bounding sphere of points (centre of their box, half its diagonal; at least 1 m). */
export function sphere(points: Vec3[]): { c: Vec3; R: number } {
  if (!points.length) return { c: [0, 0, 0], R: 5 };
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k]);
    hi[k] = Math.max(hi[k], p[k]);
  }
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { c, R: Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 0.5) };
}

export function makeView(cam: Frame3DCamera, s: { c: Vec3; R: number }, width: number, height: number): View3 {
  return {
    basis: basisOf(cam), c: s.c,
    scale: (cam.zoom * 0.44 * Math.min(width, height)) / s.R,
    sx: width / 2 + cam.panX * width, sy: height / 2 + cam.panY * height,
  };
}

export function project(v: View3, p: Vec3): P3 {
  const d: Vec3 = [p[0] - v.c[0], p[1] - v.c[1], p[2] - v.c[2]];
  return { x: v.sx + dot(d, v.basis.r) * v.scale, y: v.sy - dot(d, v.basis.u) * v.scale, depth: dot(d, v.basis.e) };
}

/** A world direction on the screen (pixels per metre of it). */
export const screenDir = (v: View3, d: Vec3) => ({ x: dot(d, v.basis.r), y: -dot(d, v.basis.u) });

/** Named views. */
export const VIEWS: { id: string; label: string; title: string; yaw: number; pitch: number }[] = [
  { id: 'iso', label: 'Iso', title: 'Isometric view from the front right', yaw: 35, pitch: 25 },
  { id: 'front', label: 'Front', title: 'Front view: X to the right, Z up', yaw: 0, pitch: 0 },
  { id: 'side', label: 'Side', title: 'Side view: Y to the right, Z up', yaw: 90, pitch: 0 },
  { id: 'top', label: 'Top', title: 'Plan: X to the right, Y up', yaw: 0, pitch: 90 },
];

/** Node positions in m: the evaluated ones, else the plain numbers of the table (while there are errors). */
export function nodePositions(r: Frame3DRegion, res?: Frame3DResult): Map<string, Vec3> {
  const k = LENGTH_M[r.lengthUnit] ?? 1;
  const out = new Map<string, Vec3>();
  for (const n of r.nodes) {
    const p = res?.pos[n.id];
    if (p) out.set(n.id, p);
    else {
      const v = [n.x, n.y, n.z].map((s) => Number(s) * k);
      if (v.every(Number.isFinite)) out.set(n.id, v as Vec3);
    }
  }
  return out;
}

/** Which side a force diagram is drawn on, member axes: M on the tension side (+z for M_y, −y for M_z). */
export function diagramDir(key: ForceKey, axes: Axes): Vec3 {
  const [, y, z] = axes;
  if (key === 'Vy') return y;
  if (key === 'Mz') return [-y[0], -y[1], -y[2]];
  return z;
}

/** Largest magnitude of an internal force over the members of a solution (and its lower bound). */
export function forceScale(key: ForceKey, sols: (FrameSolution | undefined)[]): number {
  let m = 0;
  for (const sol of sols) for (const mr of sol?.members ?? []) for (const v of mr[key]) m = Math.max(m, Math.abs(v));
  return m;
}

/** Largest displacement along the members of a solution. */
export function displacementScale(sol?: FrameSolution): number {
  let m = 0;
  for (const mr of sol?.members ?? []) mr.ux.forEach((ux, i) => (m = Math.max(m, Math.hypot(ux, mr.uy[i], mr.uz[i]))));
  return m;
}

/** A tidy factor for the deformed shape: 1, 2, 5 × 10ⁿ. */
export function niceFactor(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 1;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}
