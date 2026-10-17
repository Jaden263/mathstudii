// A parametric design as in Fusion: components, each with a timeline of sketches
// (on origin planes, offset planes or faces) and features (extrude, revolve, hole,
// pattern, mirror, combine) that build its bodies; occurrences of the components are
// placed in the assembly by joints.
//
// The document is plain JSON. Evaluation runs in two stages so the worksheet and the
// CAD window can share it: `resolve` turns expressions into numbers and solves the
// sketches (serialisable, no kernel), `build` makes the solids from those numbers.
import type { CadRegion } from '../model/types';
import { sketchSig, type CadSketch, type CadView } from './model';
import { findProfiles, type ProfileRegion, type Vec2 } from './profile';
import { extrudeProps, revolveProps, type MassProps } from './features';
import {
  Arena, IDENTITY, add3, combineMass, cross3, dot3, frameDir, frameFromNormal, frameMatrix, framePoint,
  len3, m4Dir, m4Frame, m4Mirror, m4Mul, m4Point, m4Rotate, m4Translate, massFromProps, norm3, propsFromMass,
  scale3, solidMass, sub3, transformMass, transformSolid,
  type Frame, type M4, type Manifold, type ManifoldToplevel, type Mass3, type Vec3,
} from './solid';
import type { EdgeOptions, ThinOptions } from './shaping';
import { meshOps } from './meshOps';
import { meshTopology } from './meshTopology';
import {
  anchorPoint, edgeWords, faceAnchor, faceFrame, faceWords, keyFeature, refTo, refToken, refWords, resolveRef, resolvedEntity,
  type BodyTopology, type FaceAnchor, type TopoRef,
} from './topology';
import { chamferFace, chamferLimit, filletLimit, needsBrep, sizeWords } from './modify';
import type { FaceInfo } from './buildResult';
import { snapPlace, type SnapOrigin } from './snaps';
import { datumOf, type ConstructContext, type CurveAt } from './construct';
import {
  chainEdges, coilGeometry, sketchPath, startNear, threadFace, threadGeometry,
  type Helix, type PathGeom, type SweepOptions, type ThreadGeom,
} from './sweep';
import { parseThread, threadIn } from './threads';
import { ribCurve, ribRegion, type RibCurve } from './rib';
import { reproject, sameReferences, type ReferenceContext, type RefCurve3 } from './reference';
import { sketchSolution } from './sketchSolve';
import type { CadResult } from './evaluate';
import { loopPolygon, segDeriv, segPoint } from './profile';
import { entitySegs } from './sketchCurves';
import type { DofKey, ExplodeOffset, JointDof, MotionLink, MotionStudy, RigidGroup } from './assembly';
import { kinModel, solveKinematics, type KinState } from './kinematics';

export type { Helix };

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
   * (older documents), or when the face is gone, the captured frame stays. When the origin
   * sits on a vertex or circle centre of the face (`anchor`), it moves with that point.
   * A sketch on a construction plane (`datum`, its id) takes that plane as built instead.
   */
  | { frame: { o: Vec3; u: Vec3; v: Vec3 }; face?: TopoRef; anchor?: FaceAnchor; datum?: string; label?: string; offset?: string };

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

/** Origin axis, a sketch line as `${sketchId}/${entityId}`, or a construction axis (its id). */
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
  /** Tapped: drilled to the tap drill of an ISO thread (its diameter replaces `d`), threaded to a depth. */
  tap?: { size: string; depth?: string; modeled?: boolean };
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

// ------------------------------------------------------------ modify features
//
// Fillet, chamfer, shell, draft and press-pull work on faces and edges picked on the
// bodies built before them. They store references (topology.ts), so a base made longer
// keeps its rounded edge rounded.

/** A plane: an origin plane, a sketch's or construction plane (its id, as a mirror's `plane`), or a flat face picked on a body. */
export type PlanePick = string | TopoRef;
/** An axis: an origin axis or a sketch line (AxisRef), or a straight edge, circle or round face picked on a body. */
export type AxisPick = AxisRef | TopoRef;

/** Edges rounded with one radius, or with one that goes linearly from `r` to `r2` along the chain. */
export interface FilletSet {
  edges: TopoRef[];
  r: string;
  /** Radius at the end of the chain (variable radius); empty = constant. */
  r2?: string;
}

export interface FilletFeature extends FeatureBase {
  kind: 'fillet';
  sets: FilletSet[];
  /** Round along the edges tangent to the picked ones (the default); false = only the picked edges. */
  chain?: boolean;
}

export interface ChamferFeature extends FeatureBase {
  kind: 'chamfer';
  edges: TopoRef[];
  /** Equal distances, two distances (d on one face, d2 on the other) or a distance and an angle. */
  type: 'equal' | 'two' | 'angle';
  d: string;
  d2?: string;
  angle?: string;
  /** Measure d (and the angle) on the other face of each edge. */
  flip?: boolean;
  chain?: boolean;
}

export interface ShellFeature extends FeatureBase {
  kind: 'shell';
  /** Faces to remove (the openings); none = `body` is hollowed out. */
  faces: TopoRef[];
  body?: string;
  t: string;
  side: 'inside' | 'outside';
}

export interface DraftFeature extends FeatureBase {
  kind: 'draft';
  faces: TopoRef[];
  /** Neutral plane: the faces turn about where they meet it. */
  plane: PlanePick;
  /** Pull direction; missing = the neutral plane's normal. */
  pull?: AxisPick;
  angle: string;
  /** Pull the other way. */
  flip?: boolean;
}

/** Press-pull: planar faces moved along their normal, cylinders grown or shrunk. */
export interface PressPullFeature extends FeatureBase {
  kind: 'presspull';
  faces: TopoRef[];
  /** Out of the material (adds) or, negative, into it (removes). */
  d: string;
}

export interface SplitFeature extends FeatureBase {
  kind: 'split';
  body: string;
  plane: PlanePick;
  /** Offset of the plane along its normal. */
  offset?: string;
}

/** Move or copy bodies: turned about an axis, then moved by (dx, dy, dz). */
export interface MoveFeature extends FeatureBase {
  kind: 'move';
  bodies: string[];
  dx?: string;
  dy?: string;
  dz?: string;
  axis?: AxisPick;
  angle?: string;
  /** Move a copy and keep the original. */
  copy?: boolean;
}

export type ModifyFeature = FilletFeature | ChamferFeature | ShellFeature | DraftFeature | PressPullFeature | SplitFeature | MoveFeature;

// ------------------------------------------------------------ sweeps, coils, threads

/**
 * A point: a sketch point `${sketch}/${point}`, a construction point (its id), or a vertex,
 * circle or sphere picked on a body (a circle or sphere stands for its centre).
 */
export type PointPick = string | TopoRef;
/** A curve: a sketch line, arc or circle `${sketch}/${entity}`, or an edge picked on a body. */
export type CurvePick = string | TopoRef;

/** Where a sweep goes: curves of a sketch joined end to end, edges picked on the bodies, or the helix of a coil. */
export type SweepPath =
  /** `curves` missing = every curve of the sketch that is not construction geometry. */
  | { kind: 'sketch'; sketch: string; curves?: string[] }
  | { kind: 'edges'; edges: TopoRef[] }
  | { kind: 'coil'; coil: string };

export interface SweepFeature extends FeatureBase {
  kind: 'sweep';
  sketch: string;
  /** Profile key; missing = the first profile of the sketch. */
  profile?: string;
  path: SweepPath;
  /** Perpendicular: the profile turns with the path (corrected Frenet); parallel: it keeps its orientation. */
  orientation?: 'perpendicular' | 'parallel';
  /** The profile turns this far about the path from its start to its end. */
  twist?: string;
  /** Size of the profile at the end of the path as a factor of its size at the start (taper). */
  scale?: string;
  op: FeatureOp;
  targets?: string[];
}

/** Fusion's coil: a section swept along a helix standing on a plane. */
export interface CoilFeature extends FeatureBase {
  kind: 'coil';
  /** The plane it stands on (origin, sketch or construction plane, or a flat face); its axis is the normal through `centre`. */
  plane: PlanePick;
  /** Missing: the plane's origin (a face: its centre). */
  centre?: PointPick;
  /** Grow against the plane's normal. */
  flip?: boolean;
  /** Which two of revolutions, height and pitch give its size. */
  mode: 'revs-height' | 'revs-pitch' | 'height-pitch';
  /** Diameter of the helix the section follows. */
  d: string;
  revs?: string;
  height?: string;
  pitch?: string;
  /** Right-hand turns anticlockwise seen from the top (looking down its axis). */
  hand?: 'right' | 'left';
  /** Triangles with the point outwards or inwards. */
  section: 'circle' | 'square' | 'triangle-out' | 'triangle-in';
  /** The section's diameter (circle) or side, square to the helix. */
  size: string;
  /** Where the section lies against the diameter: centred on it, inside or outside it. */
  position?: 'center' | 'inside' | 'outside';
  /** Only the helix, as a path for a sweep: no body. */
  pathOnly?: boolean;
  op: FeatureOp;
  targets?: string[];
}

