// SMath Studio built-ins that imported SMath worksheets use and the core library lacks, under
// their SMath names: roots (a root from an initial value), subs (SMath's at: substitution), xy2pol / pol2xy
// (polar coordinates), minor and Clear. Semantics follow SMath's function reference, checked against values SMath saved
// with real worksheets.
import type { MathNode } from 'mathjs';
import { math, isUnit, splitUnit, joinUnit } from './math';
import { vec, num, int, matrix2D, engineCtx, tick } from './library';
import * as N from './numeric';
import { compileNode } from './compile';
import { ChainScope, type ScopeLike } from './scope';

type Raw = ((args: MathNode[], m: unknown, scope: ScopeLike) => unknown) & { rawArgs?: boolean };

const unwrap = (n: MathNode): MathNode => (n.type === 'ParenthesisNode' ? unwrap((n as unknown as { content: MathNode }).content) : n);

/** Where f changes sign or is zero on [a, b] (n equal steps), each refined to a root. */
function allRoots(f: (x: number) => number, a: number, b: number, n = 400): number[] {
  const out: number[] = [];
  const h = (b - a) / n;
  let x0 = a, f0 = f(a);
  if (f0 === 0) out.push(a);
  for (let k = 1; k <= n; k++) {
    tick();
    const x1 = k === n ? b : a + k * h, f1 = f(x1);
    if (Number.isFinite(f0) && Number.isFinite(f1)) {
      if (f1 === 0) out.push(x1);
      else if (f0 !== 0 && Math.sign(f0) !== Math.sign(f1)) {
        const r = N.brent(f, x0, x1);
        // a pole changes sign too: a root makes |f| small
        if (Math.abs(f(r)) <= 1e-6 * Math.max(Math.abs(f0), Math.abs(f1))) out.push(r);
      }
    }
    x0 = x1;
    f0 = f1;
  }
  return out;
}

/** An equation a = b as the expression a − b (just a when b is 0, which has any unit). */
function difference(n: MathNode): MathNode {
  const f = unwrap(n);
  if (f.type !== 'OperatorNode' || (f as unknown as { fn: string }).fn !== 'equal') return f;
  const [a, b] = (f as unknown as { args: MathNode[] }).args;
  const zero = (z: MathNode) => z.type === 'ConstantNode' && (z as unknown as { value: unknown }).value === 0;
  return zero(b) ? a : zero(a) ? b : (new math.OperatorNode('-', 'subtract', [a, b]) as unknown as MathNode);
}

/**
 * roots(f(x), x, x₀): a root of f near x₀ (roots(f(x), x) starts from the value x has).
 * roots(f(x), x, a, b): every root between a and b — SMath's solve(f(x), x, a, b), one value
 * or a vector of them. An equation a = b stands for a − b. Systems (roots of sys(…) in
 * several unknowns) are solve blocks here.
 */
const roots: Raw = (args, _m, scope) => {
  if (args.length === 4) {
    const v = unwrap(args[1]);
    if (v.type !== 'SymbolNode') throw new Error('roots: the second argument must be a variable name');
    const name = (v as unknown as { name: string }).name;
    const lo = splitUnit(compileNode(args[2]).evaluate(scope)), hi = splitUnit(compileNode(args[3]).evaluate(scope));
    const unit = lo.unit ?? hi.unit;
    const body = compileNode(difference(args[0]));
    const local = new ChainScope(scope);
    const f = (x: number) => {
      local.set(name, joinUnit(x, unit));
      try {
        return splitUnit(body.evaluate(local)).value;
      } catch (e) {
        if (/aborted/.test((e as Error).message)) throw e;
        return NaN;
      }
    };
    const found = allRoots(f, Math.min(lo.value, hi.value), Math.max(lo.value, hi.value));
    if (!found.length) throw new Error(`roots: no root of the expression between ${lo.value} and ${hi.value}`);
    const vals = found.map((x) => joinUnit(x, unit));
    return vals.length === 1 ? vals[0] : vec(vals);
  }
  if (args.length < 2 || args.length > 3) throw new Error('roots(f(x), x, x₀): an expression, its variable and an initial value');
  const v = unwrap(args[1]);
  if (v.type !== 'SymbolNode') throw new Error('roots: the second argument must be a variable name (for a system of equations use a solve block)');
  const name = (v as unknown as { name: string }).name;
  const f = difference(args[0]);
  const local = new ChainScope(scope);
  const x0 = args.length === 3 ? compileNode(args[2]).evaluate(scope) : undefined;
  if (args.length === 3) local.set(name, x0);
  else if (!scope.has(name)) throw new Error(`roots: give an initial value, roots(f(${name}), ${name}, ${name}₀)`);
  const root = (math as unknown as Record<string, Raw>).root;
  try {
    return root([f, v], math, local);
  } catch (e) {
    // SMath solves from the number of an initial value whose unit the expression cannot take
    // (f(x) with x·V in it, started from v_x in V): its root is a number then
    if (!isUnit(x0) || !/unit|type of argument/i.test((e as Error).message)) throw e;
    local.set(name, splitUnit(x0).value);
    return root([f, v], math, local);
  }
};
roots.rawArgs = true;

