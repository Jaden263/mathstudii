// Evaluating a formula's syntax tree: operators lifted over arrays element by element (as
// Excel 365 does, so =A1:A3*2 gives three values), function calls, references and names.
// Errors are thrown as XlError inside functions and come back out as values.
import type { Node } from './formula';
import { type Area } from './refs';
import { Arr, compare, ERR, Ref, round15, toBool, toNumber, toText, XlError, type Scalar, type Value } from './values';

export interface Ctx {
  /** Sheet, row and column of the cell being calculated. */
  sheet: number;
  row: number;
  col: number;
  date1904: boolean;
  /** NOW() for this calculation, ms since 1970. */
  now: number;
  get(sheet: number, r: number, c: number): Scalar;
  /** The area holding everything on a sheet (whole columns are read only that far). */
  used(sheet: number): Area | null;
  sheetIndex(name: string): number;
  sheetCount(): number;
  /** A defined name's value (a reference or a value); undefined when there is no such name. */
  name(name: string, sheet?: string): Value | undefined;
  /** Functions called that do not exist. */
  unknown(name: string): void;
  /** Ranges already read as arrays during this calculation. */
  arrays?: Map<string, Arr>;
  /** The area a formula's array result fills (its own value calculated first); null when it gave one value. */
  spillArea?(sheet: number, r: number, c: number): Area | null;
}

export type Fn = (args: Value[], ctx: Ctx) => Value;
export type LazyFn = (args: (() => Value)[], ctx: Ctx) => Value;
export interface FnDef {
  min: number;
  max: number;
  fn?: Fn;
  lazy?: LazyFn;
}

export const FUNCTIONS = new Map<string, FnDef>();

export function register(name: string, min: number, max: number, fn: Fn): void {
  FUNCTIONS.set(name, { min, max, fn });
}
export function registerLazy(name: string, min: number, max: number, lazy: LazyFn): void {
  FUNCTIONS.set(name, { min, max, lazy });
}

// ---------------------------------------------------------------- coercion that throws

/** Run a function body; an XlError it throws is its result. Non-finite numbers are #NUM!. */
export function guard<T extends Value>(f: () => T): Value {
  try {
    const v = f();
    if (typeof v === 'number' && !Number.isFinite(v)) return ERR.num;
    return v;
  } catch (e) {
    if (e instanceof XlError) return e;
    throw e;
  }
}

export function N(v: Scalar): number {
  const n = toNumber(v);
  if (n instanceof XlError) throw n;
  return n;
}
export function T(v: Scalar): string {
  const s = toText(v);
  if (s instanceof XlError) throw s;
  return s;
}
export function B(v: Scalar): boolean {
  const b = toBool(v);
  if (b instanceof XlError) throw b;
  return b;
}
/** Throw an error value; let anything else through. */
export function E<V extends Scalar>(v: V): Exclude<V, XlError> {
  if (v instanceof XlError) throw v;
  return v as Exclude<V, XlError>;
}

// ---------------------------------------------------------------- references and arrays

/** The part of a reference that holds anything (A:A is read only as far as the sheet is used). */
export function clip(ref: Ref, ctx: Ctx, sheet = ref.sheet): Area | null {
  const u = ctx.used(sheet);
  if (!u) return null;
  const a = { r1: ref.r1, c1: ref.c1, r2: Math.min(ref.r2, u.r2), c2: Math.min(ref.c2, u.c2) };
  return a.r1 > a.r2 || a.c1 > a.c2 ? null : a;
}

/** A one-cell value: a one-cell reference reads the cell; ranges and arrays of more than one value are #VALUE!. */
export function scalar(v: Value, ctx: Ctx): Scalar {
  if (v instanceof Ref) {
    if (v.single) return ctx.get(v.sheet, v.r1, v.c1);
    return ERR.value;
  }
  if (v instanceof Arr) return v.h === 1 && v.w === 1 ? v.rows[0][0] : ERR.value;
  return v;
}

