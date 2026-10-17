// What an imported file does to a design, as Fusion's Insert does it: a file of one part
// placed at the origin becomes an import feature in the active component (its bodies join
// the component's); an assembly becomes a component per part with an occurrence for every
// instance, grounded where the file places it, named and coloured as in the file. Replace
// file swaps the file under the import features: each keeps its part by key, the
// occurrences the import placed move to the new placements, and new parts are added.
import { cadId, type CadUnit } from './model';
import type { CadComponent, CadDesign, CadOccurrence, ImportFeature, ImportedFile } from './design';
import { nextName } from './design';
import { packFile, withFiles, LARGE_IMPORT, sizeWords } from './imported';
import { readMeshFile } from './meshFiles';
import { stepStructure } from './step21';
import { MM_PER_UNIT } from './importFeature';
import { strFromU8 } from 'fflate';
import type { M4, Vec3 } from './solid';

/** What a file holds, read without a kernel: its parts and where it places them. */
export interface ImportPlan {
  file: ImportedFile;
  /** `bodies`: the names of its solids or meshes; `triangles`: a mesh part's count. */
  parts: { key: string; name: string; color?: string; bodies: string[]; triangles?: number }[];
  /** Placements in millimetres. */
  instances: { part: number; path: string; name: string; M: M4 }[];
  /** Millimetres per unit of the file's numbers (null: the file has no unit). */
  unit: number | null;
  warnings: string[];
}

/** Read a file for importing. `materials`: colours of an MTL file picked with an OBJ. */
export function planImport(name: string, format: ImportedFile['format'], bytes: Uint8Array, materials?: Record<string, string>): ImportPlan {
  const file = packFile(name, format, bytes);
  const base = name.replace(/\.[^.]+$/, '');
  const warnings: string[] = [];
  if (bytes.length > LARGE_IMPORT) warnings.push(`${name} is ${sizeWords(bytes.length)}: the worksheet file grows by about ${sizeWords(file.data.length)}, and saving it in the browser's storage may fail`);
  if (format === 'step') {
    const s = stepStructure(strFromU8(bytes, true), base);
    return { file, parts: s.parts.map((p) => ({ key: p.key, name: p.name, ...(p.color ? { color: p.color } : {}), bodies: p.solids })), instances: s.instances, unit: s.unit, warnings: [...warnings, ...s.warnings] };
  }
  const m = readMeshFile(format, bytes, base, materials);
  return {
    file, parts: m.parts.map((p) => ({ key: p.key, name: p.name, ...(p.color ? { color: p.color } : {}), bodies: p.meshes.map((x) => x.name), triangles: p.meshes.reduce((n, x) => n + x.indices.length / 3, 0) })),
    instances: m.instances, unit: m.unit, warnings: [...warnings, ...m.warnings],
  };
}

const IDENT_EPS = 1e-12;
const isIdentity = (M: M4) => M.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < IDENT_EPS);

/**
 * A rigid placement (millimetres) as an occurrence's position (part units) and rotation
 * about X, then Y, then Z (fixed axes, degrees, as m4Pose composes R = Rz·Ry·Rx). Null
 * when it mirrors or scales.
 */
export function poseOf(M: M4, unit: CadUnit): { pos: Vec3; rot: Vec3 } | null {
  const R = (r: number, c: number) => M[4 * c + r];
  const det = R(0, 0) * (R(1, 1) * R(2, 2) - R(1, 2) * R(2, 1)) - R(0, 1) * (R(1, 0) * R(2, 2) - R(1, 2) * R(2, 0)) + R(0, 2) * (R(1, 0) * R(2, 1) - R(1, 1) * R(2, 0));
  if (Math.abs(det - 1) > 1e-6) return null;
  const deg = 180 / Math.PI;
  const sb = Math.max(-1, Math.min(1, -R(2, 0)));
  let a: number, b: number, c: number;
  if (Math.abs(sb) < 1 - 1e-12) {
    b = Math.asin(sb);
    a = Math.atan2(R(2, 1), R(2, 2));
    c = Math.atan2(R(1, 0), R(0, 0));
  } else {
    // gimbal lock: the turn about Z taken as none
    b = (Math.sign(sb) * Math.PI) / 2;
    c = 0;
    a = Math.atan2(R(0, 1) * Math.sign(sb), R(1, 1));
  }
  const k = 1 / (MM_PER_UNIT[unit] ?? 1);
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return { pos: [clean(M[12] * k), clean(M[13] * k), clean(M[14] * k)], rot: [clean(a * deg), clean(b * deg), clean(c * deg)] };
}

