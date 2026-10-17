// Mathcad built-ins that imported worksheets use and the core library lacked: table
// lookup (match, lookup, vlookup, hlookup, vhlookup), trim, IsArray/IsScalar/IsString,
// logspace/linspace, the shape statistics (skew, kurt, percentile, Rank, cvar, histogram),
// condition numbers, rref, geninv; and the hyperbolic functions taking an angle in
// degrees, since Mathcad's angles are plain numbers. Semantics follow PTC's reference
// pages, checked against values Mathcad Prime saved with real worksheets.
import type { MathNode, Unit } from 'mathjs';
import { math, isMatrix, isUnit, splitUnit, joinUnit } from './math';
import { toVector, vec, numVec, num, int, matrix2D, engineCtx, normalize } from './library';
import { compileNode, freeSymbols } from './compile';
import { ChainScope, type ScopeLike } from './scope';
import * as N from './numeric';

const isArrayValue = (v: unknown) => isMatrix(v) || Array.isArray(v);

/** Same value for a lookup: strings exactly, numbers (with units) to rounding. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  try {
    const x = splitUnit(a), y = splitUnit(b);
    if (!!x.unit !== !!y.unit || (x.unit && y.unit && !x.unit.equalBase(y.unit))) return false;
    return Math.abs(x.value - y.value) <= 1e-12 * Math.max(Math.abs(x.value), Math.abs(y.value), 1e-300);
  } catch {
    return false;
  }
}

/** A matrix as rows of values; a vector is one column. */
function grid(v: unknown): unknown[][] {
  if (!isArrayValue(v)) return [[v]];
  return matrix2D(v);
}

const isVectorShape = (v: unknown) => {
  if (!isArrayValue(v)) return true;
  const s = math.size(v as never) as unknown as number[];
  return s.length === 1 || s[1] === 1;
};

function found(hits: unknown[], what: string, z: unknown): unknown {
  if (!hits.length) throw new Error(`${what}: ${typeof z === 'string' ? `"${z}"` : math.format(z as never, { precision: 6 })} not found`);
  return normalize(math.matrix(hits as never));
}

/** match(z, A): the indices of z in A (row, column pairs, one per row of the result, for a matrix). */
function match(z: unknown, A: unknown) {
  const o = engineCtx.origin;
  if (isVectorShape(A)) return found(toVector(A).flatMap((v, i) => (same(v, z) ? [i + o] : [])), 'match', z);
  const g = grid(A);
  const hits: number[][] = [];
  // Mathcad scans a matrix column by column
  for (let j = 0; j < g[0].length; j++) for (let i = 0; i < g.length; i++) if (same(g[i][j], z)) hits.push([i + o, j + o]);
  if (!hits.length) return found([], 'match', z);
  return hits.length === 1 ? vec(hits[0]) : math.matrix(hits);
}

/** lookup(z, A, B): the elements of B where A equals z. */
function lookup(z: unknown, A: unknown, B: unknown) {
  const a = grid(A), b = grid(B);
  const out: unknown[] = [];
  for (let j = 0; j < (a[0]?.length ?? 0); j++) {
    for (let i = 0; i < a.length; i++) {
      if (!same(a[i][j], z)) continue;
      if (b[i]?.[j] === undefined) throw new Error('lookup: A and B must have the same size');
      out.push(b[i][j]);
    }
  }
  return found(out, 'lookup', z);
}

function index(v: unknown, what: string): number {
  return int(v, what) - engineCtx.origin;
}

/** vlookup(z, A, c): column c of the rows whose first column holds z. */
function vlookup(z: unknown, A: unknown, c: unknown) {
  const g = grid(A), k = index(c, 'vlookup column');
  if (k < 0 || k >= g[0].length) throw new Error('vlookup: column index out of range');
  return found(g.filter((row) => same(row[0], z)).map((row) => row[k]), 'vlookup', z);
}

/** hlookup(z, A, r): row r of the columns whose first row holds z. */
function hlookup(z: unknown, A: unknown, r: unknown) {
  const g = grid(A), k = index(r, 'hlookup row');
  if (k < 0 || k >= g.length) throw new Error('hlookup: row index out of range');
  return found(g[0].flatMap((v, j) => (same(v, z) ? [g[k][j]] : [])), 'hlookup', z);
}

