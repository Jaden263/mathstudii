// The flat pattern on the B-rep kernel: the pieces of a sheet-metal body laid out flat as
// one exact face (lines, arcs, circles), less what was cut through its flanges (sheet.ts),
// which the DXF, the SVG and the drawing's flat view are drawn from.
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { Prim } from '../drawing2d';
import { bendAxis, bendStrip, chainMatrix, flatNumbers, flatSummary, modelSize, type FlatPattern, type FlatSummary, type SheetModel } from '../sheetMetal';
import { m4Dir, m4Point, type Arena, type Frame, type Vec3 } from '../solid';
import { regionFace } from './geometry';
import { edgePrims } from './drawing';
import { ax1, guard, pnt, scratch, subShapes, type OC } from './kernel';
import { faceArea, faceBoolean, faces, regionArea, throughCut } from './sheet';

const FLAT: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };

// ------------------------------------------------------------ the flat pattern

// a body that did not change keeps its flat pattern (shapes are never modified in place)
const flats = new WeakMap<TopoDS_Shape, { m: SheetModel; fp: FlatPattern }>();

/** The flat pattern of a sheet-metal body: the pieces laid out flat, joined, less what was cut through the flanges. */
export function flatPatternOcc(oc: OC, solid: TopoDS_Shape, m: SheetModel): FlatPattern {
  const hit = flats.get(solid);
  if (hit && hit.m === m) return hit.fp;
  const fp = scratch((t) => {
    const size = modelSize(m), fuzz = 1e-7 * size;
    const warnings: string[] = [];
    const pieces = [
      ...m.flanges.map((f) => regionFace(oc, t, f.region, FLAT, 0).face),
      ...m.bends.map((b) => regionFace(oc, t, bendStrip(b), FLAT, 0).face),
    ];
    let blank = pieces.length > 1 ? faceBoolean(oc, t, 'fuse', [pieces[0]], pieces.slice(1), fuzz) : pieces[0];
    const cuts: TopoDS_Shape[] = [];
    for (const f of m.flanges) {
      const c = throughCut(oc, t, solid, m, f, size);
      const area = c.reduce((s, q) => s + faceArea(oc, t, q), 0);
      if (area > 0.999 * regionArea(f.region)) warnings.push('a flange is not where its sheet put it (moved or cut away): its cut-outs are left out');
      else cuts.push(...c);
    }
    if (cuts.length) blank = faceBoolean(oc, t, 'cut', [blank], cuts, fuzz);
    // cuts through bends
    m.bends.forEach((_, i) => {
      if (bendCut(oc, t, solid, m, i, size)) warnings.push(`Bend${i + 1} is cut through: its cut-out is not in the flat pattern`);
    });
    const outer: Prim[][] = [], inner: Prim[][] = [];
    let area = 0;
    for (const f of faces(oc, t, blank, fuzz * size)) {
      area += faceArea(oc, t, f);
      const F = t.add(oc.TopoDS.Face(f));
      const ow = t.add(oc.BRepTools.OuterWire(F));
      for (const w of subShapes(oc, t, F, oc.TopAbs_ShapeEnum.TopAbs_WIRE)) (w.IsSame(ow) ? outer : inner).push(edgePrims(oc, t, w, size));
    }
    if (outer.length > 1) warnings.push('the flat pattern falls apart into pieces');
    return { outer, inner, area, numbers: flatNumbers(m), warnings };
  });
  flats.set(solid, { m, fp });
  return fp;
}

/** Whether something is cut through a bend: its middle surface (at t/2) is not all inside the solid. */
function bendCut(oc: OC, t: Arena, solid: TopoDS_Shape, m: SheetModel, i: number, size: number): boolean {
  const b = m.bends[i];
  const P = chainMatrix(m, b.chain);
  const at = (s: number): Vec3 => m4Point(P, [b.o.x + b.e.x * s, b.o.y + b.e.y * s, m.t / 2]);
  const ax = bendAxis(b, m.t);
  return guard(oc, 'the bend cannot be checked', () => {
    const edge = t.add(t.add(new oc.BRepBuilderAPI_MakeEdge(pnt(oc, t, at(b.s0)), pnt(oc, t, at(b.s1)))).Edge());
    const mid = t.add(t.add(new oc.BRepPrimAPI_MakeRevol(edge, ax1(oc, t, m4Point(P, ax.p), m4Dir(P, ax.d)), b.angle, false)).Shape());
    const gone = faceBoolean(oc, t, 'cut', [mid], [solid], 0);
    const area = faces(oc, t, gone, 0).reduce((s, f) => s + faceArea(oc, t, f), 0);
    return area > 1e-6 * size * (b.s1 - b.s0);
  });
}

/** The flat pattern's numbers for the worksheet, of a body if it is sheet metal (its model's numbers alone if the flat cannot be made). */
export function bodyFlat(oc: OC, solid: TopoDS_Shape, m: SheetModel | undefined): { flat?: FlatSummary } {
  if (!m) return {};
  try {
    return { flat: flatSummary(flatPatternOcc(oc, solid, m)) };
  } catch (e) {
    const numbers = flatNumbers(m);
    return { flat: flatSummary({ area: numbers.area, numbers, warnings: [`the flat pattern could not be made (${e instanceof Error ? e.message : String(e)}): its cut-outs are left out`] }) };
  }
}
