// More Mathcad built-ins that public worksheets use: max and min over all their arguments,
// SIUnitsOf, error, IsNaN, the coordinate
// conversions (xy2pol, pol2xy, xyz2sph, sph2xyz, xyz2cyl, cyl2xyz), gmean and hmean, Spearman's
// and Kendall's rank correlations; the product of two vectors, which in Mathcad is their dot
// product, and their quotient, element by element. Semantics follow PTC's reference pages, checked against values Mathcad saved with real
// worksheets (the sph2xyz convention against Lab01.xmcd, for one).
import type { Unit } from 'mathjs';
import { math, isMatrix, isUnit, isComplex, splitUnit, joinUnit } from './math';
import { toVector, vec, num } from './library';

const isArrayValue = (v: unknown) => isMatrix(v) || Array.isArray(v);

/** The unit of a value as the SI unit (value 1); 1 for a plain number. An array's elements share it. */
function siUnitsOf(x: unknown): unknown {
  const items = isArrayValue(x) ? toVector(x) : [x];
  let unit: Unit | null = null;
  for (const v of items) {
    if (typeof v === 'string') throw new Error('SIUnitsOf: the argument must be a number or an array of numbers');
    const s = splitUnit(v);
    if (!s.unit) {
      // a plain 0 goes with any unit
      if (s.value !== 0 && unit) throw new Error('SIUnitsOf: the elements have different units');
      continue;
    }
    if (unit && !unit.equalBase(s.unit)) throw new Error('SIUnitsOf: the elements have different units');
    unit = s.unit;
  }
  return unit ?? 1;
}

/** Arguments given one by one or as one vector: f(x, y) or f(v). */
function coords(args: unknown[], n: number, name: string): unknown[] {
  const a = args.length === 1 && isArrayValue(args[0]) ? toVector(args[0]) : args;
  if (a.length !== n) throw new Error(`${name} takes ${n} coordinates, or a vector of ${n}`);
  return a;
}

const plain = (v: unknown) => (isUnit(v) ? splitUnit(v) : { value: num(v), unit: null });
/** An angle as radians (a number, or a quantity in deg or rad). */
const angle = (v: unknown) => splitUnit(v).value;
/** Lengths share a unit: the first one's. */
function lengths(vals: unknown[], name: string) {
  const parts = vals.map(plain);
  const unit = parts.find((p) => p.unit)?.unit ?? null;
  for (const p of parts) {
    if (p.unit && unit && !p.unit.equalBase(unit)) throw new Error(`${name}: the coordinates have different units`);
    if (!p.unit && unit && p.value !== 0) throw new Error(`${name}: the coordinates have different units`);
  }
  return { values: parts.map((p) => p.value), unit };
}
const out = (values: unknown[]) => vec(values);

/** xy2pol(x, y) → [r; θ], θ in (−π, π]. */
function xy2pol(...args: unknown[]) {
  const { values: [x, y], unit } = lengths(coords(args, 2, 'xy2pol'), 'xy2pol');
  return out([joinUnit(Math.hypot(x, y), unit), Math.atan2(y, x)]);
}

/** pol2xy(r, θ) → [x; y]. */
function pol2xy(...args: unknown[]) {
  const [rv, tv] = coords(args, 2, 'pol2xy');
  const { value: r, unit } = plain(rv);
  const t = angle(tv);
  return out([joinUnit(r * Math.cos(t), unit), joinUnit(r * Math.sin(t), unit)]);
}

/** xyz2sph(x, y, z) → [r; θ; φ]: θ the angle in the x-y plane, φ the angle from the z axis. */
function xyz2sph(...args: unknown[]) {
  const { values: [x, y, z], unit } = lengths(coords(args, 3, 'xyz2sph'), 'xyz2sph');
  return out([joinUnit(Math.hypot(x, y, z), unit), Math.atan2(y, x), Math.atan2(Math.hypot(x, y), z)]);
}

/** sph2xyz(r, θ, φ) → [r sin φ cos θ; r sin φ sin θ; r cos φ]. */
function sph2xyz(...args: unknown[]) {
  const [rv, tv, pv] = coords(args, 3, 'sph2xyz');
  const { value: r, unit } = plain(rv);
  const t = angle(tv), p = angle(pv);
  return out([joinUnit(r * Math.sin(p) * Math.cos(t), unit), joinUnit(r * Math.sin(p) * Math.sin(t), unit), joinUnit(r * Math.cos(p), unit)]);
}

