// A parametric design as in Fusion: components, each with a timeline of sketches
// (on origin planes, offset planes or faces) and features (extrude, revolve, hole,
// pattern, mirror, combine) that build its bodies; occurrences of the components are
// placed in the assembly by joints.
//
// The document is plain JSON. Evaluation runs in two stages so the worksheet and the
// CAD window can share it: `resolve` turns expressions into numbers and solves the
// sketches (serialisable, no kernel), `build` makes the solids from those numbers.
import type { CadRegion } from '../model/types';
import type { CadSketch, CadView } from './model';
import { findProfiles, type ProfileRegion, type Vec2 } from './profile';
import { extrudeProps, revolveProps, type MassProps } from './features';
import {
  Arena, IDENTITY, add3, combineMass, cross3, dot3, frameDir, frameFromNormal, frameMatrix, framePoint,
  len3, m4Frame, m4Inv, m4Mirror, m4Mul, m4Point, m4Pose, m4Rotate, m4Translate, massFromProps, norm3, propsFromMass,
  scale3, solidMass, sub3, transformMass, transformSolid,
  type Frame, type M4, type Manifold, type ManifoldToplevel, type Mass3, type Vec3,
} from './solid';
import type { EdgeOptions, ThinOptions } from './shaping';
import { meshOps } from './meshOps';
import { meshTopology } from './meshTopology';
import { faceFrame, faceWords, keyFeature, refTo, resolveRef, resolvedEntity, type BodyTopology, type TopoRef } from './topology';
import type { FaceInfo } from './buildResult';
import { snapPlace, type SnapOrigin } from './snaps';

// ------------------------------------------------------------ document

export type PlaneRef = 'XY' | 'XZ' | 'YZ';

