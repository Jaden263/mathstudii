// Mathcad-style built-in function library, registered on the shared mathjs instance.
import type { MathNode, Matrix, Unit } from 'mathjs';
import { math, isMatrix, isUnit, isComplex, splitUnit, joinUnit } from './math';
import { ChainScope, type ScopeLike } from './scope';
import { compileNode } from './compile';
import * as N from './numeric';

/** Worksheet-level settings the library needs (set by the evaluator before each run). */
export const engineCtx = { origin: 0, tol: 1e-9, iterationBudget: 5e6, deadline: Infinity };

type Raw = ((args: MathNode[], m: unknown, scope: ScopeLike) => unknown) & { rawArgs?: boolean };

// ---------------------------------------------------------------- helpers

export function toArray(v: unknown): unknown[] {
  if (isMatrix(v)) return v.toArray() as unknown[];
  if (Array.isArray(v)) return v;
  return [v];
}

/** Flatten a vector (1-D, n×1 or 1×n) into a JS array. */
export function toVector(v: unknown): unknown[] {
  return math.flatten(toArray(v) as never) as unknown as unknown[];
}

export function vec(values: unknown[]): Matrix {
  return math.matrix(values as never);
}

/** Numeric vector in SI with a shared unit template. */
export function numVec(v: unknown, what = 'vector'): { vals: number[]; unit: Unit | null } {
  const items = toVector(v);
  if (items.length === 0) throw new Error(`${what} is empty`);
  let unit: Unit | null = null;
  const vals = items.map((it, i) => {
    const s = splitUnit(it);
    if (i === 0) unit = s.unit;
    else if (!!s.unit !== !!unit || (s.unit && unit && !s.unit.equalBase(unit))) {
      throw new Error(`${what}: all elements must have the same units`);
    }
    return s.value;
  });
  return { vals, unit };
}

function num(v: unknown, what = 'argument'): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = splitUnit(v);
  if (s.unit) throw new Error(`${what} must be dimensionless`);
  return s.value;
}

function int(v: unknown, what = 'argument'): number {
  const n = num(v, what);
  if (!Number.isInteger(n)) throw new Error(`${what} must be an integer`);
  return n;
}

function matrix2D(v: unknown): unknown[][] {
  const a = toArray(v);
  if (a.length === 0) return [];
  if (!Array.isArray(a[0])) return a.map((x) => [x]); // vectors are columns
  return a as unknown[][];
}

function varName(node: MathNode, fn: string): string {
  if (node.type !== 'SymbolNode') throw new Error(`${fn}: second argument must be a variable name`);
  return (node as unknown as { name: string }).name;
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isComplex(v)) return v.re !== 0 || v.im !== 0;
  if (isUnit(v)) return (v.value as number) !== 0;
  if (isMatrix(v) || Array.isArray(v)) return toVector(v).every(truthy);
  return !!v;
}

export function tick(n = 1) {
  engineCtx.iterationBudget -= n;
  if (engineCtx.iterationBudget < 0) throw new Error('Calculation aborted: iteration limit exceeded (infinite loop?)');
  if ((engineCtx.iterationBudget & 4095) === 0 && performance.now() > engineCtx.deadline) {
    throw new Error('Calculation aborted: took too long (infinite loop?)');
  }
}

/** Wrap a numeric 1-D function of x so that it carries units. */
function unitFunction(body: MathNode, v: string, scope: ScopeLike, xUnit: Unit | null) {
  const compiled = compileNode(body);
  const local = new ChainScope(scope);
  const at = (xv: number) => {
    tick();
    local.set(v, joinUnit(xv, xUnit));
    return compiled.evaluate(local);
  };
  return at;
}

function mulUnits(value: number, ...units: (Unit | null)[]): unknown {
  let r: unknown = value;
  for (const u of units) if (u) r = math.multiply(r as never, u as never);
  return r;
}

function divUnits(value: number, num: Unit | null, den: Unit | null, power = 1): unknown {
  let r: unknown = value;
  if (num) r = math.multiply(r as never, num as never);
  if (den) for (let i = 0; i < power; i++) r = math.divide(r as never, den as never);
  return r;
}

// ---------------------------------------------------------------- raw (lazy) functions

