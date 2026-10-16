// Construction geometry as built: the planes, axes and points of Fusion's Construct menu,
// worked out from what they were made from. The timeline (design.ts) finds the planes,
// axes, points, curves and faces they refer to on the bodies built before them (by their
// references, so they follow edits) and hands them over here; this file only does the
// geometry, kernel-neutral.
import type { ConstructItem, Datum } from './design';
import type { FaceInfo } from './buildResult';
import { add3, cross3, dot3, frameFromNormal, len3, m4Dir, m4Rotate, norm3, scale3, sub3, type Frame, type Vec3 } from './solid';

/** A curve the construction goes along: a point and unit tangent at a fraction t of its length. */
export interface CurveAt {
  at(t: number): { p: Vec3; d: Vec3 };
  line?: { a: Vec3; b: Vec3 };
  circle?: { c: Vec3; axis: Vec3; r: number };
}

/** What the timeline finds for a construction item: each throws with a message when its pick is gone or of the wrong kind. */
export interface ConstructContext {
  /** A plane's frame; a flat face's has its centre for origin (`face`). */
  plane(pick: unknown, what: string): Frame & { face?: boolean };
  axis(pick: unknown, what: string): { p: Vec3; d: Vec3 };
  /** The plane an axis was drawn in or lies on (a sketch line's sketch, an edge's flat face), if any. */
  axisPlane(pick: unknown): Vec3 | null;
  point(pick: unknown, what: string): Vec3;
  curve(pick: unknown, what: string): CurveAt;
  face(pick: unknown, what: string): FaceInfo;
}

const turn = (v: Vec3, d: Vec3, angle: number) => m4Dir(m4Rotate([0, 0, 0], d, angle), v);
/** A unit vector square to d: v's part square to it, or any when v is (nearly) along it. */
function square(v: Vec3 | null, d: Vec3): Vec3 {
  const w = v ? sub3(v, scale3(d, dot3(v, d))) : null;
  if (w && len3(w) > 1e-9) return norm3(w);
  return frameFromNormal([0, 0, 0], d).u;
}
/** A plane's frame with the component origin projected onto it and a level x axis (as a sketch on a face). */
const planeThrough = (p: Vec3, n: Vec3): Frame => {
  const z = norm3(n);
  return frameFromNormal(scale3(z, dot3(p, z)), z);
};
/** A plane through o with its x axis along u. */
const planeAlong = (o: Vec3, u: Vec3, n: Vec3): Frame => {
  const z = norm3(n), x = norm3(sub3(u, scale3(z, dot3(u, z))));
  return { o, u: x, v: cross3(z, x), n: z };
};

/** Where a curve first crosses a plane (t from its start), or null. */
function crossing(c: CurveAt, o: Vec3, n: Vec3): Vec3 | null {
  const side = (t: number) => dot3(sub3(c.at(t).p, o), n);
  const N = c.line ? 1 : 256;
  let t0 = 0, s0 = side(0);
  if (Math.abs(s0) < 1e-12) return c.at(0).p;
  for (let i = 1; i <= N; i++) {
    const t1 = i / N, s1 = side(t1);
    if (s0 * s1 <= 0) {
      // bisection, then the point at the root
      let a = t0, b = t1, sa = s0;
      for (let k = 0; k < 80 && b - a > 1e-15; k++) {
        const m = (a + b) / 2, sm = side(m);
        if (sa * sm <= 0) b = m;
        else [a, sa] = [m, sm];
      }
      return c.at((a + b) / 2).p;
    }
    [t0, s0] = [t1, s1];
  }
  return null;
}

/** The datum a construction item makes; `p` holds its evaluated sizes (lengths in part units, angles in radians). */
export function datumOf(item: ConstructItem, p: Record<string, number>, cx: ConstructContext): Datum {
  if (item.kind === 'plane') return { kind: 'plane', frame: planeOf(item.def, p, cx) };
  if (item.kind === 'axis') {
    const def = item.def;
    switch (def.type) {
      case 'points': {
        const a = cx.point(def.a, 'first point'), b = cx.point(def.b, 'second point');
        if (!(len3(sub3(b, a)) > 0)) throw new Error('the two points are the same point');
        return { kind: 'axis', p: a, d: norm3(sub3(b, a)) };
      }
      case 'edge': {
        const c = cx.curve(def.edge, 'edge');
        if (c.line) return { kind: 'axis', p: c.line.a, d: norm3(sub3(c.line.b, c.line.a)) };
        if (c.circle) return { kind: 'axis', p: c.circle.c, d: norm3(c.circle.axis) };
        throw new Error('the edge must be straight, a circle or an arc');
      }
      case 'cylinder': {
        const f = cx.face(def.face, 'face');
        if (!f.axis || f.type === 'sphere' || f.type === 'plane') throw new Error('pick a cylindrical, conical or toroidal face');
        return { kind: 'axis', p: f.axis.p, d: norm3(f.axis.d) };
      }
      case 'normal': {
        const f = cx.face(def.face, 'face');
        const at = def.point !== undefined ? cx.point(def.point, 'point') : null;
        if (f.type === 'plane' && f.frame) {
          const n = norm3(f.frame.n), q = at ?? f.c;
          return { kind: 'axis', p: sub3(q, scale3(n, dot3(sub3(q, f.frame.o), n))), d: n };
        }
        if ((f.type === 'cylinder' || f.type === 'sphere') && f.axis && f.radius) {
          if (!at) throw new Error(`pick a point for the normal to a ${f.type}`);
          const d = norm3(f.axis.d), w = sub3(at, f.axis.p);
          const r = f.type === 'sphere' ? w : sub3(w, scale3(d, dot3(w, d)));
          if (!(len3(r) > 0)) throw new Error('the point is on the axis: there the normal has no direction');
          const u = norm3(r);
          const foot = f.type === 'sphere' ? f.axis.p : add3(f.axis.p, scale3(d, dot3(w, d)));
          return { kind: 'axis', p: add3(foot, scale3(u, f.radius)), d: f.outward === false ? scale3(u, -1) : u };
        }
        throw new Error('the normal goes on a flat, cylindrical or spherical face');
      }
    }
  }
  const def = item.def;
  switch (def.type) {
    case 'vertex':
      return { kind: 'point', p: cx.point(def.vertex, 'vertex') };
    case 'centre': {
      if (typeof def.of !== 'string' && def.of.kind === 'face') {
        const f = cx.face(def.of, 'face');
        if (f.type !== 'sphere' || !f.axis) throw new Error('pick a sphere, a circle or an arc');
        return { kind: 'point', p: f.axis.p };
      }
      const c = cx.curve(def.of, 'circle');
      if (!c.circle) throw new Error('pick a circle, an arc or a sphere');
      return { kind: 'point', p: c.circle.c };
    }
    case 'edgePlane': {
      const c = cx.curve(def.curve, 'edge'), pl = cx.plane(def.plane, 'plane');
      const q = crossing(c, pl.o, pl.n);
      if (!q) throw new Error('the edge does not cross the plane');
      return { kind: 'point', p: q };
    }
  }
}