/** A value as an array of scalars (a reference reads its cells; a scalar is 1 × 1). */
export function toArr(v: Value, ctx: Ctx): Arr {
  if (v instanceof Arr) return v;
  if (v instanceof Ref) {
    if (v.sheet !== v.sheet2) throw ERR.value;
    // whole columns or rows stop at the end of what is used (but keep their shape when empty)
    const u = ctx.used(v.sheet);
    const r2 = v.rows > 100000 ? Math.max(v.r1, Math.min(v.r2, u?.r2 ?? v.r1)) : v.r2;
    const c2 = v.cols > 1000 ? Math.max(v.c1, Math.min(v.c2, u?.c2 ?? v.c1)) : v.c2;
    const id = `${v.sheet}:${v.r1}:${v.c1}:${r2}:${c2}`;
    const known = ctx.arrays?.get(id);
    if (known) return known;
    const rows: Scalar[][] = [];
    for (let r = v.r1; r <= r2; r++) {
      const row: Scalar[] = [];
      for (let c = v.c1; c <= c2; c++) row.push(ctx.get(v.sheet, r, c));
      rows.push(row);
    }
    const arr = new Arr(rows);
    if ((r2 - v.r1 + 1) * (c2 - v.c1 + 1) > 16) ctx.arrays?.set(id, arr);
    return arr;
  }
  return new Arr([[v]]);
}

/** Every value in the arguments, in order (references across sheets included); blanks are null. */
export function* each(args: Value[], ctx: Ctx): Generator<{ v: Scalar; fromRef: boolean }> {
  for (const a of args) {
    if (a instanceof Ref) {
      for (let s = a.sheet; s <= a.sheet2; s++) {
        const area = clip(a, ctx, s);
        if (!area) continue;
        for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) yield { v: ctx.get(s, r, c), fromRef: true };
      }
    } else if (a instanceof Arr) {
      for (const row of a.rows) for (const v of row) yield { v, fromRef: true };
    } else yield { v: a, fromRef: false };
  }
}

const isMulti = (v: Value) => (v instanceof Ref && !v.single) || (v instanceof Arr && (v.h > 1 || v.w > 1));

/**
 * Apply a function of scalars element by element when any argument is a range or array
 * (sizes broadcast: a single row or column repeats; past the smaller size is #N/A).
 */
export function lift(args: Value[], ctx: Ctx, f: (xs: Scalar[]) => Value): Value {
  if (!args.some(isMulti)) return guard(() => f(args.map((a) => scalar(a, ctx))));
  const arrs = args.map((a) => (isMulti(a) ? toArr(a, ctx) : null));
  const sc = args.map((a, i) => (arrs[i] ? null : scalar(a, ctx)));
  const h = Math.max(...arrs.map((a) => a?.h ?? 1)), w = Math.max(...arrs.map((a) => a?.w ?? 1));
  const rows: Scalar[][] = [];
  for (let i = 0; i < h; i++) {
    const row: Scalar[] = [];
    for (let j = 0; j < w; j++) {
      let bad = false;
      const xs = args.map((_, k) => {
        const a = arrs[k];
        if (!a) return sc[k];
        const ii = a.h === 1 ? 0 : i, jj = a.w === 1 ? 0 : j;
        if (ii >= a.h || jj >= a.w) { bad = true; return null; }
        return a.rows[ii][jj];
      });
      const v = bad ? ERR.na : guard(() => f(xs));
      row.push(v instanceof Ref || v instanceof Arr ? scalar(v, ctx) : v);
    }
    rows.push(row);
  }
  return new Arr(rows);
}

/** Functions that take single values and work element by element when given a range. */
export const LIFTED = new Set<string>();

/** A function of scalars that works element by element on ranges. */
export function scalarFn(name: string, min: number, max: number, f: (xs: Scalar[], ctx: Ctx) => Scalar): void {
  LIFTED.add(name);
  register(name, min, max, (args, ctx) => lift(args, ctx, (xs) => f(xs, ctx)));
}

// ---------------------------------------------------------------- operators

/** a + b and a − b, with results within rounding of zero made zero (as Excel does). */
function addSub(a: number, b: number, sub: boolean): number {
  const r = sub ? a - b : a + b;
  return Math.abs(r) < 1e-15 * Math.max(Math.abs(a), Math.abs(b)) ? 0 : r;
}