/** vhlookup(zv, zh, A): where the row labelled zv (first column) meets the column labelled zh (first row). */
function vhlookup(zv: unknown, zh: unknown, A: unknown) {
  const g = grid(A);
  const rows = g.flatMap((row, i) => (same(row[0], zv) ? [i] : []));
  const cols = g[0].flatMap((v, j) => (same(v, zh) ? [j] : []));
  if (!rows.length) return found([], 'vhlookup', zv);
  if (!cols.length) return found([], 'vhlookup', zh);
  return found(cols.flatMap((j) => rows.map((i) => g[i][j])), 'vhlookup', zv);
}

/** trim(v, indices): v without the elements (rows of a matrix) at those indices. */
function trim(v: unknown, which: unknown) {
  const drop = new Set(toVector(which).map((i) => index(i, 'trim index')));
  if (isVectorShape(v)) return normalize(vec(toVector(v).filter((_, i) => !drop.has(i))));
  return math.matrix(grid(v).filter((_, i) => !drop.has(i)) as never);
}

/** logspace(a, b, n): n points from a to b with equal ratios (Mathcad's bounds are values, not exponents). */
function logspace(a: unknown, b: unknown, n: unknown) {
  const lo = num(a, 'logspace start'), hi = num(b, 'logspace end'), k = int(n, 'number of points');
  if (lo <= 0 || hi <= 0) throw new Error('logspace: the end points must be positive');
  if (k < 2) return vec([lo]);
  const step = (Math.log10(hi) - Math.log10(lo)) / (k - 1);
  return vec(Array.from({ length: k }, (_, i) => (i === k - 1 ? hi : 10 ** (Math.log10(lo) + i * step))));
}

/** linspace(a, b, n): n equally spaced points from a to b (units allowed). */
function linspace(a: unknown, b: unknown, n: unknown) {
  const x = splitUnit(a), y = splitUnit(b), k = int(n, 'number of points');
  if (!!x.unit !== !!y.unit || (x.unit && y.unit && !x.unit.equalBase(y.unit))) throw new Error('linspace: the end points have different units');
  if (k < 2) return vec([a]);
  const unit = x.unit ?? y.unit;
  return vec(Array.from({ length: k }, (_, i) => joinUnit(i === k - 1 ? y.value : x.value + ((y.value - x.value) * i) / (k - 1), unit)));
}

function sampleStats(v: unknown, what: string) {
  const { vals } = numVec(v, what);
  const n = vals.length;
  const mean = vals.reduce((s, x) => s + x, 0) / n;
  const s = Math.sqrt(vals.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (n - 1));
  return { vals, n, mean, s };
}

/** skew(A): bias-corrected sample skewness n/((n−1)(n−2)) Σ((x − x̄)/s)³. */
function skew(v: unknown) {
  const { vals, n, mean, s } = sampleStats(v, 'skew');
  if (n < 3) throw new Error('skew needs at least 3 values');
  return (n / ((n - 1) * (n - 2))) * vals.reduce((acc, x) => acc + ((x - mean) / s) ** 3, 0);
}

