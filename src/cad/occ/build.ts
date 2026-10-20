// Designs built with the B-rep kernel: the shared timeline with OCCT operations, exact
// mass properties by surface integration, and caches so a worksheet that recalculates
// for other reasons does not rebuild unchanged parts (and an edited part rebuilds only
// from the feature that changed, cache.ts).
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import {
  buildInputs, runTimeline, type CadDesign, type Datum, type DesignNumbers, type MeshBody, type Placement, type RebuiltSketch, type ThreadMark, type TimelineBody, type TimelineTool,
} from '../design';
import { meshBodyResult } from '../meshBody';
import { designKey } from '../keys';
import { Arena, type Frame, type Mass3, type Vec3 } from '../solid';
import { failedComponent, placeBuilt, timelineCache } from './cache';
import { hasSolid, occBox, onOccRenewed, renewOcc, scratch, trsf, volumeProperties, xyz, type OC } from './kernel';
import { occOps, type OccSolid } from './ops';

export { occBox };

export type OccBody = TimelineBody<OccSolid>;

export interface OccComponentBuild {
  bodies: OccBody[];
  errors: Record<string, string>;
  /** Problems that did not stop an item (a lost reference). */
  warnings: Record<string, string>;
  /** Sketch planes as built (sketches on faces) and construction planes. */
  frames: Record<string, Frame>;
  /** Construction geometry and coil helices. */
  datums: Record<string, Datum>;
  tools: Map<string, TimelineTool<OccSolid>>;
  /** Sketches the timeline solved again (their projected references moved). */
  sketches?: Record<string, RebuiltSketch>;
  /** Cosmetic threads (drawings draw them). */
  threads?: ThreadMark[];
  /** Imported mesh bodies (no B-rep). */
  meshes?: MeshBody[];
}

export interface OccBuiltDesign {
  oc: OC;
  arena: Arena;
  components: Map<string, OccComponentBuild>;
  placements: Record<string, Placement>;
  /** Joint and occurrence problems. */
  errors: Record<string, string>;
  /** Joints whose origin on geometry was lost. */
  warnings: Record<string, string>;
  free(): void;
}

/** Build every component with OCCT and place the occurrences. Call `free()` when done. */
export function buildDesignOcc(oc: OC, design: CadDesign, numbers: DesignNumbers): OccBuiltDesign {
  const arena = new Arena();
  const ops = occOps(oc, arena);
  const inp = buildInputs(design, numbers);
  const components = new Map<string, OccComponentBuild>();
  for (const c of design.components) {
    try {
      components.set(c.id, runTimeline(ops, design, c, inp));
    } catch (e) {
      components.set(c.id, failedComponent(c.id, e));
    }
  }
  const { placements, errors, warnings } = placeBuilt(oc, design, numbers, components);
  return { oc, arena, components, placements, errors, warnings, free: () => arena.free() };
}

export const isEmptyShape = (oc: OC, s: TopoDS_Shape) => !hasSolid(oc, s);

/**
 * The design built through the timeline cache: unchanged steps are reused. It belongs to
 * the cache (nothing to free) and stays valid until the next cached build.
 */
export const buildDesignCached = (oc: OC, design: CadDesign, numbers: DesignNumbers): OccBuiltDesign => timelineCache.build(oc, design, numbers);

// a solid that did not change keeps its measurements (shapes are never modified in place)
const massOf = new WeakMap<TopoDS_Shape, Mass3>();
const shapeMass = (oc: OC, s: TopoDS_Shape) => {
  let m = massOf.get(s);
  if (!m) massOf.set(s, (m = occMass(oc, s)));
  return m;
};

/**
 * Exact volume properties: volume, centroid and covariance ∫(x−c)(x−c)ᵀ dV. OCCT gives
 * moments of inertia about axes; six axes through the centroid recover the tensor J,
 * and C = ½ tr(J) I − J.
 */
export function occMass(oc: OC, s: TopoDS_Shape): Mass3 {
  return scratch((t) => {
    const p = t.add(new oc.GProp_GProps());
    const pi = volumeProperties(oc, t, s, p);
    const V = p.Mass();
    const g = t.add(p.CentreOfMass());
    const c = xyz(g);
    if (!(Math.abs(V) > 0)) return { V: 0, c, C: new Array(9).fill(0) };
    const I = (x: number, y: number, z: number) => pi.MomentOfInertia(t.add(new oc.gp_Ax1(g, t.add(new oc.gp_Dir(x, y, z)))));
    const Jxx = I(1, 0, 0), Jyy = I(0, 1, 0), Jzz = I(0, 0, 1);
    // about (a + b)/√2: ½(Jaa + Jbb) + Jab, and the product ∫ab dV = −Jab
    const Pxy = (Jxx + Jyy) / 2 - I(1, 1, 0), Pxz = (Jxx + Jzz) / 2 - I(1, 0, 1), Pyz = (Jyy + Jzz) / 2 - I(0, 1, 1);
    const half = (Jxx + Jyy + Jzz) / 2;
    return { V, c, C: [half - Jxx, Pxy, Pxz, Pxy, half - Jyy, Pyz, Pxz, Pyz, half - Jzz] };
  });
}

// ------------------------------------------------------------ measured designs (for the worksheet)

