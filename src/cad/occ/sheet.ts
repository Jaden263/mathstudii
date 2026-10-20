// Sheet metal on the B-rep kernel: what was cut through each flange of the folded solid,
// laid back into the flat (flat.ts makes the flat pattern of it).
//
// A cut-out is what is gone from a flange through its whole thickness: the flange's outline
// as a face just inside each of its two faces (a fiftieth of t in), each cut by the solid,
// mapped back into the flat and the two intersected. A hole counts, a pocket from one side
// does not, a countersink counts as its drill. Cuts through bends are not mapped (their
// flat would need the bend unrolled): the flat pattern says so.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { loopMoment, type Loop, type ProfileRegion, type Seg, type Vec2 } from '../profile';
import { chainMatrix, matrixFrame, modelSize, reversedLoop, sheetVolume, type SheetCutouts, type SheetFlange, type SheetModel } from '../sheetMetal';
import { m4Inv, m4Mul, m4Translate, type Arena, type M4 } from '../solid';
import { regionFace } from './geometry';
import { guard, occError, scratch, subShapes, trsf, volumeProperties, xyz, type OC } from './kernel';

type Op = { SetArguments(l: unknown): void; SetTools(l: unknown): void; SetFuzzyValue(v: number): void; Build(r: unknown): void; HasErrors(): boolean; Shape(): TopoDS_Shape; SimplifyResult(a?: boolean, b?: boolean, c?: number): void; Clear(): void };

/** A boolean of faces: fuse, cut or common, glued within `fuzz` (pieces of the flat meet on shared edges). */
export function faceBoolean(oc: OC, t: Arena, kind: 'fuse' | 'cut' | 'common', args: TopoDS_Shape[], tools: TopoDS_Shape[], fuzz: number): TopoDS_Shape {
  const op = t.add(kind === 'fuse' ? new oc.BRepAlgoAPI_Fuse() : kind === 'cut' ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Common()) as unknown as Op;
  const list = (ss: TopoDS_Shape[]) => {
    const l = t.add(new oc.NCollection_List_TopoDS_Shape());
    for (const s of ss) t.add(l.Append(s));
    return l;
  };
  op.SetArguments(list(args));
  op.SetTools(list(tools));
  if (fuzz > 0) op.SetFuzzyValue(fuzz);
  try {
    guard(oc, 'the flat pattern cannot be made', () => op.Build(t.add(new oc.Message_ProgressRange())));
    if (op.HasErrors()) throw new Error('the flat pattern cannot be made');
    try {
      op.SimplifyResult(true, true, 1e-9);
    } catch (e) {
      occError(oc, e, 'merging faces failed');
    }
    return t.add(op.Shape());
  } finally {
    try {
      op.Clear();
    } catch (e) {
      occError(oc, e, 'clearing a boolean failed');
    }
  }
}

const transformed = (oc: OC, t: Arena, s: TopoDS_Shape, M: M4) => t.add(t.add(new oc.BRepBuilderAPI_Transform(s, trsf(oc, t, M), true, false)).Shape());