/** kurt(A): sample excess kurtosis (0 for a normal sample). */
function kurt(v: unknown) {
  const { vals, n, mean, s } = sampleStats(v, 'kurt');
  if (n < 4) throw new Error('kurt needs at least 4 values');
  const m4 = vals.reduce((acc, x) => acc + ((x - mean) / s) ** 4, 0);
  return (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * m4 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
}

/** percentile(A, p): interpolated at rank p(n + 1) of the sorted sample (p a fraction or %). */
function percentile(v: unknown, p: unknown) {
  const { vals, unit } = numVec(v, 'percentile');
  const f = num(p, 'percentile fraction');
  if (f < 0 || f > 1) throw new Error('percentile: p must be between 0 and 1');
  const xs = [...vals].sort((a, b) => a - b);
  const pos = f * (xs.length + 1) - 1;
  const lo = Math.max(0, Math.min(xs.length - 1, Math.floor(pos)));
  const hi = Math.min(xs.length - 1, lo + 1);
  const t = Math.max(0, Math.min(1, pos - lo));
  return joinUnit(xs[lo] + t * (xs[hi] - xs[lo]), unit);
}

/** Rank(v): each element's place, from 1, in ascending order. */
function rankOf(v: unknown) {
  const { vals } = numVec(v, 'Rank');
  const order = vals.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Array<number>(vals.length);
  order.forEach(([, i], k) => (out[i] = k + 1));
  return vec(out);
}

/** cvar(A, B): the population covariance. */
function cvar(a: unknown, b: unknown) {
  const x = numVec(a, 'cvar'), y = numVec(b, 'cvar');
  if (x.vals.length !== y.vals.length) throw new Error('cvar: the two samples must have the same length');
  const n = x.vals.length;
  const mx = x.vals.reduce((s, q) => s + q, 0) / n, my = y.vals.reduce((s, q) => s + q, 0) / n;
  const c = x.vals.reduce((s, q, i) => s + (q - mx) * (y.vals[i] - my), 0) / n;
  let r: unknown = c;
  if (x.unit) r = math.multiply(r as never, x.unit as never);
  if (y.unit) r = math.multiply(r as never, y.unit as never);
  return r;
}

/** histogram(n, A): n equal intervals over the data, as [midpoints, counts]; histogram(edges, A): the counts. */
function histogram(bins: unknown, v: unknown) {
  const { vals, unit } = numVec(v, 'histogram');
  if (isArrayValue(bins)) {
    const edges = toVector(bins).map((e) => splitUnit(e).value);
    return vec(edges.slice(0, -1).map((lo, i) => vals.filter((x) => x > lo && x <= edges[i + 1]).length));
  }
  const n = int(bins, 'number of intervals');
  if (n < 1) throw new Error('histogram: at least one interval');
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const w = (hi - lo) / n || 1;
  const counts = new Array<number>(n).fill(0);
  for (const x of vals) counts[Math.min(n - 1, Math.floor((x - lo) / w))]++;
  return math.matrix(counts.map((c, i) => [joinUnit(lo + (i + 0.5) * w, unit), c]) as never);
}

function numericMatrix(A: unknown, what: string): number[][] {
  return grid(A).map((row) => row.map((x) => num(x, what)));
}

function inverse(A: number[][]): number[][] {
  const n = A.length;
  if (A.some((r) => r.length !== n)) throw new Error('The matrix must be square');
  const cols = Array.from({ length: n }, (_, j) => N.solveLinear(A, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return A.map((_, i) => cols.map((c) => c[i]));
}

const norm1 = (A: number[][]) => Math.max(...A[0].map((_, j) => A.reduce((s, r) => s + Math.abs(r[j]), 0)));
const normInf = (A: number[][]) => Math.max(...A.map((r) => r.reduce((s, x) => s + Math.abs(x), 0)));
const normE = (A: number[][]) => Math.sqrt(A.reduce((s, r) => s + r.reduce((t, x) => t + x * x, 0), 0));
/** Singular values, largest first: square roots of the eigenvalues of AᵀA. */
function singularValues(A: number[][]): number[] {
  const At = A[0].map((_, j) => A.map((r) => r[j]));
  const AtA = At.map((r) => At.map((q) => r.reduce((s, x, k) => s + x * q[k], 0)));
  const ev = toVector((math.eigs(AtA) as unknown as { values: unknown }).values).map((x) => Math.max(0, Number(math.re(x as never))));
  return ev.map(Math.sqrt).sort((a, b) => b - a);
}
const norm2 = (A: number[][]) => singularValues(A)[0];

const cond = (norm: (A: number[][]) => number) => (A: unknown) => {
  const M = numericMatrix(A, 'condition number');
  return norm(M) * norm(inverse(M));
};

/** rref(A): the reduced row echelon form (Gauss–Jordan with partial pivoting). */
function rref(A: unknown) {
  const m = numericMatrix(A, 'rref').map((r) => r.slice());
  const rows = m.length, cols = m[0].length;
  const scale = Math.max(...m.flat().map(Math.abs), 1e-300);
  let p = 0;
  for (let c = 0; c < cols && p < rows; c++) {
    let r = p;
    for (let i = p + 1; i < rows; i++) if (Math.abs(m[i][c]) > Math.abs(m[r][c])) r = i;
    if (Math.abs(m[r][c]) <= 1e-12 * scale) continue;
    [m[p], m[r]] = [m[r], m[p]];
    const piv = m[p][c];
    m[p] = m[p].map((x) => x / piv);
    for (let i = 0; i < rows; i++) {
      if (i === p || m[i][c] === 0) continue;
      const f = m[i][c];
      m[i] = m[i].map((x, j) => x - f * m[p][j]);
    }
    p++;
  }
  return math.matrix(m.map((r) => r.map((x) => (Math.abs(x) < 1e-14 * scale ? 0 : x))));
}

/** geninv(A): the left inverse (AᵀA)⁻¹Aᵀ of a matrix with at least as many rows as columns. */
function geninv(A: unknown) {
  const M = numericMatrix(A, 'geninv');
  if (M.length < M[0].length) throw new Error('geninv: the matrix needs at least as many rows as columns');
  const At = M[0].map((_, j) => M.map((r) => r[j]));
  const AtA = At.map((r) => At.map((q) => r.reduce((s, x, k) => s + x * q[k], 0)));
  const inv = inverse(AtA);
  return math.matrix(inv.map((r) => At[0].map((_, j) => r.reduce((s, x, k) => s + x * At[k][j], 0))));
}

/** Hyperbolic functions of an angle: Mathcad's deg is a plain factor π/180. */
function hyperbolic(name: 'sinh' | 'cosh' | 'tanh' | 'coth' | 'sech' | 'csch') {
  const f = math[name] as unknown as (x: unknown) => unknown;
  return (x: unknown) => {
    if (isUnit(x) && (x as Unit).equalBase(math.unit(1, 'rad'))) return f((x as Unit).toNumber('rad'));
    return f(x);
  };
}

/**
 * vectorize(expr): Mathcad's vectorize arrow. The expression is evaluated element by element
 * over every vector (or matrix) it names, so scalar functions and programs apply to each element.
 */
function vectorize(args: MathNode[], _m: unknown, scope: ScopeLike) {
  if (args.length !== 1) throw new Error('vectorize(expression) takes one expression');
  // matrix literals in the expression are operands too: each becomes a name bound to its value
  const literals: unknown[] = [];
  const expr = args[0].transform((n: MathNode) => {
    if (n.type !== 'ArrayNode') return n;
    literals.push(compileNode(n).evaluate(scope));
    return new math.SymbolNode(`__vec${literals.length - 1}`);
  });
  const local0 = new ChainScope(scope);
  literals.forEach((v, k) => local0.set(`__vec${k}`, normalize(v)));
  scope = local0;
  const body = compileNode(expr);
  const names = [...freeSymbols(expr)].filter((n) => scope.has(n) && isArrayValue(scope.get(n)));
  if (!names.length) return body.evaluate(scope);
  const arrays = names.map((n) => toVector(scope.get(n)));
  const len = arrays[0].length;
  if (arrays.some((a) => a.length !== len)) throw new Error(`vectorize: ${names.join(', ')} have different numbers of elements`);
  const local = new ChainScope(scope);
  const out = Array.from({ length: len }, (_, i) => {
    names.forEach((n, k) => local.set(n, arrays[k][i]));
    return body.evaluate(local);
  });
  const size = math.size(scope.get(names[0]) as never) as unknown as number[];
  return size.length === 2 && size[1] > 1 ? math.reshape(math.matrix(out as never), size) : normalize(vec(out));
}
vectorize.rawArgs = true;

const MATHCAD_LIBRARY: Record<string, unknown> = {
  vectorize,
  match, lookup, vlookup, hlookup, vhlookup, trim, logspace, linspace,
  IsArray: (x: unknown) => (isArrayValue(x) ? 1 : 0),
  IsScalar: (x: unknown) => (isArrayValue(x) || typeof x === 'string' ? 0 : 1),
  IsString: (x: unknown) => (typeof x === 'string' ? 1 : 0),
  skew, kurt, percentile, Rank: rankOf, cvar, histogram,
  cond1: cond(norm1), cond2: cond(norm2), conde: cond(normE), condi: cond(normInf),
  rref, geninv,
  svds: (A: unknown) => vec(singularValues(numericMatrix(A, 'svds'))),
};

const clashes = Object.keys(MATHCAD_LIBRARY).filter((k) => k in math);
if (clashes.length) throw new Error(`Mathcad library names clash: ${clashes.join(', ')}`);
math.import({
  ...MATHCAD_LIBRARY,
  sinh: hyperbolic('sinh'), cosh: hyperbolic('cosh'), tanh: hyperbolic('tanh'),
  coth: hyperbolic('coth'), sech: hyperbolic('sech'), csch: hyperbolic('csch'),
  // round(x, n) of a quantity rounds its value in SI units, as Mathcad does (mathjs wants the unit)
  round: ((f) => (x: unknown, n?: unknown) => {
    if (!isUnit(x)) return n === undefined ? f(x) : f(x, n);
    const s = splitUnit(x);
    const r = n === undefined ? Math.round(s.value) : Number(f(s.value, n));
    return s.unit && (s.unit as Unit).dimensions.some((d, i) => i !== 7 && d !== 0) ? joinUnit(r, s.unit) : r;
  })(math.round as unknown as (...a: unknown[]) => unknown),
  // Mathcad's acot is π/2 − atan(x), continuous through 0 (acot(−2) = 2.6779 rad)
  acot: ((f) => (x: unknown) => (typeof x === 'number' ? Math.PI / 2 - Math.atan(x) : f(x)))(math.acot as unknown as (x: unknown) => unknown),
}, { override: true });

