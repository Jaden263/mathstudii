// STEP parts read by OpenCascade for the import feature. The file's structure (which
// PRODUCT_DEFINITION is which part, step21.ts) picks the entity, STEPControl_Reader
// transfers it in the part's unit (SetSystemLengthUnit: millimetres per unit), and the
// solids are kept per file and unit for every later build.
//
// Imported faces have no history, so they are named after their body and their surface:
// `${feature}/b${body}:${kind}${hash}`, the hash of the surface's own parameters (a plane's
// normal and offset, a cylinder's axis and radius …, a free-form face's centroid and area).
// The same file gives the same names, and a replaced file gives a face on the same surface
// the same name: a sketch on the top of an imported plate stays there when the new version
// has a hole in it. Faces on one surface are told apart by their place (#1, #2, as split
// faces are, topology.ts).
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { ImportedFile } from '../design';
import { fileBytes } from '../imported';
import { MM_PER_UNIT, partIndex } from '../importFeature';
import { stepStructure, type StepStructure } from '../step21';
import { Arena, dot3, norm3, scale3, sub3, type Vec3 } from '../solid';
import { hashString } from '../keys';
import type { FaceInfo } from '../buildResult';
import { guard, scratch, subShapes, xyz, type OC } from './kernel';
import type { FaceTag, OccSolid } from './ops';
import { faceInfo } from './topology';
import { strFromU8 } from 'fflate';

interface ReadPart {
  /** Solids in part units (owned by the file's arena). */
  solids: TopoDS_Shape[];
  /** Face names without the feature, per solid in explorer order. */
  keys: string[][];
  warnings: string[];
}

interface ReadFile {
  oc: OC;
  arena: Arena;
  structure: StepStructure;
  parts: Map<number, ReadPart>;
}

const read = new Map<string, ReadFile>();
const KEEP = 4;

/** The structure of a STEP file's text (kept with the file). */
export function stepFileStructure(f: ImportedFile): StepStructure {
  return stepStructure(strFromU8(fileBytes(f), true), f.name.replace(/\.[^.]+$/, ''));
}

/** Snap a length to a grid of 10⁻⁶ mm, a direction's components to 10⁻⁹: the same surface read twice gives the same numbers. */
const lengthQ = (unit: string) => {
  const q = 1e-6 / (MM_PER_UNIT[unit] ?? 1);
  return (v: number) => String(Math.round(v / q));
};
const dirQ = (d: Vec3) => d.map((v) => String(Math.round(v * 1e9))).join(',');
/** An axis direction pointing one agreed way (its first clear component positive). */
const canonical = (d: Vec3): Vec3 => {
  const n = norm3(d);
  const k = n.findIndex((v) => Math.abs(v) > 1e-9);
  return k >= 0 && n[k] < 0 ? scale3(n, -1) : n;
};
/** The point of a line nearest the origin. */
const foot = (p: Vec3, d: Vec3): Vec3 => sub3(p, scale3(d, dot3(p, d)));

/** What names a face of an imported solid: its kind and the parameters of its surface. */
export function surfaceSignature(oc: OC, t: Arena, face: TopoDS_Shape, f: FaceInfo, unit: string): string {
  const L = lengthQ(unit), P = (p: Vec3) => p.map(L).join(',');
  if (f.type === 'plane' && f.frame) {
    const n = norm3(f.frame.n);
    return `p${dirQ(n)};${L(dot3(n, f.frame.o))}`;
  }
  if ((f.type === 'cylinder' || f.type === 'torus') && f.axis && f.radius !== undefined) {
    const d = canonical(f.axis.d);
    const at = f.type === 'torus' ? f.axis.p : foot(f.axis.p, d);
    return `${f.type === 'cylinder' ? 'c' : 't'}${dirQ(d)};${P(at)};${L(f.radius)};${f.minorRadius !== undefined ? L(f.minorRadius) : ''};${f.outward === false ? 'in' : 'out'}`;
  }
  if (f.type === 'sphere' && f.axis && f.radius !== undefined) return `s${P(f.axis.p)};${L(f.radius)}`;
  if (f.type === 'cone' && f.axis && f.angle !== undefined) {
    // its apex and half angle (the reference radius depends on where the surface was set up)
    const g = t.add(oc.BRep_Tool.Surface(oc.TopoDS.Face(face))) as unknown as { Apex?: () => { X(): number; Y(): number; Z(): number; delete(): void } };
    const apex = g.Apex ? xyz(t.add(g.Apex())) : null;
    const d = canonical(f.axis.d);
    return `k${dirQ(d)};${apex ? P(apex) : P(foot(f.axis.p, d))};${Math.round(f.angle * 1e9)}`;
  }
  // free-form faces: where the face is and how big
  return `${f.type === 'bspline' ? 'b' : 'o'}${P(f.c)};${L(Math.sqrt(Math.max(f.area, 0)))}`;
}

/** Face names of a solid: `b${body}:${kind letter}${hash of its surface}`. */
function faceKeys(oc: OC, solid: TopoDS_Shape, body: number, unit: string): string[] {
  return scratch((t) => subShapes(oc, t, solid, oc.TopAbs_ShapeEnum.TopAbs_FACE).map((fs, i) => {
    const info = faceInfo(oc, t, t.add(oc.TopoDS.Face(fs)), i);
    const sig = surfaceSignature(oc, t, fs, info, unit);
    return `b${body}:${sig[0]}${hashString(sig).slice(-10)}`;
  }));
}