const integral: Raw = (args, _m, scope) => {
  if (args.length !== 4) throw new Error('integral(f(x), x, a, b) expects 4 arguments');
  const v = varName(args[1], 'integral');
  const a = splitUnit(compileNode(args[2]).evaluate(scope));
  const b = splitUnit(compileNode(args[3]).evaluate(scope));
  if (a.unit && b.unit && !a.unit.equalBase(b.unit)) throw new Error('integral: limits have different units');
  const xUnit = a.unit ?? b.unit;
  const at = unitFunction(args[0], v, scope, xUnit);
  const mid = Number.isFinite(a.value) && Number.isFinite(b.value) ? (a.value + b.value) / 2
    : Number.isFinite(a.value) ? a.value + 1 : Number.isFinite(b.value) ? b.value - 1 : 0.5;
  const fUnit = splitUnit(at(mid)).unit;
  const value = N.integrate((x) => splitUnit(at(x)).value, a.value, b.value, 1e-11);
  return mulUnits(value, fUnit, xUnit);
};
integral.rawArgs = true;

const mcDiff: Raw = (args, _m, scope) => {
  if (args.length < 2 || args.length > 3) throw new Error('diff(f(x), x[, n]) expects 2 or 3 arguments');
  const v = varName(args[1], 'diff');
  if (!scope.has(v)) {
    throw new Error(`diff: "${v}" has no value. Define ${v} first, or use → for a symbolic derivative`);
  }
  const x = splitUnit(scope.get(v));
  const order = args.length === 3 ? int(compileNode(args[2]).evaluate(scope), 'order') : 1;
  if (order < 0 || order > 5) throw new Error('diff: order must be 0..5');
  const at = unitFunction(args[0], v, scope, x.unit);
  const fUnit = splitUnit(at(x.value)).unit;
  const d = N.derivative((t) => splitUnit(at(t)).value, x.value, order);
  return divUnits(d, fUnit, x.unit, order);
};
mcDiff.rawArgs = true;

const root: Raw = (args, _m, scope) => {
  if (args.length !== 2 && args.length !== 4) throw new Error('root(f(x), x) or root(f(x), x, a, b)');
  const v = varName(args[1], 'root');
  let xUnit: Unit | null;
  let result: number;
  if (args.length === 4) {
    const a = splitUnit(compileNode(args[2]).evaluate(scope));
    const b = splitUnit(compileNode(args[3]).evaluate(scope));
    xUnit = a.unit ?? b.unit;
    const at = unitFunction(args[0], v, scope, xUnit);
    result = N.brent((x) => splitUnit(at(x)).value, a.value, b.value);
  } else {
    if (!scope.has(v)) throw new Error(`root: give "${v}" a guess value first, or use root(f(${v}), ${v}, a, b)`);
    const g = splitUnit(scope.get(v));
    xUnit = g.unit;
    const at = unitFunction(args[0], v, scope, xUnit);
    result = N.rootFromGuess((x) => splitUnit(at(x)).value, g.value);
  }
  return joinUnit(result, xUnit);
};
root.rawArgs = true;

function iterate(args: MathNode[], scope: ScopeLike, name: string, combine: (a: unknown, b: unknown) => unknown, unit: unknown) {
  if (args.length === 1) {
    const v = compileNode(args[0]).evaluate(scope);
    return toVector(v).reduce((acc, x) => combine(acc, x), unit);
  }
  const v = varName(args[1], name);
  const body = compileNode(args[0]);
  const local = new ChainScope(scope);
  let values: unknown[];
  if (args.length === 2) {
    if (!scope.has(v)) throw new Error(`${name}: "${v}" must be a range variable or vector`);
    values = toVector(scope.get(v));
  } else if (args.length === 4) {
    const a = int(compileNode(args[2]).evaluate(scope), `${name} lower limit`);
    const b = int(compileNode(args[3]).evaluate(scope), `${name} upper limit`);
    values = [];
    for (let k = a; k <= b; k++) values.push(k);
  } else throw new Error(`${name}(f(k), k, a, b) expects 4 arguments`);
  let acc: unknown = unit;
  for (const x of values) {
    tick();
    local.set(v, x);
    acc = combine(acc, body.evaluate(local));
  }
  return acc;
}

const mcSum: Raw = (args, _m, scope) =>
  iterate(args, scope, 'sum', (a, b) => (a === null ? b : math.add(a as never, b as never)), null) ?? 0;
mcSum.rawArgs = true;

const mcProd: Raw = (args, _m, scope) =>
  iterate(args, scope, 'prod', (a, b) => (a === null ? b : math.multiply(a as never, b as never)), null) ?? 1;
mcProd.rawArgs = true;

const ifFn: Raw = (args, _m, scope) => {
  if (args.length !== 3) throw new Error('if(condition, value_if_true, value_if_false)');
  return truthy(compileNode(args[0]).evaluate(scope))
    ? compileNode(args[1]).evaluate(scope)
    : compileNode(args[2]).evaluate(scope);
};
ifFn.rawArgs = true;

// ---------------------------------------------------------------- indexing

