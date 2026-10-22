// Check a recalculated import against the results the source program saved with the file:
// Mathcad Prime keeps them in result.xml (SI), Mathcad 15 inside each region (in its display
// unit), SMath in the region's <result>. The import report says how many agree.
import { math, isMatrix, isUnit, isComplex, splitUnit } from '../engine/math';
import { compileExpr } from '../engine/compile';
import { ChainScope } from '../engine/scope';
import type { MathRegion, Region, SolveRegion } from '../model/types';
import type { SavedResult } from './common';

export interface SavedComparison {
  /** Saved results that could be compared with ours. */
  checked: number;
  agree: number;
  /** Results that differ, with both values as text. */
  differ: { regionId: string; source: string; ours: string; theirs: string }[];
  /** Saved results for regions that gave no value here (an error, or not calculated). */
  missing: { regionId: string; source: string; theirs: string }[];
}

const ANGLE = 7; // mathjs base dimension index of angles

/** SI magnitude (real and imaginary part) and dimensions; angles count as plain numbers, as in Mathcad. */
function si(v: unknown): { value: number; im: number; dims: number[] } | null {
  try {
    if (isComplex(v)) return { value: v.re, im: v.im, dims: [] };
    // a complex quantity, (5 + 2i) mm: mathjs keeps its value in SI
    if (isUnit(v) && isComplex(v.value)) {
      const dims = [...(v as unknown as { dimensions: number[] }).dimensions];
      if (dims.length > ANGLE) dims[ANGLE] = 0;
      return { value: v.value.re, im: v.value.im, dims };
    }
    const s = splitUnit(v);
    const dims = s.unit ? [...(s.unit as unknown as { dimensions: number[] }).dimensions] : [];
    if (dims.length > ANGLE) dims[ANGLE] = 0;
    return { value: s.value, im: 0, dims };
  } catch {
    return null;
  }
}

const sameDims = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return false;
  return true;
};

/** Every element, row by row; a nested array's elements (arrays themselves) give theirs. */
const flat = (v: unknown): unknown[] => {
  const items = isMatrix(v) ? (math.flatten(v.toArray() as never) as unknown as unknown[]) : Array.isArray(v) ? (math.flatten(v as never) as unknown as unknown[]) : [v];
  return items.some((x) => isMatrix(x) || Array.isArray(x)) ? items.flatMap(flat) : items;
};

/** Do two values agree to a relative tolerance (of the largest element, for vectors and matrices)? */
export function agrees(ours: unknown, theirs: unknown, tol = 1e-6): boolean {
  const a = flat(ours), b = flat(theirs);
  if (a.length !== b.length) return false;
  if (a.some((x) => typeof x === 'string') || b.some((x) => typeof x === 'string')) return a.every((x, i) => x === b[i]);
  const sa = a.map(si), sb = b.map(si);
  if (sa.some((x) => !x) || sb.some((x) => !x)) return false;
  const size = (x: { value: number; im: number } | null) => Math.hypot(x!.value, x!.im);
  const finite = (x: { value: number; im: number } | null) => (Number.isFinite(size(x)) ? size(x) : 0);
  const scale = Math.max(...sb.map(finite), ...sa.map(finite));
  return sa.every((x, i) => {
    const y = sb[i]!;
    // NaN (Mathcad's "no number") and ∞ agree with themselves only
    if (!Number.isFinite(size(x)) || !Number.isFinite(size(y))) return Object.is(x!.value, y.value) && Object.is(x!.im, y.im) && (Number.isNaN(x!.value) || sameDims(x!.dims, y.dims));
    // a zero has any unit
    if (!sameDims(x!.dims, y.dims) && size(x) !== 0 && size(y) !== 0) return false;
    const d = Math.hypot(x!.value - y.value, x!.im - y.im);
    // Mathcad shows (and saves) values below 1e-15 of 1 as 0
    return d <= tol * scale || d <= 1e-300 || (Math.min(size(x), size(y)) === 0 && d < 1e-12);
  });
}

const text = (v: unknown) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : math.format(v as never, { precision: 8 });
  } catch {
    return String(v);
  }
};

function sourceOf(r: Region | undefined): string {
  if (!r) return '';
  return r.kind === 'math' ? (r as MathRegion).source : r.kind === 'solve' ? (r as SolveRegion).solver : '';
}

/** A shown result's display unit (x = deg): Mathcad saves a plain number scaled to it. */
function displayScale(src: string): unknown {
  const m = / =\s*([^=]+)$/.exec(src.split('\n')[0]);
  if (!m) return null;
  if (m[1].trim() === '%') return 0.01;
  try {
    return math.evaluate(m[1]);
  } catch {
    return null;
  }
}

export function compareSaved(saved: SavedResult[], regions: Region[], shown: Map<string, unknown>, tol = 1e-6): SavedComparison {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const out: SavedComparison = { checked: 0, agree: 0, differ: [], missing: [] };
  for (const s of saved) {
    let theirs: unknown;
    try {
      // our syntax (10 %, 5 kN), with no worksheet names in reach
      theirs = compileExpr(s.expr).evaluate(new ChainScope(null));
    } catch {
      continue;
    }
    const source = sourceOf(byId.get(s.regionId));
    const ours = shown.get(s.regionId);
    if (ours === undefined || ours === null || typeof ours === 'function') {
      out.missing.push({ regionId: s.regionId, source, theirs: text(theirs) });
      continue;
    }
    out.checked++;
    let ok = agrees(ours, theirs, s.tol ?? tol);
    if (!ok) {
      // angles shown in deg are saved in deg, a ratio shown in % in percent
      const unit = displayScale(source);
      if (isUnit(unit) || (typeof unit === 'number' && unit !== 0 && unit !== 1)) {
        try {
          ok = agrees(math.divide(ours as never, unit as never), theirs, s.tol ?? tol);
        } catch {
          /* not a scale of ours */
        }
      }
    }
    if (ok) out.agree++;
    else out.differ.push({ regionId: s.regionId, source, ours: text(ours), theirs: text(theirs) });
  }
  return out;
}