/** The solids of a transferred shape; closed shells (surface models) made solids, open ones left out. */
function solidsOf(oc: OC, arena: Arena, shape: TopoDS_Shape, warnings: string[]): TopoDS_Shape[] {
  const A = oc.TopAbs_ShapeEnum;
  return scratch((t) => {
    const out: TopoDS_Shape[] = [];
    for (const s of subShapes(oc, t, shape, A.TopAbs_SOLID)) out.push(arena.add(oc.TopoDS.Solid(s)));
    if (out.length) return out;
    let open = 0;
    for (const sh of subShapes(oc, t, shape, A.TopAbs_SHELL)) {
      const shell = t.add(oc.TopoDS.Shell(sh));
      if (!oc.BRep_Tool.IsClosed(shell)) {
        open++;
        continue;
      }
      const mk = t.add(new oc.BRepBuilderAPI_MakeSolid(shell));
      if (!mk.IsDone()) continue;
      const solid = t.add(mk.Solid());
      const p = t.add(new oc.GProp_GProps());
      oc.BRepGProp.VolumeProperties(solid, p, false, false, false);
      // a shell facing inwards encloses everything else: turned round
      out.push(arena.add(p.Mass() < 0 ? solid.Reversed() : oc.TopoDS.Solid(solid)));
    }
    if (open) warnings.push(`${open} open surface${open > 1 ? 's' : ''} (no solid) left out`);
    return out;
  });
}

/** Read a STEP file's parts (all at once: the reader holds the whole file anyway). */
function readFile(oc: OC, f: ImportedFile, unit: string): ReadFile {
  const key = `${f.hash}|${unit}`;
  const hit = read.get(key);
  if (hit && hit.oc === oc) {
    read.delete(key);
    read.set(key, hit);
    return hit;
  }
  const structure = stepFileStructure(f);
  const arena = new Arena();
  const out: ReadFile = { oc, arena, structure, parts: new Map() };
  const path = `/import-${f.hash.replace(/\W/g, '_')}.step`;
  try {
    readParts(oc, f, unit, path, out);
  } catch (e) {
    arena.free();
    throw e;
  }
  read.set(key, out);
  // the oldest files go (the steps that use their solids hold handles of their own)
  while (read.size > KEEP) {
    const k = read.keys().next().value!;
    read.get(k)!.arena.free();
    read.delete(k);
  }
  return out;
}

/** Transfer every part of a file (the solids into `out`'s arena). */
function readParts(oc: OC, f: ImportedFile, unit: string, path: string, out: ReadFile) {
  const { arena, structure } = out;
  scratch((t) => {
    oc.FS.writeFile(path, fileBytes(f));
    try {
      const r = t.add(new oc.STEPControl_Reader());
      const status = guard(oc, `${f.name} could not be read`, () => r.ReadFile(path));
      if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error(`${f.name} could not be read as a STEP file`);
      // the transfer writes the part's unit
      r.SetSystemLengthUnit(MM_PER_UNIT[unit] ?? 1);
      const model = t.add(r.StepModel());
      for (const p of structure.parts) {
        const warnings: string[] = [];
        r.ClearShapes();
        const shapes: TopoDS_Shape[] = [];
        /** The shape the kernel makes of one entity. */
        const transfer = (id: number) => {
          const n = model.NextNumberForLabel(`#${id}`, 0, true);
          if (n > 0 && guard(oc, `${p.name} could not be read`, () => r.TransferEntity(t.add(model.Entity(n)), t.add(new oc.Message_ProgressRange()))) && r.NbShapes()) shapes.push(t.add(r.Shape(r.NbShapes())));
        };
        // an assembly's own solids by their representations (its definition would bring its sub-assemblies along)
        if (p.reps?.length) p.reps.forEach(transfer);
        else if (p.pd) transfer(p.pd);
        else if (guard(oc, `${f.name} could not be read`, () => r.TransferRoots(t.add(new oc.Message_ProgressRange()))) > 0) shapes.push(t.add(r.OneShape()));
        const solids = shapes.filter((s) => !s.IsNull()).flatMap((s) => solidsOf(oc, arena, s, warnings));
        if (!solids.length) warnings.push('it has no solid in the file');
        out.parts.set(p.pd, { solids, keys: solids.map((s, i) => faceKeys(oc, s, i, unit)), warnings });
      }
    } finally {
      oc.FS.unlink(path);
    }
  });
}

/** The solids of one part of a STEP file for an import feature, tagged with their face names (handles in `arena`). */
export function stepBodiesOcc(oc: OC, arena: Arena, f: ImportedFile, part: { key: string; index: number } | undefined, unit: string, tag: string): { solids: OccSolid[]; warnings: string[] } {
  const file = readFile(oc, f, unit);
  const p = file.structure.parts[partIndex(file.structure.parts, part, f.name)];
  const got = file.parts.get(p.pd);
  if (!got) throw new Error(`${p.name} could not be read from ${f.name}`);
  const solids = got.solids.map((s, bi): OccSolid => {
    // a handle of the step's own: the file's may be freed while the step lives on
    const shape = arena.add(oc.TopoDS.Solid(s));
    const faces = scratch((t) => subShapes(oc, t, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE).map((fc) => arena.add(oc.TopoDS.Face(fc))));
    const tags: FaceTag[] = faces.map((face, i) => ({ face, key: `${tag}/${got.keys[bi][i]}`, feature: tag }));
    return { shape, tags };
  });
  return { solids, warnings: got.warnings };
}

/** Free every file read (tests check that nothing is left behind). */
export function clearStepFiles() {
  for (const f of read.values()) f.arena.free();
  read.clear();
}