/** Origin planes, Z up: front (XZ) looks along +Y, right (YZ) along −X. */
export const ORIGIN_FRAMES: Record<PlaneRef, Frame> = {
  XY: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  XZ: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  YZ: { o: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
};

export type SketchPlane =
  /** An origin plane, optionally offset along its normal (worksheet expression). */
  | { ref: PlaneRef; offset?: string }
  /**
   * A planar face: the frame captured when the sketch was made and, since sketches follow
   * their faces, a reference to the face. Every rebuild finds the face again (among the
   * bodies built before the sketch) and moves the frame onto it; without a reference
   * (older documents), or when the face is gone, the captured frame stays.
   */
  | { frame: { o: Vec3; u: Vec3; v: Vec3 }; face?: TopoRef; label?: string; offset?: string };

export interface DesignSketch {
  kind: 'sketch';
  id: string;
  name: string;
  plane: SketchPlane;
  sketch: CadSketch;
  hidden?: boolean;
  suppressed?: boolean;
  /** Editor viewport of this sketch. */
  view?: CadView;
}

export type FeatureOp = 'new' | 'join' | 'cut' | 'intersect';
/** '+' along the sketch normal, '−' against it, auto: new/join go +, cut/intersect go into the material. */
export type Direction = 'auto' | '+' | '-';

export type Extent =
  | { type: 'one'; d: string; dir?: Direction }
  | { type: 'symmetric'; d: string }
  | { type: 'two'; d: string; d2: string }
  | { type: 'all'; dir?: Direction; both?: boolean };

/** Origin axis, or a sketch line as `${sketchId}/${entityId}`. */
export type AxisRef = string;

interface FeatureBase {
  id: string;
  name: string;
  suppressed?: boolean;
}

export interface ExtrudeFeature extends FeatureBase {
  kind: 'extrude';
  sketch: string;
  /** Profile keys (see profileKey); empty or missing = every profile of the sketch. */
  profiles?: string[];
  extent: Extent;
  op: FeatureOp;
  /** Bodies to join to / cut / intersect; missing = last body (join) or all bodies. */
  targets?: string[];
  /** Thin extrude: only a wall of thickness t along the outline (a shell), with optional caps. */
  thin?: { t: string; side: 'inside' | 'outside' | 'center'; cap: 'none' | 'start' | 'end' | 'both' };
  /** Rounded or chamfered edges where the extrusion starts and ends. */
  edgeStart?: { type: 'fillet' | 'chamfer'; r: string };
  edgeEnd?: { type: 'fillet' | 'chamfer'; r: string };
}

/** A solid joining a profile of one sketch to a profile of another (on another plane). */
export interface LoftFeature extends FeatureBase {
  kind: 'loft';
  sketch: string;
  sketch2: string;
  /** Profile keys; missing = the first profile of each sketch. */
  profile?: string;
  profile2?: string;
  op: FeatureOp;
  targets?: string[];
}

export interface RevolveFeature extends FeatureBase {
  kind: 'revolve';
  sketch: string;
  profiles?: string[];
  /** A line of the sketch, or its own 'x' / 'y' axis. */
  axis: string;
  angle: string;
  /** Turn the other way. */
  flip?: boolean;
  op: FeatureOp;
  targets?: string[];
}

export interface HoleFeature extends FeatureBase {
  kind: 'hole';
  sketch: string;
  /** Sketch point entities at the hole centres; missing = all of them. */
  points?: string[];
  d: string;
  /** Depth expression, ignored when `through`. */
  depth: string;
  through?: boolean;
  dir?: Direction;
  style: 'simple' | 'counterbore' | 'countersink';
  cbD?: string;
  cbDepth?: string;
  csD?: string;
  csAngle?: string;
  targets?: string[];
}

export interface PatternFeature extends FeatureBase {
  kind: 'pattern';
  of: 'features' | 'bodies';
  refs: string[];
  type: 'rect' | 'circ';
  axis: AxisRef;
  count: string;
  /** rect: distance between copies; circ: total angle ("360 deg" spreads them evenly). */
  spacing: string;
  /** Second direction of a rectangular pattern. */
  axis2?: AxisRef;
  count2?: string;
  spacing2?: string;
  /** Bodies: merge the copies into the original instead of making new bodies. */
  join?: boolean;
}

export interface MirrorFeature extends FeatureBase {
  kind: 'mirror';
  of: 'features' | 'bodies';
  refs: string[];
  /** Origin plane, or a sketch whose plane mirrors. */
  plane: string;
  join?: boolean;
}

export interface CombineFeature extends FeatureBase {
  kind: 'combine';
  target: string;
  tools: string[];
  op: 'join' | 'cut' | 'intersect';
  keepTools?: boolean;
}

export type DesignFeature = ExtrudeFeature | RevolveFeature | HoleFeature | PatternFeature | MirrorFeature | CombineFeature | LoftFeature;
export type DesignItem = DesignSketch | DesignFeature;

export interface CadComponent {
  id: string;
  name: string;
  /** Material density expression; empty = the part's density. */
  density?: string;
  color?: string;
  items: DesignItem[];
  /** Timeline marker: only the first `marker` items are built (rollback). */
  marker?: number;
  bodyNames?: Record<string, string>;
  hiddenBodies?: string[];
}

export interface CadOccurrence {
  id: string;
  component: string;
  name?: string;
  grounded?: boolean;
  /** Free placement (used when grounded or not positioned by a joint). */
  pos?: Vec3;
  /** Rotation about X, Y, Z (degrees). */
  rot?: Vec3;
  hidden?: boolean;
}

export type JointOrigin =
  | { kind: 'origin' }
  /** A sketch point; Z along the sketch normal ('n') or its x / y axis. */
  | { kind: 'point'; sketch: string; point: string; axis?: 'n' | 'u' | 'v' }
  /** A picked spot (component coordinates). */
  | { kind: 'frame'; o: Vec3; z: Vec3; x?: Vec3 }
  /** A snap point on a body's geometry (snaps.ts): it follows the face, edge or vertex. */
  | SnapOrigin;

export type JointType = 'rigid' | 'revolute' | 'slider' | 'cylindrical';

export interface CadJoint {
  id: string;
  name: string;
  type: JointType;
  /** The parent side… */
  a: { occ: string; origin: JointOrigin };
  /** …and the side that moves onto it. */
  b: { occ: string; origin: JointOrigin };
  /** Rotation about the joint Z axis (revolute / cylindrical motion). */
  angle: string;
  /** Offset along the joint Z axis (slider / cylindrical motion). */
  offset: string;
  /** Turn the moving part over (its Z axis opposite the parent's): faces mating. */
  flip?: boolean;
  suppressed?: boolean;
}

export interface CadDesign {
  version: 2;
  components: CadComponent[];
  occurrences: CadOccurrence[];
  joints: CadJoint[];
}

export const isSketch = (i: DesignItem): i is DesignSketch => i.kind === 'sketch';
export const FEATURE_LABEL: Record<DesignItem['kind'], string> = {
  sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', hole: 'Hole', pattern: 'Pattern', mirror: 'Mirror', combine: 'Combine', loft: 'Loft',
};

/** Profiles are identified by the entities of their outer loop. */
export function profileKey(r: ProfileRegion): string {
  return [...r.outer.entities].sort().join(',');
}

/** Items of a component that the timeline marker leaves active. */
export function activeItems(c: CadComponent): DesignItem[] {
  return c.marker === undefined ? c.items : c.items.slice(0, c.marker);
}

/** Whether the design makes any solid: a feature that is neither rolled back nor suppressed. */
export function hasFeatures(design: CadDesign): boolean {
  return design.components.some((c) => activeItems(c).some((i) => i.kind !== 'sketch' && !i.suppressed));
}

export function nextName(design: CadDesign, base: string): string {
  const used = new Set<string>();
  for (const c of design.components) {
    used.add(c.name);
    for (const i of c.items) used.add(i.name);
  }
  for (const j of design.joints) used.add(j.name);
  let k = 1;
  while (used.has(`${base}${k}`)) k++;
  return `${base}${k}`;
}

/** Worksheet identifier for a name ("Part 1" → Part_1). */
export function identifier(name: string): string {
  const s = name.trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  return /^\p{L}/u.test(s) ? s : s ? `_${s}` : '';
}

/**
 * The design of a part. Parts saved before designs existed hold one sketch and one
 * feature; they become a component with that sketch on the XY plane.
 */
export function designOf(r: CadRegion): CadDesign {
  if (r.design) return r.design;
  // a new, empty part starts with an empty timeline
  const items: DesignItem[] = r.sketch.entities.length || r.feature.type !== 'none'
    ? [{ kind: 'sketch', id: 's1', name: 'Sketch1', plane: { ref: 'XY' }, sketch: r.sketch, ...(r.viewW ? { view: r.viewW } : {}) }]
    : [];
  const f = r.feature;
  if (f.type === 'extrude') {
    items.push({ kind: 'extrude', id: 'f1', name: 'Extrude1', sketch: 's1', extent: f.symmetric ? { type: 'symmetric', d: f.depth } : { type: 'one', d: f.depth, dir: '+' }, op: 'new' });
  } else if (f.type === 'revolve') {
    items.push({ kind: 'revolve', id: 'f1', name: 'Revolve1', sketch: 's1', axis: f.axis, angle: f.angle, op: 'new' });
  }
  return {
    version: 2,
    components: [{ id: 'c1', name: r.name?.trim() ? capital(r.name.trim()) : 'Part1', items }],
    occurrences: [{ id: 'o1', component: 'c1', grounded: true }],
    joints: [],
  };
}

const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

export function emptyDesign(name = 'Part1'): CadDesign {
  return { version: 2, components: [{ id: 'c1', name, items: [] }], occurrences: [{ id: 'o1', component: 'c1', grounded: true }], joints: [] };
}

// ------------------------------------------------------------ resolved numbers

export interface SolvedSketch {
  points: Record<string, [number, number]>;
  radii: Record<string, number>;
}

/** What `resolve` produced: plain numbers, safe to send between windows. */
export interface DesignNumbers {
  /** Sketch id → solved geometry. */
  sketches: Record<string, SolvedSketch>;
  /** Sketch id → its plane in component coordinates. */
  frames: Record<string, Frame>;
  /** Item / joint / component id → evaluated parameters (lengths in part units, angles in radians). */
  params: Record<string, Record<string, number>>;
  /** Item / joint / occurrence id → why it failed. */
  errors: Record<string, string>;
}

/** Plane of a sketch before its offset. */
export function planeFrame(p: SketchPlane): Frame {
  if ('ref' in p) return ORIGIN_FRAMES[p.ref];
  const u = norm3(p.frame.u), v0 = p.frame.v;
  const n = norm3(cross3(u, v0));
  return { o: p.frame.o, u, v: cross3(n, u), n };
}

export function offsetFrame(f: Frame, d: number): Frame {
  return d ? { ...f, o: add3(f.o, scale3(f.n, d)) } : f;
}

/**
 * The plane of a new sketch on a flat face of a body: the face's plane with the component
 * origin projected onto it (its x axis kept level), and the reference it follows.
 */
export function facePlane(body: string, face: FaceInfo, label?: string): SketchPlane {
  const n = face.frame!.n;
  const f = frameFromNormal(scale3(n, dot3(face.frame!.o, n)), n);
  return { frame: { o: f.o.map((v) => +v.toPrecision(12)) as Vec3, u: f.u, v: f.v }, face: refTo('face', body, face), ...(label ? { label } : {}) };
}

// ------------------------------------------------------------ building

export interface Body {
  id: string;
  name: string;
  /** Feature that created it. */
  feature: string;
  solid: Manifold;
  /** Exact properties while the body is a single extrude or revolve. */
  exact?: Mass3;
}

interface ToolRec {
  tool: Manifold;
  exact?: Mass3;
  op: FeatureOp;
  targets?: string[];
}

export interface BuildInputs {
  numbers: DesignNumbers;
  /** Profiles of a sketch (from its solved geometry). */
  regions(sketchId: string): ProfileRegion[];
}

/** Profiles of every sketch, recomputed from solved numbers (memoised per call site). */
export function buildInputs(design: CadDesign, numbers: DesignNumbers): BuildInputs {
  const cache = new Map<string, ProfileRegion[]>();
  const sketches = new Map<string, DesignSketch>();
  for (const c of design.components) for (const i of c.items) if (isSketch(i)) sketches.set(i.id, i);
  return {
    numbers,
    regions(id) {
      let r = cache.get(id);
      if (!r) {
        const s = sketches.get(id), sol = numbers.sketches[id];
        r = s && sol ? findProfiles(s.sketch, pointMapOf(sol), new Map(Object.entries(sol.radii))).regions : [];
        cache.set(id, r);
      }
      return r;
    },
  };
}

export const pointMapOf = (s: SolvedSketch) => new Map(Object.entries(s.points).map(([id, [x, y]]) => [id, { x, y }]));

export interface ComponentBuild {
  bodies: Body[];
  errors: Record<string, string>;
  warnings: Record<string, string>;
  /** Sketch planes as built (sketches on faces). */
  frames: Record<string, Frame>;
  /** Tool solid of every feature that made one (previews, patterns). */
  tools: Map<string, ToolRec>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Frame of a sketch in its component, or an error: as built (a sketch on a face where
 * the face is now), else as resolved.
 */
function frameIn(inp: BuildInputs, sketchId: string, built?: Record<string, Frame>): Frame {
  const f = built?.[sketchId] ?? inp.numbers.frames[sketchId];
  if (!f) throw new Error(inp.numbers.errors[sketchId] ?? 'the sketch is missing or failed');
  return f;
}

/** Axis in component coordinates: origin axis or a sketch line. */
export function axisOf(design: CadDesign, inp: BuildInputs, ref: AxisRef, built?: Record<string, Frame>): { p: Vec3; d: Vec3 } {
  if (ref === 'X') return { p: [0, 0, 0], d: [1, 0, 0] };
  if (ref === 'Y') return { p: [0, 0, 0], d: [0, 1, 0] };
  if (ref === 'Z') return { p: [0, 0, 0], d: [0, 0, 1] };
  const [sid, eid] = ref.split('/');
  const sk = findSketch(design, sid);
  const e = sk?.sketch.entities.find((q) => q.id === eid);
  const sol = inp.numbers.sketches[sid];
  if (!sk || e?.type !== 'line' || !sol) throw new Error('the pattern axis is missing');
  const f = frameIn(inp, sid, built);
  const [ax, ay] = sol.points[e.p1], [bx, by] = sol.points[e.p2];
  return { p: framePoint(f, { x: ax, y: ay }), d: norm3(frameDir(f, { x: bx - ax, y: by - ay })) };
}

export function findSketch(design: CadDesign, id: string): DesignSketch | undefined {
  for (const c of design.components) for (const i of c.items) if (i.id === id && isSketch(i)) return i;
  return undefined;
}

/** In-plane revolve axis in sketch coordinates. */
export function sketchAxis(sk: DesignSketch, axis: string, sol: SolvedSketch): { p: Vec2; d: Vec2 } | null {
  if (axis === 'x') return { p: { x: 0, y: 0 }, d: { x: 1, y: 0 } };
  if (axis === 'y') return { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } };
  const e = sk.sketch.entities.find((q) => q.id === axis);
  if (e?.type !== 'line' || !sol.points[e.p1] || !sol.points[e.p2]) return null;
  const [ax, ay] = sol.points[e.p1], [bx, by] = sol.points[e.p2];
  return { p: { x: ax, y: ay }, d: { x: bx - ax, y: by - ay } };
}

function selectedProfiles(inp: BuildInputs, sketchId: string, keys?: string[]): ProfileRegion[] {
  const all = inp.regions(sketchId);
  if (!all.length) throw new Error('the sketch has no closed profile');
  if (!keys?.length) return all;
  const picked = all.filter((r) => keys.includes(profileKey(r)));
  if (!picked.length) throw new Error('the selected profiles no longer exist — pick them again');
  return picked;
}

/** Hole tool options (lengths in part units, the countersink angle in radians). */
export interface HoleOptions {
  d: number;
  depth: number;
  style: 'simple' | 'counterbore' | 'countersink';
  cbD?: number;
  cbDepth?: number;
  csD?: number;
  csAngle?: number;
}

/** A loft end: one profile on its sketch plane. */
export interface LoftEnd {
  region: ProfileRegion;
  frame: Frame;
}

/**
 * What a solid kernel does for the timeline. S is the kernel's solid; `tag` is the id of
 * the feature (or feature copy) making it, which a kernel may use to name faces.
 */
export interface SolidOps<S> {
  /** Prism of the regions between z0 and z1 along the frame normal. */
  extrude(regions: ProfileRegion[], f: Frame, z0: number, z1: number, tag: string): S;
  /** Thin-walled prism: a wall of thickness t along the outline, with optional caps. */
  thin(regions: ProfileRegion[], f: Frame, z0: number, z1: number, o: ThinOptions, tag: string): S;
  /** Prism whose start (z0) and end (z1) edges are rounded or chamfered. */
  rounded(regions: ProfileRegion[], f: Frame, z0: number, z1: number, start: EdgeOptions | undefined, end: EdgeOptions | undefined, tag: string): S;
  loft(a: LoftEnd, b: LoftEnd, tag: string): S;
  /** Revolve about an in-plane axis (sketch coordinates), `angle` radians by the right-hand rule. */
  revolve(regions: ProfileRegion[], f: Frame, axis: { p: Vec2; d: Vec2 }, angle: number, tag: string): S;
  /** Hole tools at the centres (component coordinates), drilled along dir; one solid. */
  hole(centres: Vec3[], dir: Vec3, o: HoleOptions, tag: string): S;
  union(solids: S[]): S;
  /** Several tools as one, for a single boolean (they may overlap; nothing is merged yet). */
  group(solids: S[]): S;
  cut(target: S, tool: S): S;
  intersect(target: S, tool: S): S;
  /** A moved (or mirrored) copy; `prefix` goes before the names of the copy's faces. */
  transform(s: S, M: M4, prefix: string): S;
  /** Volume two solids share. */
  shared(a: S, b: S): number;
  box(solids: S[]): { min: Vec3; max: Vec3 } | null;
  /** The faces, edges and vertices of a body with their persistent names (topology.ts). */
  topology(s: S, id: string): BodyTopology;
}

export interface TimelineBody<S> {
  id: string;
  name: string;
  /** Feature that created it. */
  feature: string;
  solid: S;
}

export interface TimelineTool<S> {
  tool: S;
  op: FeatureOp;
  targets?: string[];
}

export interface Timeline<S> {
  bodies: TimelineBody<S>[];
  errors: Record<string, string>;
  /** Problems that did not stop an item (a sketch whose face is gone keeps its old plane). */
  warnings: Record<string, string>;
  /** Sketch planes found on the bodies (sketches on faces), by sketch id. */
  frames: Record<string, Frame>;
  /** Tool solid of every feature that made one (previews, patterns). */
  tools: Map<string, TimelineTool<S>>;
}

/** z-range of a box in a sketch frame. */
function zRange(f: Frame, box: { min: Vec3; max: Vec3 } | null): [number, number] | null {
  if (!box) return null;
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 8; k++) {
    const p: Vec3 = [k & 1 ? box.max[0] : box.min[0], k & 2 ? box.max[1] : box.min[1], k & 4 ? box.max[2] : box.min[2]];
    const z = dot3(sub3(p, f.o), f.n);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return [lo, hi];
}

/**
 * Which way a cut goes when nobody said: the side whose tool removes more of the
 * targets (into the material, as Fusion's default); against the normal on a tie.
 */
function bestSide<S>(ops: SolidOps<S>, make: (sign: 1 | -1) => S, targets: S[]): 1 | -1 {
  const removed = (sg: 1 | -1) => {
    const t = make(sg);
    let v = 0;
    for (const b of targets) v += ops.shared(b, t);
    return v;
  };
  return removed(1) > removed(-1) * (1 + 1e-9) ? 1 : -1;
}

function reach<S>(ops: SolidOps<S>, f: Frame, solids: S[]): number {
  const r = zRange(f, solids.length ? ops.box(solids) : null);
  return r ? Math.max(Math.abs(r[0]), Math.abs(r[1])) * 1.05 + 1e-3 * (r[1] - r[0] + 1) : 0;
}

/** Copies a pattern or mirror makes (transforms in component coordinates). */
function copyMatrices(design: CadDesign, inp: BuildInputs, f: PatternFeature | MirrorFeature, built: Record<string, Frame>): M4[] {
  const p = inp.numbers.params[f.id] ?? {};
  if (f.kind === 'mirror') {
    let fr: Frame;
    if (f.plane in ORIGIN_FRAMES) fr = ORIGIN_FRAMES[f.plane as PlaneRef];
    else fr = frameIn(inp, f.plane, built);
    return [m4Mirror(fr.o, fr.n)];
  }
  const out: M4[] = [];
  const n = Math.round(p.count ?? 0);
  if (f.type === 'rect') {
    const a = axisOf(design, inp, f.axis, built);
    const n2 = f.axis2 ? Math.round(p.count2 ?? 1) : 1;
    const a2 = f.axis2 ? axisOf(design, inp, f.axis2, built) : null;
    for (let i = 0; i < n; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      let t = scale3(a.d, i * (p.spacing ?? 0));
      if (a2) t = add3(t, scale3(a2.d, j * (p.spacing2 ?? 0)));
      out.push(m4Translate(t));
    }
  } else {
    const a = axisOf(design, inp, f.axis, built);
    const total = p.spacing ?? 2 * Math.PI;
    const full = Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-9;
    const step = n > 1 ? total / (full ? n : n - 1) : 0;
    for (let i = 1; i < n; i++) out.push(m4Rotate(a.p, a.d, i * step));
  }
  return out;
}

/**
 * What a component's timeline has built so far. A step returns a new state and leaves
 * the one it started from as it was, so a cache can resume from any earlier step.
 */
export interface TimelineState<S> {
  bodies: TimelineBody<S>[];
  tools: Map<string, TimelineTool<S>>;
  errors: Record<string, string>;
  warnings: Record<string, string>;
  /** Planes of the sketches on faces, found on the bodies built before them. */
  frames: Record<string, Frame>;
  /** Ids of every body made so far, in order (default names count them). */
  made: string[];
}

export const emptyTimeline = <S>(): TimelineState<S> => ({ bodies: [], tools: new Map(), errors: {}, warnings: {}, frames: {}, made: [] });

/** The face a sketch follows, if it does (sketches made on faces before references existed do not). */
export const sketchFace = (s: DesignSketch): TopoRef | undefined => ('frame' in s.plane ? s.plane.face : undefined);

/** Name of a design item by id (for messages). */
export function itemName(design: CadDesign, id: string): string | undefined {
  for (const c of design.components) for (const i of c.items) if (i.id === id) return i.name;
  return undefined;
}

/**
 * A sketch on a face, on the bodies built before it: the face found again by its reference
 * and the sketch plane moved onto it (topology.ts), else the captured plane with a warning.
 */
function sketchOnFace<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, prev: TimelineState<S>, item: DesignSketch, ref: TopoRef): TimelineState<S> {
  const captured = inp.numbers.frames[item.id];
  if (!captured || inp.numbers.errors[item.id]) return prev;
  const bodies = prev.bodies.map((b) => ops.topology(b.solid, b.id));
  const r = resolveRef(ref, bodies);
  const face = resolvedEntity(bodies, 'face', r);
  const f = face && faceFrame(planeFrame(item.plane), face);
  const frames = { ...prev.frames, [item.id]: f ? offsetFrame(f, inp.numbers.params[item.id]?.offset ?? 0) : captured };
  const warnings = { ...prev.warnings };
  delete warnings[item.id];
  if (!f) {
    // the feature that made the face may be gone with it: the label still says what it was
    const plane = item.plane as { label?: string };
    const words = !itemName(design, keyFeature(ref.key)) && plane.label ? `the ${plane.label}` : faceWords(ref.key, (id) => itemName(design, id));
    warnings[item.id] = bodies.some((b) => b.named === false)
      ? `the mesh kernel cannot follow ${words} until OpenCascade has loaded; the sketch stays where the face was when it was made`
      : face ? `reference lost: ${words} is no longer flat; the sketch stays where the face was when it was made`
        : `reference lost: ${words}, which the sketch is on, is gone; the sketch stays where the face was when it was made`;
  }
  return { ...prev, frames, warnings };
}

