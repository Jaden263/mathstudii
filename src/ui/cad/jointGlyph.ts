// The glyph of a joint in the 3-D view, as Fusion draws one: its frame on the parent (Z
// with an arrow head, X short), an arc for each turning DOF over its limits (a full circle
// without) with a spoke at its value, and a line for each sliding DOF between its limits
// with a mark at its value. Drawn in assembly coordinates, on top of the model.
import { JOINT_DOFS, isAngleDof } from '../../cad/assembly';
import type { DofValues, KinJoint } from '../../cad/kinematics';
import { m4Mul, m4Point, type M4, type Vec3 } from '../../cad/solid';
import type { SceneLines } from './Scene3D';

const GLYPH: [number, number, number] = [0.95, 0.6, 0.05];
const LIMIT: [number, number, number] = [0.85, 0.2, 0.2];

/** The joint's lines, `P` the placement of its parent side (a), `size` the model's. */
export function jointGlyph(j: KinJoint, P: M4, values: DofValues, size: number, key = `jg:${j.id}`): SceneLines[] {
  const W = m4Mul(P, j.Fa);
  const at = (x: number, y: number, z: number): Vec3 => m4Point(W, [x, y, z]);
  const axes: number[] = [], limits: number[] = [];
  const seg = (out: number[], a: Vec3, b: Vec3) => out.push(...a, ...b);
  const L = size * 0.09, r = size * 0.045, h = size * 0.012;
  // the frame: Z with an arrow head, X shorter
  seg(axes, at(0, 0, 0), at(0, 0, L));
  seg(axes, at(0, 0, L), at(h, 0, L - 2 * h));
  seg(axes, at(0, 0, L), at(-h, 0, L - 2 * h));
  seg(axes, at(0, 0, 0), at(L * 0.55, 0, 0));
  const dofs = JOINT_DOFS[j.type];
  const arc = (out: number[], a0: number, a1: number, plane: (a: number) => Vec3) => {
    const n = Math.max(8, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
    for (let i = 0; i < n; i++) seg(out, plane(a0 + ((a1 - a0) * i) / n), plane(a0 + ((a1 - a0) * (i + 1)) / n));
  };
  for (const k of dofs) {
    const v = values[k] ?? 0, lo = j.min[k], hi = j.max[k];
    if (isAngleDof(k)) {
      // yaw in the XY plane; a ball's pitch in XZ and roll in YZ, smaller
      const rr = k === 'angle' ? r : k === 'angle2' ? r * 0.8 : r * 0.65;
      const plane = (a: number, s = 1): Vec3 => {
        const c = rr * s * Math.cos(a), d = rr * s * Math.sin(a);
        return k === 'angle' ? at(c, d, 0) : k === 'angle2' ? at(c, 0, -d) : at(0, c, d);
      };
      if (lo !== undefined || hi !== undefined) {
        arc(axes, lo ?? v - Math.PI, hi ?? v + Math.PI, plane);
        // the stops: short radial ticks outwards
        for (const a of [lo, hi]) if (a !== undefined) seg(limits, plane(a), plane(a, 1.3));
      } else arc(axes, 0, 2 * Math.PI, plane);
      seg(axes, at(0, 0, 0), plane(v));
    } else {
      const dir = (s: number): Vec3 => (k === 'offset' ? at(0, 0, s) : k === 'x' ? at(s, 0, 0) : at(0, s, 0));
      const tick = (s: number): [Vec3, Vec3] => (k === 'offset' ? [at(-h, 0, s), at(h, 0, s)] : k === 'x' ? [at(s, -h, 0), at(s, h, 0)] : [at(-h, s, 0), at(h, s, 0)]);
      const a0 = lo ?? Math.min(v, 0) - L, a1 = hi ?? Math.max(v, 0) + L;
      seg(axes, dir(a0), dir(a1));
      for (const s of [lo, hi]) if (s !== undefined) seg(limits, ...tick(s));
      // the value: a cross on the line
      const [p, q] = tick(v);
      seg(axes, p, q);
      const off = (s: number, d: number): Vec3 => (k === 'offset' ? at(0, d, s) : k === 'x' ? at(s, 0, d) : at(0, s, d));
      seg(axes, off(v, -h), off(v, h));
    }
  }
  const out: SceneLines[] = [{ key, segments: new Float32Array(axes), color: GLYPH, overlay: true, unframed: true }];
  if (limits.length) out.push({ key: `${key}:lim`, segments: new Float32Array(limits), color: LIMIT, overlay: true, unframed: true });
  return out;
}
