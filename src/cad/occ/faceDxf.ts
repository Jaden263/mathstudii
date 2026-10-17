// A flat face as a DXF for laser, waterjet or plasma cutting: its outer loop and the loops of
// its holes, straight edges as LINEs, circles as CIRCLEs and arcs as ARCs with their true
// radii, other curves (ellipses, B-splines) as fine polylines. The face is seen from outside
// (its normal towards the viewer), in the plane a sketch on it would have: the component
// origin projected onto it, the x axis level (design.ts facePlane), part units.
import type { CadEntity, CadPoint, CadSketch, CadUnit } from '../model';
import { sketchToDxf } from '../dxf';
import { dot3, frameFromNormal, norm3, scale3, sub3, type Frame, type Vec3 } from '../solid';
import type { OccBuiltDesign } from './build';
import { scratch, subShapes, xyz, type OC } from './kernel';
import { faceInfo } from './topology';

/** The loops of a flat face of a body as sketch lines, arcs and circles in the face's plane. */
export function faceSketch(oc: OC, built: OccBuiltDesign, component: string, body: string, face: number): { sketch: CadSketch; frame: Frame } {
  const b = built.components.get(component)?.bodies.find((q) => q.id === body);
  if (!b) throw new Error('the body of the face is gone');
  return scratch((t) => {
    const A = oc.TopAbs_ShapeEnum;
    const faces = subShapes(oc, t, b.solid.shape, A.TopAbs_FACE);
    const fs = faces[face];
    if (!fs) throw new Error('the face is gone');
    const f = t.add(oc.TopoDS.Face(fs));
    const info = faceInfo(oc, t, f, face);
    if (info.type !== 'plane' || !info.frame) throw new Error('only a flat face can be written as a DXF profile');
    const n = norm3(info.frame.n);
    const frame = frameFromNormal(scale3(n, dot3(info.frame.o, n)), n);
    const to2 = (p: Vec3) => ({ x: dot3(sub3(p, frame.o), frame.u), y: dot3(sub3(p, frame.o), frame.v) });
    // the size of the face, for the tolerances
    const span = Math.sqrt(Math.max(info.area, 1e-18));
    const tol = span * 1e-9;
    const points: CadPoint[] = [];
    const entities: CadEntity[] = [];
    /** A point, shared with one at the same place (so the outlines read back connected). */
    const point = (q: { x: number; y: number }) => {
      const hit = points.find((p) => Math.hypot(p.x - q.x, p.y - q.y) <= tol);
      if (hit) return hit.id;
      const id = `p${points.length}`;
      points.push({ id, x: q.x, y: q.y });
      return id;
    };
    let k = 0;
    const C = oc.GeomAbs_CurveType;
    for (const es of subShapes(oc, t, f, A.TopAbs_EDGE)) {
      const e = t.add(oc.TopoDS.Edge(es));
      const a = t.add(new oc.BRepAdaptor_Curve(e));
      const u0 = a.FirstParameter(), u1 = a.LastParameter();
      const at = (u: number) => to2(xyz(t.add(a.EvalD0(u))));
      const ty = a.GetType();
      if (ty === C.GeomAbs_Line) {
        entities.push({ id: `e${k++}`, type: 'line', p1: point(at(u0)), p2: point(at(u1)) });
      } else if (ty === C.GeomAbs_Circle) {
        const circ = t.add(a.Circle());
        const r = circ.Radius();
        const c = to2(xyz(t.add(circ.Location())));
        const axis = xyz(t.add(t.add(circ.Axis()).Direction()));
        if (Math.abs(u1 - u0 - 2 * Math.PI) < 1e-9) {
          entities.push({ id: `e${k++}`, type: 'circle', c: point(c), r });
        } else {
          // a sketch arc runs counter-clockwise seen from outside: from the start when the
          // circle turns that way about the face's normal, else from the end
          const ccw = dot3(axis, n) > 0;
          const [s, eEnd] = ccw ? [at(u0), at(u1)] : [at(u1), at(u0)];
          entities.push({ id: `e${k++}`, type: 'arc', c: point(c), p1: point(s), p2: point(eEnd) });
        }
      } else {
        // ellipses and free-form curves: a polyline within about 10⁻⁴ of the face's size
        const len = (() => {
          const p = t.add(new oc.GProp_GProps());
          oc.BRepGProp.LinearProperties(e, p, false, false);
          return p.Mass();
        })();
        const m = Math.min(720, Math.max(16, Math.ceil(len / (span * 2e-3))));
        let prev = point(at(u0));
        for (let i = 1; i <= m; i++) {
          const next = point(at(u0 + ((u1 - u0) * i) / m));
          if (next !== prev) entities.push({ id: `e${k++}`, type: 'line', p1: prev, p2: next });
          prev = next;
        }
      }
    }
    return { sketch: { points, entities, constraints: [] }, frame };
  });
}

/** The DXF of a flat face (R12 entities, $INSUNITS the part's unit). */
export function faceDxf(oc: OC, built: OccBuiltDesign, component: string, body: string, face: number, unit: CadUnit): string {
  return sketchToDxf(faceSketch(oc, built, component, body, face).sketch, unit);
}
