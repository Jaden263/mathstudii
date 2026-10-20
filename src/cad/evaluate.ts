// Evaluates a CAD region inside the worksheet: expressions (dimensions, extents,
// joint values, densities) are read from the worksheet scope, every sketch is solved,
// the bodies are built and placed, and the part's properties are exported under the
// region's name (part.m, part.V, part.d1, part.Bracket.m, …) for the math below it.
import type { Unit } from 'mathjs';
import type { CadRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import type { SectionProps } from '../engine/geometry';
import { isAngleDim, isDimension, type CadSketch } from './model';
import type { ProfileRegion, Vec2 } from './profile';
import { sketchSolution } from './sketchSolve';
import {
  activeItems, buildDesign, buildInputs, bodyMass, designOf, exactComponent, hasFeatures, identifier, isSketch, massOut, offsetFrame, placeOccurrences,
  placedSolids, planeFrame, type CadDesign, type DesignNumbers, type MassOut, type Placement, type RebuiltSketch,
} from './design';
import { boxOf, kernel, kernelFailure, transformMass, type Frame, type Mass3, type Vec3 } from './solid';
import { designKey } from './keys';
import { dimensionValue } from './dimension';
import { parseThread, threadIn } from './threads';
import { occ, occFailure } from './occ/kernel';
import type { KinState } from './kinematics';
import type { MotionResult } from './motion';
import { studyResult } from './occ/motion';
import { assemblyParams, jointExport, jointParams, motionValue } from './assemblyParams';
import { measureDesignOcc, type MeasuredDesign } from './occ/build';

export interface CadResult {
  kind: 'cad';
  /** sketchSig of the sketch this result was solved from. */
  sig?: string;
  /** Solved geometry (of the first sketch, for a whole part). */
  points: Record<string, [number, number]>;
  radii: Record<string, number>;
  ok: boolean;
  dof: number;
  determined: string[];
  determinedRadii: string[];
  conflicting: string[];
  redundant: string[];
  /** Current value of every dimension, sketch units (angles in radians). */
  values: Record<string, number>;
  /** Dimension id → why its expression could not be used. */
  dimErrors: Record<string, string>;
  /** Profile problems (open outlines, branches). */
  issues: string[];
  section?: SectionProps;
  /** Whole design: volume properties, mass (kg) and mass moments (kg·unit²). */
  mass?: MassOut;
  /** First feature problem (bad depth, profile crossing the axis …). */
  featureError?: string;
  error?: string;
  design?: DesignResult;
  /** Booleans waited for the 3-D kernel; evaluate again once it has loaded. */
  needsKernel?: boolean;
  /** Built without the B-rep kernel (not loaded yet); evaluate again once it has, for exact results. */
  needsBrep?: boolean;
}

export interface BodyInfo {
  id: string;
  name: string;
  feature: string;
  mass?: MassOut;
  empty?: boolean;
}

export interface DesignResult extends DesignNumbers {
  sketches: Record<string, CadResult>;
  /** Component id → its bodies. */
  bodies: Record<string, BodyInfo[]>;
  /** Component id → mass properties of all its bodies (component coordinates). */
  components: Record<string, MassOut | null>;
  placements: Record<string, Placement>;
  total?: MassOut;
  box?: { min: Vec3; max: Vec3 };
  /** Solids were built by the kernel (not only exact single-feature bodies). */
  kernel: boolean;
  /** …by the B-rep kernel: every property is exact. */
  brep?: boolean;
  /** Why the B-rep kernel is not there (it could not load): the mesh kernel built the part. */
  brepError?: string;
  /** Neither kernel could load: why the mesh kernel did not (nothing built the part). */
  kernelError?: string;
  /** Key of the built design (keys.ts): its display data comes separately, once per key. */
  display?: string;
  /** The errors of resolving the numbers, before the build added its own (`errors` has both). */
  resolveErrors?: Record<string, string>;
  /** Items and joints whose references were lost but which still build (a sketch whose face is gone). */
  warnings?: Record<string, string>;
  /** The sketch planes as resolved, before the build moved sketches on faces onto them (`frames` are as built). */
  resolveFrames?: Record<string, Frame>;
  /** The sketches as resolved, before the build projected their references again (`sketches` are as built). */
  resolveSketches?: Record<string, CadResult>;
  /** Sketches whose projected references the build moved: the sketch with its references as built. */
  rebuilt?: Record<string, CadSketch>;
  /** The joints' kinematic model and their values as placed (solved DOFs as found). */
  kin?: KinState;
  /** Motion study id → its frames sampled (and their clearance). */
  motions?: Record<string, MotionResult>;
}

export { designNumbers } from './keys';

export { dimensionValue };

export interface CadSolved {
  result: CadResult;
  regions: ProfileRegion[];
  points: Map<string, Vec2>;
  radii: Map<string, number>;
}

type Eval = (src: string) => unknown;

/** Solve one sketch with its dimension expressions. */
export function solveSketchIn(sk: CadSketch, unit: string, evalExpr: Eval): CadSolved & { values: Map<string, number> } {
  const values = new Map<string, number>();
  const dimErrors: Record<string, string> = {};
  for (const c of sk.constraints) {
    if (!isDimension(c.type) || c.driving === false) continue;
    try {
      const n = dimensionValue(evalExpr(c.value?.trim() || '0'), unit, isAngleDim(c));
      if (!Number.isFinite(n)) throw new Error('not a finite number');
      if (n < 0 && c.type !== 'distanceX' && c.type !== 'distanceY' && c.type !== 'pattern') throw new Error('must not be negative');
      values.set(c.id, n);
    } catch (e) {
      dimErrors[c.id] = e instanceof Error ? e.message : String(e);
    }
  }
  return { ...sketchSolution(sk, values, dimErrors), values };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Expressions → numbers and solved sketches for the whole design. */
export function resolveDesign(design: CadDesign, unit: string, partDensity: string, evalExpr: Eval): DesignNumbers & { sketches: Record<string, CadResult> } {
  const sketches: Record<string, CadResult> = {};
  const frames: Record<string, Frame> = {};
  const params: Record<string, Record<string, number>> = {};
  const errors: Record<string, string> = {};
  const value = (src: string | undefined, fallback: string, kind: 'L' | 'A' | 'N', what: string) => {
    const v = evalExpr((src ?? '').trim() || fallback);
    if (kind === 'N') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1000) throw new Error(`the ${what} must be a whole number from 1 to 1000`);
      return v;
    }
    const n = dimensionValue(v, unit, kind === 'A');
    if (!Number.isFinite(n)) throw new Error(`the ${what} is not a finite number`);
    return n;
  };
  const positive = (n: number, what: string) => {
    if (!(n > 0)) throw new Error(`the ${what} must be positive`);
    return n;
  };
  /** A plain number (a count of turns, a scale factor, a fraction). */
  const ratio = (src: string | undefined, fallback: string, what: string) => {
    const v = evalExpr((src ?? '').trim() || fallback);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`the ${what} must be a plain number`);
    return v;
  };
  /** The ISO dimensions of a thread designation, in part units. */
  const thread = (size: string) => {
    const s = threadIn(parseThread(size), unit);
    return { P: s.P, dM: s.d, d2: s.d2, d1: s.d1, d3: s.d3, As: s.As, drill: s.drill };
  };
  for (const comp of design.components) {
    try {
      const src = comp.density?.trim() || partDensity.trim();
      if (src) {
        const rho = evalExpr(src);
        if (!isUnit(rho) || !(rho as Unit).equalBase(math.unit('kg/m^3'))) throw new Error('the density needs a unit such as kg/m^3');
        params[comp.id] = { density: (rho as Unit).toNumeric(`kg/${unit}^3`) as number };
      }
    } catch (e) {
      errors[comp.id] = msg(e);
    }
    for (const item of comp.items) {
      const p: Record<string, number> = {};
      try {
        switch (item.kind) {
          case 'sketch': {
            p.offset = item.plane.offset?.trim() ? value(item.plane.offset, '0', 'L', 'plane offset') : 0;
            frames[item.id] = offsetFrame(planeFrame(item.plane), p.offset);
            const solved = solveSketchIn(item.sketch, unit, evalExpr);
            sketches[item.id] = solved.result;
            // a sketch with projected references is solved again on the bodies before it, with these values
            if (item.sketch.sources?.length) for (const [cid, v] of solved.values) p[`v:${cid}`] = v;
            break;
          }
          case 'extrude': {
            const ex = item.extent;
            if (ex.type !== 'all') p.d = positive(value(ex.d, '10', 'L', 'distance'), 'distance');
            if (ex.type === 'two') {
              p.d2 = value(ex.d2, '0', 'L', 'second distance');
              if (p.d + p.d2 <= 0) throw new Error('the two distances must add up to more than zero');
            }
            if (item.thin) p.thin = positive(value(item.thin.t, '2', 'L', 'wall thickness'), 'wall thickness');
            if (item.edgeStart?.r.trim()) p.edgeStart = positive(value(item.edgeStart.r, '1', 'L', 'start edge size'), 'start edge size');
            if (item.edgeEnd?.r.trim()) p.edgeEnd = positive(value(item.edgeEnd.r, '1', 'L', 'end edge size'), 'end edge size');
            break;
          }
          case 'revolve': {
            p.angle = value(item.angle, '360', 'A', 'angle');
            if (!(p.angle > 0 && p.angle <= 2 * Math.PI + 1e-12)) throw new Error('the revolve angle must be between 0 and 360°');
            p.angle = Math.min(p.angle, 2 * Math.PI);
            break;
          }
          case 'hole': {
            // a tapped hole is drilled to the tap drill of its thread
            if (item.tap) Object.assign(p, thread(item.tap.size), { d: thread(item.tap.size).drill });
            else p.d = positive(value(item.d, '6', 'L', 'diameter'), 'diameter');
            if (!item.through) p.depth = positive(value(item.depth, '10', 'L', 'depth'), 'depth');
            if (item.tap?.depth?.trim()) {
              p.tdepth = positive(value(item.tap.depth, '10', 'L', 'thread depth'), 'thread depth');
              if (!item.through && p.tdepth > p.depth * (1 + 1e-9)) throw new Error('the thread is deeper than the hole');
            }
            if (item.style === 'counterbore') {
              p.cbD = value(item.cbD, `${p.d * 1.8}`, 'L', 'counterbore diameter');
              p.cbDepth = positive(value(item.cbDepth, `${p.d * 0.6}`, 'L', 'counterbore depth'), 'counterbore depth');
              if (!(p.cbD > p.d)) throw new Error('the counterbore must be wider than the hole');
            }
            if (item.style === 'countersink') {
              p.csD = value(item.csD, `${p.d * 2}`, 'L', 'countersink diameter');
              p.csAngle = value(item.csAngle, '90', 'A', 'countersink angle');
              if (!(p.csD > p.d)) throw new Error('the countersink must be wider than the hole');
              if (!(p.csAngle > 0 && p.csAngle < Math.PI)) throw new Error('the countersink angle must be between 0 and 180°');
            }
            break;
          }
          case 'fillet': {
            item.sets.forEach((st, i) => {
              p[`r${i}`] = positive(value(st.r, '2', 'L', 'radius'), 'radius');
              if (st.r2?.trim()) p[`re${i}`] = positive(value(st.r2, '2', 'L', 'end radius'), 'end radius');
            });
            break;
          }
          case 'chamfer': {
            p.d = positive(value(item.d, '1', 'L', 'distance'), 'distance');
            if (item.type === 'two') p.d2 = positive(value(item.d2, item.d, 'L', 'second distance'), 'second distance');
            if (item.type === 'angle') {
              p.angle = value(item.angle, '45', 'A', 'angle');
              if (!(p.angle > 0 && p.angle < Math.PI / 2)) throw new Error('the chamfer angle must be between 0 and 90°');
            }
            break;
          }
          case 'shell':
            p.t = positive(value(item.t, '2', 'L', 'wall thickness'), 'wall thickness');
            break;
          case 'draft': {
            p.angle = value(item.angle, '3', 'A', 'draft angle');
            if (!(Math.abs(p.angle) < Math.PI / 2) || !p.angle) throw new Error('the draft angle must be between −90° and 90°, and not 0');
            break;
          }
          case 'presspull': {
            p.d = value(item.d, '5', 'L', 'distance');
            if (!p.d) throw new Error('the distance must not be 0');
            break;
          }
          case 'split':
            p.offset = item.offset?.trim() ? value(item.offset, '0', 'L', 'plane offset') : 0;
            break;
          case 'sweep': {
            p.twist = item.twist?.trim() ? value(item.twist, '0', 'A', 'twist angle') : 0;
            p.scale = item.scale?.trim() ? positive(ratio(item.scale, '1', 'end scale'), 'end scale') : 1;
            break;
          }
          case 'coil': {
            p.d = positive(value(item.d, '20', 'L', 'diameter'), 'diameter');
            p.size = positive(value(item.size, '2', 'L', 'section size'), 'section size');
            const revs = () => positive(ratio(item.revs, '5', 'number of revolutions'), 'number of revolutions');
            const height = () => positive(value(item.height, '50', 'L', 'height'), 'height');
            const pitch = () => positive(value(item.pitch, '5', 'L', 'pitch'), 'pitch');
            if (item.mode === 'revs-height') {
              p.revs = revs();
              p.height = height();
              p.pitch = p.height / p.revs;
            } else if (item.mode === 'revs-pitch') {
              p.revs = revs();
              p.pitch = pitch();
              p.height = p.revs * p.pitch;
            } else {
              p.height = height();
              p.pitch = pitch();
              p.revs = p.height / p.pitch;
            }
            break;
          }
          case 'thread': {
            Object.assign(p, thread(item.size));
            if (item.length?.trim()) p.length = positive(value(item.length, '10', 'L', 'thread length'), 'thread length');
            if (item.offset?.trim()) p.offset = value(item.offset, '0', 'L', 'thread offset');
            break;
          }
          case 'rib':
            p.thickness = positive(value(item.thickness, '2', 'L', 'thickness'), 'thickness');
            if (item.depth?.trim()) p.depth = positive(value(item.depth, '10', 'L', 'depth'), 'depth');
            break;
          case 'plane': {
            const def = item.def;
            if (def.type === 'offset') p.d = value(def.d, '10', 'L', 'offset');
            if (def.type === 'angle' || def.type === 'tangent') p.angle = value(def.angle, '0', 'A', 'angle');
            if (def.type === 'path') {
              p.at = ratio(def.at, '0', 'position along the path');
              if (!(p.at >= 0 && p.at <= 1)) throw new Error('the position along the path is a fraction from 0 (its start) to 1 (its end)');
            }
            break;
          }
          case 'move': {
            for (const k of ['dx', 'dy', 'dz'] as const) p[k] = item[k]?.trim() ? value(item[k], '0', 'L', k) : 0;
            p.angle = item.angle?.trim() ? value(item.angle, '0', 'A', 'angle') : 0;
            break;
          }
          case 'pattern': {
            p.count = value(item.count, '3', 'N', 'count');
            p.spacing = item.type === 'circ' ? value(item.spacing, '360', 'A', 'total angle') : value(item.spacing, '10', 'L', 'spacing');
            if (item.type === 'rect' && item.axis2) {
              p.count2 = value(item.count2, '1', 'N', 'second count');
              p.spacing2 = value(item.spacing2, '10', 'L', 'second spacing');
            }
            break;
          }
          default:
            break;
        }
      } catch (e) {
        errors[item.id] = msg(e);
      }
      params[item.id] = { ...params[item.id], ...p };
    }
  }
  for (const j of design.joints) {
    try {
      params[j.id] = jointParams(j, value);
    } catch (e) {
      errors[j.id] = msg(e);
    }
  }
  assemblyParams(design, unit, value, evalExpr, params, errors);
  return { sketches, frames, params, errors, unit };
}