/** xyz2cyl(x, y, z) → [r; θ; z]. */
function xyz2cyl(...args: unknown[]) {
  const { values: [x, y, z], unit } = lengths(coords(args, 3, 'xyz2cyl'), 'xyz2cyl');
  return out([joinUnit(Math.hypot(x, y), unit), Math.atan2(y, x), joinUnit(z, unit)]);
}

/** cyl2xyz(r, θ, z) → [r cos θ; r sin θ; z]. */
function cyl2xyz(...args: unknown[]) {
  const [rv, tv, zv] = coords(args, 3, 'cyl2xyz');
  const { values: [r, z], unit } = lengths([rv, zv], 'cyl2xyz');
  const t = angle(tv);
  return out([joinUnit(r * Math.cos(t), unit), joinUnit(r * Math.sin(t), unit), joinUnit(z, unit)]);
}

/** Every element of the arguments (scalars and arrays), as SI numbers with their shared unit. */
function sample(args: unknown[], name: string) {
  const items = args.flatMap((a) => (isArrayValue(a) ? toVector(a) : [a]));
  if (!items.length) throw new Error(`${name} needs at least one value`);
  return lengths(items, name);
}

/** gmean(A, B, …): the geometric mean of all the elements. */
function gmean(...args: unknown[]) {
  const { values, unit } = sample(args, 'gmean');
  if (values.some((v) => v <= 0)) throw new Error('gmean: every value must be positive');
  return joinUnit(Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length), unit);
}

/** hmean(A, B, …): the harmonic mean of all the elements. */
function hmean(...args: unknown[]) {
  const { values, unit } = sample(args, 'hmean');
  if (values.some((v) => v <= 0)) throw new Error('hmean: every value must be positive');
  return joinUnit(values.length / values.reduce((s, v) => s + 1 / v, 0), unit);
}

/** Ranks 1 … n, ties sharing their mean rank. */
function ranks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    for (let k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function pair(vx: unknown, vy: unknown, name: string): [number[], number[]] {
  const x = toVector(vx).map((v) => splitUnit(v).value), y = toVector(vy).map((v) => splitUnit(v).value);
  if (x.length !== y.length || x.length < 2) throw new Error(`${name}: the vectors need the same number of elements, at least 2`);
  return [x, y];
}

function pearson(x: number[], y: number[]): number {
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Spear(vx, vy): Spearman's rank correlation, the correlation of the ranks. */
function Spear(vx: unknown, vy: unknown) {
  const [x, y] = pair(vx, vy, 'Spear');
  return pearson(ranks(x), ranks(y));
}

/** kendltau(vx, vy): Kendall's τ-b, (concordant − discordant) over the pairs untied in each. */
function kendltau(vx: unknown, vy: unknown) {
  const [x, y] = pair(vx, vy, 'kendltau');
  let c = 0, d = 0, tx = 0, ty = 0;
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const a = Math.sign(x[i] - x[j]), b = Math.sign(y[i] - y[j]);
      if (a === 0 && b === 0) continue;
      if (a === 0) tx++;
      else if (b === 0) ty++;
      else if (a === b) c++;
      else d++;
    }
  }
  return (c - d) / Math.sqrt((c + d + tx) * (c + d + ty));
}

/** error(S): stops the calculation with the message S (a program's own error). */
function error(s: unknown): never {
  throw new Error(typeof s === 'string' ? s : String(s));
}

/** IsNaN(x): 1 for NaN, else 0 (element by element for an array). */
function IsNaN(x: unknown): unknown {
  if (isArrayValue(x)) return math.map(x as never, (v: unknown) => IsNaN(v) as never);
  if (typeof x === 'number') return Number.isNaN(x) ? 1 : 0;
  if (isUnit(x)) return Number.isNaN(splitUnit(x).value) ? 1 : 0;
  if (isComplex(x)) return Number.isNaN(x.re) || Number.isNaN(x.im) ? 1 : 0;
  return 0;
}