export function faceArea(oc: OC, t: Arena, f: TopoDS_Shape): number {
  const p = t.add(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(f, p, false, false);
  return p.Mass();
}

/** The faces of a shape larger than `min` (booleans of faces can leave slivers along shared edges). */
export const faces = (oc: OC, t: Arena, s: TopoDS_Shape, min: number) => subShapes(oc, t, s, oc.TopAbs_ShapeEnum.TopAbs_FACE).filter((f) => faceArea(oc, t, f) > min);

/** What is gone through a flange (flat coordinates, z = 0), as faces. */
export function throughCut(oc: OC, t: Arena, solid: TopoDS_Shape, m: SheetModel, f: SheetFlange, size: number): TopoDS_Shape[] {
  const M = chainMatrix(m, f.chain);
  const F = matrixFrame(M);
  const fuzz = 1e-7 * size;
  const gone = [0.02, 0.98].map((k) => {
    const z = k * m.t;
    const face = regionFace(oc, t, f.region, F, z).face;
    const cut = faceBoolean(oc, t, 'cut', [face], [solid], 0);
    // back into the flat, at z = 0
    return faces(oc, t, transformed(oc, t, cut, m4Mul(m4Translate([0, 0, -z]), m4Inv(M))), fuzz * size);
  });
  if (!gone[0].length || !gone[1].length) return [];
  return faces(oc, t, faceBoolean(oc, t, 'common', gone[0], gone[1], fuzz), fuzz * size);
}

/** The area of a flange's own outline. */
export const regionArea = (r: ProfileRegion) => loopMoment(r.outer, 0, 0) + r.holes.reduce((s, h) => s + loopMoment(h, 0, 0), 0);

/** A wire of a flat face as a loop of segments (lines, arcs; other curves as short lines), chained head to tail. */
function wireLoop(oc: OC, t: Arena, wire: TopoDS_Shape, tol: number): Loop {
  const C = oc.GeomAbs_CurveType;
  const segs: Seg[] = [];
  for (const es of subShapes(oc, t, wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE)) {
    const e = t.add(oc.TopoDS.Edge(es));
    const a = t.add(new oc.BRepAdaptor_Curve(e));
    const rev = e.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const [u0, u1] = [a.FirstParameter(), a.LastParameter()];
    const at = (u: number): Vec2 => {
      const q = t.add(a.EvalD0(u));
      return { x: q.X(), y: q.Y() };
    };
    const [s0, s1] = rev ? [u1, u0] : [u0, u1];
    const ty = a.GetType();
    if (ty === C.GeomAbs_Line) segs.push({ kind: 'line', a: at(s0), b: at(s1) });
    else if (ty === C.GeomAbs_Circle) {
      const circ = t.add(a.Circle());
      const c3 = xyz(t.add(circ.Location()));
      const c = { x: c3[0], y: c3[1] };
      const p = at(s0);
      const ccw = (t.add(t.add(circ.Axis()).Direction()).Z() > 0) !== rev;
      const a0 = Math.atan2(p.y - c.y, p.x - c.x), span = Math.min(u1 - u0, 2 * Math.PI);
      segs.push({ kind: 'arc', c, r: circ.Radius(), a0, a1: ccw ? a0 + span : a0 - span });
    } else {
      const n = 48;
      for (let i = 0; i < n; i++) segs.push({ kind: 'line', a: at(s0 + ((s1 - s0) * i) / n), b: at(s0 + ((s1 - s0) * (i + 1)) / n) });
    }
  }
  // head to tail
  const end = (s: Seg): Vec2 => (s.kind === 'line' ? s.b : s.kind === 'arc' ? { x: s.c.x + s.r * Math.cos(s.a1), y: s.c.y + s.r * Math.sin(s.a1) } : { x: 0, y: 0 });
  const start = (s: Seg): Vec2 => (s.kind === 'line' ? s.a : s.kind === 'arc' ? { x: s.c.x + s.r * Math.cos(s.a0), y: s.c.y + s.r * Math.sin(s.a0) } : { x: 0, y: 0 });
  const out = segs.splice(0, 1);
  while (segs.length) {
    const p = end(out[out.length - 1]);
    const k = segs.findIndex((s) => Math.hypot(start(s).x - p.x, start(s).y - p.y) < tol);
    if (k < 0) break;
    out.push(...segs.splice(k, 1));
  }
  return { segs: out, entities: out.map((_, i) => `c${i}`) };
}

/** A flat face as a region: its outer wire counter-clockwise, its other wires clockwise. */
function faceRegion(oc: OC, t: Arena, f: TopoDS_Shape, tol: number): ProfileRegion {
  const F = t.add(oc.TopoDS.Face(f));
  const outerWire = t.add(oc.BRepTools.OuterWire(F));
  let outer: Loop | null = null;
  const holes: Loop[] = [];
  for (const w of subShapes(oc, t, F, oc.TopAbs_ShapeEnum.TopAbs_WIRE)) {
    const l = wireLoop(oc, t, w, tol);
    const area = loopMoment(l, 0, 0);
    if (w.IsSame(outerWire)) outer = area >= 0 ? l : reversedLoop(l);
    else holes.push(area <= 0 ? l : reversedLoop(l));
  }
  return { outer: outer ?? { segs: [], entities: [] }, holes };
}

/**
 * The cut-outs through each flange of a sheet-metal body, as regions in flat coordinates,
 * and how far the solid's volume is from its model's less those cut-outs (what a refold
 * from the model would lose).
 */
export function sheetCutoutsOcc(oc: OC, solid: TopoDS_Shape, m: SheetModel): SheetCutouts {
  const size = modelSize(m);
  return scratch((t) => {
    let gone = 0;
    const cuts = m.flanges.map((f) => {
      const cut = throughCut(oc, t, solid, m, f, size);
      // a flange the solid is no longer on (moved, or cut away) has nothing to carry over
      const area = cut.reduce((s, q) => s + faceArea(oc, t, q), 0);
      if (area > 0.999 * regionArea(f.region)) return { tag: f.tag, regions: [] };
      gone += area;
      return { tag: f.tag, regions: cut.map((q) => faceRegion(oc, t, q, 1e-6 * size)) };
    });
    const props = t.add(new oc.GProp_GProps());
    volumeProperties(oc, t, solid, props);
    const V = props.Mass();
    return { cuts, other: Math.abs(V - (sheetVolume(m) - gone * m.t)) };
  });
}