/** ISO metric threads on cylindrical faces: shafts get external threads, holes internal ones. */
export interface ThreadFeature extends FeatureBase {
  kind: 'thread';
  faces: TopoRef[];
  /** ISO 262 designation: M12, M12x1.25. */
  size: string;
  /** Threaded length from the start end; empty = the whole face. */
  length?: string;
  /** Distance of the thread's start from the end of the face. */
  offset?: string;
  /** Start at the other end of the face (the default is an end the thread can run out of). */
  flip?: boolean;
  /** True helical geometry; otherwise cosmetic (an attribute the inspector and drawings show). */
  modeled?: boolean;
  hand?: 'right' | 'left';
}

/**
 * Fusion's rib: an open sketch curve grown in its sketch plane until it meets the body (or
 * to a depth), as thick as `thickness` across the plane — a gusset in the corner of a bracket.
 */
export interface RibFeature extends FeatureBase {
  kind: 'rib';
  sketch: string;
  /** Lines and arcs joined end to end; missing = every curve of the sketch that is not construction geometry. */
  curves?: string[];
  thickness: string;
  /** Across the sketch plane: both sides, its normal's side or the other. */
  side?: 'symmetric' | 'one' | 'other';
  /** Empty = to the next faces of the body. */
  depth?: string;
  /** Grow to the other side of the curve than the one found. */
  flip?: boolean;
  op: 'join' | 'new';
  targets?: string[];
}

// ------------------------------------------------------------ construction geometry
//
// Planes, axes and points made from origin geometry, sketches and what is picked on the
// bodies before them (references), so they follow edits. They make no body; sketches,
// mirrors, patterns, splits, coils, joints and sweeps can use them.

export type PlaneDef =
  /** Parallel to a plane (or flat face), at a distance along its normal. */
  | { type: 'offset'; plane: PlanePick; d: string }
  /** Through an axis (line, edge), turned by the angle from a plane (default: one the axis lies in). */
  | { type: 'angle'; axis: AxisPick; angle: string; plane?: PlanePick }
  /** Halfway between two planes (or flat faces); between planes that meet, the bisector between them. */
  | { type: 'midplane'; a: PlanePick; b: PlanePick }
  | { type: 'points'; points: PointPick[] }
  /** Tangent to a cylinder or cone, where it is turned by the angle about the axis from a plane's normal. */
  | { type: 'tangent'; face: TopoRef; angle: string; plane?: PlanePick }
  /** Square to a curve at a fraction of its length (0 its start, 1 its end), the curve's point its origin. */
  | { type: 'path'; curve: CurvePick; at: string };

export type AxisDef =
  | { type: 'points'; a: PointPick; b: PointPick }
  /** A straight edge or sketch line; a circle or arc gives its axis. */
  | { type: 'edge'; edge: CurvePick }
  /** The axis of a cylinder, cone or torus. */
  | { type: 'cylinder'; face: TopoRef }
  /** Square to a flat, cylindrical or spherical face through a point (default: the face's centre). */
  | { type: 'normal'; face: TopoRef; point?: PointPick };

export type PointDef =
  | { type: 'vertex'; vertex: TopoRef }
  /** The centre of a circle or arc (edge or sketch curve) or of a sphere. */
  | { type: 'centre'; of: CurvePick }
  /** Where a curve crosses a plane (the first crossing along the curve). */
  | { type: 'edgePlane'; curve: CurvePick; plane: PlanePick };

export interface ConstructPlane extends FeatureBase {
  kind: 'plane';
  def: PlaneDef;
  hidden?: boolean;
}

export interface ConstructAxis extends FeatureBase {
  kind: 'axis';
  def: AxisDef;
  hidden?: boolean;
}

export interface ConstructPoint extends FeatureBase {
  kind: 'point';
  def: PointDef;
  hidden?: boolean;
}

export type ConstructItem = ConstructPlane | ConstructAxis | ConstructPoint;

/** A construction plane, axis or point as built, or the helix of a coil (component coordinates). */
export type Datum =
  | { kind: 'plane'; frame: Frame }
  | { kind: 'axis'; p: Vec3; d: Vec3 }
  | { kind: 'point'; p: Vec3 }
  | { kind: 'helix'; helix: Helix };

export type DesignFeature = ExtrudeFeature | RevolveFeature | HoleFeature | PatternFeature | MirrorFeature | CombineFeature | LoftFeature | ModifyFeature
  | SweepFeature | CoilFeature | ThreadFeature | RibFeature | ConstructItem;
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
  /** Where it goes in the exploded view. */
  explode?: ExplodeOffset;
}

export type JointOrigin =
  | { kind: 'origin' }
  /** A sketch point; Z along the sketch normal ('n') or its x / y axis. */
  | { kind: 'point'; sketch: string; point: string; axis?: 'n' | 'u' | 'v' }
  /** A picked spot (component coordinates). */
  | { kind: 'frame'; o: Vec3; z: Vec3; x?: Vec3 }
  /** A snap point on a body's geometry (snaps.ts): it follows the face, edge or vertex. */
  | SnapOrigin
  /** Construction geometry of the component: a point (Z up), an axis (Z along it) or a plane (Z its normal). */
  | { kind: 'datum'; id: string };

export type JointType = 'rigid' | 'revolute' | 'slider' | 'cylindrical' | 'pinslot' | 'planar' | 'ball';

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
  /** Slides along the joint X and Y (pin-slot, planar). */
  x?: string;
  y?: string;
  /** Ball joints: pitch about the turned Y and roll about the turned X, after the yaw `angle`. */
  angle2?: string;
  angle3?: string;
  /** Per DOF: solved by the assembly, limits, rest value. */
  dofs?: Partial<Record<DofKey, JointDof>>;
}

export interface CadDesign {
  version: 2;
  components: CadComponent[];
  occurrences: CadOccurrence[];
  joints: CadJoint[];
  links?: MotionLink[];
  groups?: RigidGroup[];
  motions?: MotionStudy[];
}

export const isSketch = (i: DesignItem): i is DesignSketch => i.kind === 'sketch';
export const FEATURE_LABEL: Record<DesignItem['kind'], string> = {
  sketch: 'Sketch', extrude: 'Extrude', revolve: 'Revolve', hole: 'Hole', pattern: 'Pattern', mirror: 'Mirror', combine: 'Combine', loft: 'Loft',
  fillet: 'Fillet', chamfer: 'Chamfer', shell: 'Shell', draft: 'Draft', presspull: 'Press pull', split: 'Split', move: 'Move',
  sweep: 'Sweep', coil: 'Coil', thread: 'Thread', rib: 'Rib', plane: 'Plane', axis: 'Axis', point: 'Point',
};

/** Features that work on what is picked on the bodies: they are edited with the timeline rolled back to them. */
export const MODIFY_KINDS = new Set<DesignItem['kind']>(['fillet', 'chamfer', 'shell', 'draft', 'presspull', 'split', 'move']);
export const isModify = (i: DesignItem): i is ModifyFeature => MODIFY_KINDS.has(i.kind);

export const CONSTRUCT_KINDS = new Set<DesignItem['kind']>(['plane', 'axis', 'point']);
export const isConstruct = (i: DesignItem): i is ConstructItem => CONSTRUCT_KINDS.has(i.kind);

/** Items that pick faces, edges or vertices of the bodies before them: edited with the timeline rolled back to them. */
export const picksOnBodies = (i: DesignItem): boolean => isModify(i) || isConstruct(i) || i.kind === 'thread'
  || (i.kind === 'sweep' && i.path.kind === 'edges') || (i.kind === 'coil' && (typeof i.plane !== 'string' || (i.centre !== undefined && typeof i.centre !== 'string')));

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
  for (const x of [...(design.links ?? []), ...(design.groups ?? []), ...(design.motions ?? [])]) used.add(x.name);
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
  /** The part's unit, for sizes in messages ("radius 12 mm is too large …"). */
  unit?: string;
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
 * origin projected onto it (its x axis kept level), the reference it follows and, when the
 * origin lands on a vertex or circle centre of the face, that point as its anchor.
 */
