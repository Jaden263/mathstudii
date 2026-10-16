// Designs built with the B-rep kernel: the shared timeline with OCCT operations, exact
// mass properties by surface integration, and caches so a worksheet that recalculates
// for other reasons does not rebuild unchanged parts (and an edited part rebuilds only
// from the feature that changed, cache.ts).
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import {
  buildInputs, placeOccurrences, runTimeline, type CadDesign, type DesignNumbers, type Placement, type TimelineBody, type TimelineTool,
} from '../design';
import { designKey } from '../keys';
import { Arena, type Mass3, type Vec3 } from '../solid';
import { timelineCache } from './cache';
import { hasSolid, renewOcc, scratch, trsf, xyz, type OC } from './kernel';
import { occOps, type OccSolid } from './ops';

export type OccBody = TimelineBody<OccSolid>;

export interface OccComponentBuild {
  bodies: OccBody[];
  errors: Record<string, string>;
  tools: Map<string, TimelineTool<OccSolid>>;
}

export interface OccBuiltDesign {
  oc: OC;
  arena: Arena;
  components: Map<string, OccComponentBuild>;
  placements: Record<string, Placement>;
  /** Joint and occurrence problems. */
  errors: Record<string, string>;
  free(): void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      components.set(c.id, { bodies: [], errors: { [c.id]: msg(e) }, tools: new Map() });
    }
  }
  const { placements, errors } = placeOccurrences(design, numbers);
  return { oc, arena, components, placements, errors, free: () => arena.free() };
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
    oc.BRepGProp.VolumeProperties(s, p, false, false, false);
    const V = p.Mass();
    const g = t.add(p.CentreOfMass());
    const c = xyz(g);
    if (!(Math.abs(V) > 0)) return { V: 0, c, C: new Array(9).fill(0) };
    const I = (x: number, y: number, z: number) => p.MomentOfInertia(t.add(new oc.gp_Ax1(g, t.add(new oc.gp_Dir(x, y, z)))));
    const Jxx = I(1, 0, 0), Jyy = I(0, 1, 0), Jzz = I(0, 0, 1);
    // about (a + b)/√2: ½(Jaa + Jbb) + Jab, and the product ∫ab dV = −Jab
    const Pxy = (Jxx + Jyy) / 2 - I(1, 1, 0), Pxz = (Jxx + Jzz) / 2 - I(1, 0, 1), Pyz = (Jyy + Jzz) / 2 - I(0, 1, 1);
    const half = (Jxx + Jyy + Jzz) / 2;
    return { V, c, C: [half - Jxx, Pxy, Pxz, Pxy, half - Jyy, Pyz, Pxz, Pyz, half - Jzz] };
  });
}

export function occBox(oc: OC, shapes: TopoDS_Shape[]): { min: Vec3; max: Vec3 } | null {
  return scratch((t) => {
    const bb = t.add(new oc.Bnd_Box());
    // the optimal box hugs curved faces (the plain one is padded by their control points)
    for (const s of shapes) oc.BRepBndLib.AddOptimal(s, bb, false, false);
    if (bb.IsVoid()) return null;
    return { min: [bb.GetXMin(), bb.GetYMin(), bb.GetZMin()], max: [bb.GetXMax(), bb.GetYMax(), bb.GetZMax()] };
  });
}

// ------------------------------------------------------------ measured designs (for the worksheet)

export interface MeasuredBody {
  id: string;
  name: string;
  feature: string;
  mass?: Mass3;
  empty?: boolean;
}

export interface MeasuredDesign {
  /** Component id → its bodies. */
  bodies: Record<string, MeasuredBody[]>;
  /** Feature, component, joint and occurrence problems. */
  errors: Record<string, string>;
  placements: Record<string, Placement>;
  /** Bounding box of the visible occurrences (assembly coordinates). */
  box?: { min: Vec3; max: Vec3 };
}

const cache = new Map<string, MeasuredDesign>();
const CACHE_SIZE = 16;

/** Exact properties of every body, measured once per design and numbers (results are plain data). */
export function measureDesignOcc(oc: OC, design: CadDesign, numbers: DesignNumbers): MeasuredDesign {
  const key = designKey(design, numbers);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return structuredClone(hit);
  }
  const built = buildDesignCached(oc, design, numbers);
  try {
    const out: MeasuredDesign = { bodies: {}, errors: { ...built.errors }, placements: built.placements };
    let box: { min: Vec3; max: Vec3 } | null = null;
    for (const c of design.components) {
      const cb = built.components.get(c.id)!;
      Object.assign(out.errors, cb.errors);
      out.bodies[c.id] = cb.bodies.map((b) => (isEmptyShape(oc, b.solid.shape)
        ? { id: b.id, name: b.name, feature: b.feature, empty: true }
        : { id: b.id, name: b.name, feature: b.feature, mass: shapeMass(oc, b.solid.shape) }));
      // the box of each visible occurrence: its bodies moved into place
      for (const o of design.occurrences) {
        const M = built.placements[o.id]?.matrix;
        if (o.hidden || o.component !== c.id || !M) continue;
        const bb = scratch((t) => occBox(oc, cb.bodies.map((b) => t.add(t.add(new oc.BRepBuilderAPI_Transform(b.solid.shape, trsf(oc, t, M), false, false)).Shape()))));
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
