// Parametric CAD document model: a constrained 2-D sketch plus an optional 3-D
// feature (extrude or revolve). Plain JSON, like the rest of the worksheet.
//
// Geometry is stored as points shared between entities (a polyline's corners are
// one point each), so "connected" is topology, not a tolerance. Point positions
// are the last solved state; the solver moves them to satisfy the constraints.

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

export type CadEntity = CadLine | CadCircle | CadArc | CadPointEntity;

export type GeometricConstraint =
  | 'coincident' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal'
  | 'fix' | 'pointOnLine' | 'pointOnCircle' | 'tangent' | 'midpoint' | 'symmetric' | 'concentric';

export type DimensionConstraint = 'distance' | 'distanceX' | 'distanceY' | 'length' | 'angle' | 'radius' | 'diameter';

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
   *   radius/diameter [circle|arc]
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
}

export interface CadSketch {
  points: CadPoint[];
  entities: CadEntity[];
  constraints: CadConstraint[];
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
  t === 'distance' || t === 'distanceX' || t === 'distanceY' || t === 'length' || t === 'angle' || t === 'radius' || t === 'diameter';

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
  }
}

/** Next free dimension name d1, d2, … */
export function nextDimName(s: CadSketch): string {
  const used = new Set(s.constraints.map((c) => c.name).filter(Boolean));
  let i = 1;
  while (used.has(`d${i}`)) i++;
  return `d${i}`;
}

/**
 * Remove entities and constraints, then any point no entity uses and any constraint
 * that lost a reference. Returns a new sketch.
 */
export function removeFromSketch(s: CadSketch, ids: Set<string>): CadSketch {
  const entities = s.entities.filter((e) => !ids.has(e.id) && !entityPoints(e).some((p) => ids.has(p)));
  const used = new Set(entities.flatMap(entityPoints));
  const points = s.points.filter((p) => used.has(p.id));
  const alive = new Set([...entities.map((e) => e.id), ...points.map((p) => p.id)]);
  const constraints = s.constraints.filter((c) => !ids.has(c.id) && c.refs.every((r) => alive.has(r)));
  return { points, entities, constraints };
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
