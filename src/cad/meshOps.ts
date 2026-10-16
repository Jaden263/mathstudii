// The mesh kernel (Manifold) behind the design timeline. A body made by a single
// extrude or revolve keeps its exact profile-integral properties next to the mesh;
// any boolean drops them, and the mass then comes from the mesh.
import type { SolidOps } from './design';
import { extrudeProps, revolveProps } from './features';
import {
  boxOf, extrudeSolid, frameMatrix, holeTool, massFromProps, revolveSolid, sharedVolume, transformMass, transformSolid,
  type Arena, type Manifold, type ManifoldToplevel, type Mass3,
} from './solid';
import { loftSolid, shapedExtrude, thinExtrude } from './shaping';

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
  };
}
