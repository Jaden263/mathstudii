// Exchange files from the exact shapes, as pure functions (they run in a worker as well
// as anywhere else): STEP AP214 with names, colours and the assembly structure, and
// binary STL tessellated from the B-rep at a chosen accuracy.
import type { TDF_Label, TDocStd_Document } from 'replicad-opencascadejs';
import type { CadUnit } from '../model';
import type { CadDesign } from '../design';
import { meshToStl } from '../stl';
import { Arena, m4Point, IDENTITY, type M4 } from '../solid';
import type { OccBuiltDesign } from './build';
import { compound, guard, scratch, trsf, type OC, type TopoDS_Shape } from './kernel';

/** What to export: one body, one component (in its own coordinates) or the assembly. */
export type ExportScope =
  | { kind: 'body'; component: string; body: string }
  | { kind: 'component'; component: string }
  | { kind: 'assembly' };

export interface StepOptions {
  /** Unit of the design's numbers, written into the file (default mm). */
  unit?: CadUnit;
  /** Product name of an assembly (default "Assembly"). */
  name?: string;
}

const STEP_UNIT: Record<CadUnit, string> = { mm: 'MM', cm: 'CM', m: 'M', in: 'INCH' };
const METRES: Record<CadUnit, number> = { mm: 1e-3, cm: 1e-2, m: 1, in: 0.0254 };

interface Part {
  name: string;
  color?: [number, number, number];
  shapes: TopoDS_Shape[];
}