/**
 * subs(f, x = a, y = b …): f with x set to a, y to b — SMath's at(…), named so here because
 * "at" reads as a unit (an attotonne).
 */
const subs: Raw = (args, _m, scope) => {
  if (args.length < 2) throw new Error('subs(expression, x = value, …)');
  const local = new ChainScope(scope);
  for (const a of args.slice(1)) {
    const eq = unwrap(a) as unknown as { type: string; fn?: string; args?: MathNode[] };
    const lhs = eq.args && unwrap(eq.args[0]);
    if (eq.type !== 'OperatorNode' || eq.fn !== 'equal' || !lhs || lhs.type !== 'SymbolNode') throw new Error('subs: the values are given as x = value');
    local.set((lhs as unknown as { name: string }).name, compileNode(eq.args![1]).evaluate(scope));
  }
  return compileNode(args[0]).evaluate(local);
};
subs.rawArgs = true;

/**
 * Clear(x, y …) removes the worksheet's definitions of x, y …: what follows sees them as
 * undefined (a fresh vector for x[1] := …, a symbol for SMath). Returns 1, as SMath shows.
 */
const Clear: Raw = (args, _m, scope) => {
  for (const a of args) {
    const n = unwrap(a);
    if (n.type !== 'SymbolNode') throw new Error('Clear(x, y, …) takes variable names');
    const name = (n as unknown as { name: string }).name;
    // the worksheet's scope and any layer between (a function's or a range's local scope)
    for (let s: ScopeLike | null = scope; s; s = s instanceof ChainScope ? s.parent : null) s.delete?.(name);
  }
  return 1;
};
Clear.rawArgs = true;

/** An angle as a number in radians (SMath's angles are numbers; deg and rad quantities too). */
function radians(v: unknown, what: string): number {
  if (isUnit(v)) {
    const d = (v as unknown as { dimensions: number[] }).dimensions;
    if (d.some((e, i) => e !== 0 && i !== 7)) throw new Error(`${what} must be an angle`);
    return splitUnit(v).value;
  }
  return num(v, what);
}

/** xy2pol(x, y) = [r; φ]: the distance from the origin (in the unit of x and y) and the angle in radians, −π < φ ≤ π. */
function xy2pol(x: unknown, y: unknown) {
  const a = splitUnit(x), b = splitUnit(y);
  if (!!a.unit !== !!b.unit || (a.unit && b.unit && !a.unit.equalBase(b.unit))) {
    // 0 has any unit
    if (a.value !== 0 && b.value !== 0) throw new Error('xy2pol: x and y need the same unit');
  }
  const r = math.sqrt(math.add(math.multiply(x as never, x as never), math.multiply(y as never, y as never)) as never);
  return vec([r, Math.atan2(b.value, a.value)]);
}

/** pol2xy(r, φ) = [r·cos φ; r·sin φ]. */
function pol2xy(r: unknown, phi: unknown) {
  const p = radians(phi, 'pol2xy: φ');
  return vec([math.multiply(r as never, Math.cos(p)), math.multiply(r as never, Math.sin(p))]);
}

/** minor(M, i, j): the determinant of M without row i and column j. */
function minor(M: unknown, i: unknown, j: unknown) {
  const rows = matrix2D(M);
  const n = rows.length;
  if (!n || rows.some((r) => r.length !== n)) throw new Error('minor: the matrix must be square');
  const r = int(i, 'minor: row') - engineCtx.origin, c = int(j, 'minor: column') - engineCtx.origin;
  if (r < 0 || r >= n || c < 0 || c >= n) throw new Error(`minor: row and column must be from ${engineCtx.origin} to ${n - 1 + engineCtx.origin}`);
  if (n === 1) throw new Error('minor: the matrix needs at least two rows');
  const sub = rows.filter((_, k) => k !== r).map((row) => row.filter((_, k) => k !== c));
  return math.det(math.matrix(sub as never));
}

const SMATH_LIBRARY: Record<string, unknown> = { roots, subs, xy2pol, pol2xy, minor, Clear };

// a function the shared library has by the same name and meaning (Mathcad's xy2pol, pol2xy) is
// that one; a unit by the name is an error
const units = Object.keys(SMATH_LIBRARY).filter((k) => math.Unit.isValuelessUnit(k));
if (units.length) throw new Error(`SMath library names are units: ${units.join(', ')}`);
math.import(Object.fromEntries(Object.entries(SMATH_LIBRARY).filter(([k]) => !(k in math))));