export interface ImportOptions {
  /** The part's unit. */
  unit: CadUnit;
  /** The component new single-part imports go into (the active one). */
  active?: string;
  /** Unit of a file without one (STL, OBJ). */
  fileUnit?: CadUnit;
  /** Sew closed meshes into solids. */
  solid?: boolean;
}

/** Ids of the bodies an import feature makes (as the timeline names them). */
export const importBodyIds = (fid: string, n: number) => Array.from({ length: n }, (_, k) => (k ? `${fid}.b${k}` : fid));

function feature(design: CadDesign, plan: ImportPlan, part: number, o: ImportOptions): ImportFeature {
  const p = plan.parts[part];
  return {
    kind: 'import', id: cadId('f'), name: nextName(design, 'Import'), file: plan.file.hash, part: { key: p.key, index: part },
    ...(plan.file.format !== 'step' && plan.unit === null && o.fileUnit && o.fileUnit !== 'mm' ? { unit: o.fileUnit } : {}),
    ...(o.solid && plan.file.format !== 'step' ? { solid: true } : {}),
  };
}

/** Body names from the file for the bodies an import makes (unnamed ones keep the default). */
function bodyNames(fid: string, names: string[]): Record<string, string> {
  const ids = importBodyIds(fid, names.length);
  return Object.fromEntries(names.map((n, k) => [ids[k], n.trim()]).filter(([, n]) => n));
}

const isEmpty = (c: CadComponent) => !c.items.length;

/** The design with a file imported (see the top of this file). */
export function insertImport(design: CadDesign, plan: ImportPlan, o: ImportOptions): { design: CadDesign; components: string[]; features: string[] } {
  let d: CadDesign = design;
  // the occurrences the import placed, by their path in the file (Replace file moves them)
  const placed: Record<string, string> = {};
  const single = plan.parts.length === 1 && plan.instances.length === 1 && isIdentity(plan.instances[0].M);
  const active = d.components.find((c) => c.id === o.active) ?? d.components[0];
  if (single && active) {
    const f = feature(d, plan, 0, o);
    const names = plan.file.format === 'step' ? bodyNames(f.id, plan.parts[0].bodies) : {};
    d = {
      ...d, components: d.components.map((c) => {
        if (c.id !== active.id) return c;
        const at = c.marker ?? c.items.length;
        const items = [...c.items];
        items.splice(at, 0, f);
        // a new, empty part is named and coloured after the file's
        const fresh = isEmpty(active) ? { name: uniqueName({ ...d, components: d.components.filter((q) => q !== c) }, [], plan.parts[0].name), ...(plan.parts[0].color ? { color: plan.parts[0].color } : {}) } : {};
        return {
          ...c, items, marker: c.marker === undefined ? undefined : c.marker + 1, ...fresh,
          ...(Object.keys(names).length ? { bodyNames: { ...c.bodyNames, ...names } } : {}),
        };
      }),
    };
    return { design: withFiles(d, [plan.file]), components: [active.id], features: [f.id] };
  }
  const comps: CadComponent[] = [];
  const features: string[] = [];
  // an empty active component (a new part) takes the first part
  const reuse = active && isEmpty(active) ? active : null;
  for (let pi = 0; pi < plan.parts.length; pi++) {
    const p = plan.parts[pi];
    const f = feature({ ...d, components: [...d.components, ...comps] }, plan, pi, o);
    features.push(f.id);
    const names = plan.file.format === 'step' ? bodyNames(f.id, p.bodies) : {};
    const base = reuse && pi === 0 ? reuse : null;
    const comp: CadComponent = {
      ...(base ?? { id: cadId('c'), name: uniqueName(d, comps, p.name) }),
      items: [f],
      ...(p.color ? { color: p.color } : {}),
      ...(Object.keys(names).length ? { bodyNames: names } : {}),
    };
    if (base) comp.name = uniqueName({ ...d, components: d.components.filter((c) => c !== base) }, comps, p.name);
    comps.push(comp);
  }
  const compOf = (pi: number) => comps[pi].id;
  // occurrences: the reused component's own occurrence takes its first instance
  const occs: CadOccurrence[] = d.occurrences.filter((oc) => !(reuse && oc.component === reuse.id));
  const warnings: string[] = [];
  let reused = reuse ? d.occurrences.find((oc) => oc.component === reuse.id) : undefined;
  for (const inst of plan.instances) {
    const pose = poseOf(inst.M, o.unit) ?? movedOnly(inst.M, o.unit);
    if (!poseOf(inst.M, o.unit)) warnings.push(`${inst.name} is mirrored or scaled in the file: it is placed where the file has it, but not turned`);
    const id = reused?.id ?? cadId('o');
    reused = undefined;
    occs.push({ id, component: compOf(inst.part), name: inst.name, grounded: true, ...place(pose) });
    placed[inst.path || `#${occs.length}`] = id;
  }
  d = withFiles({ ...d, components: [...d.components.filter((c) => c !== reuse), ...comps], occurrences: occs }, [{ ...plan.file, placed }]);
  plan.warnings.push(...warnings);
  return { design: d, components: comps.map((c) => c.id), features };
}