function zeroBased(i: unknown, len: number): number | number[] {
  if (i === '__ALL__') return Array.from({ length: len }, (_, k) => k);
  if (isMatrix(i) || Array.isArray(i)) return toVector(i).map((x) => int(x, 'index') - engineCtx.origin);
  const k = int(i, 'index') - engineCtx.origin;
  if (k < 0 || k >= len) throw new Error(`Index ${k + engineCtx.origin} out of range (ORIGIN = ${engineCtx.origin}, size ${len})`);
  return k;
}

export function indexValue(obj: unknown, ...idx: unknown[]): unknown {
  if (typeof obj === 'string') return obj.charAt(zeroBased(idx[0], obj.length) as number);
  if (!isMatrix(obj) && !Array.isArray(obj)) throw new Error('Subscript applied to a value that is not an array');
  const M = isMatrix(obj) ? obj : math.matrix(obj as never);
  const size = M.size();
  let index: number[] | (number | number[])[];
  if (size.length === 1) {
    if (idx.length === 2) {
      if (zeroBased(idx[1], 1) !== 0) throw new Error('Column index out of range for a vector');
    } else if (idx.length !== 1) throw new Error('Vectors take one subscript');
    index = [zeroBased(idx[0], size[0])];
  } else if (size.length === 2) {
    if (idx.length === 1) {
      if (size[1] === 1) index = [zeroBased(idx[0], size[0]), 0];
      else if (size[0] === 1) index = [0, zeroBased(idx[0], size[1])];
      else throw new Error('Matrices take two subscripts [row, col]');
    } else if (idx.length === 2) index = [zeroBased(idx[0], size[0]), zeroBased(idx[1], size[1])];
    else throw new Error('Matrices take two subscripts [row, col]');
  } else throw new Error('Arrays with more than two dimensions are not supported');
  const res = math.subset(M, math.index(...(index as never[])));
  return normalize(res);
}

/** Assign an element (auto-resizing, zero-filled like Mathcad). */
export function assignIndex(current: unknown, idx: unknown[], value: unknown): Matrix {
  const o = engineCtx.origin;
  const ks = idx.map((i) => {
    const k = int(i, 'index') - o;
    if (k < 0) throw new Error(`Index below ORIGIN (${o})`);
    return k;
  });
  let M: Matrix;
  if (isMatrix(current)) M = current.clone();
  else if (Array.isArray(current)) M = math.matrix(current as never);
  else M = ks.length === 1 ? math.matrix([]) : (math.zeros([0, 0], 'dense') as Matrix);
  if (ks.length === 1 && M.size().length === 2) {
    if (M.size()[1] === 1) ks.push(0);
    else if (M.size()[0] === 1) ks.unshift(0);
    else throw new Error('Matrices take two subscripts [row, col]');
  }
  if (ks.length === 2 && M.size().length === 1) {
    if (M.size()[0] === 0) M = math.zeros([0, 0], 'dense') as Matrix;
    else M = math.reshape(M, [M.size()[0], 1]) as Matrix;
  }
  return math.subset(M, math.index(...ks), value as never, 0 as never) as Matrix;
}

/** Column vectors (n×1) become 1-D vectors so subscripts and products behave like Mathcad. */
export function normalize(v: unknown): unknown {
  if (Array.isArray(v)) v = math.matrix(v as never);
  if (isMatrix(v)) {
    const s = v.size();
    if (s.length === 2 && s[1] === 1 && s[0] > 0) return math.reshape(v, [s[0]]);
  }
  return v;
}

function transposeMc(v: unknown): unknown {
  if (isMatrix(v) || Array.isArray(v)) {
    const M = isMatrix(v) ? v : math.matrix(v as never);
    const s = M.size();
    if (s.length === 1) return math.reshape(M, [1, s[0]]);
    return normalize(math.transpose(M));
  }
  return v;
}

// ---------------------------------------------------------------- vectors & matrices

function rows(v: unknown) {
  if (!isMatrix(v) && !Array.isArray(v)) return 0;
  return (isMatrix(v) ? v.size() : math.size(v as never) as unknown as number[])[0];
}

function cols(v: unknown) {
  if (!isMatrix(v) && !Array.isArray(v)) return 0;
  const s = isMatrix(v) ? v.size() : (math.size(v as never) as unknown as number[]);
  return s.length === 1 ? 1 : s[1];
}

function augment(...ms: unknown[]) {
  const parts = ms.map(matrix2D);
  const n = parts[0].length;
  if (!parts.every((p) => p.length === n)) throw new Error('augment: all arguments need the same number of rows');
  return math.matrix(Array.from({ length: n }, (_, i) => parts.flatMap((p) => p[i])) as never);
}