function rgb(hex?: string): [number, number, number] | undefined {
  const m = hex && /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * sRGB (what #rrggbb means) to linear RGB, which OCCT's colours hold: its STEP writer turns
 * them back into the sRGB numbers other programs read from COLOUR_RGB.
 */
export const linearRgb = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The visible bodies of a component (all bodies when asked for one). */
function partOf(built: OccBuiltDesign, design: CadDesign, cid: string, only?: string): Part | null {
  const comp = design.components.find((c) => c.id === cid);
  const cb = built.components.get(cid);
  if (!comp || !cb) return null;
  const bodies = cb.bodies.filter((b) => (only ? b.id === only : !comp.hiddenBodies?.includes(b.id)));
  if (!bodies.length) return null;
  return { name: only ? bodies[0].name : comp.name, color: rgb(comp.color), shapes: bodies.map((b) => b.solid.shape) };
}

/** Occurrences to export with their placements. */
function placed(built: OccBuiltDesign, design: CadDesign): { name: string; component: string; M: M4 }[] {
  return design.occurrences
    .filter((o) => !o.hidden && built.placements[o.id])
    .map((o, i) => ({ name: o.name?.trim() || `${design.components.find((c) => c.id === o.component)?.name ?? 'Part'}:${i + 1}`, component: o.component, M: built.placements[o.id].matrix }));
}

let files = 0;

/** A STEP AP214 file of the scope. Throws when there is nothing to export or OCCT fails. */
export function stepFile(oc: OC, built: OccBuiltDesign, design: CadDesign, scope: ExportScope, o: StepOptions = {}): string {
  const unit = o.unit ?? 'mm';
  return scratch((t) => {
    // the writer first: it registers the STEP parameters set below
    const writer = t.add(new oc.STEPCAFControl_Writer());
    const restore = stepParameters(oc, unit);
    try {
      writer.SetNameMode(true);
      writer.SetColorMode(true);
      const doc = stepDocument(oc, t, built, design, scope, o);
      const path = `/export-${++files}.step`;
      const ok = guard(oc, 'the STEP file could not be written', () => writer.Perform(doc, path, t.add(new oc.Message_ProgressRange())));
      if (!ok) throw new Error('the STEP file could not be written');
      try {
        return part21Ascii(oc.FS.readFile(path, { encoding: 'utf8' }) as string);
      } finally {
        oc.FS.unlink(path);
      }
    } finally {
      restore();
    }
  });
}

/**
 * STEP files are ASCII (ISO 10303-21): other characters, which OCCT writes as raw UTF-8 and
 * which only occur in names, become \X2\…\X0\ (4 hex digits each), or \X4\…\X0\ (8) past
 * the basic plane, for readers that hold to it.
 */
export function part21Ascii(text: string): string {
  return text.replace(/[^\x00-\x7f]+/gu, (run) => {
    const cps = [...run].map((c) => c.codePointAt(0)!);
    let out = '';
    for (let i = 0; i < cps.length;) {
      const wide = cps[i] > 0xffff;
      let hex = '';
      for (; i < cps.length && cps[i] > 0xffff === wide; i++) hex += cps[i].toString(16).toUpperCase().padStart(wide ? 8 : 4, '0');
      out += `\\X${wide ? 4 : 2}\\${hex}\\X0\\`;
    }
    return out;
  });
}

/** An XCAF document of the scope: parts with names and colours, an assembly placing them. */
function stepDocument(oc: OC, t: Arena, built: OccBuiltDesign, design: CadDesign, scope: ExportScope, o: StepOptions): TDocStd_Document {
  const doc = t.add(new oc.TDocStd_Document(t.add(new oc.TCollection_ExtendedString('XmlOcaf', true))));
  oc.XCAFDoc_DocumentTool.SetLengthUnit(doc, METRES[o.unit ?? 'mm']);
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const main = t.add(doc.Main());
  const shapes = t.add(oc.XCAFDoc_DocumentTool.ShapeTool(main));
  const colors = t.add(oc.XCAFDoc_DocumentTool.ColorTool(main));
  const name = (label: TDF_Label, s: string) => t.add(oc.TDataStd_Name.Set(label, t.add(new oc.TCollection_ExtendedString(s, true))));
  const addPart = (p: Part) => {
    const label = t.add(shapes.AddShape(compound(oc, t, p.shapes), false, true));
    name(label, p.name);
    if (p.color) colors.SetColor(label, t.add(new oc.Quantity_ColorRGBA(linearRgb(p.color[0]), linearRgb(p.color[1]), linearRgb(p.color[2]), 1)), oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf);
    return label;
  };
  if (scope.kind === 'assembly') {
    const asm = t.add(shapes.NewShape());
    name(asm, o.name?.trim() || 'Assembly');
    // each component once, placed by every occurrence of it
    const parts = new Map<string, TDF_Label | null>();
    let n = 0;
    for (const occ of placed(built, design)) {
      if (!parts.has(occ.component)) {
        const p = partOf(built, design, occ.component);
        parts.set(occ.component, p && addPart(p));
      }
      const part = parts.get(occ.component);
      if (!part) continue;
      name(t.add(shapes.AddComponent(asm, part, t.add(new oc.TopLoc_Location(trsf(oc, t, occ.M))))), occ.name);
      n++;
    }
    if (!n) throw new Error('there is no solid to export');
    shapes.UpdateAssemblies();
  } else {
    const p = partOf(built, design, scope.component, scope.kind === 'body' ? scope.body : undefined);
    if (!p) throw new Error('there is no solid to export');
    addPart(p);
  }
  return doc;
}

/**
 * Set OCCT's (global) STEP parameters for writing numbers in `unit`; returns what puts
 * them back, so a later import still reads in its own unit.
 */
function stepParameters(oc: OC, unit: CadUnit): () => void {
  const S = oc.Interface_Static;
  const texts = ['xstep.cascade.unit', 'write.step.unit', 'write.step.schema'].map((k) => [k, S.CVal(k)] as const);
  const assembly = S.IVal('write.step.assembly');
  S.SetCVal('xstep.cascade.unit', STEP_UNIT[unit]);
  S.SetCVal('write.step.unit', STEP_UNIT[unit]);
  S.SetCVal('write.step.schema', 'AP214IS');
  // assemblies as assemblies (not flattened to one compound)
  S.SetIVal('write.step.assembly', 1);
  return () => {
    for (const [k, v] of texts) S.SetCVal(k, v);
    S.SetIVal('write.step.assembly', assembly);
  };
}

export interface StlOptions {
  /** Largest distance of the facets from the true surface, part units (default 10⁻⁴ of the size). */
  tolerance?: number;
  /** Largest angle between neighbouring facets on a curved face, radians (default 0.1). */
  angle?: number;
  name?: string;
  /** Factor from part units to the file's (millimetres: mmPerUnit). Default 1. */
  scale?: number;
}

/** Millimetres in one part unit: STL has no units, and slicers read it as millimetres. */
export const mmPerUnit = (unit: CadUnit) => ({ mm: 1, cm: 10, m: 1000, in: 25.4 })[unit];

/** A binary STL of the scope (an assembly in its placed coordinates), facets from the exact surfaces. */
export function stlFile(oc: OC, built: OccBuiltDesign, design: CadDesign, scope: ExportScope, o: StlOptions = {}): Uint8Array {
  const items: { shape: TopoDS_Shape; M: M4 }[] = [];
  if (scope.kind === 'assembly') {
    for (const occ of placed(built, design)) for (const s of partOf(built, design, occ.component)?.shapes ?? []) items.push({ shape: s, M: occ.M });
  } else {
    for (const s of partOf(built, design, scope.component, scope.kind === 'body' ? scope.body : undefined)?.shapes ?? []) items.push({ shape: s, M: IDENTITY });
  }
  if (!items.length) throw new Error('there is no solid to export');
  return scratch((t) => {
    const size = boxSize(oc, t, items.map((i) => i.shape));
    const tol = o.tolerance ?? Math.max(size * 1e-4, 1e-9), scale = o.scale ?? 1;
    const parts: Float32Array[] = [];
    for (const { shape, M } of items) {
      const raw = t.add(oc.ReplicadMeshExtractor.extract(shape, tol, o.angle ?? 0.1, true));
      const buf = oc.wasmMemory.buffer as ArrayBuffer;
      const v = new Float32Array(buf, raw.getVerticesPtr() >>> 0, raw.getVerticesSize());
      const tri = new Uint32Array(buf, raw.getTrianglesPtr() >>> 0, raw.getTrianglesSize());
      // non-indexed, moved into place (doubles on the way: the placement may be far out)
      const out = new Float32Array(tri.length * 3);
      for (let k = 0; k < tri.length; k++) {
        const i = tri[k] * 3;
        const q = m4Point(M, [v[i], v[i + 1], v[i + 2]]);
        out.set([q[0] * scale, q[1] * scale, q[2] * scale], 3 * k);
      }
      parts.push(out);
    }
    const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return meshToStl({ positions: all, normals: all, edges: new Float32Array(0), bounds: { min: [0, 0, 0], max: [0, 0, 0] } }, o.name);
  });
}

function boxSize(oc: OC, t: Arena, shapes: TopoDS_Shape[]): number {
  const bb = t.add(new oc.Bnd_Box());
  for (const s of shapes) oc.BRepBndLib.Add(s, bb, false);
  if (bb.IsVoid()) return 1;
  return Math.hypot(bb.GetXMax() - bb.GetXMin(), bb.GetYMax() - bb.GetYMin(), bb.GetZMax() - bb.GetZMin());
}
