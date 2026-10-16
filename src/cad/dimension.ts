// Dimension values from worksheet expressions, for the evaluation and the sketch editor
// alike (kept apart from evaluate.ts, which brings the solid kernels with it).
import type { Unit } from 'mathjs';
import { math, isUnit } from '../engine/math';

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
