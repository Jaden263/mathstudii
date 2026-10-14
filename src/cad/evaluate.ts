// Evaluates a CAD region inside the worksheet: dimension expressions are read from
// the worksheet scope, the sketch is solved, and the part's properties are exported
// under the region's name (part.A, part.m, part.d1, …) for the math below it.
import type { Unit } from 'mathjs';
import type { CadRegion } from '../model/types';
import { math, isUnit } from '../engine/math';
import type { SectionProps } from '../engine/geometry';
import { isDimension, sketchSig, type CadSketch, type CadFeature } from './model';
import { solveSketch, measure } from './solver';
import { findProfiles, profileProperties, type ProfileRegion, type Vec2 } from './profile';
import { extrudeProps, revolveProps, type MassProps } from './features';

export interface CadResult {
  kind: 'cad';
  /** sketchSig of the sketch this result was solved from. */
  sig?: string;
  /** Solved geometry. */
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
  mass?: MassProps & { m?: number; density?: number };
  /** Evaluated feature size: extrusion depth (sketch units) or revolve angle (radians). */
  depth?: number;
  angle?: number;
  /** Feature-level problem (bad depth, profile crossing the axis …). */
  featureError?: string;
  error?: string;
}

const isAngle = (t: string) => t === 'angle';

/** A dimension expression → sketch units, or radians for angles (bare numbers are degrees). */
export function dimensionValue(v: unknown, unit: string, angle: boolean): number {
  if (typeof v === 'number') return angle ? (v * Math.PI) / 180 : v;
  if (isUnit(v)) {
    const u = v as Unit;
    if (angle) {
      if (!u.equalBase(math.unit('rad'))) throw new Error('expected an angle');
      return u.toNumeric('rad') as number;
    }
    if (!u.equalBase(math.unit('m'))) throw new Error(`expected a length, got ${u.formatUnits()}`);
    return u.toNumeric(unit) as number;
  }
  throw new Error('expected a number');
}

/** Axis of a revolve feature in sketch coordinates. */
export function revolveAxis(sk: CadSketch, feature: Extract<CadFeature, { type: 'revolve' }>, P: Map<string, Vec2>): { p: Vec2; d: Vec2 } | null {
  if (feature.axis === 'x') return { p: { x: 0, y: 0 }, d: { x: 1, y: 0 } };
  if (feature.axis === 'y') return { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } };
  const e = sk.entities.find((q) => q.id === feature.axis);
  if (e?.type !== 'line') return null;
  const a = P.get(e.p1)!, b = P.get(e.p2)!;
  return { p: a, d: { x: b.x - a.x, y: b.y - a.y } };
}

export interface CadSolved {
  result: CadResult;
  regions: ProfileRegion[];
  points: Map<string, Vec2>;
  radii: Map<string, number>;
}

