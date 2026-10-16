// Questions the workspace asks the exact shapes of a built design: a section view (the
// bodies cut by a plane, with the cut faces marked), the outline of the bodies in a sketch
// plane, the smallest distance between two picked faces, edges or points, and the volume
// two occurrences share. Everything comes back as plain data.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { BodyResult } from '../buildResult';
import type { CadDesign } from '../design';
import { capFaces, planeToLocal, type Distance, type EntityRef, type SectionPlane } from '../inspect';
import { chainLoops } from '../outline';
import type { Vec2 } from '../profile';
import { dot3, frameFromNormal, sub3, type Arena, type Frame, type M4, type Vec3 } from '../solid';
import { occBox, type OccBuiltDesign } from './build';
import { ax2, frameAx3, guard, hasSolid, occError, pnt, scratch, shapeIndex, trsf, xyz, type OC } from './kernel';
import { shapeVolume } from './ops';
import { bodyResultOcc, heap, joinSegments } from './result';

export interface SectionBody {
  occ: string;
  component: string;
  /** The kept part of the body (component coordinates). */
  body: BodyResult;
  /** Its faces in the section plane. */
  caps: number[];
}

/** Bodies of the visible occurrences that a placement puts in the assembly. */
function placedBodies(built: OccBuiltDesign, design: CadDesign) {
  const out: { occ: string; component: string; M: M4; id: string; name: string; feature: string; shape: TopoDS_Shape }[] = [];
  for (const o of design.occurrences) {
    const comp = design.components.find((c) => c.id === o.component);
    const M = built.placements[o.id]?.matrix;
    if (o.hidden || !comp || !M) continue;
    for (const b of built.components.get(comp.id)?.bodies ?? []) {
      if (comp.hiddenBodies?.includes(b.id)) continue;
      out.push({ occ: o.id, component: comp.id, M, id: b.id, name: b.name, feature: b.feature, shape: b.solid.shape });
    }
  }
  return out;
}

/** Clear a boolean before deleting it (this build keeps its data structure otherwise). */
function cleared(oc: OC, op: { Clear(): void }) {
  try {
    op.Clear();
  } catch (e) {
    occError(oc, e, 'clearing a boolean failed');
  }
}

/** The common part of two shapes, or null when there is none. */
function common(oc: OC, t: Arena, a: TopoDS_Shape, b: TopoDS_Shape, what: string): TopoDS_Shape | null {
  const op = t.add(new oc.BRepAlgoAPI_Common(a, b, t.add(new oc.Message_ProgressRange())));
  try {
    const s = t.add(guard(oc, what, () => op.Shape()));
    return hasSolid(oc, s) ? s : null;
  } finally {
    cleared(oc, op);
  }
}

/**
 * The visible bodies cut by a plane (assembly coordinates): each keeps the part on the
 * normal's side, as a BodyResult in its component's coordinates, cut faces listed.
 */
export function sectionOcc(oc: OC, built: OccBuiltDesign, design: CadDesign, plane: SectionPlane): SectionBody[] {
  const out: SectionBody[] = [];
  for (const pb of placedBodies(built, design)) {
    if (!hasSolid(oc, pb.shape)) continue;
    const p = planeToLocal(pb.M, plane);
    const box = occBox(oc, [pb.shape]);
    if (!box) continue;
    const c: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const r = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2 || 1;
    const h = dot3(c, p.n) - p.offset;
    if (h <= -r) continue; // all of it on the side cut away
    const body = { id: pb.id, name: pb.name, feature: pb.feature };
    if (h >= r) {
      out.push({ occ: pb.occ, component: pb.component, body: bodyResultOcc(oc, { ...body, solid: { shape: pb.shape, tags: [] } }), caps: [] });
      continue;
    }
    // the kept half space as a box on the plane, beyond the body all round
    const kept = scratch((t) => {
      const f = frameFromNormal(sub3(c, [p.n[0] * h, p.n[1] * h, p.n[2] * h]), p.n);
      const R = r * 1.05 + 1e-6;
      const corner: Vec3 = [f.o[0] - (f.u[0] + f.v[0]) * R, f.o[1] - (f.u[1] + f.v[1]) * R, f.o[2] - (f.u[2] + f.v[2]) * R];
      const half = t.add(t.add(new oc.BRepPrimAPI_MakeBox(ax2(oc, t, corner, f.n, f.u), 2 * R, 2 * R, h + R)).Shape());
      const s = common(oc, t, pb.shape, half, 'the section failed');
      // the result outlives the scratch arena: it is freed with its own below
      if (s) t.release(s);
      return s;
    });
    if (!kept) continue;
    try {
      const res = bodyResultOcc(oc, { ...body, solid: { shape: kept, tags: [] } });
      out.push({ occ: pb.occ, component: pb.component, body: res, caps: capFaces(res, p, 2 * r) });
    } finally {
      kept.delete();
    }
  }
  return out;
}

/** Polylines of the edges of a shape (OCCT's tessellation), in 3-D. */
function edgePolylines(oc: OC, t: Arena, s: TopoDS_Shape, size: number): Vec3[][] {
  const lines = t.add(oc.ReplicadEdgeMeshExtractor.extract(s, Math.max(size * 2e-4, 1e-9), 0.05));
  const pts = heap(oc, Float32Array, lines.getLinesPtr(), lines.getLinesSize());
  const groups = heap(oc, Int32Array, lines.getEdgeGroupsPtr(), lines.getEdgeGroupsSize());
  const out: Vec3[][] = [];
  for (let g = 0; g < groups.length; g += 3) {
    const p = joinSegments(pts.subarray(3 * groups[g], 3 * (groups[g] + groups[g + 1])));
    const line: Vec3[] = [];
    for (let i = 0; i + 2 < p.length; i += 3) line.push([p[i], p[i + 1], p[i + 2]]);
    out.push(line);
  }
  return out;
}