function stack(...ms: unknown[]) {
  const parts = ms.map((m) => (isMatrix(m) && m.size().length === 1) || (!isMatrix(m) && !Array.isArray(m)) ? toVector(m).map((x) => [x]) : matrix2D(m));
  const c = parts[0][0]?.length ?? 0;
  if (!parts.every((p) => p.every((r) => r.length === c))) throw new Error('stack: all arguments need the same number of columns');
  return normalize(math.matrix(parts.flat() as never));
}

function submatrix(A: unknown, ir: unknown, jr: unknown, ic: unknown, jc: unknown) {
  const M = matrix2D(A);
  const o = engineCtx.origin;
  const [r0, r1, c0, c1] = [ir, jr, ic, jc].map((x) => int(x) - o);
  const out: unknown[][] = [];
  for (let i = Math.min(r0, r1); i <= Math.max(r0, r1); i++) {
    if (!M[i]) throw new Error('submatrix: row index out of range');
    const row: unknown[] = [];
    for (let j = Math.min(c0, c1); j <= Math.max(c0, c1); j++) {
      if (M[i][j] === undefined) throw new Error('submatrix: column index out of range');
      row.push(M[i][j]);
    }
    out.push(row);
  }
  return normalize(math.matrix(out as never));
}

function colOf(A: unknown, j: unknown) {
  const M = matrix2D(A);
  const k = int(j) - engineCtx.origin;
  if (k < 0 || k >= (M[0]?.length ?? 0)) throw new Error('Column index out of range');
  return vec(M.map((r) => r[k]));
}

function rowOf(A: unknown, i: unknown) {
  const M = matrix2D(A);
  const k = int(i) - engineCtx.origin;
  if (!M[k]) throw new Error('Row index out of range');
  return math.matrix([M[k]] as never);
}

function numMatrix(A: unknown): number[][] {
  return matrix2D(A).map((r) => r.map((x) => num(x, 'matrix element')));
}

function eigs(A: unknown) {
  const r = math.eigs(math.matrix(matrix2D(A) as never)) as unknown as {
    values: unknown;
    eigenvectors?: { value: unknown; vector: unknown }[];
    vectors?: unknown;
  };
  return r;
}

function eigenvecs(A: unknown) {
  const r = eigs(A);
  if (r.eigenvectors) {
    const vs = r.eigenvectors.map((e) => toVector(e.vector));
    const n = vs.length;
    return math.matrix(Array.from({ length: vs[0].length }, (_, i) => Array.from({ length: n }, (_, j) => vs[j][i])) as never);
  }
  return r.vectors;
}

function eigenvec(A: unknown, lambda: unknown) {
  const r = eigs(A);
  if (!r.eigenvectors) throw new Error('eigenvec not supported for this matrix');
  let best = r.eigenvectors[0];
  let bestD = Infinity;
  for (const e of r.eigenvectors) {
    const d = Number(math.abs(math.subtract(e.value as never, lambda as never) as never));
    if (d < bestD) { bestD = d; best = e; }
  }
  const v = toVector(best.vector);
  const nrm = Number(math.norm(v as never));
  return vec(v.map((x) => math.divide(x as never, nrm)));
}

function sortVec(v: unknown) {
  const items = toVector(v);
  return vec([...items].sort((a, b) => (math.compare(a as never, b as never) as number)));
}

function csort(A: unknown, j: unknown) {
  const M = matrix2D(A);
  const k = int(j) - engineCtx.origin;
  return math.matrix([...M].sort((a, b) => math.compare(a[k] as never, b[k] as never) as number) as never);
}

function rsort(A: unknown, i: unknown) {
  const M = matrix2D(A);
  const k = int(i) - engineCtx.origin;
  const order = M[k].map((_, j) => j).sort((a, b) => math.compare(M[k][a] as never, M[k][b] as never) as number);
  return math.matrix(M.map((r) => order.map((j) => r[j])) as never);
}

function matrixFn(m: unknown, n: unknown, f: unknown) {
  if (typeof f !== 'function') throw new Error('matrix(m, n, f): f must be a function of (i, j)');
  const r = int(m), c = int(n);
  const o = engineCtx.origin;
  return math.matrix(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => (f as (a: number, b: number) => unknown)(i + o, j + o))) as never);
}

// ---------------------------------------------------------------- statistics

function stat(v: unknown, f: (xs: number[]) => number, power = 1) {
  const { vals, unit } = numVec(v);
  const r = f(vals);
  return power === 0 ? r : joinUnit(r, unit && power === 2 ? (math.multiply(unit, unit) as Unit) : unit);
}

const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const varOf = (xs: number[], sample: boolean) => {
  const m = meanOf(xs);
  const ss = xs.reduce((a, b) => a + (b - m) * (b - m), 0);
  if (sample && xs.length < 2) throw new Error('Sample variance needs at least two values');
  return ss / (sample ? xs.length - 1 : xs.length);
};

