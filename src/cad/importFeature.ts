// The import feature in the timeline: the bodies of one part of an imported file. STEP
// parts come from the B-rep kernel (occ/stepImport.ts) with their faces named after their
// body and surface, so sketches, fillets, holes, joints and drawings on them hold on
// through a rebuild and through Replace file where the geometry is the same. Meshes are
// read here (meshFiles.ts), whichever kernel builds, and become mesh bodies, or solids
// sewn by the B-rep kernel when asked.
import type { CadDesign, ImportFeature, SolidOps } from './design';
import { fileBytes, importedFile, type ImportedFile } from './imported';
import { meshBodyOf, meshWords, isClosed, type MeshBody } from './meshBody';
import { readMeshFile, type MeshFile } from './meshFiles';

/** Millimetres per part unit. */
export const MM_PER_UNIT: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/** Above this many triangles a mesh is not sewn into a solid (sewing takes about a second per 20 000). */
export const SEW_LIMIT = 20_000;

const files = new Map<string, MeshFile>();
const bodies = new Map<string, Omit<MeshBody, 'id' | 'feature'>>();

/** A mesh file's contents (the last few read are kept). */
export function meshFileOf(f: ImportedFile): MeshFile {
  let m = files.get(f.hash);
  if (!m) {
    if (f.format === 'step') throw new Error('a STEP file has no meshes');
    m = readMeshFile(f.format, fileBytes(f), f.name.replace(/\.[^.]+$/, ''));
    files.set(f.hash, m);
    if (files.size > 4) files.delete(files.keys().next().value!);
  }
  return m;
}

/** The part of a file an import builds: by its key, else (gone from a replaced file) by its place. */
export function partIndex<T extends { key: string }>(parts: T[], part: ImportFeature['part'], file: string): number {
  if (!part) return 0;
  const k = parts.findIndex((p) => p.key === part.key);
  if (k >= 0) return k;
  // a file of one part, or parts without keys: by its place (another product in the same place is no match)
  if (parts.length === 1 || !part.key) return Math.min(part.index, parts.length - 1);
  throw new Error(`${file} has no part ${part.key}`);
}

export interface Imported<S> {
  solids: S[];
  meshes: MeshBody[];
  warnings: string[];
}

/** Run an import feature: its B-rep solids or mesh bodies in part units. */
export function runImport<S>(ops: SolidOps<S>, design: CadDesign, item: ImportFeature, unit = 'mm'): Imported<S> {
  const file = importedFile(design, item.file);
  if (file.format === 'step') {
    if (!ops.stepBodies) throw new Error('needs the B-rep kernel: OpenCascade has not loaded, and the mesh kernel cannot read STEP files');
    const { solids, warnings } = ops.stepBodies(file, item.part, unit, item.id);
    if (!solids.length) throw new Error(`the part in ${file.name} has no solid${warnings.length ? ` (${warnings.join('; ')})` : ''}`);
    return { solids, meshes: [], warnings };
  }
  const mf = meshFileOf(file);
  const pi = partIndex(mf.parts, item.part, file.name);
  const part = mf.parts[pi];
  // the file's unit if it has one, else the feature's
  const scale = (mf.unit ?? MM_PER_UNIT[item.unit ?? 'mm']) / (MM_PER_UNIT[unit] ?? 1);
  const out: Imported<S> = { solids: [], meshes: [], warnings: [] };
  part.meshes.forEach((m, k) => {
    const id = k ? `${item.id}.b${k}` : item.id;
    const key = `${file.hash}|${pi}|${k}|${scale}`;
    let b = bodies.get(key);
    if (!b) {
      const { id: _, feature: __, ...rest } = meshBodyOf(id, item.id, m, scale);
      bodies.set(key, (b = rest));
      if (bodies.size > 16) bodies.delete(bodies.keys().next().value!);
    }
    const body: MeshBody = { ...b, id, feature: item.id };
    const why = meshWords(body);
    if (item.solid) {
      if (!ops.meshSolid) throw new Error('needs the B-rep kernel: OpenCascade has not loaded, and the mesh kernel cannot sew meshes into solids');
      if (!isClosed(body.check) || !body.mass) throw new Error(`${body.name || 'the mesh'} cannot become a solid: ${why}`);
      const n = body.indices.length / 3;
      if (n > SEW_LIMIT) throw new Error(`${body.name || 'the mesh'} has ${n} triangles: only meshes of up to ${SEW_LIMIT} are sewn into solids (leave it a mesh body)`);
      out.solids.push(ops.meshSolid(body, k, unit, item.id));
    } else {
      out.meshes.push(body);
      if (why) out.warnings.push(`${body.name || 'mesh'}: ${why}`);
    }
  });
  return out;
}