/**
 * The outline of a component's bodies in a sketch plane (sketch coordinates), as closed
 * loops: cut a hair behind the plane, so a sketch on a face sees that face's outline.
 */
export function outlineOcc(oc: OC, built: OccBuiltDesign, componentId: string, f: Frame): Vec2[][] {
  const bodies = (built.components.get(componentId)?.bodies ?? []).filter((b) => hasSolid(oc, b.solid.shape));
  const box = occBox(oc, bodies.map((b) => b.solid.shape));
  if (!box) return [];
  const size = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2], 1e-9);
  const eps = 1e-5 * size;
  const toSketch = (q: Vec3): Vec2 => {
    const d = sub3(q, f.o);
    return { x: dot3(d, f.u), y: dot3(d, f.v) };
  };
  for (const h of [-eps, eps]) {
    const pieces = scratch((t) => {
      const out: Vec2[][] = [];
      const pln = t.add(new oc.gp_Pln(frameAx3(oc, t, { ...f, o: [f.o[0] + f.n[0] * h, f.o[1] + f.n[1] * h, f.o[2] + f.n[2] * h] })));
      for (const b of bodies) {
        const op = t.add(new oc.BRepAlgoAPI_Section(b.solid.shape, pln, false));
        try {
          guard(oc, 'the outline failed', () => op.Build(t.add(new oc.Message_ProgressRange())));
          if (op.HasErrors()) continue;
          const cut = t.add(op.Shape());
          for (const line of edgePolylines(oc, t, cut, size)) out.push(line.map(toSketch));
        } finally {
          cleared(oc, op);
        }
      }
      return out;
    });
    const loops = chainLoops(pieces, size * 1e-6).filter((l) => l.length >= 3);
    if (loops.length) return loops;
  }
  return [];
}

/** The sub-shape an entity names, placed in the assembly (owned by the arena). */
function entityShape(oc: OC, t: Arena, built: OccBuiltDesign, design: CadDesign, r: EntityRef): TopoDS_Shape | null {
  if (r.kind === 'point') return t.add(t.add(new oc.BRepBuilderAPI_MakeVertex(pnt(oc, t, r.p))).Vertex());
  const o = design.occurrences.find((q) => q.id === r.occ);
  const body = o && built.components.get(o.component)?.bodies.find((b) => b.id === r.body);
  const M = built.placements[r.occ]?.matrix;
  if (!body || !M) return null;
  // the same explorer order as the face and edge tables (result.ts)
  const type = r.kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const sub = shapeIndex(oc, t, body.solid.shape, type).shapes[r.index];
  if (!sub) return null;
  return t.add(t.add(new oc.BRepBuilderAPI_Transform(sub, trsf(oc, t, M), true, false)).Shape());
}

/** The smallest distance between two entities, on the exact geometry. */
export function distanceOcc(oc: OC, built: OccBuiltDesign, design: CadDesign, a: EntityRef, b: EntityRef): Distance | null {
  return scratch((t) => {
    const A = entityShape(oc, t, built, design, a), B = entityShape(oc, t, built, design, b);
    if (!A || !B) return null;
    const d = t.add(new oc.BRepExtrema_DistShapeShape(A, B));
    if (!guard(oc, 'the distance could not be measured', () => d.IsDone()) || d.NbSolution() < 1) return null;
    return { d: d.Value(), a: xyz(t.add(d.PointOnShape1(1))), b: xyz(t.add(d.PointOnShape2(1))), exact: true };
  });
}

export interface Interference {
  a: string;
  b: string;
  /** Shared volume (part units cubed). */
  v: number;
}

/** Volumes that pairs of visible occurrences share. */
export function interferenceOcc(oc: OC, built: OccBuiltDesign, design: CadDesign): Interference[] {
  return scratch((t) => {
    const placed = new Map<string, { shape: TopoDS_Shape; box: { min: Vec3; max: Vec3 } }[]>();
    for (const pb of placedBodies(built, design)) {
      if (!hasSolid(oc, pb.shape)) continue;
      const s = t.add(t.add(new oc.BRepBuilderAPI_Transform(pb.shape, trsf(oc, t, pb.M), true, false)).Shape());
      const box = occBox(oc, [s]);
      if (box) placed.set(pb.occ, [...(placed.get(pb.occ) ?? []), { shape: s, box }]);
    }
    const ids = [...placed.keys()];
    const rows: Interference[] = [];
    const apart = (p: { min: Vec3; max: Vec3 }, q: { min: Vec3; max: Vec3 }) => [0, 1, 2].some((k) => p.max[k] < q.min[k] || q.max[k] < p.min[k]);
    for (let i = 0; i < ids.length; i++) for (let k = i + 1; k < ids.length; k++) {
      let v = 0;
      for (const x of placed.get(ids[i])!) for (const y of placed.get(ids[k])!) {
        if (apart(x.box, y.box)) continue;
        const s = common(oc, t, x.shape, y.shape, 'the interference check failed');
        if (s) v += shapeVolume(oc, s);
      }
      if (v > 0) rows.push({ a: ids[i], b: ids[k], v });
    }
    return rows;
  });
}

/** The exact box of the visible bodies, placed in the assembly (drawings dimension it). */
export function visibleBoxOcc(oc: OC, built: OccBuiltDesign, design: CadDesign): { min: Vec3; max: Vec3 } | null {
  return scratch((t) => {
    const placed = placedBodies(built, design).filter((pb) => hasSolid(oc, pb.shape));
    return occBox(oc, placed.map((pb) => t.add(t.add(new oc.BRepBuilderAPI_Transform(pb.shape, trsf(oc, t, pb.M), false, false)).Shape())));
  });
}