/** Sketches the build solved again replace their resolved results (the sketch first in the part too). */
function rebuiltInto(dr: DesignResult, rebuilt?: Record<string, RebuiltSketch>) {
  for (const [id, r] of Object.entries(rebuilt ?? {})) {
    dr.sketches[id] = r.result;
    (dr.rebuilt ??= {})[id] = r.sketch;
  }
}

const emptyResult = (): CadResult => ({
  kind: 'cad', points: {}, radii: {}, ok: true, dof: 0, determined: [], determinedRadii: [], conflicting: [], redundant: [], values: {}, dimErrors: {}, issues: [],
});

/** Solve, build and measure a CAD region. `evalExpr` evaluates worksheet expressions (throws on error). */
export function solveCad(r: CadRegion, evalExpr: Eval): { result: CadResult } {
  const design = designOf(r);
  const numbers = resolveDesign(design, r.unit, r.density, evalExpr);
  const first = design.components[0]?.items.find(isSketch);
  const result: CadResult = first && numbers.sketches[first.id] ? { ...numbers.sketches[first.id] } : emptyResult();
  let dof = 0;
  for (const s of Object.values(numbers.sketches)) dof += s.dof;
  result.dof = dof;
  result.ok = Object.values(numbers.sketches).every((s) => s.ok);

  const dr: DesignResult = {
    ...numbers, errors: { ...numbers.errors }, resolveErrors: numbers.errors, frames: { ...numbers.frames }, resolveFrames: numbers.frames, warnings: {},
    sketches: { ...numbers.sketches }, resolveSketches: numbers.sketches,
    display: designKey(design, numbers), bodies: {}, components: {}, placements: {}, kernel: false,
  };
  const density = (cid: string) => numbers.params[cid]?.density;
  const compMass = new Map<string, Mass3[]>();
  const oc = occ();
  const K = kernel();
  // without the B-rep kernel the values are approximate (or missing): evaluate again once it
  // is there, unless it could not load
  const failure = occFailure();
  if (!oc && !failure) result.needsBrep = hasFeatures(design) || undefined;
  if (!oc && failure) dr.brepError = failure;
  let m: MeasuredDesign | null = null;
  try {
    m = oc && measureDesignOcc(oc, design, numbers);
  } catch (e) {
    // OCCT failing outside a feature (out of memory…): the mesh kernel's values rather than none
    console.warn('the B-rep kernel failed on this part; using the mesh kernel', e);
  }
  if (m) {
    dr.kernel = dr.brep = true;
    for (const c of design.components) {
      const masses: Mass3[] = [];
      dr.bodies[c.id] = (m.bodies[c.id] ?? []).map((b) => {
        if (!b.mass) return { id: b.id, name: b.name, feature: b.feature, empty: true };
        masses.push(b.mass);
        return { id: b.id, name: b.name, feature: b.feature, mass: massOut([{ m: b.mass, rho: density(c.id) }]) ?? undefined };
      });
      compMass.set(c.id, masses);
    }
    Object.assign(dr.errors, m.errors);
    Object.assign(dr.warnings!, m.warnings);
    Object.assign(dr.frames, m.frames);
    rebuiltInto(dr, m.sketches);
    dr.placements = m.placements;
    if (m.kin) dr.kin = m.kin;
    dr.box = m.box;
  } else if (K) {
    const built = buildDesign(K, design, numbers);
    try {
      dr.kernel = true;
      for (const c of design.components) {
        const cb = built.components.get(c.id)!;
        Object.assign(dr.errors, cb.errors);
        Object.assign(dr.warnings!, cb.warnings);
        Object.assign(dr.frames, cb.frames);
        rebuiltInto(dr, cb.sketches);
        const masses: Mass3[] = [];
        dr.bodies[c.id] = cb.bodies.map((b) => {
          if (b.solid.isEmpty()) return { id: b.id, name: b.name, feature: b.feature, empty: true };
          const m = bodyMass(b);
          masses.push(m);
          return { id: b.id, name: b.name, feature: b.feature, mass: massOut([{ m, rho: density(c.id) }]) ?? undefined };
        });
        compMass.set(c.id, masses);
      }
      Object.assign(dr.errors, built.errors);
      Object.assign(dr.warnings!, built.warnings);
      dr.placements = built.placements;
      if (built.kin) dr.kin = built.kin;
      dr.box = boxOf(design.occurrences.filter((o) => !o.hidden).flatMap((o) => placedSolids(built, design, o.id).map((p) => p.solid))) ?? undefined;
    } finally {
      built.free();
    }
  } else {
    const inp = buildInputs(design, numbers);
    // both kernels failed to load: nothing is coming, say so instead of waiting
    const none = failure && kernelFailure();
    if (none) dr.kernelError = none;
    for (const c of design.components) {
      const ex = exactComponent(design, c, inp);
      if (!ex) {
        if (!none) result.needsKernel = true;
        for (const i of activeItems(c)) if (i.kind !== 'sketch' && !i.suppressed) dr.errors[i.id] ??= none ? 'the 3-D kernel could not load' : 'loading the 3-D kernel…';
        compMass.set(c.id, []);
        dr.bodies[c.id] = [];
        continue;
      }
      Object.assign(dr.errors, ex.errors);
      dr.bodies[c.id] = ex.bodies.map((b) => ({ id: b.id, name: b.name, feature: b.feature, mass: massOut([{ m: b.mass, rho: density(c.id) }]) ?? undefined }));
      compMass.set(c.id, ex.bodies.map((b) => b.mass));
    }
    const placed = placeOccurrences(design, numbers);
    dr.placements = placed.placements;
    dr.kin = placed.kin;
    Object.assign(dr.errors, placed.errors);
    Object.assign(dr.warnings!, placed.warnings);
  }
  // motion studies: the frames sampled, and their clearance on the exact shapes
  if (design.motions?.length && dr.kin) {
    dr.motions = {};
    for (const st of design.motions) if (!numbers.errors[st.id]) dr.motions[st.id] = studyResult(m ? oc : null, design, numbers, st, dr.kin);
  }
  // the part's own sketch readouts: the first sketch as the build solved it
  if (first && dr.rebuilt?.[first.id]) {
    Object.assign(result, dr.sketches[first.id], { dof: Object.values(dr.sketches).reduce((s, x) => s + x.dof, 0), ok: Object.values(dr.sketches).every((x) => x.ok) });
  }
  for (const c of design.components) dr.components[c.id] = massOut((compMass.get(c.id) ?? []).map((m) => ({ m, rho: density(c.id) })));
  const all: { m: Mass3; rho?: number }[] = [];
  for (const o of design.occurrences) {
    const M = dr.placements[o.id]?.matrix;
    if (!M) continue;
    for (const m of compMass.get(o.component) ?? []) all.push({ m: transformMass(m, M), rho: density(o.component) });
  }
  const total = massOut(all);
  if (total) {
    dr.total = total;
    result.mass = total;
  }
  for (const c of design.components) {
    if (numbers.errors[c.id]) result.featureError ??= numbers.errors[c.id];
    for (const i of activeItems(c)) if (i.kind !== 'sketch' && dr.errors[i.id] && !i.suppressed) result.featureError ??= `${i.name}: ${dr.errors[i.id]}`;
  }
  // a lost reference builds on, but the worksheet hears of it (the mesh kernel cannot follow
  // references at all: that is no news while OpenCascade loads)
  if (dr.brep) {
    for (const c of design.components) for (const i of activeItems(c)) if (dr.warnings?.[i.id]) result.featureError ??= `${i.name}: ${dr.warnings[i.id]}`;
    for (const j of design.joints) if (dr.warnings?.[j.id]) result.featureError ??= `${j.name}: ${dr.warnings[j.id]}`;
  }
  result.design = dr;
  return { result };
}

