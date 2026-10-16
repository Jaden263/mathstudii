// Joint origins on geometry, as Fusion offers them: the snap points of a face or edge
// under the pointer (a flat face's area centroid, a cylinder's axis, the centres of
// circles and arcs, edge midpoints, vertices), each with the Z axis a joint takes there.
// A picked snap is stored as a reference to its face, edge or vertex (topology.ts), so
// the joint follows the geometry through every rebuild.
import type { BodyResult, FaceInfo } from './buildResult';
import { refTo, resolveRef, resolvedEntity, type BodyTopology, type EdgeFacts, type TopoRef } from './topology';
import { dot3, len3, norm3, scale3, sub3, type Vec3 } from './solid';

export type SnapKind = 'centroid' | 'axis' | 'centre' | 'mid' | 'vertex';

export interface Snap {
  snap: SnapKind;
  /** The face (centroid, axis), edge (centre, mid) or vertex it sits on. */
  ref: TopoRef;
  /** Edge midpoints and vertices: the flat face whose normal is the Z axis. */
  face?: TopoRef;
  /** The joint origin and Z axis when picked (component coordinates). */
  o: Vec3;
  z: Vec3;
  label: string;
}

/** A joint origin on a snap point: it follows the geometry; o and z stand in when it is lost. */
export interface SnapOrigin extends Snap {
  kind: 'snap';
}

/** Turn d to the side of `like`. */
const towards = (d: Vec3, like: Vec3): Vec3 => (dot3(d, like) < 0 ? scale3(d, -1) : d);

/** The foot of p on an axis. */
const onAxis = (p: Vec3, a: { p: Vec3; d: Vec3 }): Vec3 => {
  const d = norm3(a.d);
  return sub3(a.p, scale3(d, -dot3(sub3(p, a.p), d)));
};

/** The flat face of an edge (the first, if both are), for the Z axis of points on it. */
function flatSide(b: BodyTopology, e: EdgeFacts): FaceInfo | undefined {
  return e.faces.map((i) => b.faces[i]).find((f) => f?.frame);
}

/**
 * The snap points of a face or edge of a body, `len` writing lengths with their unit:
 * a face offers its centroid (flat) or axis (cylinder, cone), the centres of its circles,
 * the midpoints of its straight edges and its vertices; an edge its centre or midpoint
 * and its ends. Circle centres take Z out of the flat face they bound, or along the axis
 * away from the middle of the cylinder they end.
 */
export function snapsOn(b: BodyResult | BodyTopology, at: { face?: number; edge?: number }, len: (v: number) => string = String): Snap[] {
  const out: Snap[] = [];
  const vertexSnaps = (vs: number[], face: FaceInfo | undefined) => {
    if (!face?.frame) return;
    for (const vi of new Set(vs)) {
      const v = b.vertices[vi];
      if (v) out.push({ snap: 'vertex', ref: refTo('vertex', b.id, v), face: refTo('face', b.id, face), o: v.p, z: face.frame.n, label: 'vertex' });
    }
  };
  const centre = (e: EdgeFacts, face: FaceInfo | undefined) => {
    const c = e.circle!;
    let z = norm3(c.axis);
    if (face?.frame) z = towards(z, face.frame.n);
    else if (face?.axis) z = towards(z, sub3(c.c, face.c));
    out.push({ snap: 'centre', ref: refTo('edge', b.id, e), o: c.c, z, label: `centre of the ⌀${len(2 * c.r)} ${e.length < 2 * Math.PI * c.r * (1 - 1e-9) ? 'arc' : 'circle'}` });
  };
  if (at.edge !== undefined) {
    const e = b.edges[at.edge];
    if (!e) return out;
    const face = flatSide(b, e);
    if (e.circle) centre(e, face ?? b.faces[e.faces[0]]);
    else if (face?.frame) out.push({ snap: 'mid', ref: refTo('edge', b.id, e), face: refTo('face', b.id, face), o: e.mid, z: face.frame.n, label: 'midpoint of the edge' });
    // a closed curve's one vertex is only where its parameter starts: no point to snap to
    if (e.v[0] !== e.v[1]) vertexSnaps(e.v.filter((v) => v >= 0), face);
    return out;
  }
  const f = at.face !== undefined ? b.faces[at.face] : undefined;
  if (!f) return out;
  if (f.frame) out.push({ snap: 'centroid', ref: refTo('face', b.id, f), o: f.c, z: f.frame.n, label: 'centre of the face' });
  else if (f.axis && f.type !== 'sphere' && f.type !== 'torus') {
    out.push({ snap: 'axis', ref: refTo('face', b.id, f), o: onAxis(f.c, f.axis), z: norm3(f.axis.d), label: `axis of the ⌀${len(2 * (f.radius ?? 0))} ${f.type}` });
  }
  const verts: number[] = [];
  for (const e of b.edges) {
    // a seam is no edge of the shape, only of its parameters
    if (!e.faces.includes(f.index) || e.faces[0] === e.faces[1]) continue;
    if (e.circle) centre(e, f);
    else if (f.frame) out.push({ snap: 'mid', ref: refTo('edge', b.id, e), face: refTo('face', b.id, f), o: e.mid, z: f.frame.n, label: 'midpoint of an edge' });
    if (e.v[0] !== e.v[1]) verts.push(...e.v.filter((v) => v >= 0));
  }
  vertexSnaps(verts, f);
  return out;
}

/** The snap nearest to a point (the pointer on the model). */
export function nearestSnap(snaps: Snap[], p: Vec3): Snap | null {
  let best: Snap | null = null, d = Infinity;
  for (const s of snaps) {
    const q = len3(sub3(s.o, p));
    if (q < d) [best, d] = [s, q];
  }
  return best;
}

/**
 * Where a snap origin is on the bodies as built: its point and Z axis found on the
 * geometry it names (an axis or circle keeps the side Z pointed to when picked), or null
 * when that geometry is gone.
 */
export function snapPlace(o: Snap, bodies: BodyTopology[]): { o: Vec3; z: Vec3 } | null {
  const r = resolveRef(o.ref, bodies);
  if (!r.ok) return null;
  // the Z axis of a point: the normal of the flat face it was picked on, if still flat
  const zOf = () => {
    const fr = o.face && resolveRef(o.face, bodies);
    const f = fr && fr.ok ? resolvedEntity(bodies, 'face', fr) : null;
    return f?.frame ? f.frame.n : o.z;
  };
  if (o.ref.kind === 'vertex') {
    const v = resolvedEntity(bodies, 'vertex', r);
    return v && { o: v.p, z: zOf() };
  }
  if (o.ref.kind === 'edge') {
    const e = resolvedEntity(bodies, 'edge', r);
    if (!e) return null;
    if (o.snap === 'centre') return e.circle ? { o: e.circle.c, z: towards(norm3(e.circle.axis), o.z) } : null;
    return { o: e.mid, z: zOf() };
  }
  const f = resolvedEntity(bodies, 'face', r);
  if (!f) return null;
  if (o.snap === 'axis') return f.axis ? { o: onAxis(f.c, f.axis), z: towards(norm3(f.axis.d), o.z) } : null;
  return f.frame ? { o: f.c, z: f.frame.n } : null;
}