export function power(a: number, b: number): number {
  if (a === 0 && b === 0) throw ERR.num;
  if (a === 0 && b < 0) throw ERR.div0;
  // Excel has no real odd roots of negatives: (-8)^(1/3) is #NUM!
  if (a < 0 && !Number.isInteger(b)) throw ERR.num;
  return Math.pow(a, b);
}

function binary(op: string, x: Scalar, y: Scalar): Scalar {
  if (x instanceof XlError) return x;
  if (y instanceof XlError) return y;
  switch (op) {
    case '+': return addSub(N(x), N(y), false);
    case '-': return addSub(N(x), N(y), true);
    case '*': return N(x) * N(y);
    case '/': {
      const a = N(x), b = N(y);
      if (b === 0) throw ERR.div0;
      return a / b;
    }
    case '^': return power(N(x), N(y));
    case '&': return T(x) + T(y);
    case '=': return compare(x, y) === 0;
    case '<>': return compare(x, y) !== 0;
    case '<': return compare(x, y) < 0;
    case '>': return compare(x, y) > 0;
    case '<=': return compare(x, y) <= 0;
    case '>=': return compare(x, y) >= 0;
  }
  throw ERR.value;
}

// ---------------------------------------------------------------- evaluation

export function evalNode(n: Node, ctx: Ctx): Value {
  switch (n.t) {
    case 'num': case 'str': case 'bool': return n.v;
    case 'err': return n.v;
    case 'none': return null;
    case 'arr': return new Arr(n.rows);
    case 'ref': {
      const s = n.ref.sheet === undefined ? ctx.sheet : ctx.sheetIndex(n.ref.sheet);
      const s2 = n.ref.sheet2 === undefined ? s : ctx.sheetIndex(n.ref.sheet2);
      if (s < 0 || s2 < 0) return ERR.ref;
      const a = n.ref.area;
      return new Ref(Math.min(s, s2), a.r1, a.c1, a.r2, a.c2, Math.max(s, s2));
    }
    case 'name': {
      const v = ctx.name(n.name, n.sheet);
      return v === undefined ? ERR.name : v;
    }
    case 'un': {
      const a = evalNode(n.a, ctx);
      // 0 − x, so −blank is 0 and not −0
      return lift([a], ctx, ([x]) => (x instanceof XlError ? x : n.op === '-' ? 0 - N(x) : x === null ? 0 : x));
    }
    case 'pct': return lift([evalNode(n.a, ctx)], ctx, ([x]) => (x instanceof XlError ? x : N(x) / 100));
    case 'bin': {
      const a = evalNode(n.a, ctx), b = evalNode(n.b, ctx);
      if (n.op === ':' || n.op === ' ') {
        if (a instanceof XlError) return a;
        if (b instanceof XlError) return b;
        if (!(a instanceof Ref) || !(b instanceof Ref) || a.sheet !== b.sheet || a.sheet2 !== b.sheet2) return ERR.value;
        if (n.op === ':') return new Ref(a.sheet, Math.min(a.r1, b.r1), Math.min(a.c1, b.c1), Math.max(a.r2, b.r2), Math.max(a.c2, b.c2), a.sheet2);
        const r1 = Math.max(a.r1, b.r1), c1 = Math.max(a.c1, b.c1), r2 = Math.min(a.r2, b.r2), c2 = Math.min(a.c2, b.c2);
        return r1 > r2 || c1 > c2 ? ERR.null : new Ref(a.sheet, r1, c1, r2, c2, a.sheet2);
      }
      return lift([a, b], ctx, ([x, y]) => binary(n.op, x, y));
    }
    case 'fn': {
      const def = FUNCTIONS.get(n.name);
      if (!def) {
        ctx.unknown(n.name);
        return ERR.name;
      }
      if (n.args.length < def.min || n.args.length > def.max) return ERR.value;
      if (def.lazy) return guard(() => def.lazy!(n.args.map((a) => () => evalNode(a, ctx)), ctx));
      return guard(() => def.fn!(n.args.map((a) => evalNode(a, ctx)), ctx));
    }
  }
}

/** Numbers compare to 15 digits here too (MATCH, criteria). */
export const eq15 = (a: number, b: number) => a === b || (Math.abs(a - b) <= 1e-13 * Math.max(Math.abs(a), Math.abs(b)) && round15(a) === round15(b));