export interface MeasuredBody {
  id: string;
  name: string;
  feature: string;
  mass?: Mass3;
  empty?: boolean;
  /** An imported mesh body. */
  mesh?: boolean;
}

/** A box moved by a placement (the box of its moved corners). */
export function placedBox(b: { min: Vec3; max: Vec3 } | null, M: number[]): { min: Vec3; max: Vec3 } | null {
  if (!b) return null;
  const out = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (let k = 0; k < 8; k++) {
    const p: Vec3 = [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]];
    for (let i = 0; i < 3; i++) {
      const v = M[i] * p[0] + M[4 + i] * p[1] + M[8 + i] * p[2] + M[12 + i];
      out.min[i] = Math.min(out.min[i], v);
      out.max[i] = Math.max(out.max[i], v);
    }
  }
  return out;
}

/** The box around a box and others (any of them may be null). */
export function withMeshBoxes(b: { min: Vec3; max: Vec3 } | null, more: ({ min: Vec3; max: Vec3 } | null)[]): { min: Vec3; max: Vec3 } | null {
  let out = b && { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
  for (const m of more) {
    if (!m) continue;
    if (!out) out = { min: [...m.min] as Vec3, max: [...m.max] as Vec3 };
    else for (let i = 0; i < 3; i++) {
      out.min[i] = Math.min(out.min[i], m.min[i]);
      out.max[i] = Math.max(out.max[i], m.max[i]);
    }
  }
  return out;
}

export interface MeasuredDesign {
  /** Component id → its bodies. */
  bodies: Record<string, MeasuredBody[]>;
  /** Feature, component, joint and occurrence problems. */
  errors: Record<string, string>;
  /** Items and joints whose references were lost (they still build). */
  warnings: Record<string, string>;
  /** Sketch planes as built (a sketch on a face follows it). */
  frames: Record<string, Frame>;
  /** Sketches whose projected references moved, as the timeline solved them again. */
  sketches?: Record<string, RebuiltSketch>;
  placements: Record<string, Placement>;
  /** Bounding box of the visible occurrences (assembly coordinates). */
  box?: { min: Vec3; max: Vec3 };
}

const cache = new Map<string, MeasuredDesign>();
const CACHE_SIZE = 16;
let cachedBy: OC | null = null;
// a renewed kernel measures afresh, and the old instance must not stay reachable from here
onOccRenewed(() => {
  cache.clear();
  cachedBy = null;
});

/** Exact properties of every body, measured once per design and numbers (results are plain data). */
export function measureDesignOcc(oc: OC, design: CadDesign, numbers: DesignNumbers): MeasuredDesign {
  // a renewed kernel measures afresh: what the old one failed on (a trap) may build now
  if (oc !== cachedBy) {
    cache.clear();
    cachedBy = oc;
  }
  const key = designKey(design, numbers);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return structuredClone(hit);
  }
  const built = buildDesignCached(oc, design, numbers);
  try {
    const out: MeasuredDesign = { bodies: {}, errors: { ...built.errors }, warnings: { ...built.warnings }, frames: {}, placements: built.placements };
    let box: { min: Vec3; max: Vec3 } | null = null;
    for (const c of design.components) {
      const cb = built.components.get(c.id)!;
      Object.assign(out.errors, cb.errors);
      Object.assign(out.warnings, cb.warnings);
      Object.assign(out.frames, cb.frames);
      if (cb.sketches && Object.keys(cb.sketches).length) Object.assign((out.sketches ??= {}), cb.sketches);
      out.bodies[c.id] = cb.bodies.map((b) => (isEmptyShape(oc, b.solid.shape)
        ? { id: b.id, name: b.name, feature: b.feature, empty: true }
        : { id: b.id, name: b.name, feature: b.feature, mass: shapeMass(oc, b.solid.shape) }));
      // mesh bodies: volume properties only when closed
      for (const m of cb.meshes ?? []) out.bodies[c.id].push({ id: m.id, name: m.name, feature: m.feature, mesh: true, ...(m.mass ? { mass: m.mass } : { empty: true }) });
      // the box of each visible occurrence: its bodies moved into place
      for (const o of design.occurrences) {
        const M = built.placements[o.id]?.matrix;
        if (o.hidden || o.component !== c.id || !M) continue;
        const solidBox = scratch((t) => occBox(oc, cb.bodies.map((b) => t.add(t.add(new oc.BRepBuilderAPI_Transform(b.solid.shape, trsf(oc, t, M), false, false)).Shape()))));
        const bb = withMeshBoxes(solidBox, (cb.meshes ?? []).map((m) => placedBox(meshBodyResult(m).box, M)));
        if (!bb) continue;
        if (!box) box = { min: [...bb.min], max: [...bb.max] };
        for (let i = 0; i < 3; i++) {
          box.min[i] = Math.min(box.min[i], bb.min[i]);
          box.max[i] = Math.max(box.max[i], bb.max[i]);
        }
      }
    }
    if (box) out.box = box;
    cache.set(key, out);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return structuredClone(out);
  } finally {
    // between builds: the moment to renew a heap that OCCT's own leaks filled (the
    // timeline cache starts over with the fresh instance)
    renewOcc()?.catch((e) => console.warn('renewing the B-rep kernel failed', e));
  }
}