export function facePlane(body: BodyTopology, face: FaceInfo, label?: string): SketchPlane {
  const n = face.frame!.n;
  const f = frameFromNormal(scale3(n, dot3(face.frame!.o, n)), n);
  const anchor = faceAnchor(body, face, f.o);
  return {
    frame: { o: f.o.map((v) => +v.toPrecision(12)) as Vec3, u: f.u, v: f.v }, face: refTo('face', body.id, face),
    ...(anchor ? { anchor } : {}), ...(label ? { label } : {}),
  };
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
  datums: Record<string, Datum>;
  /** Tool solid of every feature that made one (previews, patterns). */
  tools: Map<string, ToolRec>;
  /** Sketches the timeline solved again (their projected references moved). */
  sketches: Record<string, RebuiltSketch>;
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

/** Axis in component coordinates: origin axis, a sketch line or a construction axis (as built). */
export function axisOf(design: CadDesign, inp: BuildInputs, ref: AxisRef, built?: Record<string, Frame>, datums?: Record<string, Datum>): { p: Vec3; d: Vec3 } {
  if (ref === 'X') return { p: [0, 0, 0], d: [1, 0, 0] };
  if (ref === 'Y') return { p: [0, 0, 0], d: [0, 1, 0] };
  if (ref === 'Z') return { p: [0, 0, 0], d: [0, 0, 1] };
  if (!ref.includes('/')) {
    const dt = datums?.[ref];
    if (dt?.kind === 'axis') return { p: dt.p, d: norm3(dt.d) };
    throw new Error(itemName(design, ref) ? `the axis ${itemName(design, ref)} failed` : 'the axis is missing: its construction axis is gone');
  }
  const [sid, eid] = ref.split('/');
  const sk = findSketch(design, sid);
  const e = sk?.sketch.entities.find((q) => q.id === eid);
  const sol = inp.numbers.sketches[sid];
  if (!sk || e?.type !== 'line' || !sol) throw new Error('the axis is missing: its sketch line is gone');
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
 * An edge or face a modify operation works on: its index in the body's topology, and the
 * name the faces made from it carry (a rounding `f5/round:${name}`; refToken of the
 * reference, so the UI finds the pick again from what it made).
 */
export interface ModifyPick {
  index: number;
  name: string;
  /** Chamfers with two distances or an angle: the face (index) the first distance is measured on. */
  face?: number;
}

/** A fillet set as the kernel takes it: radius r, or linearly r → r2 from the start of the chain to its end. */
export interface FilletPicks {
  picks: ModifyPick[];
  r: number;
  r2?: number;
}

export interface ChamferOptions {
  type: 'equal' | 'two' | 'angle';
  d: number;
  d2?: number;
  /** Radians, measured from the face the distance is on. */
  angle?: number;
}

/** A plane in component coordinates: a point on it and its unit normal. */
export interface PlaneAt {
  o: Vec3;
  n: Vec3;
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
  /** Round edges (indices in the body's topology); `chain`: along the edges tangent to them too. */
  fillet(s: S, sets: FilletPicks[], chain: boolean, tag: string): S;
  chamfer(s: S, picks: ModifyPick[], o: ChamferOptions, chain: boolean, tag: string): S;
  /** Walls of thickness t inside (or outside) the faces with the picked faces open; none picked: a closed void. */
  shell(s: S, faces: number[], t: number, outside: boolean, tag: string): S;
  /** Faces tilted by `angle` about where they meet the neutral plane; angle > 0 removes matter on the pull side. */
  draft(s: S, faces: number[], pull: Vec3, angle: number, plane: PlaneAt, tag: string): S;
  /** Flat faces moved d along their normals, cylinders grown by d (d < 0: into the material). */
  pressPull(s: S, faces: number[], d: number, tag: string): S;
  /** The pieces on either side of a plane, those behind it first. */
  split(s: S, plane: PlaneAt, tag: string): S[];
  /** The separate solids of a shape (a boolean's result can fall apart). */
  pieces(s: S): S[];
  /** A profile region swept along a path (component coordinates); its holes are swept too and cut out. */
  sweep(region: ProfileRegion, f: Frame, path: PathGeom<S>, o: SweepOptions, tag: string): S;
  /** The groove of a screw thread, a tool to cut. */
  thread(g: ThreadGeom, tag: string): S;
  /** The point and unit tangent at a fraction t of an edge's length (its index in the body's topology). */
  edgeAt(s: S, edge: number, t: number): { p: Vec3; d: Vec3 };
  /** The curves the plane f cuts from a solid (component coordinates): lines, circles and ellipses exactly, other curves as points along them. */
  section(s: S, f: Frame): RefCurve3[];
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
  /** Sketch planes found on the bodies (sketches on faces) and construction planes, by item id. */
  frames: Record<string, Frame>;
  /** Construction planes, axes and points and the helices of coils, by item id. */
  datums: Record<string, Datum>;
  /** Tool solid of every feature that made one (previews, patterns). */
  tools: Map<string, TimelineTool<S>>;
  /** Sketches the timeline solved again (their projected references moved). */
  sketches: Record<string, RebuiltSketch>;
  threads: ThreadMark[];
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
function copyMatrices(design: CadDesign, inp: BuildInputs, f: PatternFeature | MirrorFeature, built: Record<string, Frame>, datums: Record<string, Datum>): M4[] {
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
    const a = axisOf(design, inp, f.axis, built, datums);
    const n2 = f.axis2 ? Math.round(p.count2 ?? 1) : 1;
    const a2 = f.axis2 ? axisOf(design, inp, f.axis2, built, datums) : null;
    for (let i = 0; i < n; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      let t = scale3(a.d, i * (p.spacing ?? 0));
      if (a2) t = add3(t, scale3(a2.d, j * (p.spacing2 ?? 0)));
      out.push(m4Translate(t));
    }
  } else {
    const a = axisOf(design, inp, f.axis, built, datums);
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
  /** Planes of the sketches on faces, found on the bodies built before them, and of construction planes. */
  frames: Record<string, Frame>;
  /** Construction geometry and coil helices built so far. */
  datums: Record<string, Datum>;
  /** Ids of every body made so far, in order (default names count them). */
  made: string[];
  /** Sketches whose projected references moved: projected again on the bodies before them and solved again. */
  sketches: Record<string, RebuiltSketch>;
  /** Cosmetic threads so far (drawings draw them per ISO 6410). */
  threads: ThreadMark[];
}

/**
 * A cosmetic thread (a thread feature without geometry, or a tapped hole): where it runs
 * and its diameters, for the drawings (component coordinates, part units).
 */
export interface ThreadMark {
  /** Feature that made it (a pattern's copies carry its prefix, `${pattern}.${k}.${feature}`). */
  feature: string;
  /** Body it is on, when known (a tapped hole has one for each body it drills). */
  body?: string;
  /** On the axis where the threaded face starts; `axis` points along it (unit). */
  o: Vec3;
  axis: Vec3;
  /** Radius of the threaded face (a hole's: its tap drill). */
  R: number;
  /** The thread runs from z0 to z1 along the axis (z1 undefined: as far as the hole goes); the face or hole ends at `length` (undefined: through). */
  z0: number;
  z1?: number;
  length?: number;
  /** Major diameter and the root of an external thread (d3) or the crest of an internal one (D1), ISO 68-1. */
  d: number;
  d1: number;
  internal: boolean;
  name: string;
}

/** A thread mark moved by a placement. */
const movedMark = (m: ThreadMark, M: M4, feature = m.feature, body = m.body): ThreadMark => ({ ...m, feature, body, o: m4Point(M, m.o), axis: norm3(m4Dir(M, m.axis)) });

/** A sketch as its timeline rebuilt it (its reference geometry projected again). */
export interface RebuiltSketch {
  sketch: CadSketch;
  solved: SolvedSketch;
  result: CadResult;
}

export const emptyTimeline = <S>(): TimelineState<S> => ({ bodies: [], tools: new Map(), errors: {}, warnings: {}, frames: {}, datums: {}, made: [], sketches: {}, threads: [] });

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
  // the origin goes with the vertex or circle centre it sits on; without one (or with it
  // gone) it is the stored one projected onto the face
  const anchor = 'frame' in item.plane ? item.plane.anchor : undefined;
  const to = face && anchor ? anchorPoint(anchor, bodies) : null;
  const f = face && faceFrame(planeFrame(item.plane), face, to && anchor ? { from: anchor.at, to } : undefined);
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

/** The construction plane a sketch is on, as built before it; the captured plane with a warning when it failed or is gone. */
function sketchOnDatum<S>(design: CadDesign, inp: BuildInputs, prev: TimelineState<S>, item: DesignSketch, datum: string): TimelineState<S> {
  const captured = inp.numbers.frames[item.id];
  if (!captured || inp.numbers.errors[item.id]) return prev;
  const d = prev.datums[datum];
  const warnings = { ...prev.warnings };
  delete warnings[item.id];
  const name = itemName(design, datum);
  if (d?.kind !== 'plane') {
    warnings[item.id] = name
      ? `${name} failed (${prev.errors[datum] ?? 'it is rolled back or suppressed'}); the sketch stays where the plane was when it was made`
      : 'reference lost: the construction plane the sketch is on is gone; the sketch stays where it was when it was made';
  }
  const f = d?.kind === 'plane' ? offsetFrame(d.frame, inp.numbers.params[item.id]?.offset ?? 0) : captured;
  return { ...prev, frames: { ...prev.frames, [item.id]: f }, warnings };
}

// ------------------------------------------------------------ projected references

/**
 * A sketch's reference geometry projected again on the bodies built before it (and the
 * construction geometry so far). When it moved, the sketch is solved again with the values
 * its dimensions resolved to, and the features after it use that solution.
 */
function sketchReferences<S>(ops: SolidOps<S>, inp: BuildInputs, prev: TimelineState<S>, item: DesignSketch): TimelineState<S> {
  const f = prev.frames[item.id] ?? inp.numbers.frames[item.id];
  if (!f || inp.numbers.errors[item.id]) return prev;
  let topo: BodyTopology[] | null = null;
  const box = ops.box(prev.bodies.map((b) => b.solid));
  const size = box ? Math.max(...[0, 1, 2].map((i) => box.max[i] - box.min[i])) : 100;
  const cx: ReferenceContext = {
    get bodies() {
      return (topo ??= prev.bodies.map((b) => ops.topology(b.solid, b.id)));
    },
    edgeAt: (bi, ei, t) => ops.edgeAt(prev.bodies[bi].solid, ei, t),
    section: (fr, ids) => prev.bodies.filter((b) => !ids?.length || ids.includes(b.id)).flatMap((b) => ops.section(b.solid, fr)),
    datums: prev.datums,
    size,
  };
  const { sketch, lost } = reproject(item.sketch, f, cx);
  const warnings = { ...prev.warnings };
  delete warnings[`${item.id}:refs`];
  if (lost.length) warnings[item.id] = [warnings[item.id], ...lost].filter(Boolean).join('; ');
  let scale = 1;
  for (const p of sketch.points) scale = Math.max(scale, Math.abs(p.x), Math.abs(p.y));
  const sketches = { ...prev.sketches };
  delete sketches[item.id];
  if (sameReferences(item.sketch, sketch, 1e-9 * scale)) return { ...prev, warnings, sketches: Object.keys(prev.sketches).includes(item.id) ? sketches : prev.sketches };
  const p = inp.numbers.params[item.id] ?? {};
  const values = new Map(Object.entries(p).filter(([k]) => k.startsWith('v:')).map(([k, v]) => [k.slice(2), v]));
  const sol = sketchSolution(sketch, values, (inp.numbers.sketches[item.id] as Partial<CadResult> | undefined)?.dimErrors ?? {}, sketchSig(item.sketch));
  sketches[item.id] = { sketch, solved: { points: sol.result.points, radii: sol.result.radii }, result: sol.result };
  return { ...prev, warnings, sketches };
}

const views = new WeakMap<Record<string, RebuiltSketch>, { design: CadDesign; numbers: DesignNumbers; view: { design: CadDesign; inp: BuildInputs } }>();

/** The design and inputs with the rebuilt sketches in place of the stored ones. */
function withRebuilt(design: CadDesign, inp: BuildInputs, rebuilt: Record<string, RebuiltSketch>): { design: CadDesign; inp: BuildInputs } {
  if (!rebuilt || !Object.keys(rebuilt).length) return { design, inp };
  const hit = views.get(rebuilt);
  if (hit && hit.design === design && hit.numbers === inp.numbers) return hit.view;
  const d2: CadDesign = { ...design, components: design.components.map((c) => ({ ...c, items: c.items.map((i) => (isSketch(i) && rebuilt[i.id] ? { ...i, sketch: rebuilt[i.id].sketch } : i)) })) };
  const solved: Record<string, SolvedSketch> = {};
  for (const [id, r] of Object.entries(rebuilt)) solved[id] = r.result;
  const view = { design: d2, inp: buildInputs(d2, { ...inp.numbers, sketches: { ...inp.numbers.sketches, ...solved } }) };
  views.set(rebuilt, { design, numbers: inp.numbers, view });
  return view;
}

// ------------------------------------------------------------ picks of construction geometry, sweeps, coils and threads

/**
 * What construction geometry, sweeps, coils and threads pick, found on the bodies built
 * before them: planes, axes, points and curves of origin geometry, sketches, construction
 * items and bodies (by reference), and faces. Each throws with a message saying what is
 * gone or of the wrong kind.
 */
function picksIn<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, bodies: TimelineBody<S>[], built: Record<string, Frame>, datums: Record<string, Datum>): ConstructContext & { topo(): BodyTopology[] } {
  let topo: BodyTopology[] | null = null;
  const topoNow = () => (topo ??= bodies.map((b) => ops.topology(b.solid, b.id)));
  const entity = <K extends 'face' | 'edge' | 'vertex'>(ref: TopoRef, kind: K, what: string) => {
    const t = topoNow();
    const r = resolveRef(ref, t);
    const e = resolvedEntity(t, kind, r);
    if (!e || !r.ok) throw lostPick(design, ref, what, t.some((b) => b.named === false));
    return { e, body: r.body };
  };
  const failed = (id: string, what: string) => new Error(itemName(design, id) ? `the ${what}, ${itemName(design, id)}, failed` : `the ${what} is missing`);
  const sketchPoint = (pick: string, what: string): Vec3 => {
    const [sid, pid] = pick.split('/');
    const q = inp.numbers.sketches[sid]?.points[pid];
    if (!q) throw new Error(`the ${what} is gone: its sketch point no longer exists`);
    return framePoint(frameIn(inp, sid, built), { x: q[0], y: q[1] });
  };
  const sketchCurve = (pick: string, what: string): CurveAt => {
    const [sid, eid] = pick.split('/');
    const sk = findSketch(design, sid), sol = inp.numbers.sketches[sid];
    const e = sk?.sketch.entities.find((q) => q.id === eid);
    if (!sk || !sol || !e || e.type === 'point') throw new Error(`the ${what} is gone: its sketch curve no longer exists`);
    const f = frameIn(inp, sid, built);
    const P = (id: string) => framePoint(f, { x: sol.points[id][0], y: sol.points[id][1] });
    if (e.type === 'line') {
      const a = P(e.p1), b = P(e.p2), d = norm3(sub3(b, a));
      return { at: (t) => ({ p: add3(a, scale3(sub3(b, a), t)), d }), line: { a, b } };
    }
    if (e.type === 'spline' || e.type === 'ellipse' || e.type === 'text') {
      // the curve's own parameter (not arc length), as for edges of a body
      const seg = e.type === 'text' ? undefined : entitySegs(e, (id) => (sol.points[id] ? { x: sol.points[id][0], y: sol.points[id][1] } : undefined), (id) => sol.radii[id])[0];
      if (!seg) throw new Error(`the ${what} is not a curve that can be followed`);
      return { at: (t) => ({ p: framePoint(f, segPoint(seg, t)), d: norm3(frameDir(f, segDeriv(seg, t))) }) };
    }
    const c = sol.points[e.c];
    const r = e.type === 'circle' ? sol.radii[e.id] ?? e.r : Math.hypot(sol.points[e.p1][0] - c[0], sol.points[e.p1][1] - c[1]);
    let a0 = 0, a1 = 2 * Math.PI;
    if (e.type === 'arc') {
      a0 = Math.atan2(sol.points[e.p1][1] - c[1], sol.points[e.p1][0] - c[0]);
      a1 = Math.atan2(sol.points[e.p2][1] - c[1], sol.points[e.p2][0] - c[0]);
      while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
    }
    return {
      at: (t) => {
        const a = a0 + (a1 - a0) * t;
        return { p: framePoint(f, { x: c[0] + r * Math.cos(a), y: c[1] + r * Math.sin(a) }), d: norm3(frameDir(f, { x: -Math.sin(a), y: Math.cos(a) })) };
      },
      circle: { c: framePoint(f, { x: c[0], y: c[1] }), axis: f.n, r },
    };
  };
  // a field not filled in yet (a new construction item)
  const need = (pick: unknown, what: string) => {
    if (pick === undefined || pick === null || pick === '') throw new Error(`pick the ${what}`);
  };
  return {
    topo: topoNow,
    plane(pick, what) {
      need(pick, what);
      if (typeof pick === 'string') {
        if (pick in ORIGIN_FRAMES) return ORIGIN_FRAMES[pick as PlaneRef];
        if (!findSketch(design, pick) && !built[pick]) throw failed(pick, what);
        return frameIn(inp, pick, built);
      }
      const { e } = entity(pick as TopoRef, 'face', what);
      if (!e.frame) throw new Error(`the ${what} must be a flat face`);
      return { ...e.frame, n: norm3(e.frame.n), face: true };
    },
    axis: (pick, what) => {
      need(pick, what);
      return axisAt(ops, design, inp, bodies, built, pick as AxisPick, datums);
    },
    axisPlane(pick) {
      if (pick === 'X' || pick === 'Y') return ORIGIN_FRAMES.XY.n;
      if (pick === 'Z') return ORIGIN_FRAMES.XZ.n;
      if (typeof pick === 'string') return pick.includes('/') ? frameIn(inp, pick.split('/')[0], built).n : null;
      const ref = pick as TopoRef;
      if (ref.kind !== 'edge') return null;
      const { e, body } = entity(ref, 'edge', 'axis');
      const b = topoNow().find((q) => q.id === body)!;
      return e.faces.map((i) => b.faces[i]?.frame?.n).find((n): n is Vec3 => !!n) ?? null;
    },
    point(pick, what) {
      need(pick, what);
      if (typeof pick === 'string') {
        if (pick.includes('/')) return sketchPoint(pick, what);
        const d = datums[pick];
        if (d?.kind !== 'point') throw failed(pick, what);
        return d.p;
      }
      const ref = pick as TopoRef;
      if (ref.kind === 'vertex') return entity(ref, 'vertex', what).e.p;
      if (ref.kind === 'edge') {
        const { e } = entity(ref, 'edge', what);
        return e.circle ? e.circle.c : e.mid;
      }
      const { e } = entity(ref, 'face', what);
      return e.type === 'sphere' && e.axis ? e.axis.p : e.c;
    },
    curve(pick, what) {
      need(pick, what);
      if (typeof pick === 'string') return sketchCurve(pick, what);
      const { e, body } = entity(pick as TopoRef, 'edge', what);
      const b = bodies.find((q) => q.id === body)!;
      return { at: (t) => ops.edgeAt(b.solid, e.index, t), ...(e.line ? { line: e.line } : {}), ...(e.circle ? { circle: e.circle } : {}) };
    },
    face: (pick, what) => {
      need(pick, what);
      return entity(pick as TopoRef, 'face', what).e;
    },
  };
}

/** Points of the outline of a profile region in its frame (for the checks on a sweep). */
const outlinePoints = (r: ProfileRegion, f: Frame): Vec3[] => loopPolygon(r.outer, Math.PI / 36).map((q) => framePoint(f, q));

/** The path of a sweep as the kernel takes it: sketch curves (run from the end nearer the profile), body edges in order, or a coil's helix. */
function sweepPath<S>(design: CadDesign, inp: BuildInputs, bodies: TimelineBody<S>[], built: Record<string, Frame>, datums: Record<string, Datum>, cx: ReturnType<typeof picksIn<S>>, item: SweepFeature, near: Vec3): PathGeom<S> {
  const path = item.path;
  if (path.kind === 'sketch') {
    const sk = findSketch(design, path.sketch), sol = inp.numbers.sketches[path.sketch];
    if (!sk || !sol) throw new Error(inp.numbers.errors[path.sketch] ?? 'the path sketch is missing');
    const { segs, closed } = sketchPath(sk.sketch, sol, frameIn(inp, path.sketch, built), path.curves);
    return { kind: 'segs', segs: startNear(segs, closed, near) };
  }
  if (path.kind === 'coil') {
    const d = datums[path.coil];
    if (d?.kind !== 'helix') throw new Error(itemName(design, path.coil) ? `the coil ${itemName(design, path.coil)} failed or comes after the sweep` : 'the coil of the path is gone');
    return { kind: 'helix', helix: d.helix };
  }
  if (!path.edges.length) throw new Error('pick the edges of the path');
  const topo = cx.topo();
  if (topo.some((b) => b.named === false)) throw new Error(needsBrep('sweep'));
  const found = path.edges.map((ref) => {
    const r = resolveRef(ref, topo);
    if (!r.ok) throw lostPick(design, ref, 'path', false);
    return r;
  });
  const body = found[0].body;
  if (found.some((r) => r.body !== body)) throw new Error('the path edges must all be on one body');
  const { edges } = chainEdges(topo.find((b) => b.id === body)!, found.map((r) => r.index));
  return { kind: 'edges', body: bodies.find((b) => b.id === body)!.solid, edges };
}

/** The coil: where it stands (centre, axis and start direction from its plane) and its helix and section. */
function coilOf<S>(cx: ReturnType<typeof picksIn<S>>, item: CoilFeature, p: Record<string, number>, unit?: string) {
  const pl = cx.plane(item.plane, 'plane');
  const n = item.flip ? scale3(pl.n, -1) : pl.n;
  const c0 = item.centre !== undefined ? cx.point(item.centre, 'centre point') : pl.o;
  const c = sub3(c0, scale3(n, dot3(sub3(c0, pl.o), n)));
  return coilGeometry({ c, axis: n, x: pl.u }, p.d, p.pitch, p.revs, p.size, item.section, item.position ?? 'center', item.hand === 'left', unit);
}

/**
 * The solid of a rib: the strip its curve sweeps in the sketch plane (as thick as the rib
 * across it) less the bodies, and of that the pieces that start at the curve. To the next
 * faces, both sides of the curve are tried: the side where the bodies close the strip off
 * (both do: the shallower one; `flip` the other). A depth goes to the side whose strip
 * runs into the bodies. `on` is the body it stands on, for a join (−1: none).
 */
function ribOf<S>(ops: SolidOps<S>, f: Frame, c: RibCurve, solids: S[], p: Record<string, number>, item: RibFeature): { tool: S; on: number } {
  if (!solids.length) throw new Error('a rib stands on a body: there is none yet');
  const t = p.thickness;
  const [z0, z1] = item.side === 'one' ? [0, t] : item.side === 'other' ? [-t, 0] : [-t / 2, t / 2];
  const all = ops.group(solids);
  // how far it could reach: the bodies and the curve together
  const bb = ops.box(solids)!;
  const pts = [bb.min, bb.max, framePoint(f, c.a), framePoint(f, c.b), framePoint(f, c.mid)];
  const diag = Math.hypot(...[0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])) - Math.min(...pts.map((q) => q[k])))) + t;
  const strip = (side: 1 | -1, depth: number) => ops.extrude([ribRegion(c, side, depth)], f, z0, z1, item.id);
  const n3 = frameDir(f, c.n), a3 = framePoint(f, c.a);
  /** How far pieces reach from the curve's chord on a side (by their box: at most what it is). */
  const reachOf = (qs: S[], side: 1 | -1) => {
    const b = ops.box(qs);
    if (!b) return 0;
    let r = -Infinity;
    for (let k = 0; k < 8; k++) r = Math.max(r, side * dot3(sub3([k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]], a3), n3));
    return r;
  };
  const tiny = 1e-9 * diag * diag * t;
  /** The pieces of a strip, the bodies cut out of it, that start at the curve. */
  const piecesOf = (side: 1 | -1, depth: number) => {
    const near = strip(side, 1e-3 * diag);
    return ops.pieces(ops.cut(strip(side, depth), all)).filter((q) => ops.shared(q, near) > tiny);
  };
  let side: 1 | -1, qs: S[];
  if (p.depth) {
    const meets = ([1, -1] as const).map((sd) => ops.shared(strip(sd, p.depth), all));
    const auto = meets[1] > meets[0] ? -1 : 1;
    side = item.flip ? (-auto as 1 | -1) : auto;
    qs = piecesOf(side, p.depth);
    if (!qs.length) throw new Error('the rib’s curve lies inside the body: draw it where the rib should end');
  } else {
    const D = 3 * diag;
    const tries = ([1, -1] as const).map((sd) => {
      const got = piecesOf(sd, D);
      const reach = reachOf(got, sd);
      return { side: sd, qs: got, reach, ok: got.length > 0 && reach < 1.5 * diag };
    });
    if (!tries.some((q) => q.qs.length)) throw new Error('the rib’s curve lies inside the body: draw it where the rib should end');
    const good = tries.filter((q) => q.ok).sort((x, y) => x.reach - y.reach);
    if (!good.length) throw new Error('the rib meets no face on either side of its curve: draw the curve so the body closes the rib off (its ends on faces), or give it a depth');
    const pick = item.flip ? tries.find((q) => q.side !== good[0].side)! : good[0];
    if (!pick.ok) throw new Error('flipped, the rib meets no face on that side of its curve');
    side = pick.side;
    qs = pick.qs;
  }
  // the body it stands on: the one its strip runs into most, just past the rib
  const touch = strip(side, (p.depth ?? reachOf(qs, side)) + 1e-3 * diag);
  let on = -1, most = tiny;
  solids.forEach((b, i) => {
    const v = ops.shared(b, touch);
    if (v > most) [on, most] = [i, v];
  });
  return { tool: qs.length === 1 ? qs[0] : ops.group(qs), on };
}

