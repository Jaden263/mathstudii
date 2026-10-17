// Parametric CAD document model: a constrained 2-D sketch plus an optional 3-D
// feature (extrude or revolve). Plain JSON, like the rest of the worksheet.
//
// Geometry is stored as points shared between entities (a polyline's corners are
// one point each), so "connected" is topology, not a tolerance. Point positions
// are the last solved state; the solver moves them to satisfy the constraints.
import type { TopoRef } from './topology';

export type CadUnit = 'mm' | 'cm' | 'm' | 'in';

export interface CadPoint {
  id: string;
  x: number;
  y: number;
}

interface EntityBase {
  id: string;
  /** Construction geometry guides constraints but is not part of the profile. */
  construction?: boolean;
  /**
   * Reference geometry projected from the model (the id of its source in `sources`): fixed
   * in place, rebuilt with the model and drawn as a reference.
   */
  ref?: string;
}

export interface CadLine extends EntityBase {
  type: 'line';
  p1: string;
  p2: string;
}

export interface CadCircle extends EntityBase {
  type: 'circle';
  c: string;
  r: number;
}

/** Counter-clockwise arc from p1 to p2 around c; |c p1| = |c p2| is implied. */
export interface CadArc extends EntityBase {
  type: 'arc';
  c: string;
  p1: string;
  p2: string;
}

/** A free point (sketch point, not part of a profile). */
export interface CadPointEntity extends EntityBase {
  type: 'point';
  p: string;
}

/**
 * A cubic spline. 'fit' (default): through its points in order, parameterised by chord
 * length, its ends natural (no curvature there) unless a tangent handle sets the end's
 * direction and speed; 'control': its points are the poles of a clamped uniform B-spline.
 */
export interface CadSpline extends EntityBase {
  type: 'spline';
  pts: string[];
  mode?: 'fit' | 'control';
  closed?: boolean;
  /** Fit splines: tangent handles at the start and the end (the second and last-but-one pole). */
  h1?: string;
  h2?: string;
  /** Control splines: a clamped knot vector of their own (a piece of a split one); uniform when missing. */
  knots?: number[];
}

/**
 * An ellipse about c with one semi-axis from c to the point `a` (the major axis as drawn)
 * and the other, across it, of length r; an elliptical arc counter-clockwise from p1 to
 * p2 when both are set.
 */
export interface CadEllipse extends EntityBase {
  type: 'ellipse';
  c: string;
  a: string;
  r: number;
  p1?: string;
  p2?: string;
}

/** Single-line text: the baseline starts at p and runs at `angle` degrees; size is the font size (sketch units). */
export interface CadText extends EntityBase {
  type: 'text';
  p: string;
  text: string;
  size: number;
  angle?: number;
}

export type CadEntity = CadLine | CadCircle | CadArc | CadPointEntity | CadSpline | CadEllipse | CadText;

export type GeometricConstraint =
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal'
  | 'fix' | 'pointOnLine' | 'pointOnCircle' | 'tangent' | 'midpoint' | 'symmetric' | 'concentric'
  | 'collinear' | 'pointOnCurve' | 'curvature';

export type DimensionConstraint =
  | 'distance' | 'distanceX' | 'distanceY' | 'length' | 'angle' | 'radius' | 'diameter'
  | 'majorRadius' | 'minorRadius' | 'offset' | 'pattern';

export type ConstraintType = GeometricConstraint | DimensionConstraint;

