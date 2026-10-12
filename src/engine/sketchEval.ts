// Evaluates sketch regions: resolves expression-bound fields against the
// worksheet scope and computes section properties of the closed shapes.
import type { Unit } from 'mathjs';
import type { SketchRegion } from '../model/types';
import { applyResolved, areaRole, type Shape } from '../model/sketch';
import { math, isUnit } from './math';
import { templatePrimitives, placePrimitives, sectionProperties, type Primitive, type SectionProps } from './geometry';

export interface SketchResult {
  kind: 'sketch';
  /** shape id → field path → resolved number (sketch units, angles in degrees). */
  resolved: Record<string, Record<string, number>>;
  /** shape id → error message */
  errors: Record<string, string>;
  props?: SectionProps;
  error?: string;
}

const ANGLE_FIELDS = new Set(['rot', 'a0', 'a1']);

function toNumber(v: unknown, unit: string, angle: boolean): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isUnit(v)) {
    const u = v as Unit;
    if (angle) {
      if (!u.equalBase(math.unit('rad'))) throw new Error('expected an angle');
      return u.toNumeric('deg') as number;
    }
    if (!u.equalBase(math.unit('m'))) throw new Error(`expected a length, got ${u.formatUnits()}`);
    return u.toNumeric(unit) as number;
  }
  throw new Error('expected a number');
}

/** The filled areas of a (resolved) shape, in sketch units. */
export function shapePrimitives(s: Shape): Primitive[] {
  const role = areaRole(s);
  if (role === 'none') return [];
  const sign = role === 'hole' ? -1 : 1;
  switch (s.type) {
    case 'rect':
      return [{ kind: 'poly', sign, pts: [s.a, { x: s.b.x, y: s.a.y }, s.b, { x: s.a.x, y: s.b.y }] }];
    case 'circle':
      return [{ kind: 'circle', sign, c: s.c, r: Math.abs(s.r) }];
    case 'poly':
      return s.closed && s.pts.length >= 3 ? [{ kind: 'poly', sign, pts: s.pts }] : [];
    case 'section': {
      const nums = Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, Number(v)]));
      const prims = placePrimitives(templatePrimitives(s.template, nums), s.p, s.rot);
      // a section used as a hole cuts its whole outline
      return sign === 1 ? prims : prims.map((q) => ({ ...q, sign: (q.sign * -1) as 1 | -1 }));
    }
    default:
      return [];
  }
}

export function evaluateSketch(r: SketchRegion, evalExpr: (src: string) => unknown): { result: SketchResult; value?: Record<string, unknown> } {
  const result: SketchResult = { kind: 'sketch', resolved: {}, errors: {} };
  const prims: Primitive[] = [];
  for (const s of r.shapes) {
    const res: Record<string, number> = {};
    const fail = (path: string, e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors[s.id] = result.errors[s.id] ? `${result.errors[s.id]}; ${path}: ${msg}` : `${path}: ${msg}`;
    };
    for (const [path, expr] of Object.entries(s.bind ?? {})) {
      if (!expr.trim()) continue;
      try {
        const n = toNumber(evalExpr(expr), r.unit, ANGLE_FIELDS.has(path.split('.').pop()!));
        if (!Number.isFinite(n)) throw new Error('not a finite number');
        res[path] = n;
      } catch (e) {
        fail(path, e);
      }
    }
    if (s.type === 'section') {
      for (const [k, expr] of Object.entries(s.params)) {
        try {
          res[`params.${k}`] = toNumber(evalExpr(expr || '0'), r.unit, false);
        } catch (e) {
          fail(k, e);
        }
      }
    }
    if (Object.keys(res).length) result.resolved[s.id] = res;
    if (result.errors[s.id]) continue;
    try {
      prims.push(...shapePrimitives(applyResolved(s, res)));
    } catch (e) {
      fail(s.type, e);
    }
  }
  const props = prims.some((p) => p.sign > 0) ? sectionProperties(prims) : null;
  if (props) result.props = props;
  if (!r.name.trim()) return { result };
  if (!props) {
    result.error = `"${r.name}" needs at least one closed shape marked as solid`;
    return { result };
  }
  const u = r.unit;
  const L = (v: number, p = 1) => math.unit(v, p === 1 ? u : `${u}^${p}`);
  const value: Record<string, unknown> = {
    A: L(props.A, 2),
    xc: L(props.xc), yc: L(props.yc),
    Ix: L(props.Ix, 4), Iy: L(props.Iy, 4), Ixy: L(props.Ixy, 4),
    I1: L(props.I1, 4), I2: L(props.I2, 4), J: L(props.J, 4),
    θ: math.unit(props.theta, 'deg'),
    theta: math.unit(props.theta, 'deg'),
    Wx: L(props.Wx, 3), Wy: L(props.Wy, 3),
    rx: L(props.rx), ry: L(props.ry),
    h: L(props.ymax - props.ymin), b: L(props.xmax - props.xmin),
  };
  return { result, value };
}