/** The position of a placement alone (part units), for one that mirrors or scales. */
const movedOnly = (M: M4, unit: CadUnit) => ({ pos: [M[12], M[13], M[14]].map((v) => v / (MM_PER_UNIT[unit] ?? 1)) as Vec3, rot: [0, 0, 0] as Vec3 });

/** Position and rotation fields, left out when zero. */
const place = (pose: { pos: Vec3; rot: Vec3 }): Partial<CadOccurrence> => ({
  ...(pose.pos.some((v) => v) ? { pos: pose.pos } : {}),
  ...(pose.rot.some((v) => v) ? { rot: pose.rot } : {}),
});

function uniqueName(d: CadDesign, more: CadComponent[], name: string): string {
  const used = new Set([...d.components, ...more].map((c) => c.name));
  if (!used.has(name)) return name;
  let k = 2;
  while (used.has(`${name} (${k})`)) k++;
  return `${name} (${k})`;
}

/**
 * Replace the file under the import features that build from `old`: they keep their part
 * by its key; occurrences the import placed move to where the new file places their path;
 * parts and instances new to the file are added; parts gone are reported (their features
 * then say so).
 */
export function replaceImport(design: CadDesign, old: string, plan: ImportPlan, o: ImportOptions): { design: CadDesign; added: string[]; missing: string[] } {
  const prev = design.files?.[old];
  const placed: Record<string, string> = { ...prev?.placed };
  const users = design.components.flatMap((c) => c.items.filter((i): i is ImportFeature => i.kind === 'import' && i.file === old).map((i) => ({ c, i })));
  const keys = new Set(plan.parts.map((p) => p.key));
  const missing = users.filter(({ i }) => i.part && plan.parts.length > 1 && !keys.has(i.part.key)).map(({ i }) => i.part!.key);
  // the features point at the new file
  let d: CadDesign = {
    ...design,
    components: design.components.map((c) => ({
      ...c, items: c.items.map((i) => {
        if (i.kind !== 'import' || i.file !== old) return i;
        const k = i.part ? plan.parts.findIndex((p) => p.key === i.part!.key) : 0;
        return { ...i, file: plan.file.hash, ...(i.part && k >= 0 ? { part: { key: i.part.key, index: k } } : {}) };
      }),
    })),
  };
  const compOfPart = new Map<number, string>();
  for (const { c, i } of users) {
    const k = i.part ? plan.parts.findIndex((p) => p.key === i.part!.key) : 0;
    if (k >= 0 && !compOfPart.has(k)) compOfPart.set(k, c.id);
  }
  const added: string[] = [];
  // a multi-part import: occurrences follow their paths; new parts get components
  if (prev?.placed || plan.instances.length > 1 || plan.parts.length > 1) {
    const occs = [...d.occurrences];
    const comps = [...d.components];
    for (let pi = 0; pi < plan.parts.length; pi++) {
      if (compOfPart.has(pi)) continue;
      const f = feature({ ...d, components: comps }, plan, pi, o);
      const p = plan.parts[pi];
      const comp: CadComponent = { id: cadId('c'), name: uniqueName({ ...d, components: comps }, [], p.name), items: [f], ...(p.color ? { color: p.color } : {}) };
      comps.push(comp);
      compOfPart.set(pi, comp.id);
      added.push(comp.name);
    }
    const seen = new Set<string>();
    for (const inst of plan.instances) {
      const pose = poseOf(inst.M, o.unit) ?? movedOnly(inst.M, o.unit);
      const path = inst.path || inst.name;
      seen.add(path);
      const at = placed[path] ? occs.findIndex((q) => q.id === placed[path]) : -1;
      if (at >= 0) {
        // where the new file has it (a grounded occurrence the user has not moved off the file's placement)
        const { pos: _, rot: __, ...rest } = occs[at];
        occs[at] = { ...rest, ...place(pose) };
      } else {
        const id = cadId('o');
        occs.push({ id, component: compOfPart.get(inst.part)!, name: inst.name, grounded: true, ...place(pose) });
        placed[path] = id;
      }
    }
    d = { ...d, components: comps, occurrences: occs };
  }
  d = withFiles(d, [plan.file]);
  if (d.files?.[plan.file.hash] && Object.keys(placed).length) d = { ...d, files: { ...d.files, [plan.file.hash]: { ...d.files[plan.file.hash], placed } } };
  return { design: d, added, missing };
}