export interface CadConstraint {
  id: string;
  type: ConstraintType;
  /**
   * Referenced point / entity ids, by type:
   *   coincident [p, q] · horizontal/vertical [line] or [p, q] · parallel/perpendicular/equal [e1, e2]
   *   fix [p] · pointOnLine [p, line] · pointOnCircle [p, circle|arc] · tangent [e1, e2]
   *   midpoint [p, line] · symmetric [p, q, line] · concentric [e1, e2] (circles / arcs)
   *   distance [p, q] or [p, line] · distanceX/Y [p, q] · length [line] · angle [l1, l2] or [line]
   *   radius/diameter [circle|arc] · majorRadius/minorRadius [ellipse]
   *   collinear [l1, l2] · pointOnCurve [p, ellipse|spline] · curvature [spline, other] (equal curvature, G2)
   *   tangent and curvature with a spline: `ends` says which end of each spline
   *   offset [src₁, dst₁, src₂, dst₂ …]: each dst the offset of its src by the value, to `sides`
   *   pattern: the source points, then every copy's points in the same order (`pattern`)
   */
  refs: string[];
  /** Dimensions: worksheet expression ("50", "b/2", "30 deg"). Bare numbers are sketch units / degrees. */
  value?: string;
  /** Dimensions: false = reference (measured, not driving). */
  driving?: boolean;
  /** Dimensions: worksheet name of the value exported on the part (part.d1). */
  name?: string;
  /** Dimension text offset from its default position, in sketch units. */
  offset?: { x: number; y: number };
  /** fix: the held position. tangent between circles: 'int' when one is inside the other. */
  at?: { x: number; y: number };
  mode?: 'ext' | 'int';
  /** tangent / curvature: for each ref that is a spline, the end it applies at (0 start, 1 end). */
  ends?: number[];
  /** offset: per pair, +1 when the copy lies to the left of its source (lines: of p1 → p2; arcs and circles: outside). */
  sides?: number[];
  /**
   * pattern: copies of `n` source points, `count` in all (the original counts), moved by
   * k·value along the sketch x axis (y with `dir: 'y'`) or a line `along` (rect), or turned
   * about the point `about` (circ: value is the total angle; 360° spreads them evenly).
   * Patterns made together share a `group` (both directions of a rectangular one).
   */
  pattern?: {
    kind: 'rect' | 'circ'; n: number; count: number; dir?: 'x' | 'y'; along?: string; about?: string; group?: string;
    /** The entities patterned and the copies made (to make them again for another count). */
    of?: string[]; made?: string[];
  };
}

/**
 * Where reference geometry comes from: body edges or a face's outer loop (by reference,
 * so they follow edits), a construction point or axis, or the section of the bodies with
 * the sketch plane. The timeline projects them onto the plane each time it builds.
 */
export type SketchSource =
  | { id: string; kind: 'edge' | 'face'; ref: TopoRef; label?: string }
  | { id: string; kind: 'datum'; datum: string; label?: string }
  | { id: string; kind: 'section'; bodies?: string[]; label?: string };

export interface CadSketch {
  points: CadPoint[];
  entities: CadEntity[];
  constraints: CadConstraint[];
  /** Sources of the projected reference geometry. */
  sources?: SketchSource[];
}

export type CadFeature =
  | { type: 'none' }
  | { type: 'extrude'; depth: string; symmetric?: boolean }
  /** axis: a line entity id, or the sketch's own 'x' / 'y' axis. angle: worksheet expression (deg if bare). */
  | { type: 'revolve'; axis: string; angle: string };

export interface CadView {
  /** World point at the region centre, sketch units. */
  cx: number;
  cy: number;
  /** Pixels per sketch unit. */
  zoom: number;
}

export interface CadView3D {
  yaw: number;
  pitch: number;
}

export const CAD_UNITS: CadUnit[] = ['mm', 'cm', 'm', 'in'];

/** Common materials, kg/m³. */
export const MATERIALS: { name: string; density: string }[] = [
  { name: 'Steel', density: '7850 kg/m^3' },
  { name: 'Stainless steel', density: '8000 kg/m^3' },
  { name: 'Aluminium', density: '2700 kg/m^3' },
  { name: 'Cast iron', density: '7200 kg/m^3' },
  { name: 'Copper', density: '8960 kg/m^3' },
  { name: 'Titanium', density: '4500 kg/m^3' },
  { name: 'Concrete', density: '2400 kg/m^3' },
  { name: 'Timber (softwood)', density: '500 kg/m^3' },
  { name: 'PLA', density: '1240 kg/m^3' },
  { name: 'ABS', density: '1050 kg/m^3' },
];