// ------------------------------------------------------------ modify features

/** What a modify feature picked, found again on the bodies of the step it runs at. */
interface Found {
  topo: BodyTopology;
  picks: { ref: TopoRef; index: number; set: number }[];
}

/**
 * The faces or edges a modify feature picked, found again by their references
 * (topology.ts) on the bodies built before it, by body. Picks that are gone are reported:
 * an error when none is left, else a warning (the feature goes on with the others).
 */
function findPicks<S>(ops: SolidOps<S>, design: CadDesign, bodies: TimelineBody<S>[], refs: { ref: TopoRef; set: number }[], goesOn: string, warn: (w: string) => void): Map<string, Found> {
  const topo = bodies.map((b) => ops.topology(b.solid, b.id));
  const on = new Map<string, Found>();
  const lost: TopoRef[] = [];
  for (const r of refs) {
    const res = resolveRef(r.ref, topo);
    if (!res.ok) {
      lost.push(r.ref);
      continue;
    }
    const g = on.get(res.body) ?? { topo: topo.find((b) => b.id === res.body)!, picks: [] };
    // two picks that found the same entity (an edge a cut merged with another) count once
    if (!g.picks.some((q) => q.index === res.index)) g.picks.push({ ...r, index: res.index });
    on.set(res.body, g);
  }
  if (lost.length) {
    const words = `${refWords(lost[0], (id) => itemName(design, id))}${lost.length > 1 ? ` and ${lost.length - 1} more` : ''} ${lost.length > 1 ? 'are' : 'is'} gone`;
    if (!on.size) throw new Error(`reference lost: ${words}`);
    warn(`reference lost: ${words}; ${goesOn}`);
  }
  return on;
}

