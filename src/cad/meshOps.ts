// The mesh kernel (Manifold) behind the design timeline. A body made by a single
// extrude or revolve keeps its exact profile-integral properties next to the mesh;
// any boolean drops them, and the mass then comes from the mesh.
import type { SolidOps } from './design';
import { extrudeProps, revolveProps } from './features';
import {
  add3, boxOf, cross3, dot3, extrudeSolid, frameMatrix, holeTool, m4Point, m4Rotate, massFromProps, norm3, revolveSolid, scale3, sharedVolume, sub3,
  transformMass, transformSolid,
  type Arena, type Manifold, type ManifoldToplevel, type Mass3, type Vec3,
} from './solid';
import { loftSolid, shapedExtrude, thinExtrude } from './shaping';
import { meshTopology } from './meshTopology';
import { needsBrep } from './modify';

export interface MeshSolid {
  m: Manifold;
  /** Exact properties while the solid is a single extrude or revolve. */
  exact?: Mass3;
}

export function meshOps(K: ManifoldToplevel, arena: Arena): SolidOps<MeshSolid> {
  const union = (ms: Manifold[]) => (ms.length === 1 ? ms[0] : arena.add(K.Manifold.union(ms)));
  return {
    extrude(regions, f, z0, z1) {
      const m = extrudeSolid(K, arena, regions, f, z0, z1);
      const props = extrudeProps(regions, z1 - z0);
      return { m, exact: props ? transformMass(massFromProps({ ...props, zg: props.zg + z0 }), frameMatrix(f)) : undefined };
    },
    thin: (regions, f, z0, z1, o) => ({ m: thinExtrude(K, arena, regions, f, z0, z1, o) }),
    rounded: (regions, f, z0, z1, start, end) => ({ m: shapedExtrude(K, arena, regions, f, z0, z1, start, end) }),
    loft: (a, b) => ({ m: loftSolid(K, arena, a, b) }),
    revolve(regions, f, axis, angle) {
      const m = revolveSolid(K, arena, regions, f, axis, angle);
      const props = revolveProps(regions, axis, angle);
      return { m, exact: props ? transformMass(massFromProps(props), frameMatrix(f)) : undefined };
    },
    hole: (centres, dir, o) => ({ m: union(centres.map((p) => holeTool(K, arena, p, dir, o))) }),
    union: (ss) => (ss.length === 1 ? ss[0] : { m: union(ss.map((s) => s.m)) }),
    group: (ss) => (ss.length === 1 ? ss[0] : { m: union(ss.map((s) => s.m)) }),
    cut: (t, tool) => ({ m: arena.add(t.m.subtract(tool.m)) }),
    intersect: (t, tool) => ({ m: arena.add(t.m.intersect(tool.m)) }),
    transform: (s, M) => ({ m: transformSolid(arena, s.m, M), exact: s.exact && transformMass(s.exact, M) }),
    shared: (a, b) => sharedVolume(a.m, b.m),
    box: (ss) => boxOf(ss.map((s) => s.m)),
    topology: (s, id) => meshTopology(s.m, id),
    // the mesh has no faces or edges of its own to round or move (timelineStep says so first)
    fillet: () => { throw new Error(needsBrep('fillet')); },
    chamfer: () => { throw new Error(needsBrep('chamfer')); },
    shell: () => { throw new Error(needsBrep('shell')); },
    draft: () => { throw new Error(needsBrep('draft')); },
    pressPull: () => { throw new Error(needsBrep('presspull')); },
    sweep: () => { throw new Error(needsBrep('sweep')); },
    thread: () => { throw new Error(needsBrep('thread')); },
    // straight edges and circles from the mesh's own facts; other curves need the B-rep kernel
    edgeAt(s, edge, t) {
      const b = meshTopology(s.m, '');
      const e = b.edges[edge];
      if (e?.line) {
        const d = norm3(sub3(e.line.b, e.line.a));
        return { p: add3(e.line.a, scale3(sub3(e.line.b, e.line.a), t)), d };
      }
      const p0 = e?.circle && b.vertices[e.v[0]]?.p;
      if (!e?.circle || !p0) throw new Error(needsBrep('point'));
      const { c, axis } = e.circle;
      const ang = (q: Vec3) => {
        const a = sub3(p0, c), w = sub3(q, c);
        return Math.atan2(dot3(cross3(a, w), norm3(axis)), dot3(a, w));
      };
      // the arc's sweep from its start through its middle (a whole circle: once round)
      let total = e.v[0] === e.v[1] ? 2 * Math.PI : 2 * ang(e.mid);
      if (e.v[0] !== e.v[1] && Math.abs(total) < 1e-12) total = 2 * Math.PI;
      const R = m4Rotate(c, axis, total * t);
      return { p: m4Point(R, p0), d: norm3(scale3(cross3(norm3(axis), sub3(m4Point(R, p0), c)), Math.sign(total))) };
    },
    split(s, pl) {
      const [front, back] = s.m.splitByPlane(pl.n, pl.o[0] * pl.n[0] + pl.o[1] * pl.n[1] + pl.o[2] * pl.n[2]);
      arena.add(front);
      arena.add(back);
      // each connected piece is a body of its own
      const pieces = (m: Manifold) => (m.isEmpty() ? [] : m.decompose().map((q) => ({ m: arena.add(q) })));
      return [...pieces(back), ...pieces(front)];
    },
  };
}