export const isDimension = (t: ConstraintType): t is DimensionConstraint =>
  t === 'distance' || t === 'distanceX' || t === 'distanceY' || t === 'length' || t === 'angle' || t === 'radius' || t === 'diameter'
  || t === 'majorRadius' || t === 'minorRadius' || t === 'offset' || t === 'pattern';

/** Dimensions measured in degrees: angles, and the total angle of a circular pattern. */
export const isAngleDim = (c: CadConstraint) => c.type === 'angle' || (c.type === 'pattern' && c.pattern?.kind === 'circ');

export function emptySketch(): CadSketch {
  return { points: [], entities: [], constraints: [] };
}

let n = 0;
/** Short ids, unique within a sketch (prefix tells the kind when debugging). */
export function cadId(prefix: string): string {
  n = (n + 1) % 1e6;
  return prefix + Date.now().toString(36).slice(-4) + n.toString(36) + Math.random().toString(36).slice(2, 5);
}

export function pointMap(s: CadSketch): Map<string, CadPoint> {
  return new Map(s.points.map((p) => [p.id, p]));
}

export function entityMap(s: CadSketch): Map<string, CadEntity> {
  return new Map(s.entities.map((e) => [e.id, e]));
}

/** Point ids an entity uses. */
export function entityPoints(e: CadEntity): string[] {
  switch (e.type) {
    case 'line': return [e.p1, e.p2];
    case 'circle': return [e.c];
    case 'arc': return [e.c, e.p1, e.p2];
    case 'point': return [e.p];
    case 'ellipse': return [e.c, e.a, ...(e.p1 ? [e.p1] : []), ...(e.p2 ? [e.p2] : [])];
    case 'spline': return [...e.pts, ...(e.h1 ? [e.h1] : []), ...(e.h2 ? [e.h2] : [])];
    case 'text': return [e.p];
  }
}

/** Entities whose size is a solver variable of their own (a circle's radius, an ellipse's minor semi-axis). */
export const hasRadius = (e: CadEntity): e is CadCircle | CadEllipse => e.type === 'circle' || e.type === 'ellipse';

/**
 * Names taken by other sketches of the same design. The editor of one sketch sets
 * this so new dimensions get names that are unique across the whole part.
 */
let reserved = new Set<string>();
export function reserveDimNames(names: Iterable<string>) {
  reserved = new Set(names);
}

/** Next free dimension name d1, d2, … */
export function nextDimName(s: CadSketch): string {
  const used = new Set([...reserved, ...s.constraints.map((c) => c.name).filter(Boolean)]);
  let i = 1;
  while (used.has(`d${i}`)) i++;
  return `d${i}`;
}

/**
 * Remove entities and constraints, then any point no entity uses and any constraint
 * that lost a reference. Returns a new sketch.
 */
export function removeFromSketch(s: CadSketch, ids: Set<string>): CadSketch {
  // a source goes with its geometry, and its geometry with it
  const sources = s.sources?.filter((q) => !ids.has(q.id) && !s.entities.some((e) => e.ref === q.id && ids.has(e.id)));
  const keepRef = new Set(sources?.map((q) => q.id));
  const entities = s.entities.filter((e) => !ids.has(e.id) && !entityPoints(e).some((p) => ids.has(p)) && (!e.ref || keepRef.has(e.ref)));
  const used = new Set(entities.flatMap(entityPoints));
  const points = s.points.filter((p) => used.has(p.id));
  const alive = new Set([...entities.map((e) => e.id), ...points.map((p) => p.id)]);
  const constraints = s.constraints.filter((c) => !ids.has(c.id) && c.refs.every((r) => alive.has(r)) && (!c.pattern?.along || alive.has(c.pattern.along)) && (!c.pattern?.about || alive.has(c.pattern.about)));
  return { points, entities, constraints, ...(sources?.length ? { sources } : {}) };
}

/**
 * Fingerprint of a sketch (FNV-1a over its JSON). A worksheet result carries the
 * fingerprint of the sketch it solved, so the editor can tell a fresh result from
 * one computed before the latest edit.
 */
export function sketchSig(s: CadSketch): string {
  const str = JSON.stringify(s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + str.length.toString(36);
}