/** Worksheet value of a part: totals, components, sketches, joints and named dimensions with units. */
export function cadValue(r: CadRegion, res: CadResult): Record<string, unknown> {
  const u = r.unit;
  const L = (v: number, p = 1) => math.unit(v, p === 1 ? u : `${u}^${p}`);
  const section = (s: SectionProps) => ({
    A: L(s.A, 2), xc: L(s.xc), yc: L(s.yc),
    Ix: L(s.Ix, 4), Iy: L(s.Iy, 4), Ixy: L(s.Ixy, 4), I1: L(s.I1, 4), I2: L(s.I2, 4), J: L(s.J, 4),
    θ: math.unit(s.theta, 'deg'), theta: math.unit(s.theta, 'deg'),
    Wx: L(s.Wx, 3), Wy: L(s.Wy, 3), rx: L(s.rx), ry: L(s.ry),
    b: L(s.xmax - s.xmin), h: L(s.ymax - s.ymin),
  });
  const solid = (m: MassOut) => {
    const o: Record<string, unknown> = { V: L(m.V, 3), xg: L(m.xg), yg: L(m.yg), zg: L(m.zg) };
    if (m.m !== undefined && m.Im) {
      const kg = (v: number) => math.unit(v, `kg ${u}^2`);
      Object.assign(o, { m: math.unit(m.m, 'kg'), Imx: kg(m.Im[0]), Imy: kg(m.Im[1]), Imz: kg(m.Im[2]), Imxy: kg(m.Im[3]), Imxz: kg(m.Im[4]), Imyz: kg(m.Im[5]) });
    }
    return o;
  };
  const value: Record<string, unknown> = { dof: res.dof };
  if (res.section) Object.assign(value, section(res.section));
  if (res.mass) Object.assign(value, solid(res.mass));
  const d = res.design;
  if (d?.box) Object.assign(value, { Lx: L(d.box.max[0] - d.box.min[0]), Ly: L(d.box.max[1] - d.box.min[1]), Lz: L(d.box.max[2] - d.box.min[2]) });
  const design = designOf(r);
  if (d) {
    for (const c of design.components) {
      const id = identifier(c.name);
      const m = d.components[c.id];
      const sub: Record<string, unknown> = m ? solid(m) : {};
      for (const b of d.bodies[c.id] ?? []) if (b.mass && identifier(b.name)) sub[identifier(b.name)] = solid(b.mass);
      for (const i of c.items) {
        const s = isSketch(i) ? d.sketches[i.id]?.section : undefined;
        if (s && identifier(i.name)) sub[identifier(i.name)] = section(s);
        // ISO thread data of threads and tapped holes: part.Thread1.As, part.Hole1.P …
        const t = d.params[i.id];
        if ((i.kind === 'thread' || (i.kind === 'hole' && i.tap)) && t?.P && identifier(i.name)) {
          sub[identifier(i.name)] = { d: L(t.dM), P: L(t.P), d2: L(t.d2), d1: L(t.d1), D1: L(t.d1), d3: L(t.d3), As: L(t.As, 2), drill: L(t.drill) };
        }
      }
      if (id && design.components.length > 1 && !(id in value)) value[id] = sub;
      else if (id && design.components.length === 1) {
        // one part: its sketches and bodies sit right on the part
        for (const [k, v] of Object.entries(sub)) if (typeof v === 'object' && !(k in value)) value[k] = v;
      }
    }
    for (const j of design.joints) {
      const p = d.params[j.id];
      const id = identifier(j.name);
      if (!p || !id || id in value) continue;
      // as placed: solved DOFs as the loops found them, driven ones where their limits stopped them
      const v = jointExport(j.type, { ...p, ...d.kin?.values[j.id] }, u);
      if (v) value[id] = v;
    }
    for (const st of design.motions ?? []) {
      const mr = d.motions?.[st.id], id = identifier(st.name);
      if (mr && d.kin && id && !(id in value)) value[id] = motionValue(st, mr, d.kin, u);
    }
  }
  for (const c of design.components) for (const i of c.items) {
    if (!isSketch(i)) continue;
    const sr = d?.sketches[i.id] ?? (i === design.components[0].items.find(isSketch) ? res : undefined);
    if (!sr) continue;
    for (const k of i.sketch.constraints) {
      if (!isDimension(k.type) || !k.name?.trim()) continue;
      const v = sr.values[k.id];
      if (!Number.isFinite(v)) continue;
      value[k.name.trim()] = isAngleDim(k) ? math.unit((v * 180) / Math.PI, 'deg') : L(v);
    }
  }
  return value;
}