/** A body's topology entity a reference names, on the bodies as built now (null when lost). */
function pickedEntity<S, K extends 'face' | 'edge'>(ops: SolidOps<S>, bodies: TimelineBody<S>[], ref: TopoRef, kind: K) {
  const topo = bodies.map((b) => ops.topology(b.solid, b.id));
  return { entity: resolvedEntity(topo, kind, resolveRef(ref, topo)), mesh: topo.some((b) => b.named === false) };
}

const lostPick = (design: CadDesign, ref: TopoRef, what: string, mesh: boolean) => new Error(mesh
  ? `the mesh kernel cannot follow ${refWords(ref, (id) => itemName(design, id))} (the ${what}) until OpenCascade has loaded`
  : `reference lost: ${refWords(ref, (id) => itemName(design, id))}, the ${what}, is gone`);

/** A plane a feature picked (origin plane, sketch plane or flat face), in component coordinates. */
function planeAt<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, bodies: TimelineBody<S>[], built: Record<string, Frame>, pick: PlanePick, what: string): PlaneAt {
  if (typeof pick === 'string') {
    const f = pick in ORIGIN_FRAMES ? ORIGIN_FRAMES[pick as PlaneRef] : frameIn(inp, pick, built);
    return { o: f.o, n: f.n };
  }
  const { entity: face, mesh } = pickedEntity(ops, bodies, pick, 'face');
  if (!face) throw lostPick(design, pick, what, mesh);
  if (!face.frame) throw new Error(`the ${what} must be a flat face`);
  return { o: face.frame.o, n: norm3(face.frame.n) };
}