/** max(A, B, c …) and min(…): the largest (smallest) element over all the arguments, arrays and scalars. */
function extreme(fn: (...xs: unknown[]) => unknown, name: string) {
  return (...args: unknown[]) => {
    if (!args.length) throw new Error(`${name} needs at least one value`);
    const items = args.flatMap((a) => (isArrayValue(a) ? toVector(a) : [a]));
    if (!items.length) throw new Error(`${name} of an empty array`);
    const out = fn(...items);
    // a plain 0 among quantities is their zero: max(F, 0) of a negative force is 0 N
    const q = out === 0 ? items.find(isUnit) : undefined;
    return q ? joinUnit(0, splitUnit(q).unit) : out;
  };
}

/**
 * traceText(S, x, y …): Mathcad's trace and pause, which show the message S with {0}, {1} …
 * replaced by x, y … while a program is debugged; here they give that message and go on.
 */
function traceText(s: unknown, ...values: unknown[]): string {
  const show = (v: unknown) => (typeof v === 'string' ? v : math.format(v as never, { precision: 6 }));
  return String(s).replace(/\{(\d+)\}/g, (m, k: string) => (Number(k) < values.length ? show(values[Number(k)]) : m));
}

const FUNCTIONS: Record<string, unknown> = {
  mcMax: extreme(math.max as unknown as (...xs: unknown[]) => unknown, 'max'),
  mcMin: extreme(math.min as unknown as (...xs: unknown[]) => unknown, 'min'),
  SIUnitsOf: siUnitsOf, mcError: error, IsNaN,
  xy2pol, pol2xy, xyz2sph, sph2xyz, xyz2cyl, cyl2xyz,
  gmean, hmean, Spear, kendltau, traceText,
};

/**
 * u·v of two vectors is their dot product in Mathcad ([a; b; c]·[d; e; f] = ad + be + cf); every
 * other product is the matrix product as before.
 */
const vectorProduct = (() => {
  const old = math.multiply as unknown as { signatures: Record<string, (x: unknown, y: unknown) => unknown> };
  const column = (v: unknown) => {
    const s = math.size(v as never) as unknown as number[];
    return s.length === 1 ? s[0] : s.length === 2 && s[1] === 1 && s[0] > 1 ? s[0] : 0;
  };
  const wrap = (f: (x: unknown, y: unknown) => unknown) => (x: unknown, y: unknown) => {
    const n = column(x);
    if (n && n === column(y)) {
      const a = toVector(x), b = toVector(y);
      return a.reduce((s: unknown, v, i) => math.add(s as never, math.multiply(v as never, b[i] as never) as never), 0);
    }
    return f(x, y);
  };
  const sigs = { ...old.signatures };
  for (const k of ['Array,Array', 'Matrix,Matrix', 'Matrix,Array', 'Array,Matrix']) if (sigs[k]) sigs[k] = wrap(sigs[k]);
  return math.typed('multiply', sigs as never);
})();

/**
 * u/v of two vectors of one size is their quotient element by element in Mathcad (F·(y/y) is a
 * vector of F); a matrix divisor is still inverted (A/B = A·B⁻¹ of a square B).
 */
const vectorQuotient = (() => {
  const old = math.divide as unknown as { signatures: Record<string, (x: unknown, y: unknown) => unknown> };
  const vectorSize = (v: unknown) => {
    const s = math.size(v as never) as unknown as number[];
    return s.length === 1 ? `${s[0]}` : s.length === 2 && (s[0] === 1 || s[1] === 1) && s[0] * s[1] > 1 ? s.join('x') : '';
  };
  const wrap = (f: (x: unknown, y: unknown) => unknown) => (x: unknown, y: unknown) => {
    const n = vectorSize(x);
    return n && n === vectorSize(y) ? math.dotDivide(x as never, y as never) : f(x, y);
  };
  const sigs = { ...old.signatures };
  for (const k of ['Array,Array', 'Matrix,Matrix', 'Matrix,Array', 'Array,Matrix']) if (sigs[k]) sigs[k] = wrap(sigs[k]);
  return math.typed('divide', sigs as never);
})();

const clashes = Object.keys(FUNCTIONS).filter((k) => k in math);
if (clashes.length) throw new Error(`Mathcad function names clash: ${clashes.join(', ')}`);
// UnitsOf, Mathcad 15's name, takes arrays too
math.import({ ...FUNCTIONS, UnitsOf: siUnitsOf, multiply: vectorProduct, divide: vectorQuotient }, { override: true });
