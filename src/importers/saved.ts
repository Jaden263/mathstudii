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

/** SI magnitude and dimensions; angles count as plain numbers, as in Mathcad. */
function si(v: unknown): { value: number; dims: number[] } | null {
  try {
    if (isComplex(v)) return null;
    const s = splitUnit(v);
    const dims = s.unit ? [...(s.unit as unknown as { dimensions: number[] }).dimensions] : [];
    if (dims.length > ANGLE) dims[ANGLE] = 0;
    return { value: s.value, dims };
  } catch {
    return null;
  }
}

/** A quantity with a complex value (55.1 + 45.9i Ω): its SI parts and dimensions; a real one with im = 0. */
function complexSi(v: unknown): { re: number; im: number; dims: number[] } | null {
  const c = isUnit(v) ? (v as unknown as { value: unknown }).value : null;
  if (isComplex(c)) {
    const dims = [...(v as unknown as { dimensions: number[] }).dimensions];
    if (dims.length > ANGLE) dims[ANGLE] = 0;
    return { re: c.re, im: c.im, dims };
  }
  if (isComplex(v)) return { re: v.re, im: v.im, dims: [] };
  const r = si(v);
  return r && { re: r.value, im: 0, dims: r.dims };
}

const sameDims = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return false;
  return true;
};

const flat = (v: unknown): unknown[] => (isMatrix(v) ? (math.flatten(v.toArray() as never) as unknown as unknown[]) : Array.isArray(v) ? (math.flatten(v as never) as unknown as unknown[]) : [v]);

/** Do two values agree to a relative tolerance (of the largest element, for vectors and matrices)? */
export function agrees(ours: unknown, theirs: unknown, tol = 1e-6): boolean {
  const a = flat(ours), b = flat(theirs);
  if (a.length !== b.length) return false;
  if (a.some((x) => typeof x === 'string') || b.some((x) => typeof x === 'string')) return a.every((x, i) => x === b[i]);
  const complexUnit = (x: unknown) => isUnit(x) && isComplex((x as unknown as { value: unknown }).value);
  if (a.some(complexUnit) || b.some(complexUnit)) {
    return a.every((x, i) => {
      const p = complexSi(x), q = complexSi(b[i]);
      if (!p || !q) return false;
      const size = Math.hypot(q.re, q.im);
      if (!sameDims(p.dims, q.dims) && Math.hypot(p.re, p.im) !== 0 && size !== 0) return false;
      return Math.hypot(p.re - q.re, p.im - q.im) <= tol * Math.max(size, 1e-300);
    });
  }
  if (a.some(isComplex) || b.some(isComplex)) {
    return a.every((x, i) => {
      const p = math.complex(x as never) as unknown as { re: number; im: number }, q = math.complex(b[i] as never) as unknown as { re: number; im: number };
      return Math.hypot(p.re - q.re, p.im - q.im) <= tol * Math.max(Math.hypot(q.re, q.im), 1e-300);
    });
  }
  const sa = a.map(si), sb = b.map(si);
  if (sa.some((x) => !x) || sb.some((x) => !x)) return false;
  const scale = Math.max(...sb.map((x) => Math.abs(x!.value)), ...sa.map((x) => Math.abs(x!.value)));
  return sa.every((x, i) => {
    const y = sb[i]!;
    // a zero has any unit
    if (!sameDims(x!.dims, y.dims) && x!.value !== 0 && y.value !== 0) return false;
    const d = Math.abs(x!.value - y.value);
    // Mathcad shows (and saves) values below 1e-15 of 1 as 0
    return d <= tol * scale || d <= 1e-300 || (Math.min(Math.abs(x!.value), Math.abs(y.value)) === 0 && d < 1e-12);
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
      // angles shown in deg are saved in deg
      const unit = displayScale(source);
      if (isUnit(unit)) {
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