/** An axis a feature picked (origin axis, sketch line, straight edge, circle or round face), in component coordinates. */
function axisAt<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, bodies: TimelineBody<S>[], built: Record<string, Frame>, pick: AxisPick, datums?: Record<string, Datum>): { p: Vec3; d: Vec3 } {
  if (typeof pick === 'string') return axisOf(design, inp, pick, built, datums);
  const kind = pick.kind === 'face' ? 'face' : 'edge';
  const { entity: e, mesh } = pickedEntity(ops, bodies, pick, kind);
  if (!e) throw lostPick(design, pick, 'axis', mesh);
  if ('area' in e) {
    if (e.axis && e.type !== 'sphere') return { p: e.axis.p, d: norm3(e.axis.d) };
    if (e.frame) return { p: e.frame.o, d: norm3(e.frame.n) };
  } else {
    if (e.line) return { p: e.line.a, d: norm3(sub3(e.line.b, e.line.a)) };
    if (e.circle) return { p: e.circle.c, d: norm3(e.circle.axis) };
  }
  throw new Error('the axis must be a straight edge, a circle, a cylinder or a flat face');
}

/**
 * Fillet, chamfer, shell, draft and press-pull: what they picked found on the bodies, and
 * each body they are on made anew by the kernel. A rounding that does not fit says which
 * edge and about how large it may be.
 */
function modifyBodies<S>(ops: SolidOps<S>, design: CadDesign, inp: BuildInputs, bodies: TimelineBody<S>[], built: Record<string, Frame>, datums: Record<string, Datum>, item: FilletFeature | ChamferFeature | ShellFeature | DraftFeature | PressPullFeature, p: Record<string, number>, warn: (w: string) => void): [TimelineBody<S>, S][] {
  const unit = inp.numbers.unit;
  const named = (id: string) => itemName(design, id);
  const topo = bodies.map((b) => ops.topology(b.solid, b.id));
  if (topo.some((b) => b.named === false)) throw new Error(needsBrep(item.kind));
  const bodyOf = (id: string) => bodies.find((b) => b.id === id)!;
  const out: [TimelineBody<S>, S][] = [];
  if (item.kind === 'shell' && !item.faces.length) {
    const b = bodies.find((q) => q.id === item.body);
    if (!b) throw new Error(item.body ? 'the body to hollow no longer exists' : 'pick the faces to open (or a body to hollow out)');
    return [[b, shellOf(ops, b.solid, topo[bodies.indexOf(b)], [], p.t, item, unit)]];
  }
  const refs = item.kind === 'fillet' ? item.sets.flatMap((s, set) => s.edges.map((ref) => ({ ref, set }))) : (item.kind === 'chamfer' ? item.edges : item.faces).map((ref) => ({ ref, set: 0 }));
  const what = item.kind === 'fillet' || item.kind === 'chamfer' ? 'edges' : 'faces';
  if (!refs.length) throw new Error(`pick the ${what} to ${item.kind === 'fillet' ? 'round' : item.kind === 'chamfer' ? 'chamfer' : item.kind === 'shell' ? 'open' : item.kind === 'draft' ? 'draft' : 'move'}`);
  const still = { fillet: 'rounded', chamfer: 'chamfered', shell: 'open', draft: 'drafted', presspull: 'moved' }[item.kind];
  const on = findPicks(ops, design, bodies, refs, `the other ${what} are still ${still}`, warn);
  const plane = item.kind === 'draft' ? planeAt(ops, design, inp, bodies, built, item.plane, 'neutral plane') : null;
  let pull = item.kind === 'draft' ? (item.pull ? axisAt(ops, design, inp, bodies, built, item.pull, datums).d : plane!.n) : null;
  if (item.kind === 'draft' && item.flip) pull = scale3(pull!, -1);
  for (const [id, g] of on) {
    const b = bodyOf(id);
    const pick = (q: Found['picks'][number]): ModifyPick => ({ index: q.index, name: refToken(q.ref) });
    if (item.kind === 'fillet') {
      const sets = item.sets.map((_, i) => ({ r: p[`r${i}`], r2: p[`re${i}`], picks: g.picks.filter((q) => q.set === i).map(pick) })).filter((s) => s.picks.length);
      try {
        out.push([b, ops.fillet(b.solid, sets, item.chain !== false, item.id)]);
      } catch (e) {
        if (!/does not fit/.test(msg(e))) throw e;
        // the edge whose faces are too narrow for its radius, and about what fits
        for (const s of sets) for (const q of s.picks) {
          const lim = filletLimit(g.topo, q.index), r = Math.max(s.r, s.r2 ?? 0);
          if (lim !== null && r >= lim * (1 - 1e-6)) {
            throw new Error(`radius ${sizeWords(r, unit)} is too large for ${edgeWords(g.topo.edges[q.index].key, named)} (max ≈ ${sizeWords(lim, unit)})`);
          }
        }
        throw new Error(`the fillet does not fit: ${sets.length > 1 || sets[0].picks.length > 1 ? 'the roundings meet each other or the faces are too narrow' : 'the faces at the edge are too narrow'} — try a smaller radius`);
      }
    } else if (item.kind === 'chamfer') {
      const picks = g.picks.map((q) => ({ ...pick(q), face: chamferFace(g.topo, q.index, item.flip) }));
      const o: ChamferOptions = { type: item.type, d: p.d, d2: p.d2, angle: p.angle };
      try {
        out.push([b, ops.chamfer(b.solid, picks, o, item.chain !== false, item.id)]);
      } catch (e) {
        if (!/does not fit/.test(msg(e))) throw e;
        const other = item.type === 'two' ? p.d2 : item.type === 'angle' ? p.d * Math.tan(p.angle) : p.d;
        for (const q of picks) {
          const lim = chamferLimit(g.topo, q.index, q.face);
          if (!lim) continue;
          const [d, max] = p.d >= lim.own * (1 - 1e-6) ? [p.d, lim.own] : other >= lim.other * (1 - 1e-6) ? [other, lim.other] : [0, 0];
          if (d) throw new Error(`${item.type === 'equal' ? 'distance' : 'a chamfer distance of'} ${sizeWords(d, unit)} is too large for ${edgeWords(g.topo.edges[q.index].key, named)} (max ≈ ${sizeWords(max, unit)})`);
        }
        throw new Error('the chamfer does not fit: the faces at the edges are too narrow — try a smaller distance');
      }
    } else if (item.kind === 'shell') {
      out.push([b, shellOf(ops, b.solid, g.topo, g.picks.map((q) => q.index), p.t, item, unit)]);
    } else if (item.kind === 'draft') {
      out.push([b, ops.draft(b.solid, g.picks.map((q) => q.index), pull!, p.angle, plane!, item.id)]);
    } else {
      out.push([b, ops.pressPull(b.solid, g.picks.map((q) => q.index), p.d, item.id)]);
    }
  }
  return out;
}

function shellOf<S>(ops: SolidOps<S>, s: S, topo: BodyTopology, faces: number[], t: number, item: ShellFeature, unit?: string): S {
  try {
    return ops.shell(s, faces, t, item.side === 'outside', item.id);
  } catch (e) {
    if (!/does not fit/.test(msg(e))) throw e;
    // the offset of a rounding as thick as the wall shrinks to an edge, which OpenCascade cannot make
    const radius = (f: FaceInfo) => (f.type === 'torus' ? f.minorRadius : f.type === 'cylinder' || f.type === 'sphere' ? f.radius : undefined);
    const round = topo.faces.some((f) => Math.abs((radius(f) ?? Infinity) - t) <= 1e-6 * t);
    if (round && item.side === 'inside') throw new Error(`a wall of ${sizeWords(t, unit)} as thick as the radius of a rounding cannot be made — make it a little thinner or thicker`);
    throw new Error(`a wall of ${sizeWords(t, unit)} does not fit this body — try a thinner one`);
  }
}