function planeOf(def: Extract<ConstructItem, { kind: 'plane' }>['def'], p: Record<string, number>, cx: ConstructContext): Frame {
  switch (def.type) {
    case 'offset': {
      const pl = cx.plane(def.plane, 'plane');
      // from a face: its origin the component origin's foot on it, as a sketch on the face
      const f = pl.face ? planeThrough(pl.o, pl.n) : { o: pl.o, u: pl.u, v: pl.v, n: pl.n };
      return { ...f, o: add3(f.o, scale3(f.n, p.d ?? 0)) };
    }
    case 'angle': {
      const ax = cx.axis(def.axis, 'axis');
      const d = norm3(ax.d);
      // at 0° the plane the axis lies in: the one picked, or the one it was drawn on
      const ref = def.plane !== undefined ? cx.plane(def.plane, 'reference plane').n : cx.axisPlane(def.axis);
      const n0 = square(ref, d);
      const n = turn(n0, d, p.angle ?? 0);
      // its origin the point of the axis nearest the component origin, x along the axis
      const o = sub3(ax.p, scale3(d, dot3(ax.p, d)));
      return planeAlong(o, d, n);
    }
    case 'midplane': {
      const a = cx.plane(def.a, 'first plane'), b = cx.plane(def.b, 'second plane');
      // the planes equidistant from both: (x − oa)·na = ±(x − ob)·nb; the one between them
      // has their origins (face centres) on either side
      let best: { n: Vec3; c: number; split: number } | null = null;
      for (const sg of [-1, 1]) {
        const m = add3(a.n, scale3(b.n, sg));
        const k = len3(m);
        if (k < 1e-9) continue;
        const n = scale3(m, 1 / k), c = (dot3(a.o, a.n) + sg * dot3(b.o, b.n)) / k;
        const sa = dot3(a.o, n) - c, sb = dot3(b.o, n) - c;
        const split = sa * sb <= 0 ? Math.abs(sa - sb) : -Math.abs(sa - sb);
        if (!best || split > best.split) best = { n, c, split };
      }
      if (!best) throw new Error('pick two different planes');
      // the normal from the first plane towards the second
      const flip = dot3(sub3(b.o, a.o), best.n) < 0 ? -1 : 1;
      const n = scale3(best.n, flip);
      return planeThrough(scale3(n, best.c * flip), n);
    }
    case 'points': {
      if (def.points.length < 3) throw new Error('pick three points');
      const [q0, q1, q2] = def.points.slice(0, 3).map((q, i) => cx.point(q, ['first', 'second', 'third'][i] + ' point'));
      const n = cross3(sub3(q1, q0), sub3(q2, q0));
      const size = Math.max(len3(sub3(q1, q0)), len3(sub3(q2, q0)), 1e-300);
      if (len3(n) <= 1e-9 * size * size) throw new Error('the three points lie on one line');
      return planeAlong(q0, sub3(q1, q0), n);
    }
    case 'tangent': {
      const f = cx.face(def.face, 'face');
      if (f.type !== 'cylinder' || !f.axis || !f.radius) throw new Error('a tangent plane goes on a cylindrical face');
      const d = norm3(f.axis.d);
      const ref = def.plane !== undefined ? cx.plane(def.plane, 'reference plane').n : null;
      const r = turn(square(ref, d), d, p.angle ?? 0);
      // level with the middle of the face
      const foot = add3(f.axis.p, scale3(d, dot3(sub3(f.c, f.axis.p), d)));
      return planeAlong(add3(foot, scale3(r, f.radius)), d, r);
    }
    case 'path': {
      const c = cx.curve(def.curve, 'path');
      const t = Math.min(1, Math.max(0, p.at ?? 0));
      const q = c.at(t);
      return frameFromNormal(q.p, q.d);
    }
  }
}

/** Where a datum is, for messages and the 3-D view: a plane's origin, an axis' point, a point. */
export function datumPoint(d: Datum): Vec3 {
  return d.kind === 'plane' ? d.frame.o : d.kind === 'helix' ? d.helix.o : d.p;
}
