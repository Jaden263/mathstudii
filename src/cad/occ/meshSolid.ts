// A closed mesh sewn into a B-rep solid (Convert to solid on a mesh import): a plane face
// per triangle, sewn along their shared edges, the shell made a solid and the coplanar
// triangles merged into faces (ShapeUpgrade_UnifySameDomain), so a cube's twelve triangles
// become its six faces. The faces are named after their plane, as imported STEP faces are.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { MeshBody } from '../meshBody';
import type { Arena } from '../solid';
import { guard, pnt, scratch, subShapes, type OC } from './kernel';
import type { FaceTag, OccSolid } from './ops';
import { faceInfo } from './topology';
import { surfaceSignature } from './stepImport';
import { hashString } from '../keys';

export function meshSolidOcc(oc: OC, arena: Arena, mesh: MeshBody, body: number, unit: string, tag: string): OccSolid {
  const P = mesh.positions, I = mesh.indices;
  let size = 0;
  for (let k = 0; k < 3; k++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = k; i < P.length; i += 3) {
      lo = Math.min(lo, P[i]);
      hi = Math.max(hi, P[i]);
    }
    size = Math.max(size, hi - lo);
  }
  return scratch((t) => {
    const sew = t.add(new oc.BRepBuilderAPI_Sewing(Math.max(size, 1e-9) * 1e-7, true, true, true, false));
    const at = (i: number) => pnt(oc, t, [P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    for (let k = 0; k < I.length; k += 3) {
      const [a, b, c] = [I[k], I[k + 1], I[k + 2]].map(at);
      const e = [[a, b], [b, c], [c, a]].map(([p, q]) => t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(p, q)).Edge()));
      const w = t.add(new oc.BRepBuilderAPI_MakeWire(e[0], e[1], e[2]));
      const f = t.add(new oc.BRepBuilderAPI_MakeFace(t.add(w.Wire()), true));
      if (f.IsDone()) sew.Add(t.add(f.Face()));
    }
    guard(oc, 'the mesh could not be sewn into a solid', () => sew.Perform(t.add(new oc.Message_ProgressRange())));
    const sewn = t.add(sew.SewedShape());
    const shells = subShapes(oc, t, sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    if (shells.length !== 1 || sew.NbFreeEdges() > 0) throw new Error(`the mesh did not sew into one closed shell (${sew.NbFreeEdges()} free edges)`);
    const mk = t.add(new oc.BRepBuilderAPI_MakeSolid(t.add(oc.TopoDS.Shell(shells[0]))));
    if (!mk.IsDone()) throw new Error('the sewn mesh does not make a solid');
    let solid: TopoDS_Shape = t.add(mk.Solid());
    const p = t.add(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(solid, p, false, false, false);
    if (p.Mass() < 0) solid = t.add(solid.Reversed());
    // the triangles of a plane merged into one face
    const u = t.add(new oc.ShapeUpgrade_UnifySameDomain(solid, true, true, false));
    u.SetLinearTolerance(Math.max(size, 1e-9) * 1e-9);
    u.SetAngularTolerance(1e-9);
    guard(oc, 'the faces of the sewn mesh could not be merged', () => u.Build());
    const merged = t.add(u.Shape());
    const solids = subShapes(oc, t, merged, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    const shape = arena.add(oc.TopoDS.Solid(solids[0] ?? solid));
    const tags: FaceTag[] = subShapes(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE).map((fs, i) => {
      const sig = surfaceSignature(oc, t, fs, faceInfo(oc, t, t.add(oc.TopoDS.Face(fs)), i), unit);
      return { face: arena.add(oc.TopoDS.Face(fs)), key: `${tag}/b${body}:${sig[0]}${hashString(sig).slice(-10)}`, feature: tag };
    });
    return { shape, tags };
  });
}