/**
 * Run one item of a component's timeline with a solid kernel: the meaning of every
 * feature (extents, automatic cut sides, targets, patterns, booleans) lives here, so the
 * mesh and the B-rep kernel build the same design. A failing feature records its error.
 */
export function timelineStep<S>(ops: SolidOps<S>, design0: CadDesign, inp0: BuildInputs, prev: TimelineState<S>, item: DesignItem): TimelineState<S> {
  if (item.kind === 'sketch') {
    if (item.suppressed) return prev;
    const datum = 'frame' in item.plane ? item.plane.datum : undefined;
    const face = sketchFace(item);
    const placed = datum ? sketchOnDatum(design0, inp0, prev, item, datum) : face ? sketchOnFace(ops, design0, inp0, prev, item, face) : prev;
    return item.sketch.sources?.length ? sketchReferences(ops, inp0, placed, item) : placed;
  }
  if (item.suppressed) return prev;
  // the features see the sketches as the timeline rebuilt them
  const { design, inp } = withRebuilt(design0, inp0, prev.sketches);
  // copy on write: bodies change their solid in place below
  const bodies = prev.bodies.map((b) => ({ ...b }));
  const tools = new Map(prev.tools);
  const errors = { ...prev.errors };
  const warnings = { ...prev.warnings };
  const made = [...prev.made];
  // old cached states (made before threads were kept) have none
  let threads = prev.threads ?? [];
  const built = prev.frames;
  // construction items and coils add planes and datums
  let frames = prev.frames, datums = prev.datums;
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
        const drilled = targetsOf(item.targets), tgt = drilled.map((b) => b.solid);
        if (!tgt.length) throw new Error('there is no body to drill');
        const depth = item.through ? reach(ops, f, tgt) * 2 : p.depth;
        const dir = item.dir ?? 'auto';
        const opts: HoleOptions = { d: p.d, depth, style: item.style, cbD: p.cbD, cbDepth: p.cbDepth, csD: p.csD, csAngle: p.csAngle };
        const make = (sg: number) => ops.hole(centres.map(([x, y]) => framePoint(f, { x, y })), scale3(f.n, sg), opts, item.id);
        const sg = dir === '+' ? 1 : dir === '-' ? -1 : bestSide(ops, make, tgt);
        let tool = make(sg);
        if (item.tap && !item.tap.modeled) {
          // a cosmetic thread at every hole of every body drilled (the drawing keeps the ones
          // on a hole), as deep as the thread (the whole hole when through); on its body, so
          // that it moves and is copied with it
          const size = threadIn(parseThread(item.tap.size), inp.numbers.unit);
          const z1 = p.tdepth ?? (item.through ? undefined : depth);
          threads = [...threads, ...drilled.flatMap((b) => centres.map(([x, y]): ThreadMark => ({
            feature: item.id, body: b.id, o: framePoint(f, { x, y }), axis: scale3(f.n, sg), R: p.d / 2, z0: 0, z1,
            length: item.through ? undefined : depth, d: size.d, d1: size.d1, internal: true, name: size.name,
          })))];
        }
        if (item.tap?.modeled) {
          // the thread's groove cut with the drill, from outside the hole's mouth
          const size = threadIn(parseThread(item.tap.size), inp.numbers.unit);
          const grooves: S[] = [];
          try {
            centres.forEach(([x, y], i) => {
              const tf = { o: framePoint(f, { x, y }), axis: scale3(f.n, sg), radius: p.d / 2, length: depth, internal: true, openStart: true, openEnd: !!item.through };
              grooves.push(ops.thread(threadGeometry(size, tf, { length: p.tdepth }, inp.numbers.unit), `${item.id}/hole${i}:thread`));
            });
            tool = ops.group([tool, ...grooves]);
          } catch (e) {
            if (!/needs the B-rep kernel/.test(msg(e))) throw e;
            warnings[item.id] = 'the thread is modeled once OpenCascade has loaded: until then the hole is drilled to its tap drill';
          }
        }
        const rec: TimelineTool<S> = { tool, op: 'cut', targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'pattern':
      case 'mirror': {
        const Ms = copyMatrices(design, inp, item, built, prev.datums);
        if (!item.refs.length) throw new Error(`pick the ${item.of} to ${item.kind}`);
        if (item.of === 'features') {
          for (const ref of item.refs) {
            const src = tools.get(ref);
            if (!src) throw new Error('a patterned feature failed or no longer exists');
            const copies = Ms.map((M, k) => ops.transform(src.tool, M, `${item.id}.${k + 1}.`));
            const marks = threads.filter((m) => m.feature === ref || m.feature.startsWith(`${ref}.`));
            threads = [...threads, ...Ms.flatMap((M, k) => marks.map((m) => movedMark(m, M, `${item.id}.${k + 1}.${m.feature}`)))];
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
            const marks = threads.filter((m) => m.body === ref);
            threads = [...threads, ...Ms.flatMap((M, k) => marks.map((m) => movedMark(m, M, `${item.id}.${k + 1}.${m.feature}`, item.join ? ref : `${item.id}.${k + 1}.${ref}`)))];
            if (item.join) b.solid = ops.union([b.solid, ...copies]);
            else copies.forEach((s, k) => created(`${item.id}.${k + 1}.${ref}`, item.id, s));
          }
        }
        break;
      }
      case 'plane':
      case 'axis':
      case 'point': {
        const d = datumOf(item, p, picksIn(ops, design, inp, bodies, built, datums));
        datums = { ...datums, [item.id]: d };
        if (d.kind === 'plane') frames = { ...frames, [item.id]: d.frame };
        break;
      }
      case 'sweep': {
        const f = frameOf(item.sketch);
        const region = selectedProfiles(inp, item.sketch, item.profile ? [item.profile] : undefined)[0];
        if (p.twist && Math.abs((p.scale ?? 1) - 1) > 1e-12) throw new Error('a sweep cannot twist and taper at once: use one or the other');
        const cx = picksIn(ops, design, inp, bodies, built, datums);
        const pts = outlinePoints(region, f);
        const centre = scale3(pts.reduce((a, q) => add3(a, q), [0, 0, 0] as Vec3), 1 / pts.length);
        const path = sweepPath(design, inp, bodies, built, datums, cx, item, centre);
        const o: SweepOptions = { orientation: item.orientation ?? 'perpendicular', twist: p.twist ?? 0, scale: p.scale ?? 1, unit: inp.numbers.unit };
        const rec = { tool: ops.sweep(region, f, path, o, item.id), op: item.op, targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'rib': {
        const f = frameOf(item.sketch);
        const sk = findSketch(design, item.sketch)!;
        const c = ribCurve(sk.sketch, inp.numbers.sketches[item.sketch], item.curves);
        const { tool, on } = ribOf(ops, f, c, bodies.map((b) => b.solid), p, item);
        if (item.op === 'join' && !item.targets?.length && on < 0) throw new Error('the rib does not reach a body: give it a depth that does, or make it a new body');
        const rec: TimelineTool<S> = { tool, op: item.op, targets: item.targets?.length ? item.targets : on >= 0 ? [bodies[on].id] : undefined };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'coil': {
        const g = coilOf(picksIn(ops, design, inp, bodies, built, datums), item, p, inp.numbers.unit);
        // the helix is there for sweeps even when the coil makes no body
        datums = { ...datums, [item.id]: { kind: 'helix', helix: g.helix } };
        if (item.pathOnly) break;
        let tool: S;
        try {
          tool = ops.sweep(g.region, g.frame, { kind: 'helix', helix: g.helix }, { orientation: 'axis', axis: g.helix.axis, twist: 0, scale: 1 }, item.id);
        } catch (e) {
          throw /needs the B-rep kernel/.test(msg(e)) ? new Error(needsBrep('coil')) : e;
        }
        const rec = { tool, op: item.op, targets: item.targets };
        tools.set(item.id, rec);
        apply(item.id, rec);
        break;
      }
      case 'thread': {
        const size = threadIn(parseThread(item.size), inp.numbers.unit);
        if (!item.faces.length) throw new Error('pick the cylindrical faces to thread');
        const topo = bodies.map((b) => ops.topology(b.solid, b.id));
        if (topo.some((b) => b.named === false)) throw new Error(needsBrep('thread'));
        const on = findPicks(ops, design, bodies, item.faces.map((ref) => ({ ref, set: 0 })), 'the other faces are still threaded', (w) => (warnings[item.id] = w));
        let k = 0;
        for (const [id, g] of on) {
          const grooves: S[] = [];
          for (const q of g.picks) {
            // cosmetic threads change nothing, but the face must take the size
            const tf = threadFace(g.topo, g.topo.faces[q.index], item.flip);
            const geom = threadGeometry(size, tf, { length: p.length, offset: p.offset, left: item.hand === 'left' }, inp.numbers.unit);
            if (item.modeled) grooves.push(ops.thread(geom, `${item.id}/thread${k++}`));
            else {
              const z0 = p.offset ?? 0;
              threads = [...threads, {
                feature: item.id, body: id, o: tf.o, axis: tf.axis, R: tf.radius, z0, z1: Math.min(tf.length, p.length === undefined ? tf.length : z0 + p.length),
                length: tf.length, d: size.d, d1: tf.internal ? size.d1 : size.d3, internal: tf.internal, name: size.name,
              }];
            }
          }
          if (!grooves.length) continue;
          const b = bodies.find((x) => x.id === id)!;
          b.solid = ops.cut(b.solid, ops.group(grooves));
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
        // the threads of tools joined into the target are on it now
        if (item.op === 'join' && !item.keepTools) threads = threads.map((m) => (ts.some((b) => b.id === m.body) ? { ...m, body: t.id } : m));
        break;
      }
      case 'fillet':
      case 'chamfer':
      case 'shell':
      case 'draft':
      case 'presspull': {
        // every body changes or none does
        const next = modifyBodies(ops, design, inp, bodies, built, prev.datums, item, p, (w) => (warnings[item.id] = w));
        for (const [b, solid] of next) b.solid = solid;
        break;
      }
      case 'split': {
        const b = bodies.find((q) => q.id === item.body);
        if (!b) throw new Error(item.body ? 'the body to split no longer exists' : 'pick the body to split');
        const pl = planeAt(ops, design, inp, bodies, built, item.plane, 'splitting plane');
        const pieces = ops.split(b.solid, { o: add3(pl.o, scale3(pl.n, p.offset ?? 0)), n: pl.n }, item.id);
        if (pieces.length < 2) throw new Error('the plane does not cross the body');
        // the piece behind the plane stays the body; the others are new bodies after it
        b.solid = pieces[0];
        pieces.slice(1).forEach((solid, k) => created(`${item.id}.${k + 1}.${b.id}`, item.id, solid));
        // every piece takes the body's cosmetic threads (a drawing keeps them where their face is)
        const marks = threads.filter((m) => m.body === b.id);
        threads = [...threads, ...pieces.slice(1).flatMap((_, k) => marks.map((m) => ({ ...m, body: `${item.id}.${k + 1}.${b.id}` })))];
        break;
      }
      case 'move': {
        if (!item.bodies.length) throw new Error('pick the bodies to move');
        let M = m4Translate([p.dx ?? 0, p.dy ?? 0, p.dz ?? 0]);
        if (item.axis && p.angle) {
          const a = axisAt(ops, design, inp, bodies, built, item.axis, prev.datums);
          M = m4Mul(M, m4Rotate(a.p, a.d, p.angle));
        }
        const moving = item.bodies.map((id) => bodies.find((q) => q.id === id));
        if (moving.some((b) => !b)) throw new Error('a body to move no longer exists');
        for (const b of moving as TimelineBody<S>[]) {
          // a moved body keeps the names of its faces; a copy's carry a prefix, as a pattern's do
          if (item.copy) created(`${item.id}.1.${b.id}`, item.id, ops.transform(b.solid, M, `${item.id}.1.`));
          else b.solid = ops.transform(b.solid, M, '');
          // the body's cosmetic threads go with it (a copy's are copied)
          const marks = threads.filter((m) => m.body === b.id).map((m) => movedMark(m, M, item.copy ? `${item.id}.1.${m.feature}` : m.feature, item.copy ? `${item.id}.1.${b.id}` : b.id));
          threads = item.copy ? [...threads, ...marks] : [...threads.filter((m) => m.body !== b.id), ...marks];
        }
        break;
      }
    }
  } catch (e) {
    errors[item.id] = msg(e);
  }
  return { ...prev, bodies, tools, errors, warnings, made, frames, datums, threads };
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
  return { bodies: namedBodies(comp, st), errors: st.errors, warnings: st.warnings, frames: st.frames, datums: st.datums, tools: st.tools, sketches: st.sketches, threads: st.threads };
}

/** Build the bodies of one component with the mesh kernel. Every Manifold made goes into the arena. */
export function buildComponent(K: ManifoldToplevel, arena: Arena, design: CadDesign, comp: CadComponent, inp: BuildInputs): ComponentBuild {
  const t = runTimeline(meshOps(K, arena), design, comp, inp);
  return {
    bodies: t.bodies.map((b) => ({ id: b.id, name: b.name, feature: b.feature, solid: b.solid.m, exact: b.solid.exact })),
    errors: t.errors, warnings: t.warnings, frames: t.frames, datums: t.datums, sketches: t.sketches,
    tools: new Map([...t.tools].map(([id, r]) => [id, { tool: r.tool.m, exact: r.tool.exact, op: r.op, targets: r.targets }])),
  };
}

/**
 * Bodies with exact properties, without the kernel: possible while every feature of the
 * component makes a new body by extrude or revolve, and no sketch has to find its face
 * on a body first. Null otherwise.
 */
export function exactComponent(design: CadDesign, comp: CadComponent, inp: BuildInputs): { bodies: { id: string; name: string; feature: string; mass: Mass3 }[]; errors: Record<string, string> } | null {
  if (activeItems(comp).some((i) => isSketch(i) && (sketchFace(i) || ('frame' in i.plane && i.plane.datum)))) return null;
  // construction geometry makes no body
  const all = activeItems(comp).filter((i): i is DesignFeature => i.kind !== 'sketch' && !isConstruct(i) && !i.suppressed);
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
  /** Construction geometry of a component as built. */
  datums?(componentId: string): Record<string, Datum>;
}

/** Joint origin as a frame matrix in its component; `lost` says why a snap point stays where it was picked. */
export function jointFrame(numbers: DesignNumbers, o: JointOrigin, bodies?: BodyTopology[], frames?: Record<string, Frame>, lost?: (why: string) => void, datums?: Record<string, Datum>): M4 {
  if (o.kind === 'origin') return IDENTITY;
  if (o.kind === 'datum') {
    const d = datums?.[o.id];
    if (!datums) throw new Error('the joint is on construction geometry, which the 3-D kernel builds: it has not loaded');
    if (!d || d.kind === 'helix') throw new Error('the construction geometry of the joint failed or is gone');
    if (d.kind === 'plane') return m4Frame(d.frame.o, d.frame.u, d.frame.v, d.frame.n);
    const z = d.kind === 'axis' ? norm3(d.d) : [0, 0, 1] as Vec3;
    const x = frameFromNormal(d.p, z).u;
    return m4Frame(d.p, x, cross3(z, x), z);
  }
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

export interface Placement {
  matrix: M4;
  by: 'ground' | 'joint' | 'free';
}

/**
 * Place the occurrences: grounded ones (or the first, if none is) stay where they are,
 * joints then carry their neighbours along the joint tree, and the DOFs set to be solved
 * close the loops the joints make (kinematics.ts). Loops that disagree are reported.
 */
export function placeOccurrences(design: CadDesign, numbers: DesignNumbers, geo?: PlacementGeometry): { placements: Record<string, Placement>; errors: Record<string, string>; warnings: Record<string, string>; kin: KinState } {
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
  const live = design.joints.filter((j) => !j.suppressed);
  const frames = new Map<string, { Fa: M4; Fb: M4 }>();
  for (const j of live) {
    try {
      if (!occ.some((o) => o.id === j.a.occ) || !occ.some((o) => o.id === j.b.occ)) throw new Error('a jointed occurrence no longer exists');
      if (j.a.occ === j.b.occ) throw new Error('a joint needs two different occurrences');
      if (numbers.errors[j.id]) throw new Error(numbers.errors[j.id]);
      const lost = (why: string) => (warnings[j.id] ??= why);
      const datumsOf = (occ: string) => geo?.datums?.(compOf(occ));
      frames.set(j.id, {
        Fa: jointFrame(numbers, j.a.origin, bodiesOf(j.a.occ), geo?.frames, lost, datumsOf(j.a.occ)),
        Fb: jointFrame(numbers, j.b.origin, bodiesOf(j.b.occ), geo?.frames, lost, datumsOf(j.b.occ)),
      });
    } catch (e) {
      errors[j.id] = msg(e);
    }
  }
  const model = kinModel(design, numbers, frames, errors);
  const sol = solveKinematics(model);
  for (const [id, e] of Object.entries(sol.errors)) errors[id] ??= e;
  for (const [id, w] of Object.entries(sol.warnings)) warnings[id] ??= w;
  return { placements: sol.placements, errors, warnings, kin: { model, values: sol.values, parent: sol.parent, mobility: sol.mobility } };
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
  kin?: KinState;
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
      components.set(c.id, { bodies: [], errors: { [c.id]: msg(e) }, warnings: {}, frames: {}, datums: {}, tools: new Map(), sketches: {} });
    }
  }
  const { placements, errors, warnings, kin } = placeOccurrences(design, numbers, {
    frames: Object.assign({}, ...[...components.values()].map((cb) => cb.frames)),
    bodies: (cid) => (components.get(cid)?.bodies ?? []).map((b) => meshTopology(b.solid, b.id)),
    datums: (cid) => components.get(cid)?.datums ?? {},
  });
  return { arena, components, placements, errors, warnings, kin, free: () => arena.free() };
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