/** Solve and measure a CAD region. `evalExpr` evaluates worksheet expressions (throws on error). */
export function solveCad(r: CadRegion, evalExpr: (src: string) => unknown): CadSolved {
  const sk = r.sketch;
  const values = new Map<string, number>();
  const dimErrors: Record<string, string> = {};
  for (const c of sk.constraints) {
    if (!isDimension(c.type) || c.driving === false) continue;
    try {
      const n = dimensionValue(evalExpr(c.value?.trim() || '0'), r.unit, isAngle(c.type));
      if (!Number.isFinite(n)) throw new Error('not a finite number');
      if (n < 0 && c.type !== 'distanceX' && c.type !== 'distanceY') throw new Error('must not be negative');
      values.set(c.id, n);
    } catch (e) {
      dimErrors[c.id] = e instanceof Error ? e.message : String(e);
    }
  }
  const sol = solveSketch(sk, { values });
  const measured: Record<string, number> = {};
  for (const c of sk.constraints) if (isDimension(c.type)) measured[c.id] = measure(sk, c, sol.points, sol.radii);

  const { regions, issues } = findProfiles(sk, sol.points, sol.radii);
  const result: CadResult = {
    kind: 'cad',
    sig: sketchSig(sk),
    points: Object.fromEntries([...sol.points].map(([id, p]) => [id, [p.x, p.y]])),
    radii: Object.fromEntries(sol.radii),
    ok: sol.ok, dof: sol.dof,
    determined: [...sol.determined], determinedRadii: [...sol.determinedRadii],
    conflicting: sol.conflicting, redundant: sol.redundant,
    values: measured, dimErrors, issues,
  };
  const section = profileProperties(regions);
  if (section) result.section = section;

  const f = r.feature;
  try {
    let mass: MassProps | null = null;
    if (f.type === 'extrude') {
      const depth = dimensionValue(evalExpr(f.depth.trim() || '0'), r.unit, false);
      if (!(depth > 0)) throw new Error('the extrusion depth must be positive');
      result.depth = depth;
      mass = extrudeProps(regions, depth, f.symmetric);
    } else if (f.type === 'revolve') {
      const axis = revolveAxis(sk, f, sol.points);
      if (!axis) throw new Error('pick a line (or the x / y axis) to revolve about');
      const ang = dimensionValue(evalExpr(f.angle.trim() || '360'), r.unit, true);
      if (!(ang > 0 && ang <= 2 * Math.PI + 1e-12)) throw new Error('the revolve angle must be between 0 and 360°');
      result.angle = Math.min(ang, 2 * Math.PI);
      mass = revolveProps(regions, axis, result.angle);
    }
    if (mass) {
      const out: CadResult['mass'] = { ...mass };
      if (r.density.trim()) {
        const rho = evalExpr(r.density);
        if (!isUnit(rho) || !(rho as Unit).equalBase(math.unit('kg/m^3'))) throw new Error('the density needs a unit such as kg/m^3');
        out.density = (rho as Unit).toNumeric(`kg/${r.unit}^3`) as number;
        out.m = out.density * mass.V;
      }
      result.mass = out;
    } else if (f.type !== 'none' && !regions.length) throw new Error('the sketch has no closed profile to build a solid from');
  } catch (e) {
    result.featureError = e instanceof Error ? e.message : String(e);
  }
  return { result, regions, points: sol.points, radii: sol.radii };
}

/** Worksheet value of a part: section, solid and named dimensions with units. */
export function cadValue(r: CadRegion, res: CadResult): Record<string, unknown> {
  const u = r.unit;
  const L = (v: number, p = 1) => math.unit(v, p === 1 ? u : `${u}^${p}`);
  const value: Record<string, unknown> = { dof: res.dof };
  const s = res.section;
  if (s) {
    Object.assign(value, {
      A: L(s.A, 2), xc: L(s.xc), yc: L(s.yc),
      Ix: L(s.Ix, 4), Iy: L(s.Iy, 4), Ixy: L(s.Ixy, 4), I1: L(s.I1, 4), I2: L(s.I2, 4), J: L(s.J, 4),
      θ: math.unit(s.theta, 'deg'), theta: math.unit(s.theta, 'deg'),
      Wx: L(s.Wx, 3), Wy: L(s.Wy, 3), rx: L(s.rx), ry: L(s.ry),
      b: L(s.xmax - s.xmin), h: L(s.ymax - s.ymin),
    });
  }
  const m = res.mass;
  if (m) {
    Object.assign(value, { V: L(m.V, 3), xg: L(m.xg), yg: L(m.yg), zg: L(m.zg) });
    if (m.m !== undefined && m.density !== undefined) {
      const kgm2 = (v: number) => math.unit(v * m.density!, `kg ${u}^2`);
      Object.assign(value, {
        m: math.unit(m.m, 'kg'),
        Imx: kgm2(m.Ixx), Imy: kgm2(m.Iyy), Imz: kgm2(m.Izz),
        Imxy: kgm2(m.Pxy), Imxz: kgm2(m.Pxz), Imyz: kgm2(m.Pyz),
      });
    }
  }
  for (const c of r.sketch.constraints) {
    if (!isDimension(c.type) || !c.name?.trim()) continue;
    const v = res.values[c.id];
    if (!Number.isFinite(v)) continue;
    value[c.name.trim()] = isAngle(c.type) ? math.unit((v * 180) / Math.PI, 'deg') : L(v);
  }
  return value;
}