function corr(a: unknown, b: unknown) {
  const x = numVec(a).vals, y = numVec(b).vals;
  if (x.length !== y.length) throw new Error('corr: vectors must have the same length');
  const mx = meanOf(x), my = meanOf(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function linearFit(a: unknown, b: unknown) {
  const X = numVec(a, 'vx'), Y = numVec(b, 'vy');
  if (X.vals.length !== Y.vals.length) throw new Error('vx and vy must have the same length');
  const [c0, c1] = N.polyfit(X.vals, Y.vals, 1);
  return { intercept: joinUnit(c0, Y.unit), slope: divUnits(c1, Y.unit, X.unit) };
}

function hist(intervals: unknown, data: unknown) {
  const d = numVec(data).vals;
  if (typeof intervals === 'number') {
    const n = int(intervals, 'number of bins');
    const lo = Math.min(...d), hi = Math.max(...d);
    const w = (hi - lo) / n || 1;
    const counts = new Array(n).fill(0);
    for (const x of d) counts[Math.min(n - 1, Math.floor((x - lo) / w))]++;
    return vec(counts);
  }
  const edges = numVec(intervals).vals;
  const counts = new Array(Math.max(0, edges.length - 1)).fill(0);
  for (const x of d) for (let k = 0; k < edges.length - 1; k++) if (x > edges[k] && x <= edges[k + 1]) counts[k]++;
  return vec(counts);
}

// ---------------------------------------------------------------- interpolation & fitting

function linterpFn(vx: unknown, vy: unknown, x: unknown) {
  const X = numVec(vx, 'vx'), Y = numVec(vy, 'vy');
  const xv = splitUnit(x);
  return joinUnit(N.linterp(X.vals, Y.vals, xv.value), Y.unit);
}

/** cspline returns a coefficient vector; interp(vs, vx, vy, x) evaluates it (Mathcad convention). */
function cspline(vx: unknown, vy: unknown) {
  const X = numVec(vx, 'vx'), Y = numVec(vy, 'vy');
  return vec(N.splineSecondDerivs(X.vals, Y.vals));
}

function interp(vs: unknown, vx: unknown, vy: unknown, x: unknown) {
  const X = numVec(vx, 'vx'), Y = numVec(vy, 'vy');
  const s = toVector(vs).map((v) => num(v));
  if (s.length === X.vals.length) return joinUnit(N.splineEval(X.vals, Y.vals, s, splitUnit(x).value), Y.unit);
  // regress/polyfit coefficient vector
  const xv = splitUnit(x).value;
  return joinUnit(s.reduce((acc, c, k) => acc + c * Math.pow(xv, k), 0), Y.unit);
}

function polyfitFn(vx: unknown, vy: unknown, n: unknown) {
  const X = numVec(vx, 'vx'), Y = numVec(vy, 'vy');
  return vec(N.polyfit(X.vals, Y.vals, int(n, 'degree')));
}

function polyval(c: unknown, x: unknown) {
  const cs = toVector(c);
  let acc: unknown = 0;
  for (let k = cs.length - 1; k >= 0; k--) acc = math.add(math.multiply(acc as never, x as never) as never, cs[k] as never);
  return acc;
}

function genfit(vx: unknown, vy: unknown, vg: unknown, F: unknown) {
  if (typeof F !== 'function') throw new Error('genfit(vx, vy, vg, F): F must be a function F(x, u) of x and the parameter vector u');
  const X = toVector(vx), Y = numVec(vy, 'vy').vals;
  const g = toVector(vg).map((v) => num(v, 'guess'));
  const f = F as (x: unknown, u: unknown) => unknown;
  const res = N.levenbergMarquardt((u) => X.map((x, i) => splitUnit(f(x, vec(u))).value - Y[i]), g);
  return vec(res.x);
}

function polyroots(v: unknown) {
  const c = toVector(v).map((x) => num(x, 'coefficient'));
  return vec(N.polyRoots(c).map((z) => (z.im === 0 ? z.re : math.complex(z.re, z.im))));
}

// ---------------------------------------------------------------- transforms & ODEs

function complexParts(v: unknown) {
  const items = toVector(v);
  return {
    re: items.map((x) => (isComplex(x) ? x.re : num(x))),
    im: items.map((x) => (isComplex(x) ? x.im : 0)),
  };
}

function packComplex(re: number[], im: number[], scale: number) {
  return vec(re.map((r, k) => {
    const i = im[k] * scale;
    return Math.abs(i) < 1e-14 * Math.max(1, Math.abs(r * scale)) ? r * scale : math.complex(r * scale, i);
  }));
}

function cfft(v: unknown) {
  const { re, im } = complexParts(v);
  const r = N.dft(re, im, false);
  return packComplex(r.re, r.im, 1 / Math.sqrt(re.length));
}

function icfft(v: unknown) {
  const { re, im } = complexParts(v);
  const r = N.dft(re, im, true);
  return packComplex(r.re, r.im, 1 / Math.sqrt(re.length));
}

/** Mathcad fft: real input, returns the n/2+1 non-negative frequency terms. */
function fft(v: unknown) {
  const full = toVector(cfft(v));
  return vec(full.slice(0, Math.floor(full.length / 2) + 1));
}

function ifft(v: unknown) {
  const half = toVector(v);
  const n = 2 * (half.length - 1);
  const full = [...half];
  for (let k = half.length - 2; k >= 1; k--) full.push(math.conj(half[k] as never));
  const r = toVector(icfft(vec(full.slice(0, n))));
  return vec(r.map((x) => (isComplex(x) ? x.re : x)));
}

function odeSolve(method: 'rk4' | 'rk45') {
  return (y0: unknown, x1: unknown, x2: unknown, npts: unknown, D: unknown) => {
    if (typeof D !== 'function') throw new Error('Last argument must be a function D(x, y) returning the derivative vector');
    const y = toVector(y0).map((v) => num(v, 'initial value'));
    const a = num(x1, 'x1'), b = num(x2, 'x2');
    const n = int(npts, 'number of points');
    const d = D as (x: number, y: Matrix) => unknown;
    const deriv = (x: number, yv: number[]) => {
      tick();
      const r = d(x, vec(yv));
      return toVector(r).map((v) => num(v, 'derivative'));
    };
    const rowsOut = method === 'rk4' ? N.rk4(y, a, b, n, deriv) : N.rk45(y, a, b, n, deriv);
    return math.matrix(rowsOut as never);
  };
}

// ---------------------------------------------------------------- distributions

const dnorm = (x: unknown, mu: unknown = 0, s: unknown = 1) => {
  const z = (num(x) - num(mu)) / num(s);
  return Math.exp(-0.5 * z * z) / (num(s) * Math.sqrt(2 * Math.PI));
};
const pnorm = (x: unknown, mu: unknown = 0, s: unknown = 1) => 0.5 * (1 + N.erf((num(x) - num(mu)) / (num(s) * Math.SQRT2)));
const qnorm = (p: unknown, mu: unknown = 0, s: unknown = 1) => num(mu) + num(s) * N.normInv(num(p));
const pt = (x: unknown, d: unknown) => {
  const t = num(x), v = num(d);
  const ib = N.betaI(v / (v + t * t), v / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
};
const dt = (x: unknown, d: unknown) => {
  const t = num(x), v = num(d);
  return Math.exp(N.gammaln((v + 1) / 2) - N.gammaln(v / 2)) / Math.sqrt(v * Math.PI) * Math.pow(1 + (t * t) / v, -(v + 1) / 2);
};
const pchisq = (x: unknown, d: unknown) => N.gammaP(num(d) / 2, num(x) / 2);
const dchisq = (x: unknown, d: unknown) => {
  const xv = num(x), k = num(d);
  if (xv < 0) return 0;
  return Math.exp((k / 2 - 1) * Math.log(xv) - xv / 2 - (k / 2) * Math.LN2 - N.gammaln(k / 2));
};
const pF = (x: unknown, d1: unknown, d2: unknown) => {
  const xv = num(x), a = num(d1), b = num(d2);
  return xv <= 0 ? 0 : N.betaI((a * xv) / (a * xv + b), a / 2, b / 2);
};
const logChoose = (n: number, k: number) => N.gammaln(n + 1) - N.gammaln(k + 1) - N.gammaln(n - k + 1);
const dbinom = (k: unknown, n: unknown, p: unknown) => {
  const kk = int(k), nn = int(n), pp = num(p);
  if (kk < 0 || kk > nn) return 0;
  return Math.exp(logChoose(nn, kk) + kk * Math.log(pp) + (nn - kk) * Math.log1p(-pp));
};
const pbinom = (k: unknown, n: unknown, p: unknown) => {
  let s = 0;
  for (let i = 0; i <= Math.floor(num(k)); i++) s += dbinom(i, n, p);
  return Math.min(1, s);
};
const dpois = (k: unknown, l: unknown) => {
  const kk = int(k), lam = num(l);
  return kk < 0 ? 0 : Math.exp(kk * Math.log(lam) - lam - N.gammaln(kk + 1));
};
const ppois = (k: unknown, l: unknown) => {
  let s = 0;
  for (let i = 0; i <= Math.floor(num(k)); i++) s += dpois(i, l);
  return Math.min(1, s);
};

function randomVec(m: unknown, f: () => number) {
  const n = int(m, 'count');
  return vec(Array.from({ length: n }, f));
}

function gaussRandom() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// ---------------------------------------------------------------- registration

const special = (f: (n: number, x: number) => number, fixedN?: number) =>
  fixedN === undefined ? (n: unknown, x: unknown) => f(int(n, 'order'), num(x)) : (x: unknown) => f(fixedN, num(x));

function callOrMultiply(name: unknown, f: unknown, ...args: unknown[]) {
  if (typeof f === 'function') return (f as (...a: unknown[]) => unknown)(...args);
  if (args.length === 1) return math.multiply(f as never, args[0] as never);
  throw new Error(`"${String(name)}" is not a function`);
}

/** Mathcad's |x|: magnitude of a vector, determinant of a square matrix, else absolute value. */
function magnitude(x: unknown) {
  if (isMatrix(x) || Array.isArray(x)) {
    const s = isMatrix(x) ? x.size() : (math.size(x as never) as unknown as number[]);
    if (s.length === 2 && s[0] === s[1] && s[0] > 1) return math.det(x as never);
    return math.sqrt(toVector(x).reduce((acc: unknown, v) => math.add(acc as never, math.multiply(v as never, math.conj(v as never)) as never), 0) as never);
  }
  return math.abs(x as never);
}

const LIBRARY: Record<string, unknown> = {
    __I: math.complex(0, 1),
    mag: magnitude,
    __call: callOrMultiply,
    __idx: indexValue,
    integral,
    mcDiff,
    deriv: mcDiff,
    root,
    mcSum,
    mcProd,
    if: ifFn,
    mcTranspose: transposeMc,
    mcLn: (x: unknown) => math.log(x as never),
    mcLog: (x: unknown, b?: unknown) => (b === undefined ? math.log10(x as never) : math.log(x as never, b as never)),
    mcSort: sortVec,
    mcRange: (a: unknown, b: unknown, s: unknown = 1) => math.range(num(a), num(b), num(s), true),
    mcStdevP: (v: unknown) => stat(v, (xs) => Math.sqrt(varOf(xs, false))),
    mcStdevS: (v: unknown) => stat(v, (xs) => Math.sqrt(varOf(xs, true))),
    mcVarP: (v: unknown) => stat(v, (xs) => varOf(xs, false), 2),
    mcVarS: (v: unknown) => stat(v, (xs) => varOf(xs, true), 2),
    Re: (z: unknown) => math.re(z as never),
    Im: (z: unknown) => math.im(z as never),
    trunc: (x: unknown) => math.fix(x as never),
    erfc: (x: unknown) => 1 - N.erf(num(x)),
    combin: (n: unknown, k: unknown) => math.combinations(int(n) as never, int(k) as never),
    permut: (n: unknown, k: unknown) => math.permutations(int(n) as never, int(k) as never),
    Heaviside: (x: unknown) => (num(x) >= 0 ? 1 : 0),
    Φ: (x: unknown) => (num(x) >= 0 ? 1 : 0),
    δ: (m: unknown, n: unknown) => (math.equal(m as never, n as never) ? 1 : 0),
    kronecker: (m: unknown, n: unknown) => (math.equal(m as never, n as never) ? 1 : 0),
    csgn: (z: unknown) => { const c = math.complex(z as never) as unknown as { re: number; im: number }; return c.re > 0 || (c.re === 0 && c.im > 0) ? 1 : c.re === 0 && c.im === 0 ? 0 : -1; },
    signum: (z: unknown) => (isComplex(z) ? math.divide(z as never, math.abs(z as never) as never) : Math.sign(num(z))),
    // vectors & matrices
    rows,
    cols,
    length: (v: unknown) => toVector(v).length,
    last: (v: unknown) => toVector(v).length - 1 + engineCtx.origin,
    augment,
    stack,
    submatrix,
    col: colOf,
    mcRow: rowOf,
    tr: (A: unknown) => math.trace(math.matrix(matrix2D(A) as never)),
    rank: (A: unknown) => N.matrixRank(numMatrix(A)),
    eigenvals: (A: unknown) => normalize(eigs(A).values),
    eigenvecs,
    eigenvec,
    mcLsolve: (A: unknown, b: unknown) => normalize(math.lusolve(math.matrix(matrix2D(A) as never), vec(toVector(b)) as never)),
    norm1: (A: unknown) => math.norm(math.matrix(matrix2D(A) as never), 1),
    norm2: (A: unknown) => {
      const M = math.matrix(matrix2D(A) as never);
      const ev = toVector(math.eigs(math.multiply(math.transpose(M), M) as never).values).map((x) => Number(math.re(x as never)));
      return Math.sqrt(Math.max(...ev));
    },
    norme: (A: unknown) => math.norm(math.matrix(matrix2D(A) as never), 'fro'),
    normi: (A: unknown) => math.norm(math.matrix(matrix2D(A) as never), Infinity),
    reverse: (v: unknown) => vec([...toVector(v)].reverse()),
    csort,
    rsort,
    mcMatrix: matrixFn,
    // statistics
    mcCorr: corr,
    slope: (a: unknown, b: unknown) => linearFit(a, b).slope,
    intercept: (a: unknown, b: unknown) => linearFit(a, b).intercept,
    line: (a: unknown, b: unknown) => { const f = linearFit(a, b); return vec([f.intercept, f.slope]); },
    hist,
    // interpolation & fitting
    linterp: linterpFn,
    cspline,
    lspline: cspline,
    pspline: cspline,
    interp,
    polyfit: polyfitFn,
    regress: polyfitFn,
    polyval,
    genfit,
    polyroots,
    // transforms & ODEs
    mcFft: fft,
    mcIfft: ifft,
    cfft,
    icfft,
    rkfixed: odeSolve('rk4'),
    Rkadapt: odeSolve('rk45'),
    rkadapt: odeSolve('rk45'),
    // distributions
    dnorm, pnorm, qnorm,
    dunif: (x: unknown, a: unknown, b: unknown) => (num(x) >= num(a) && num(x) <= num(b) ? 1 / (num(b) - num(a)) : 0),
    punif: (x: unknown, a: unknown, b: unknown) => Math.min(1, Math.max(0, (num(x) - num(a)) / (num(b) - num(a)))),
    qunif: (p: unknown, a: unknown, b: unknown) => num(a) + num(p) * (num(b) - num(a)),
    dexp: (x: unknown, r: unknown) => (num(x) < 0 ? 0 : num(r) * Math.exp(-num(r) * num(x))),
    pexp: (x: unknown, r: unknown) => (num(x) < 0 ? 0 : 1 - Math.exp(-num(r) * num(x))),
    qexp: (p: unknown, r: unknown) => -Math.log(1 - num(p)) / num(r),
    dt, pt,
    qt: (p: unknown, d: unknown) => N.invertCdf((x) => pt(x, d), num(p), -10, 10),
    dchisq, pchisq,
    qchisq: (p: unknown, d: unknown) => N.invertCdf((x) => pchisq(x, d), num(p), 0, Math.max(1, num(d) * 4)),
    pF,
    qF: (p: unknown, d1: unknown, d2: unknown) => N.invertCdf((x) => pF(x, d1, d2), num(p), 0, 10),
    dbinom, pbinom, dpois, ppois,
    rnd: (x: unknown) => Math.random() * num(x),
    runif: (m: unknown, a: unknown, b: unknown) => randomVec(m, () => num(a) + Math.random() * (num(b) - num(a))),
    rnorm: (m: unknown, mu: unknown, s: unknown) => randomVec(m, () => num(mu) + num(s) * gaussRandom()),
    // special functions
    J0: special(N.besselJ, 0), J1: special(N.besselJ, 1), Jn: special(N.besselJ),
    Y0: special(N.besselY, 0), Y1: special(N.besselY, 1), Yn: special(N.besselY),
    I0: special(N.besselI, 0), I1: special(N.besselI, 1), In: special(N.besselI),
    K0: special(N.besselK, 0), K1: special(N.besselK, 1), Kn: special(N.besselK),
    // strings
    mcConcat: (...s: unknown[]) => s.map(String).join(''),
    strlen: (s: unknown) => String(s).length,
    substr: (s: unknown, start: unknown, n: unknown) => String(s).substr(int(start), int(n)),
    num2str: (x: unknown) => math.format(x as never, { precision: 15 }),
    str2num: (s: unknown) => math.evaluate(String(s)),
    search: (s: unknown, sub: unknown, start: unknown = 0) => String(s).indexOf(String(sub), int(start)),
    // units
    UnitsOf: (x: unknown) => {
      const s = splitUnit(x);
      return s.unit ?? 1;
    },
  };

const clashes = Object.keys(LIBRARY).filter((k) => k in math);
if (clashes.length) throw new Error(`Library names clash with mathjs: ${clashes.join(', ')}`);
// Some names (dt, In, …) are also obscure units (deci-tonne, …); functions win, as in Mathcad.
export const UNIT_SHADOWED = Object.keys(LIBRARY).filter((k) => math.Unit.isValuelessUnit(k));
math.import(LIBRARY, { override: true });