/**
 * Run one item of a component's timeline with a solid kernel: the meaning of every
 * feature (extents, automatic cut sides, targets, patterns, booleans) lives here, so the
 * mesh and the B-rep kernel build the same design. A failing feature records its error.
 */
export function timelineStep<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, prev: TimelineState<S>, item: DesignItem): TimelineState<S> {
  if (item.kind === 'sketch') {
    const face = sketchFace(item);
    return face && !item.suppressed ? sketchOnFace(ops, design, inp, prev, item, face) : prev;
  }
  if (item.suppressed) return prev;
  // copy on write: bodies change their solid in place below
  const bodies = prev.bodies.map((b) => ({ ...b }));
  const tools = new Map(prev.tools);
  const errors = { ...prev.errors };
  const made = [...prev.made];
  const built = prev.frames;
  const frameOf = (sketchId: string) => frameIn(inp, sketchId, built);
  const P = inp.numbers.params;
  const created = (id: string, feature: string, solid: S) => {
    bodies.push({ id, name: '', feature, solid });
    made.push(id);
  };
  const targetsOf = (ids?: string[]) => {
    const ts = ids?.length ? bodies.filter((b) => ids.includes(b.id)) : bodies;
    if (ids?.length && ts.length < ids.length) throw new Error('a target body no longer exists');
    return ts;
  };
  const apply = (id: string, rec: TimelineTool<S>) => {
    const { tool, op, targets } = rec;
    if (op === 'new' || (op === 'join' && !bodies.length)) {
      created(id, id.split('.')[0], tool);
      return;
    }
    if (op === 'join') {
      const t = targets?.length ? targetsOf(targets.slice(0, 1))[0] : bodies[bodies.length - 1];
      t.solid = ops.union([t.solid, tool]);
      return;
    }
    const ts = targetsOf(targets);
    if (!ts.length) throw new Error(`there is no body to ${op}`);
    for (const t of ts) t.solid = op === 'cut' ? ops.cut(t.solid, tool) : ops.intersect(t.solid, tool);
  };

  const p = P[item.id] ?? {};
  try {
    if (inp.numbers.errors[item.id]) throw new Error(inp.numbers.errors[item.id]);
    switch (item.kind) {
      case 'extrude': {
        const f = frameOf(item.sketch);
        const regions = selectedProfiles(inp, item.sketch, item.profiles);
        const ex = item.extent;
        let z0: number, z1: number;
        const cutting = item.op === 'cut' || item.op === 'intersect';
        const tgt = cutting ? targetsOf(item.targets).map((b) => b.solid) : [];
        if (ex.type === 'symmetric') [z0, z1] = [-p.d / 2, p.d / 2];
        else if (ex.type === 'two') [z0, z1] = [-p.d2, p.d];
        else {
          const d = ex.type === 'all' ? reach(ops, f, cutting ? tgt : bodies.map((b) => b.solid)) : p.d;
          if (ex.type === 'all' && !(d > 0)) throw new Error('“through all” needs a body to go through');
          if (ex.type === 'all' && ex.both) [z0, z1] = [-d, d];
          else {
            const dir = ex.dir ?? 'auto';
            const s = dir === '+' ? 1 : dir === '-' ? -1 : cutting ? bestSide(ops, (sg) => ops.extrude(regions, f, sg > 0 ? 0 : -d, sg > 0 ? d : 0, item.id), tgt) : 1;
            [z0, z1] = s > 0 ? [0, d] : [-d, 0];
          }
        }
        if (item.thin && (p.edgeStart || p.edgeEnd)) throw new Error('a thin extrude cannot also round its edges — use two features');
        const edge = (e: ExtrudeFeature['edgeStart'], r: number | undefined) => (e && r ? { type: e.type, r } : undefined);
        const tool = item.thin
          ? ops.thin(regions, f, z0, z1, { t: p.thin, side: item.thin.side, cap: item.thin.cap }, item.id)
          : p.edgeStart || p.edgeEnd
            ? ops.rounded(regions, f, z0, z1, edge(item.edgeStart, p.edgeStart), edge(item.edgeEnd, p.edgeEnd), item.id)
            : ops.extrude(regions, f, z0, z1, item.id);
        const rec = { tool, op: item.op, targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'loft': {
        if (item.sketch === item.sketch2) throw new Error('pick two different sketches');
        const pick = (sid: string, key?: string) => selectedProfiles(inp, sid, key ? [key] : undefined)[0];
        const tool = ops.loft({ region: pick(item.sketch, item.profile), frame: frameOf(item.sketch) }, { region: pick(item.sketch2, item.profile2), frame: frameOf(item.sketch2) }, item.id);
        const rec = { tool, op: item.op, targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'revolve': {
        const f = frameOf(item.sketch);
        const sk = findSketch(design, item.sketch)!;
        const regions = selectedProfiles(inp, item.sketch, item.profiles);
        const ax = sketchAxis(sk, item.axis, inp.numbers.sketches[item.sketch]);
        if (!ax) throw new Error('pick a line (or the sketch x / y axis) to revolve about');
        const axis = item.flip ? { p: ax.p, d: { x: -ax.d.x, y: -ax.d.y } } : ax;
        const rec = { tool: ops.revolve(regions, f, axis, p.angle, item.id), op: item.op, targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'hole': {
        const f = frameOf(item.sketch);
        const sk = findSketch(design, item.sketch)!;
        const sol = inp.numbers.sketches[item.sketch];
        const ids = item.points?.length ? item.points : sk.sketch.entities.filter((e) => e.type === 'point').map((e) => e.id);
        const centres = ids.map((id) => sk.sketch.entities.find((e) => e.id === id)).filter((e) => e?.type === 'point').map((e) => sol.points[(e as { p: string }).p]).filter(Boolean);
        if (!centres.length) throw new Error('place sketch points at the hole centres');
        const tgt = targetsOf(item.targets).map((b) => b.solid);
        if (!tgt.length) throw new Error('there is no body to drill');
        const depth = item.through ? reach(ops, f, tgt) * 2 : p.depth;
        const dir = item.dir ?? 'auto';
        const opts: HoleOptions = { d: p.d, depth, style: item.style, cbD: p.cbD, cbDepth: p.cbDepth, csD: p.csD, csAngle: p.csAngle };
        const make = (sg: number) => ops.hole(centres.map(([x, y]) => framePoint(f, { x, y })), scale3(f.n, sg), opts, item.id);
        const tool = make(dir === '+' ? 1 : dir === '-' ? -1 : bestSide(ops, make, tgt));
        const rec: TimelineTool<S> = { tool, op: 'cut', targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'pattern':
      case 'mirror': {
        const Ms = copyMatrices(design, inp, item, built);
        if (!item.refs.length) throw new Error(`pick the ${item.of} to ${item.kind}`);
        if (item.of === 'features') {
          for (const ref of item.refs) {
            const src = tools.get(ref);
            if (!src) throw new Error('a patterned feature failed or no longer exists');
            const copies = Ms.map((M, k) => ops.transform(src.tool, M, `${item.id}.${k + 1}.`));
            // cutting (or joining) copy after copy is one boolean with all of them: much
            // faster for a grid of holes, the same solid
            if (copies.length > 1 && (src.op === 'cut' || (src.op === 'join' && bodies.length))) apply(`${item.id}.1.${ref}`, { ...src, tool: ops.group(copies) });
            else copies.forEach((tool, k) => apply(`${item.id}.${k + 1}.${ref}`, { ...src, tool }));
          }
        } else {
          for (const ref of item.refs) {
            const b = bodies.find((q) => q.id === ref);
            if (!b) throw new Error('a body to copy no longer exists');
            const copies = Ms.map((M, k) => ops.transform(b.solid, M, `${item.id}.${k + 1}.`));
            if (item.join) b.solid = ops.union([b.solid, ...copies]);
            else copies.forEach((s, k) => created(`${item.id}.${k + 1}.${ref}`, item.id, s));
          }
        }
        break;
      }
      case 'combine': {
        const t = bodies.find((b) => b.id === item.target);
        const ts = bodies.filter((b) => item.tools.includes(b.id) && b !== t);
        if (!t) throw new Error('pick the target body');
        if (!ts.length) throw new Error('pick the tool bodies');
        const u = ts.length > 1 ? ops.union(ts.map((b) => b.solid)) : ts[0].solid;
        t.solid = item.op === 'join' ? ops.union([t.solid, u]) : item.op === 'cut' ? ops.cut(t.solid, u) : ops.intersect(t.solid, u);
        if (!item.keepTools) for (const b of ts) bodies.splice(bodies.indexOf(b), 1);
        break;
      }
    }
  } catch (e) {
    errors[item.id] = msg(e);
  }
  return { ...prev, bodies, tools, errors, made };
}

/**
 * The bodies of a finished timeline with their names: the component's own names, else
 * Body1, Body2 … counting the unnamed bodies in the order they were made.
 */
export function namedBodies<S>(comp: CadComponent, st: TimelineState<S>): TimelineBody<S>[] {
  const names = new Map<string, string>();
  let n = 0;
  for (const id of st.made) names.set(id, comp.bodyNames?.[id] ?? `Body${++n}`);
  return st.bodies.map((b) => ({ ...b, name: names.get(b.id) ?? b.id }));
}

/** Run the timeline of one component with a solid kernel. */
export function runTimeline<S>(ops: SolidOps<S>, design: CadDesign, comp: CadComponent, inp: BuildInputs): Timeline<S> {
  let st = emptyTimeline<S>();
  for (const item of activeItems(comp)) st = timelineStep(ops, design, inp, st, item);
  return { bodies: namedBodies(comp, st), errors: st.errors, warnings: st.warnings, frames: st.frames, tools: st.tools };
}

/** Build the bodies of one component with the mesh kernel. Every Manifold made goes into the arena. */
export function buildComponent(K: ManifoldToplevel, arena: Arena, design: CadDesign, comp: CadComponent, inp: BuildInputs): ComponentBuild {
  const t = runTimeline(meshOps(K, arena), design, comp, inp);
  return {
    bodies: t.bodies.map((b) => ({ id: b.id, name: b.name, feature: b.feature, solid: b.solid.m, exact: b.solid.exact })),
    errors: t.errors, warnings: t.warnings, frames: t.frames,
    tools: new Map([...t.tools].map(([id, r]) => [id, { tool: r.tool.m, exact: r.tool.exact, op: r.op, targets: r.targets }])),
  };
}

/**
 * Bodies with exact properties, without the kernel: possible while every feature of the
 * component makes a new body by extrude or revolve, and no sketch has to find its face
 * on a body first. Null otherwise.
 */
export function exactComponent(design: CadDesign, comp: CadComponent, inp: BuildInputs): { bodies: { id: string; name: string; feature: string; mass: Mass3 }[]; errors: Record<string, string> } | null {
  if (activeItems(comp).some((i) => isSketch(i) && sketchFace(i))) return null;
  const all = activeItems(comp).filter((i): i is DesignFeature => i.kind !== 'sketch' && !i.suppressed);
  const feats = all.filter((f): f is ExtrudeFeature | RevolveFeature => (f.kind === 'extrude' && f.op === 'new' && f.extent.type !== 'all') || (f.kind === 'revolve' && f.op === 'new'));
  if (feats.length < all.length) return null;
  const bodies: { id: string; name: string; feature: string; mass: Mass3 }[] = [];
  const errors: Record<string, string> = {};
  let made = 0;
  for (const f of feats) {
    const p = inp.numbers.params[f.id] ?? {};
    try {
      if (inp.numbers.errors[f.id]) throw new Error(inp.numbers.errors[f.id]);
      const fr = frameIn(inp, f.sketch);
      const regions = selectedProfiles(inp, f.sketch, f.profiles);
      let props: MassProps | null = null;
      if (f.kind === 'extrude') {
        const ex = f.extent;
        const [z0, z1] = ex.type === 'symmetric' ? [-p.d / 2, p.d / 2] : ex.type === 'two' ? [-p.d2, p.d] : ex.type === 'one' && ex.dir === '-' ? [-p.d, 0] : [0, p.d];
        const q = extrudeProps(regions, z1 - z0);
        props = q && { ...q, zg: q.zg + z0 };
      } else if (f.kind === 'revolve') {
        const ax = sketchAxis(findSketch(design, f.sketch)!, f.axis, inp.numbers.sketches[f.sketch]);
        if (!ax) throw new Error('pick a line (or the sketch x / y axis) to revolve about');
        props = revolveProps(regions, f.flip ? { p: ax.p, d: { x: -ax.d.x, y: -ax.d.y } } : ax, p.angle);
      }
      if (props) bodies.push({ id: f.id, name: comp.bodyNames?.[f.id] ?? `Body${++made}`, feature: f.id, mass: transformMass(massFromProps(props), frameMatrix(fr)) });
    } catch (e) {
      errors[f.id] = msg(e);
    }
  }
  return { bodies, errors };
}

// ------------------------------------------------------------ assembly

/**
 * What a placement knows of the built bodies: the sketch planes as built and the named
 * topology of each component's bodies (joint origins on geometry are found on them).
 * Without it (no kernel yet) joint origins on geometry stay where they were picked.
 */
export interface PlacementGeometry {
  frames: Record<string, Frame>;
  bodies(componentId: string): BodyTopology[];
}

/** Joint origin as a frame matrix in its component; `lost` says why a snap point stays where it was picked. */
export function jointFrame(numbers: DesignNumbers, o: JointOrigin, bodies?: BodyTopology[], frames?: Record<string, Frame>, lost?: (why: string) => void): M4 {
  if (o.kind === 'origin') return IDENTITY;
  if (o.kind === 'frame' || o.kind === 'snap') {
    let at = { o: o.o, z: o.z };
    if (o.kind === 'snap' && bodies) {
      const found = snapPlace(o, bodies);
      if (found) at = found;
      else lost?.(bodies.some((b) => b.named === false)
        ? 'the mesh kernel cannot follow joint origins on geometry until OpenCascade has loaded'
        : `reference lost: the ${o.label} is gone; the joint keeps its origin where it was picked`);
    }
    const z = norm3(at.z);
    const x = o.kind === 'frame' && o.x ? norm3(o.x) : frameFromNormal(at.o, z).u;
    return m4Frame(at.o, x, cross3(z, x), z);
  }
  const f = frames?.[o.sketch] ?? numbers.frames[o.sketch], sol = numbers.sketches[o.sketch];
  const q = sol?.points[o.point];
  if (!f || !q) throw new Error('the joint point no longer exists');
  const at = framePoint(f, { x: q[0], y: q[1] });
  const [x, z] = o.axis === 'u' ? [f.v, f.u] : o.axis === 'v' ? [f.n, f.v] : [f.u, f.n];
  return m4Frame(at, x, cross3(z, x), z);
}

/** Joint motion in the parent's joint frame. */
export function jointMotion(j: CadJoint, angle: number, offset: number): M4 {
  let M = m4Mul(m4Translate([0, 0, offset]), m4Rotate([0, 0, 0], [0, 0, 1], angle));
  if (j.flip) M = m4Mul(M, m4Rotate([0, 0, 0], [1, 0, 0], Math.PI));
  return M;
}

export interface Placement {
  matrix: M4;
  by: 'ground' | 'joint' | 'free';
}

/**
 * Place the occurrences: grounded ones (or the first, if none is) stay where they are,
 * joints then carry their neighbours along the joint tree. Loops that disagree are reported.
 */
export function placeOccurrences(design: CadDesign, numbers: DesignNumbers, geo?: PlacementGeometry): { placements: Record<string, Placement>; errors: Record<string, string>; warnings: Record<string, string> } {
  const placements: Record<string, Placement> = {};
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const compOf = (occ: string) => design.occurrences.find((o) => o.id === occ)?.component ?? '';
  const topo = new Map<string, BodyTopology[]>();
  const bodiesOf = (occ: string) => {
    if (!geo) return undefined;
    const cid = compOf(occ);
    if (!topo.has(cid)) topo.set(cid, geo.bodies(cid));
    return topo.get(cid);
  };
  const occ = design.occurrences;
  const pose = (o: CadOccurrence) => m4Pose(o.pos, o.rot);
  for (const o of occ) if (o.grounded) placements[o.id] = { matrix: pose(o), by: 'ground' };
  if (!Object.keys(placements).length && occ.length) placements[occ[0].id] = { matrix: pose(occ[0]), by: 'ground' };
  const live = design.joints.filter((j) => !j.suppressed);
  const frames = new Map<string, { Fa: M4; Fb: M4; M: M4 }>();
  for (const j of live) {
    try {
      if (!occ.some((o) => o.id === j.a.occ) || !occ.some((o) => o.id === j.b.occ)) throw new Error('a jointed occurrence no longer exists');
      if (j.a.occ === j.b.occ) throw new Error('a joint needs two different occurrences');
      const p = numbers.params[j.id] ?? {};
      if (numbers.errors[j.id]) throw new Error(numbers.errors[j.id]);
      const lost = (why: string) => (warnings[j.id] ??= why);
      frames.set(j.id, {
        Fa: jointFrame(numbers, j.a.origin, bodiesOf(j.a.occ), geo?.frames, lost),
        Fb: jointFrame(numbers, j.b.origin, bodiesOf(j.b.occ), geo?.frames, lost),
        M: jointMotion(j, p.angle ?? 0, p.offset ?? 0),
      });
    } catch (e) {
      errors[j.id] = msg(e);
    }
  }
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const j of live) {
      const fr = frames.get(j.id);
      if (!fr || done.has(j.id)) continue;
      const A = placements[j.a.occ], B = placements[j.b.occ];
      if (A && B) {
        done.add(j.id);
        const want = m4Mul(m4Mul(m4Mul(A.matrix, fr.Fa), fr.M), m4Inv(fr.Fb));
        const err = Math.max(...want.map((v, k) => Math.abs(v - B.matrix[k]) / (k >= 12 ? 1 + Math.abs(v) : 1)));
        if (err > 1e-6) errors[j.id] = 'this joint closes a loop that does not fit — it is ignored';
        continue;
      }
      if (A) placements[j.b.occ] = { matrix: m4Mul(m4Mul(m4Mul(A.matrix, fr.Fa), fr.M), m4Inv(fr.Fb)), by: 'joint' };
      else if (B) placements[j.a.occ] = { matrix: m4Mul(m4Mul(m4Mul(B.matrix, fr.Fb), m4Inv(fr.M)), m4Inv(fr.Fa)), by: 'joint' };
      else continue;
      done.add(j.id);
      progress = true;
    }
  }
  for (const o of occ) placements[o.id] ??= { matrix: pose(o), by: 'free' };
  return { placements, errors, warnings };
}

// ------------------------------------------------------------ properties

/** Mass properties (volume-based, part units) plus mass in kg and mass moments in kg·unit². */
export interface MassOut extends MassProps {
  m?: number;
  /** Mass moments of inertia about the centre of mass: xx, yy, zz, xy, xz, yz. */
  Im?: [number, number, number, number, number, number];
}

export function massOut(items: { m: Mass3; rho?: number }[]): MassOut | null {
  const vol = combineMass(items.map(({ m }) => ({ m, w: 1 })));
  if (!(vol.W > 0)) return null;
  const out: MassOut = propsFromMass({ V: vol.W, c: vol.c, C: vol.C });
  if (items.every((i) => i.rho !== undefined && i.rho > 0)) {
    const ms = combineMass(items.map(({ m, rho }) => ({ m, w: rho! })));
    const C = ms.C;
    const tiny = 1e-9 * (Math.abs(C[0]) + Math.abs(C[4]) + Math.abs(C[8]));
    const clean = (v: number) => (Math.abs(v) < tiny ? 0 : v);
    out.m = ms.W;
    out.xg = ms.c[0]; out.yg = ms.c[1]; out.zg = ms.c[2];
    out.Im = [C[4] + C[8], C[0] + C[8], C[0] + C[4], clean(C[1]), clean(C[2]), clean(C[5])];
  }
  // rounding noise on a symmetry plane reads as 0
  const size = Math.sqrt(Math.abs(vol.C[0] + vol.C[4] + vol.C[8]) / vol.W);
  const tidy = (v: number) => (Math.abs(v) < 1e-9 * size ? 0 : v);
  out.xg = tidy(out.xg); out.yg = tidy(out.yg); out.zg = tidy(out.zg);
  return out;
}

export interface BuiltDesign {
  arena: Arena;
  components: Map<string, ComponentBuild>;
  placements: Record<string, Placement>;
  /** Joint and occurrence problems. */
  errors: Record<string, string>;
  /** Joints whose origin on geometry was lost. */
  warnings: Record<string, string>;
  free(): void;
}

/** Build every component and place the occurrences. Call `free()` when done. */
export function buildDesign(K: ManifoldToplevel, design: CadDesign, numbers: DesignNumbers): BuiltDesign {
  const arena = new Arena();
  const inp = buildInputs(design, numbers);
  const components = new Map<string, ComponentBuild>();
  for (const c of design.components) {
    try {
      components.set(c.id, buildComponent(K, arena, design, c, inp));
    } catch (e) {
      components.set(c.id, { bodies: [], errors: { [c.id]: msg(e) }, warnings: {}, frames: {}, tools: new Map() });
    }
  }
  const { placements, errors, warnings } = placeOccurrences(design, numbers, {
    frames: Object.assign({}, ...[...components.values()].map((cb) => cb.frames)),
    bodies: (cid) => (components.get(cid)?.bodies ?? []).map((b) => meshTopology(b.solid, b.id)),
  });
  return { arena, components, placements, errors, warnings, free: () => arena.free() };
}

export function bodyMass(b: Body): Mass3 {
  return b.exact ?? solidMass(b.solid);
}

/** Solids of an occurrence in assembly coordinates (made in the arena). */
export function placedSolids(built: BuiltDesign, design: CadDesign, occId: string): { body: Body; solid: Manifold }[] {
  const o = design.occurrences.find((q) => q.id === occId);
  const cb = o && built.components.get(o.component);
  const M = built.placements[occId]?.matrix;
  if (!cb || !M) return [];
  return cb.bodies.filter((b) => !b.solid.isEmpty()).map((body) => ({ body, solid: transformSolid(built.arena, body.solid, M) }));
}

export { m4Point, len3, IDENTITY };
