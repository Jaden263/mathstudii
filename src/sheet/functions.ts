// Excel's common functions, with Excel's rules for what counts: SUM of a range skips text
// and logicals but SUM("3", TRUE) counts both, COUNT ignores errors, AVERAGE of nothing is
// #DIV/0!, criteria such as ">5" and "a*" in the …IF functions. Results were checked
// against LibreOffice recalculating the same workbook (see functions.test.ts).
import { dateSerial, parseDateText, serialOfTime, serialParts } from './dates';
import { B, clip, each, E, eq15, FUNCTIONS, lift, N, power, register, registerLazy, scalar, scalarFn, T, toArr, type Ctx } from './evaluate';
import { formatNumber } from './numfmt';
import { parseRange } from './refs';
import { Arr, compare, ERR, parseNumberText, Ref, round15, XlError, type ErrCode, type Scalar, type Value } from './values';
import { erf, erfc, normInv } from '../engine/special';

// ---------------------------------------------------------------- helpers

/** Numbers for SUM, AVERAGE, MIN …: in ranges and arrays only numbers count (with "A": text 0, logicals 1/0); typed arguments are converted. */
function numbers(args: Value[], ctx: Ctx, a = false): number[] {
  const out: number[] = [];
  for (const { v, fromRef } of each(args, ctx)) {
    if (v instanceof XlError) throw v;
    if (fromRef) {
      if (typeof v === 'number') out.push(v);
      else if (a && v !== null) out.push(v === true ? 1 : 0);
    } else out.push(v === null ? 0 : N(v));
  }
  return out;
}

const sum = (xs: number[]) => {
  // compensated, so a column of 0.1s adds up as it does in Excel
  let s = 0, c = 0;
  for (const x of xs) {
    const y = x - c, t = s + y;
    c = t - s - y;
    s = t;
  }
  return s;
};
const mean = (xs: number[]) => {
  if (!xs.length) throw ERR.div0;
  return sum(xs) / xs.length;
};
function variance(xs: number[], sample: boolean): number {
  if (xs.length < (sample ? 2 : 1)) throw ERR.div0;
  const m = mean(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - (sample ? 1 : 0));
}

/** Shift the decimal point of x by d places without binary rounding (1.005, 2 → 100.5). */
function shift(x: number, d: number): number {
  const [m, e] = x.toExponential().split('e');
  return Number(`${m}e${Number(e) + d}`);
}

/** Round to d decimals: halves away from zero, or always up / down in magnitude. */
function roundTo(x: number, d: number, mode: 'half' | 'up' | 'down'): number {
  if (x === 0) return 0;
  d = Math.trunc(d);
  const ax = Math.abs(round15(x));
  const s = shift(ax, d);
  const r = mode === 'half' ? Math.round(s) : mode === 'up' ? Math.ceil(s) : Math.floor(s);
  return Math.sign(x) * shift(r, -d);
}

/** Two-dimensional array of a value, all rows the same length. */
const grid = (v: Value, ctx: Ctx) => toArr(v, ctx).rows;
const flat = (v: Value, ctx: Ctx) => grid(v, ctx).flat();

/** Numbers of a matrix argument (MMULT, MINVERSE): anything else is #VALUE!. */
function matrix(v: Value, ctx: Ctx): number[][] {
  return grid(v, ctx).map((row) => row.map((x) => {
    if (x instanceof XlError) throw x;
    if (typeof x !== 'number') throw ERR.value;
    return x;
  }));
}

/** Arguments of an aggregate given as typed text such as "a" count as errors (#VALUE!). */
const opt = (args: Value[], i: number, ctx: Ctx, dflt: Scalar): Scalar => (i < args.length && args[i] !== null ? scalar(args[i], ctx) : dflt);

/** Wildcard text pattern (* ? and ~ to escape) as a regular expression, matching whole text, any case. */
export function wildcard(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '~' && i + 1 < p.length && '*?~'.includes(p[i + 1])) re += '\\' + p[++i];
    else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}
const hasWild = (s: string) => /[*?]/.test(s.replace(/~[*?~]/g, ''));

/** A criterion of COUNTIF, SUMIFS …: 5, ">5", "<>0", "abc", "a*", "", "<>". */
export function criterion(c: Scalar): (v: Scalar) => boolean {
  if (c instanceof XlError) return (v) => v === c;
  if (typeof c === 'number') {
    const n = c;
    return (v) => (typeof v === 'number' ? eq15(v, n) : typeof v === 'string' && parseNumberText(v) === n);
  }
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null) c = '';
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(c)!;
  const op = m[1] ?? '=';
  const operand = m[2];
  const num = operand.trim() === '' ? null : parseNumberText(operand);
  const test = (cmp: number) => (op === '=' ? cmp === 0 : op === '<>' ? cmp !== 0 : op === '<' ? cmp < 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : cmp >= 0);
  if (num !== null) {
    return (v) => {
      const x = typeof v === 'number' ? v : typeof v === 'string' && op === '=' ? parseNumberText(v) : null;
      if (x === null) return op === '<>';
      return test(eq15(x, num) ? 0 : x < num ? -1 : 1);
    };
  }
  const u = operand.toUpperCase();
  if (u === 'TRUE' || u === 'FALSE') return (v) => (typeof v === 'boolean' ? test(v === (u === 'TRUE') ? 0 : 1) : op === '<>');
  if (/^#/.test(operand)) return (v) => (v instanceof XlError && v.code === u ? op === '=' : op === '<>');
  if (operand === '') return op === '<>' ? (v) => v !== null && v !== '' : (v) => v === null || v === '';
  if (op === '=' || op === '<>') {
    const re = wildcard(operand);
    return (v) => (typeof v === 'string' && re.test(v)) === (op === '=');
  }
  return (v) => typeof v === 'string' && test(compare(v, operand));
}

/** Ranges of …IFS functions read to the same size (whole columns cut at the same row). */
function sameSize(vals: Value[], ctx: Ctx): Scalar[][][] {
  let rows = Infinity;
  for (const v of vals) if (v instanceof Ref && v.rows > 100000) rows = Math.min(rows, Math.max(...vals.map((w) => (w instanceof Ref ? (ctx.used(w.sheet)?.r2 ?? 0) - w.r1 + 1 : 1))));
  const out = vals.map((v) => {
    if (v instanceof Ref && v.rows > 100000 && Number.isFinite(rows)) return toArr(new Ref(v.sheet, v.r1, v.c1, v.r1 + Math.max(0, rows - 1), v.c2), ctx).rows;
    return grid(v, ctx);
  });
  const h = out[0].length, w = out[0][0]?.length ?? 0;
  if (out.some((g) => g.length !== h || (g[0]?.length ?? 0) !== w)) throw ERR.value;
  return out;
}

/** Indices (flattened) of the cells meeting every (range, criterion) pair. */
function matching(pairs: Value[], ctx: Ctx, target?: Value): { cells: Scalar[][] | null; hits: [number, number][] } {
  if (pairs.length % 2) throw ERR.value;
  const ranges = pairs.filter((_, i) => i % 2 === 0);
  const grids = sameSize(target ? [target, ...ranges] : ranges, ctx);
  const tg = target ? grids.shift()! : null;
  const tests = pairs.filter((_, i) => i % 2 === 1).map((c) => criterion(scalar(c, ctx)));
  const hits: [number, number][] = [];
  const g0 = grids[0];
  for (let i = 0; i < g0.length; i++) for (let j = 0; j < g0[i].length; j++) if (tests.every((t, k) => t(grids[k][i][j]))) hits.push([i, j]);
  return { cells: tg, hits };
}

/** SUMIF's and AVERAGEIF's value range: the size of the criteria range from its own top-left cell. */
function alongside(range: Value, values: Value | undefined): Value {
  if (!values) return range;
  if (range instanceof Ref && values instanceof Ref) return new Ref(values.sheet, values.r1, values.c1, values.r1 + range.rows - 1, values.c1 + range.cols - 1);
  return values;
}

// ---------------------------------------------------------------- math and aggregates

register('SUM', 1, 255, (a, ctx) => sum(numbers(a, ctx)));
register('PRODUCT', 1, 255, (a, ctx) => numbers(a, ctx).reduce((p, x) => p * x, 1));
register('SUMSQ', 1, 255, (a, ctx) => sum(numbers(a, ctx).map((x) => x * x)));
register('AVERAGE', 1, 255, (a, ctx) => mean(numbers(a, ctx)));
register('AVERAGEA', 1, 255, (a, ctx) => mean(numbers(a, ctx, true)));
register('MIN', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); return xs.length ? Math.min(...xs) : 0; });
register('MAX', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); return xs.length ? Math.max(...xs) : 0; });
register('MINA', 1, 255, (a, ctx) => { const xs = numbers(a, ctx, true); return xs.length ? Math.min(...xs) : 0; });
register('MAXA', 1, 255, (a, ctx) => { const xs = numbers(a, ctx, true); return xs.length ? Math.max(...xs) : 0; });
register('COUNT', 1, 255, (a, ctx) => {
  let n = 0;
  for (const { v, fromRef } of each(a, ctx)) {
    if (typeof v === 'number') n++;
    else if (!fromRef && (v === null || typeof v === 'boolean' || (typeof v === 'string' && parseNumberText(v) !== null))) n++;
  }
  return n;
});
register('COUNTA', 1, 255, (a, ctx) => {
  let n = 0;
  for (const { v, fromRef } of each(a, ctx)) if (v !== null || !fromRef) n++;
  return n;
});
register('COUNTBLANK', 1, 1, (a, ctx) => {
  let n = 0;
  for (const { v } of each(a, ctx)) if (v === null || v === '') n++;
  // cells past the used area are blank too
  const r = a[0];
  if (r instanceof Ref) {
    const area = clip(r, ctx);
    n += r.rows * r.cols - (area ? (area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) : 0);
  }
  return n;
});
register('SUMIF', 2, 3, (a, ctx) => {
  const { cells, hits } = matching([a[0], a[1]], ctx, alongside(a[0], a[2]));
  return sum(hits.map(([i, j]) => cells![i][j]).filter((v): v is number => { if (v instanceof XlError) throw v; return typeof v === 'number'; }));
});
register('SUMIFS', 3, 255, (a, ctx) => {
  const { cells, hits } = matching(a.slice(1), ctx, a[0]);
  return sum(hits.map(([i, j]) => cells![i][j]).filter((v): v is number => { if (v instanceof XlError) throw v; return typeof v === 'number'; }));
});
register('COUNTIF', 2, 2, (a, ctx) => matching(a, ctx).hits.length);
register('COUNTIFS', 2, 255, (a, ctx) => matching(a, ctx).hits.length);
const ifNumbers = (cells: Scalar[][], hits: [number, number][]) => hits.map(([i, j]) => cells[i][j]).filter((v): v is number => { if (v instanceof XlError) throw v; return typeof v === 'number'; });
register('AVERAGEIF', 2, 3, (a, ctx) => { const m = matching([a[0], a[1]], ctx, alongside(a[0], a[2])); return mean(ifNumbers(m.cells!, m.hits)); });
register('AVERAGEIFS', 3, 255, (a, ctx) => { const m = matching(a.slice(1), ctx, a[0]); return mean(ifNumbers(m.cells!, m.hits)); });
register('MAXIFS', 3, 255, (a, ctx) => { const m = matching(a.slice(1), ctx, a[0]); const xs = ifNumbers(m.cells!, m.hits); return xs.length ? Math.max(...xs) : 0; });
register('MINIFS', 3, 255, (a, ctx) => { const m = matching(a.slice(1), ctx, a[0]); const xs = ifNumbers(m.cells!, m.hits); return xs.length ? Math.min(...xs) : 0; });
register('SUMPRODUCT', 1, 255, (a, ctx) => {
  const gs = a.map((v) => grid(v, ctx));
  const h = gs[0].length, w = gs[0][0]?.length ?? 0;
  if (gs.some((g) => g.length !== h || (g[0]?.length ?? 0) !== w)) throw ERR.value;
  let s = 0;
  for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
    let p = 1;
    for (const g of gs) {
      const v = g[i][j];
      if (v instanceof XlError) throw v;
      p *= typeof v === 'number' ? v : 0;
    }
    s += p;
  }
  return s;
});
register('SUBTOTAL', 2, 255, (a, ctx) => {
  const f = Math.trunc(N(scalar(a[0], ctx))) % 100;
  const fn = ['', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEVP', 'SUM', 'VAR', 'VARP'][f];
  if (!fn) throw ERR.value;
  return callFn(fn, a.slice(1), ctx);
});

scalarFn('ROUND', 2, 2, ([x, d]) => roundTo(N(x), N(d), 'half'));
scalarFn('ROUNDUP', 2, 2, ([x, d]) => roundTo(N(x), N(d), 'up'));
scalarFn('ROUNDDOWN', 2, 2, ([x, d]) => roundTo(N(x), N(d), 'down'));
scalarFn('TRUNC', 1, 2, ([x, d]) => roundTo(N(x), d === undefined ? 0 : N(d), 'down'));
scalarFn('INT', 1, 1, ([x]) => Math.floor(round15(N(x))));
scalarFn('MROUND', 2, 2, ([x, m]) => {
  const n = N(x), s = N(m);
  if (s === 0) return 0;
  if (n * s < 0) throw ERR.num;
  return round15(s * roundTo(round15(n / s), 0, 'half'));
});
scalarFn('CEILING', 2, 2, ([x, m]) => {
  const n = N(x), s = N(m);
  if (s === 0) return 0;
  if (n > 0 && s < 0) throw ERR.num;
  return round15(Math.ceil(round15(n / s)) * s);
});
scalarFn('FLOOR', 2, 2, ([x, m]) => {
  const n = N(x), s = N(m);
  if (s === 0) throw ERR.div0;
  if (n > 0 && s < 0) throw ERR.num;
  return round15(Math.floor(round15(n / s)) * s);
});
// for negative numbers mode 0 rounds towards zero (CEILING) or away from it (FLOOR)
scalarFn('CEILING.MATH', 1, 3, ([x, m, mode]) => {
  const n = N(x), s = Math.abs(m === undefined || m === null ? 1 : N(m));
  if (s === 0) return 0;
  const q = round15(n / s);
  return round15((n < 0 && mode !== undefined && N(mode) !== 0 ? Math.floor(q) : Math.ceil(q)) * s);
});
scalarFn('FLOOR.MATH', 1, 3, ([x, m, mode]) => {
  const n = N(x), s = Math.abs(m === undefined || m === null ? 1 : N(m));
  if (s === 0) return 0;
  const q = round15(n / s);
  return round15((n < 0 && mode !== undefined && N(mode) !== 0 ? Math.ceil(q) : Math.floor(q)) * s);
});
scalarFn('MOD', 2, 2, ([x, d]) => {
  const n = N(x), m = N(d);
  if (m === 0) throw ERR.div0;
  const r = n - m * Math.floor(n / m);
  // within rounding of the divisor is zero (MOD(0.3, 0.1) would be 0.1 otherwise)
  return Math.abs(r - m) < 1e-15 * Math.abs(m) * 16 || Math.abs(r) < 1e-15 * Math.abs(n) ? 0 : round15(r);
});
scalarFn('QUOTIENT', 2, 2, ([x, d]) => { const m = N(d); if (m === 0) throw ERR.div0; return Math.trunc(N(x) / m); });
scalarFn('ABS', 1, 1, ([x]) => Math.abs(N(x)));
scalarFn('SIGN', 1, 1, ([x]) => Math.sign(N(x)));
scalarFn('SQRT', 1, 1, ([x]) => { const n = N(x); if (n < 0) throw ERR.num; return Math.sqrt(n); });
scalarFn('SQRTPI', 1, 1, ([x]) => { const n = N(x); if (n < 0) throw ERR.num; return Math.sqrt(n * Math.PI); });
scalarFn('POWER', 2, 2, ([x, y]) => power(N(x), N(y)));
scalarFn('EXP', 1, 1, ([x]) => Math.exp(N(x)));
scalarFn('LN', 1, 1, ([x]) => { const n = N(x); if (n <= 0) throw ERR.num; return Math.log(n); });
scalarFn('LOG10', 1, 1, ([x]) => { const n = N(x); if (n <= 0) throw ERR.num; return Math.log10(n); });
scalarFn('LOG', 1, 2, ([x, b]) => {
  const n = N(x), base = b === undefined ? 10 : N(b);
  if (n <= 0 || base <= 0) throw ERR.num;
  if (base === 1) throw ERR.div0;
  return base === 10 ? Math.log10(n) : Math.log(n) / Math.log(base);
});
register('PI', 0, 0, () => Math.PI);
for (const [name, f] of [['SIN', Math.sin], ['COS', Math.cos], ['TAN', Math.tan], ['ASIN', Math.asin], ['ACOS', Math.acos], ['ATAN', Math.atan],
  ['SINH', Math.sinh], ['COSH', Math.cosh], ['TANH', Math.tanh], ['ASINH', Math.asinh], ['ACOSH', Math.acosh], ['ATANH', Math.atanh]] as const) {
  scalarFn(name, 1, 1, ([x]) => f(N(x)));
}
scalarFn('COT', 1, 1, ([x]) => { const n = N(x); if (n === 0) throw ERR.div0; return 1 / Math.tan(n); });
scalarFn('SEC', 1, 1, ([x]) => 1 / Math.cos(N(x)));
scalarFn('CSC', 1, 1, ([x]) => { const n = N(x); if (n === 0) throw ERR.div0; return 1 / Math.sin(n); });
scalarFn('ACOT', 1, 1, ([x]) => Math.PI / 2 - Math.atan(N(x)));
// Excel's argument order is (x, y), the reverse of most languages
scalarFn('ATAN2', 2, 2, ([x, y]) => { const a = N(x), b = N(y); if (a === 0 && b === 0) throw ERR.div0; return Math.atan2(b, a); });
scalarFn('DEGREES', 1, 1, ([x]) => (N(x) * 180) / Math.PI);
scalarFn('RADIANS', 1, 1, ([x]) => (N(x) * Math.PI) / 180);
function fact(n: number): number {
  if (n < 0) throw ERR.num;
  let p = 1;
  for (let k = 2; k <= Math.trunc(n); k++) p *= k;
  return p;
}
scalarFn('FACT', 1, 1, ([x]) => fact(N(x)));
scalarFn('COMBIN', 2, 2, ([a, b]) => {
  const n = Math.trunc(N(a)), k = Math.trunc(N(b));
  if (n < 0 || k < 0 || k > n) throw ERR.num;
  let c = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) c = (c * (n - Math.min(k, n - k) + i)) / i;
  return Math.round(c);
});
scalarFn('PERMUT', 2, 2, ([a, b]) => {
  const n = Math.trunc(N(a)), k = Math.trunc(N(b));
  if (n < 0 || k < 0 || k > n) throw ERR.num;
  let p = 1;
  for (let i = 0; i < k; i++) p *= n - i;
  return p;
});
const gcd2 = (a: number, b: number): number => (b ? gcd2(b, a % b) : a);
register('GCD', 1, 255, (a, ctx) => numbers(a, ctx).reduce((g, x) => { if (x < 0) throw ERR.num; return gcd2(g, Math.trunc(x)); }, 0));
register('LCM', 1, 255, (a, ctx) => numbers(a, ctx).reduce((l, x) => { if (x < 0) throw ERR.num; const n = Math.trunc(x); return l === 0 || n === 0 ? 0 : (l / gcd2(l, n)) * n; }, 1));
scalarFn('EVEN', 1, 1, ([x]) => { const n = N(x); const r = Math.ceil(Math.abs(n) / 2) * 2; return n < 0 ? -r : r; });
scalarFn('ODD', 1, 1, ([x]) => { const n = N(x); let r = Math.ceil(Math.abs(n)); if (r % 2 === 0) r += 1; return n < 0 ? -r : r; });
register('RAND', 0, 0, () => Math.random());
scalarFn('RANDBETWEEN', 2, 2, ([a, b]) => { const lo = Math.ceil(N(a)), hi = Math.floor(N(b)); if (lo > hi) throw ERR.num; return lo + Math.floor(Math.random() * (hi - lo + 1)); });

// ---------------------------------------------------------------- logical

/** Logicals for AND / OR / XOR: in ranges text and blanks are skipped; nothing logical at all is #VALUE!. */
function logicals(args: Value[], ctx: Ctx): boolean[] {
  const out: boolean[] = [];
  for (const { v, fromRef } of each(args, ctx)) {
    if (v instanceof XlError) throw v;
    if (typeof v === 'boolean') out.push(v);
    else if (typeof v === 'number') out.push(v !== 0);
    else if (!fromRef && v !== null) out.push(B(v));
  }
  if (!out.length) throw ERR.value;
  return out;
}
register('AND', 1, 255, (a, ctx) => logicals(a, ctx).every(Boolean));
register('OR', 1, 255, (a, ctx) => logicals(a, ctx).some(Boolean));
register('XOR', 1, 255, (a, ctx) => logicals(a, ctx).filter(Boolean).length % 2 === 1);
scalarFn('NOT', 1, 1, ([x]) => !B(x));
register('TRUE', 0, 0, () => true);
register('FALSE', 0, 0, () => false);
registerLazy('IF', 2, 3, ([c, t, f], ctx) => {
  const cond = c();
  if (cond instanceof Arr || (cond instanceof Ref && !cond.single)) {
    // a range as the condition: one result per element
    const tv = t(), fv = f ? f() : false;
    return lift([cond, tv, fv], ctx, ([x, a, b]) => (x instanceof XlError ? x : B(x) ? a : b));
  }
  const x = scalar(cond, ctx);
  if (x instanceof XlError) return x;
  return B(x) ? t() : f ? f() : false;
});
registerLazy('IFS', 2, 254, (a, ctx) => {
  if (a.length % 2) throw ERR.value;
  for (let i = 0; i < a.length; i += 2) if (B(E(scalar(a[i](), ctx)))) return a[i + 1]();
  throw ERR.na;
});
registerLazy('IFERROR', 2, 2, ([v, alt], ctx) => {
  const x = v();
  if (x instanceof Arr || (x instanceof Ref && !x.single)) {
    const al = alt();
    return lift([x, al], ctx, ([y, z]) => (y instanceof XlError ? z : y));
  }
  return scalar(x, ctx) instanceof XlError ? alt() : x;
});
registerLazy('IFNA', 2, 2, ([v, alt], ctx) => {
  const x = v();
  return scalar(x, ctx) === ERR.na ? alt() : x;
});
registerLazy('SWITCH', 3, 254, (a, ctx) => {
  const x = E(scalar(a[0](), ctx));
  let i = 1;
  for (; i + 1 < a.length; i += 2) {
    const v = E(scalar(a[i](), ctx));
    if (compare(x, v) === 0 && typeof x === typeof v) return a[i + 1]();
  }
  if (i < a.length) return a[i]();
  throw ERR.na;
});
registerLazy('CHOOSE', 2, 255, (a, ctx) => {
  const i = Math.trunc(N(E(scalar(a[0](), ctx))));
  if (i < 1 || i >= a.length) throw ERR.value;
  return a[i]();
});

// ---------------------------------------------------------------- lookup and reference

/** Values along a one-row or one-column range (MATCH, XLOOKUP); a block is #N/A. */
function vector(v: Value, ctx: Ctx): { vals: Scalar[]; across: boolean } {
  const g = grid(v, ctx);
  if (g.length === 1) return { vals: g[0], across: true };
  if (g[0]?.length === 1) return { vals: g.map((r) => r[0]), across: false };
  throw ERR.na;
}

const sameType = (a: Scalar, b: Scalar) => (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string') || (typeof a === 'boolean' && typeof b === 'boolean');

/**
 * Position (0-based) of x in vals. mode 0: exact (text with wildcards when `wild`); 1: the
 * largest value ≤ x in ascending data; -1: the smallest ≥ x in descending data. -1 if none.
 */
function find(x: Scalar, vals: Scalar[], mode: number, wild: boolean, fromEnd = false): number {
  if (mode === 0) {
    const re = wild && typeof x === 'string' && hasWild(x) ? wildcard(x) : null;
    const n = vals.length;
    for (let k = 0; k < n; k++) {
      const i = fromEnd ? n - 1 - k : k;
      const v = vals[i];
      if (re ? typeof v === 'string' && re.test(v) : sameType(v, x) && compare(v, x) === 0) return i;
    }
    return -1;
  }
  let best = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!sameType(v, x)) continue;
    const c = compare(v, x);
    if (mode > 0 ? c <= 0 : c >= 0) best = i;
    else break;
  }
  return best;
}

register('MATCH', 2, 3, (a, ctx) => {
  const x = E(scalar(a[0], ctx));
  if (x === null) throw ERR.na;
  const type = a.length > 2 && a[2] !== null ? Math.sign(N(E(scalar(a[2], ctx)))) : 1;
  const i = find(x, vector(a[1], ctx).vals, type, true);
  if (i < 0) throw ERR.na;
  return i + 1;
});
function lookup(a: Value[], ctx: Ctx, vertical: boolean): Value {
  const x = E(scalar(a[0], ctx));
  // an empty lookup value finds nothing, whatever else is wrong
  if (x === null) throw ERR.na;
  const idx = Math.trunc(N(E(scalar(a[2], ctx))));
  const approx = a.length > 3 ? B(E(scalar(a[3], ctx))) : true;
  const g = grid(a[1], ctx);
  const h = g.length, w = g[0]?.length ?? 0;
  if (idx < 1) throw ERR.value;
  if (idx > (vertical ? w : h)) throw ERR.ref;
  const keys = vertical ? g.map((r) => r[0]) : g[0];
  const i = find(x, keys, approx ? 1 : 0, !approx);
  if (i < 0) throw ERR.na;
  return vertical ? g[i][idx - 1] : g[idx - 1][i];
}
register('VLOOKUP', 3, 4, (a, ctx) => lookup(a, ctx, true));
register('HLOOKUP', 3, 4, (a, ctx) => lookup(a, ctx, false));
register('XLOOKUP', 3, 6, (a, ctx) => {
  const x = E(scalar(a[0], ctx));
  const look = vector(a[1], ctx);
  const ret = grid(a[2], ctx);
  const mode = a.length > 4 && a[4] !== null ? Math.trunc(N(E(scalar(a[4], ctx)))) : 0;
  const search = a.length > 5 && a[5] !== null ? Math.trunc(N(E(scalar(a[5], ctx)))) : 1;
  const n = look.vals.length;
  if ((look.across ? ret[0]?.length : ret.length) !== n) throw ERR.value;
  let i = -1;
  if (mode === 0 || mode === 2) i = find(x, look.vals, 0, mode === 2, search < 0);
  else {
    // exact, else the next smaller (-1) or larger (1) value, in any order
    let best = -1;
    for (let k = 0; k < n; k++) {
      const j = search < 0 ? n - 1 - k : k;
      const v = look.vals[j];
      if (!sameType(v, x)) continue;
      const c = compare(v, x);
      if (c === 0) { best = j; break; }
      if ((mode < 0 && c < 0 && (best < 0 || compare(v, look.vals[best]) > 0)) || (mode > 0 && c > 0 && (best < 0 || compare(v, look.vals[best]) < 0))) best = j;
    }
    i = best;
  }
  if (i < 0) {
    if (a.length > 3 && a[3] !== null) return a[3];
    throw ERR.na;
  }
  if (look.across) return ret.length === 1 ? ret[0][i] : new Arr(ret.map((r) => [r[i]]));
  return ret[i].length === 1 ? ret[i][0] : new Arr([ret[i]]);
});
register('LOOKUP', 2, 3, (a, ctx) => {
  const x = E(scalar(a[0], ctx));
  const g = grid(a[1], ctx);
  // a block looks along its longer side and answers from its last row or column
  const across = g.length < (g[0]?.length ?? 0);
  const keys = across ? g[0] : g.map((r) => r[0]);
  const i = find(x, keys, 1, false);
  if (i < 0) throw ERR.na;
  if (a.length > 2) {
    const res = vector(a[2], ctx).vals;
    if (i >= res.length) throw ERR.na;
    return res[i];
  }
  return across ? g[g.length - 1][i] : g[i][g[i].length - 1];
});
register('INDEX', 2, 4, (a, ctx) => {
  const src = a[0];
  if (src instanceof XlError) throw src;
  const h = src instanceof Ref ? src.rows : src instanceof Arr ? src.h : 1;
  const w = src instanceof Ref ? src.cols : src instanceof Arr ? src.w : 1;
  let r = Math.trunc(N(E(scalar(a[1], ctx))));
  let c = a.length > 2 && a[2] !== null ? Math.trunc(N(E(scalar(a[2], ctx)))) : (a.length > 2 ? 0 : -1);
  // INDEX(row or column, n) counts along it
  if (c === -1) {
    if (h === 1 && w > 1) { c = r; r = 1; } else c = w === 1 ? 1 : 0;
  }
  if (r < 0 || c < 0 || r > h || c > w) throw ERR.ref;
  if (src instanceof Ref) {
    return new Ref(src.sheet, r ? src.r1 + r - 1 : src.r1, c ? src.c1 + c - 1 : src.c1, r ? src.r1 + r - 1 : src.r2, c ? src.c1 + c - 1 : src.c2);
  }
  const g = grid(src, ctx);
  if (r && c) return g[r - 1][c - 1];
  if (r) return new Arr([g[r - 1]]);
  if (c) return new Arr(g.map((row) => [row[c - 1]]));
  return new Arr(g);
});
register('ROW', 0, 1, (a, ctx) => {
  const r = a[0];
  if (r === undefined) return ctx.row + 1;
  if (!(r instanceof Ref)) throw ERR.value;
  return r.rows === 1 ? r.r1 + 1 : new Arr(Array.from({ length: Math.min(r.rows, 100000) }, (_, i) => [r.r1 + i + 1]));
});
register('COLUMN', 0, 1, (a, ctx) => {
  const r = a[0];
  if (r === undefined) return ctx.col + 1;
  if (!(r instanceof Ref)) throw ERR.value;
  return r.cols === 1 ? r.c1 + 1 : new Arr([Array.from({ length: r.cols }, (_, i) => r.c1 + i + 1)]);
});
const size = (v: Value, rows: boolean) => {
  if (v instanceof XlError) throw v;
  return v instanceof Ref ? (rows ? v.rows : v.cols) : v instanceof Arr ? (rows ? v.h : v.w) : 1;
};
register('ROWS', 1, 1, ([v]) => size(v, true));
register('COLUMNS', 1, 1, ([v]) => size(v, false));
register('TRANSPOSE', 1, 1, ([v], ctx) => {
  const g = grid(v, ctx);
  return new Arr((g[0] ?? []).map((_, j) => g.map((row) => row[j])));
});
register('OFFSET', 3, 5, (a, ctx) => {
  const r = a[0];
  if (!(r instanceof Ref)) throw ERR.value;
  const dr = Math.trunc(N(E(scalar(a[1], ctx)))), dc = Math.trunc(N(E(scalar(a[2], ctx))));
  const h = a.length > 3 && a[3] !== null ? Math.trunc(N(E(scalar(a[3], ctx)))) : r.rows;
  const w = a.length > 4 && a[4] !== null ? Math.trunc(N(E(scalar(a[4], ctx)))) : r.cols;
  if (h < 1 || w < 1 || r.r1 + dr < 0 || r.c1 + dc < 0) throw ERR.ref;
  return new Ref(r.sheet, r.r1 + dr, r.c1 + dc, r.r1 + dr + h - 1, r.c1 + dc + w - 1);
});
register('INDIRECT', 1, 2, (a, ctx) => {
  const text = T(E(scalar(a[0], ctx)));
  const p = parseRange(text);
  if (!p) {
    const n = ctx.name(text);
    if (n instanceof Ref) return n;
    throw ERR.ref;
  }
  const s = p.sheet === undefined ? ctx.sheet : ctx.sheetIndex(p.sheet);
  if (s < 0) throw ERR.ref;
  return new Ref(s, p.r1, p.c1, p.r2, p.c2);
});

// ---------------------------------------------------------------- text

scalarFn('LEFT', 1, 2, ([t, n]) => { const k = n === undefined ? 1 : Math.trunc(N(n)); if (k < 0) throw ERR.value; return [...T(t)].slice(0, k).join(''); });
scalarFn('RIGHT', 1, 2, ([t, n]) => { const k = n === undefined ? 1 : Math.trunc(N(n)); if (k < 0) throw ERR.value; const s = [...T(t)]; return k ? s.slice(-k).join('') : ''; });
scalarFn('MID', 3, 3, ([t, st, n]) => {
  const s = Math.trunc(N(st)), k = Math.trunc(N(n));
  if (s < 1 || k < 0) throw ERR.value;
  return [...T(t)].slice(s - 1, s - 1 + k).join('');
});
scalarFn('LEN', 1, 1, ([t]) => [...T(t)].length);
function findText(needle: string, hay: string, start: number, insensitive: boolean): number {
  if (start < 1 || start > hay.length + 1) throw ERR.value;
  if (insensitive && hasWild(needle)) {
    const re = new RegExp(wildcard(needle).source.slice(1, -1), 'i');
    const m = re.exec(hay.slice(start - 1));
    if (!m) throw ERR.value;
    return m.index + start;
  }
  const i = insensitive ? hay.toLowerCase().indexOf(needle.toLowerCase(), start - 1) : hay.indexOf(needle, start - 1);
  if (i < 0) throw ERR.value;
  return i + 1;
}
scalarFn('FIND', 2, 3, ([f, w, s]) => findText(T(f), T(w), s === undefined ? 1 : Math.trunc(N(s)), false));
scalarFn('SEARCH', 2, 3, ([f, w, s]) => findText(T(f), T(w), s === undefined ? 1 : Math.trunc(N(s)), true));
scalarFn('SUBSTITUTE', 3, 4, ([t, o, n, k]) => {
  const s = T(t), old = T(o), rep = T(n);
  if (!old) return s;
  if (k === undefined) return s.split(old).join(rep);
  const nth = Math.trunc(N(k));
  if (nth < 1) throw ERR.value;
  let i = -1;
  for (let c = 0; c < nth; c++) {
    i = s.indexOf(old, i + 1);
    if (i < 0) return s;
  }
  return s.slice(0, i) + rep + s.slice(i + old.length);
});
scalarFn('REPLACE', 4, 4, ([t, st, n, r]) => {
  const s = [...T(t)], i = Math.trunc(N(st)), k = Math.trunc(N(n));
  if (i < 1 || k < 0) throw ERR.value;
  return [...s.slice(0, i - 1), T(r), ...s.slice(i - 1 + k)].join('');
});
scalarFn('UPPER', 1, 1, ([t]) => T(t).toUpperCase());
scalarFn('LOWER', 1, 1, ([t]) => T(t).toLowerCase());
scalarFn('PROPER', 1, 1, ([t]) => T(t).toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()));
scalarFn('TRIM', 1, 1, ([t]) => T(t).replace(/ +/g, ' ').replace(/^ | $/g, ''));
scalarFn('CLEAN', 1, 1, ([t]) => T(t).replace(/[\x00-\x1f]/g, ''));
scalarFn('REPT', 2, 2, ([t, n]) => { const k = Math.trunc(N(n)); const s = T(t); if (k < 0 || s.length * k > 32767) throw ERR.value; return s.repeat(k); });
scalarFn('EXACT', 2, 2, ([a, b]) => T(a) === T(b));
scalarFn('CHAR', 1, 1, ([n]) => { const k = Math.trunc(N(n)); if (k < 1 || k > 255) throw ERR.value; return String.fromCharCode(k); });
scalarFn('UNICHAR', 1, 1, ([n]) => { const k = Math.trunc(N(n)); if (k < 1 || k > 0x10ffff) throw ERR.value; return String.fromCodePoint(k); });
scalarFn('CODE', 1, 1, ([t]) => { const s = T(t); if (!s) throw ERR.value; return s.charCodeAt(0); });
scalarFn('UNICODE', 1, 1, ([t]) => { const s = T(t); if (!s) throw ERR.value; return s.codePointAt(0)!; });
scalarFn('CONCATENATE', 1, 255, (xs) => xs.map((x) => T(x)).join(''));
register('CONCAT', 1, 255, (a, ctx) => {
  let s = '';
  for (const { v } of each(a, ctx)) s += T(E(v));
  return s;
});
register('TEXTJOIN', 3, 255, (a, ctx) => {
  const delim = T(E(scalar(a[0], ctx)));
  const skip = B(E(scalar(a[1], ctx)));
  const parts: string[] = [];
  for (const { v } of each(a.slice(2), ctx)) {
    const s = T(E(v));
    if (!(skip && s === '')) parts.push(s);
  }
  return parts.join(delim);
});
scalarFn('TEXT', 2, 2, ([v, f], ctx) => {
  const code = T(f);
  const x = typeof v === 'string' ? parseNumberText(v) ?? v : v === null ? 0 : typeof v === 'boolean' ? v : N(v);
  if (typeof x !== 'number') return T(x);
  return formatNumber(x, code, ctx.date1904);
});
scalarFn('VALUE', 1, 1, ([v], ctx) => {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') throw ERR.value;
  const n = parseNumberText(T(v), ctx.date1904);
  if (n === null) throw ERR.value;
  return n;
});
scalarFn('NUMBERVALUE', 1, 3, ([v, d, g]) => {
  const dec = d === undefined ? '.' : T(d)[0] ?? '.', grp = g === undefined ? ',' : T(g);
  let s = T(v).replace(/\s/g, '');
  for (const ch of grp) if (ch !== dec) s = s.split(ch).join('');
  if (dec !== '.') s = s.replace(dec, '.');
  const n = parseNumberText(s);
  if (n === null) throw ERR.value;
  return n;
});
scalarFn('FIXED', 1, 3, ([v, d, nc]) => {
  const dec = d === undefined || d === null ? 2 : Math.trunc(N(d));
  const x = roundTo(N(v), dec, 'half');
  const body = Math.max(0, dec) ? '.' + '0'.repeat(dec) : '';
  return formatNumber(x, (nc !== undefined && B(nc) ? '0' : '#,##0') + body);
});
scalarFn('T', 1, 1, ([v]) => (typeof v === 'string' ? v : v instanceof XlError ? v : ''));
scalarFn('N', 1, 1, ([v]) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof XlError ? v : 0));

// ---------------------------------------------------------------- information

const info = (name: string, f: (v: Scalar) => boolean) => register(name, 1, 1, (a, ctx) => lift(a, ctx, ([v]) => f(v)));
info('ISNUMBER', (v) => typeof v === 'number');
info('ISTEXT', (v) => typeof v === 'string');
info('ISNONTEXT', (v) => typeof v !== 'string');
info('ISBLANK', (v) => v === null);
info('ISLOGICAL', (v) => typeof v === 'boolean');
info('ISERROR', (v) => v instanceof XlError);
info('ISERR', (v) => v instanceof XlError && v !== ERR.na);
info('ISNA', (v) => v === ERR.na);
scalarFn('ISEVEN', 1, 1, ([v]) => Math.trunc(N(v)) % 2 === 0);
scalarFn('ISODD', 1, 1, ([v]) => Math.abs(Math.trunc(N(v)) % 2) === 1);
register('ISREF', 1, 1, ([v]) => v instanceof Ref);
register('NA', 0, 0, () => ERR.na);
const ERROR_TYPES: Partial<Record<ErrCode, number>> = { '#NULL!': 1, '#DIV/0!': 2, '#VALUE!': 3, '#REF!': 4, '#NAME?': 5, '#NUM!': 6, '#N/A': 7, '#SPILL!': 9, '#CALC!': 14 };
register('ERROR.TYPE', 1, 1, ([v], ctx) => { const x = scalar(v, ctx); if (!(x instanceof XlError)) throw ERR.na; return ERROR_TYPES[x.code] ?? ERR.na; });
register('TYPE', 1, 1, ([v], ctx) => {
  if (v instanceof Arr || (v instanceof Ref && !v.single)) return 64;
  const x = scalar(v, ctx);
  return typeof x === 'number' || x === null ? 1 : typeof x === 'string' ? 2 : typeof x === 'boolean' ? 4 : 16;
});

// ---------------------------------------------------------------- dates and times

const serialOf = (v: Scalar, ctx: Ctx): number => {
  if (typeof v === 'string') {
    const n = parseNumberText(v, ctx.date1904);
    if (n === null) throw ERR.value;
    return n;
  }
  const n = N(v);
  if (n < 0) throw ERR.num;
  return n;
};
register('NOW', 0, 0, (_, ctx) => serialOfTime(ctx.now, ctx.date1904));
register('TODAY', 0, 0, (_, ctx) => Math.floor(serialOfTime(ctx.now, ctx.date1904)));
scalarFn('DATE', 3, 3, ([y, m, d], ctx) => {
  let yr = Math.trunc(N(y));
  if (yr < 0 || yr > 9999) throw ERR.num;
  // two- and three-digit years are years after 1900, as in Excel
  if (yr < 1900) yr += 1900;
  const s = dateSerial(yr, Math.trunc(N(m)), Math.trunc(N(d)), ctx.date1904);
  if (s < 0) throw ERR.num;
  return s;
});
scalarFn('TIME', 3, 3, ([h, m, s]) => {
  const t = (Math.trunc(N(h)) * 3600 + Math.trunc(N(m)) * 60 + Math.trunc(N(s))) / 86400;
  if (t < 0) throw ERR.num;
  return t % 1;
});
scalarFn('YEAR', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).y);
scalarFn('MONTH', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).m);
scalarFn('DAY', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).d);
scalarFn('HOUR', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).hh);
scalarFn('MINUTE', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).mm);
scalarFn('SECOND', 1, 1, ([v], ctx) => serialParts(serialOf(v, ctx), ctx.date1904).ss);
scalarFn('WEEKDAY', 1, 2, ([v, t], ctx) => {
  const wd = serialParts(serialOf(v, ctx), ctx.date1904).wd; // 0 = Sunday
  const type = t === undefined ? 1 : Math.trunc(N(t));
  if (type === 1 || type === 17) return wd + 1;
  if (type === 2 || type === 11) return ((wd + 6) % 7) + 1;
  if (type === 3) return (wd + 6) % 7;
  if (type >= 12 && type <= 16) return ((wd - (type - 10) + 7) % 7) + 1;
  throw ERR.num;
});
function addMonths(v: Scalar, n: Scalar, ctx: Ctx, end: boolean): number {
  const p = serialParts(serialOf(v, ctx), ctx.date1904);
  const m = p.m + Math.trunc(N(n));
  const last = new Date(Date.UTC(p.y, m, 0)).getUTCDate();
  const s = dateSerial(p.y, m, end ? last : Math.min(p.d, last), ctx.date1904);
  if (s < 0) throw ERR.num;
  return s;
}
scalarFn('EDATE', 2, 2, ([v, n], ctx) => addMonths(v, n, ctx, false));
scalarFn('EOMONTH', 2, 2, ([v, n], ctx) => addMonths(v, n, ctx, true));
scalarFn('DAYS', 2, 2, ([e, s], ctx) => Math.floor(serialOf(e, ctx)) - Math.floor(serialOf(s, ctx)));
scalarFn('DATEVALUE', 1, 1, ([v], ctx) => { const n = parseDateText(T(v), ctx.date1904); if (n === null) throw ERR.value; return Math.floor(n); });
scalarFn('TIMEVALUE', 1, 1, ([v], ctx) => { const n = parseDateText(T(v), ctx.date1904); if (n === null) throw ERR.value; return n % 1; });
scalarFn('DATEDIF', 3, 3, ([a, b, u], ctx) => {
  const s = serialOf(a, ctx), e = serialOf(b, ctx);
  if (s > e) throw ERR.num;
  const p = serialParts(s, ctx.date1904), q = serialParts(e, ctx.date1904);
  const months = (q.y - p.y) * 12 + q.m - p.m - (q.d < p.d ? 1 : 0);
  switch (T(u).toUpperCase()) {
    case 'D': return Math.floor(e) - Math.floor(s);
    case 'M': return months;
    case 'Y': return Math.floor(months / 12);
    case 'YM': return months % 12;
    default: throw ERR.num;
  }
});
function workdays(ctx: Ctx, holidays: Value | undefined): (s: number) => boolean {
  const hol = new Set(holidays === undefined ? [] : flat(holidays, ctx).filter((x): x is number => typeof x === 'number').map(Math.floor));
  return (s) => {
    const wd = serialParts(s, ctx.date1904).wd;
    return wd !== 0 && wd !== 6 && !hol.has(s);
  };
}
register('NETWORKDAYS', 2, 3, (a, ctx) => {
  let s = Math.floor(serialOf(E(scalar(a[0], ctx)), ctx)), e = Math.floor(serialOf(E(scalar(a[1], ctx)), ctx));
  const sign = s > e ? -1 : 1;
  if (s > e) [s, e] = [e, s];
  const ok = workdays(ctx, a[2]);
  let n = 0;
  for (let d = s; d <= e; d++) if (ok(d)) n++;
  return sign * n;
});
register('WORKDAY', 2, 3, (a, ctx) => {
  let d = Math.floor(serialOf(E(scalar(a[0], ctx)), ctx));
  let n = Math.trunc(N(E(scalar(a[1], ctx))));
  const ok = workdays(ctx, a[2]);
  const step = n < 0 ? -1 : 1;
  while (n !== 0) {
    d += step;
    if (ok(d)) n -= step;
  }
  return d;
});

// ---------------------------------------------------------------- statistics

register('MEDIAN', 1, 255, (a, ctx) => {
  const xs = numbers(a, ctx).sort((x, y) => x - y);
  if (!xs.length) throw ERR.num;
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
});
const mode = (a: Value[], ctx: Ctx) => {
  const xs = numbers(a, ctx);
  const counts = new Map<number, number>();
  let best: number | null = null, bestN = 1;
  for (const x of xs) {
    const n = (counts.get(x) ?? 0) + 1;
    counts.set(x, n);
    if (n > bestN) { best = x; bestN = n; }
  }
  if (best === null) throw ERR.na;
  return best;
};
register('MODE', 1, 255, mode);
register('MODE.SNGL', 1, 255, mode);
for (const [name, sample, a] of [['STDEV', true, false], ['STDEV.S', true, false], ['STDEVA', true, true], ['STDEVP', false, false], ['STDEV.P', false, false], ['STDEVPA', false, true]] as const) {
  register(name, 1, 255, (args, ctx) => Math.sqrt(variance(numbers(args, ctx, a), sample)));
}
for (const [name, sample, a] of [['VAR', true, false], ['VAR.S', true, false], ['VARA', true, true], ['VARP', false, false], ['VAR.P', false, false], ['VARPA', false, true]] as const) {
  register(name, 1, 255, (args, ctx) => variance(numbers(args, ctx, a), sample));
}
register('DEVSQ', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); const m = mean(xs); return sum(xs.map((x) => (x - m) ** 2)); });
register('AVEDEV', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); const m = mean(xs); return mean(xs.map((x) => Math.abs(x - m))); });
register('GEOMEAN', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); if (!xs.length || xs.some((x) => x <= 0)) throw ERR.num; return Math.exp(mean(xs.map(Math.log))); });
register('HARMEAN', 1, 255, (a, ctx) => { const xs = numbers(a, ctx); if (!xs.length || xs.some((x) => x <= 0)) throw ERR.num; return xs.length / sum(xs.map((x) => 1 / x)); });
function kth(a: Value[], ctx: Ctx, largest: boolean): Value {
  const xs = numbers([a[0]], ctx).sort((x, y) => (largest ? y - x : x - y));
  return lift([a[1]], ctx, ([k]) => {
    const i = Math.ceil(N(k));
    if (i < 1 || i > xs.length) throw ERR.num;
    return xs[i - 1];
  });
}
register('LARGE', 2, 2, (a, ctx) => kth(a, ctx, true));
register('SMALL', 2, 2, (a, ctx) => kth(a, ctx, false));
function rank(a: Value[], ctx: Ctx, avg: boolean): Value {
  const x = N(E(scalar(a[0], ctx)));
  const xs = numbers([a[1]], ctx);
  const asc = a.length > 2 && a[2] !== null && N(E(scalar(a[2], ctx))) !== 0;
  if (!xs.some((v) => eq15(v, x))) throw ERR.na;
  const better = xs.filter((v) => (asc ? v < x : v > x) && !eq15(v, x)).length;
  const ties = xs.filter((v) => eq15(v, x)).length;
  return avg ? better + (ties + 1) / 2 : better + 1;
}
register('RANK', 2, 3, (a, ctx) => rank(a, ctx, false));
register('RANK.EQ', 2, 3, (a, ctx) => rank(a, ctx, false));
register('RANK.AVG', 2, 3, (a, ctx) => rank(a, ctx, true));
function percentile(xs: number[], p: number): number {
  if (!xs.length || p < 0 || p > 1) throw ERR.num;
  xs.sort((x, y) => x - y);
  const h = (xs.length - 1) * p, lo = Math.floor(h);
  return lo + 1 < xs.length ? xs[lo] + (h - lo) * (xs[lo + 1] - xs[lo]) : xs[lo];
}
register('PERCENTILE', 2, 2, (a, ctx) => percentile(numbers([a[0]], ctx), N(E(scalar(a[1], ctx)))));
register('PERCENTILE.INC', 2, 2, (a, ctx) => percentile(numbers([a[0]], ctx), N(E(scalar(a[1], ctx)))));
const quartile = (a: Value[], ctx: Ctx) => {
  const q = Math.trunc(N(E(scalar(a[1], ctx))));
  if (q < 0 || q > 4) throw ERR.num;
  return percentile(numbers([a[0]], ctx), q / 4);
};
register('QUARTILE', 2, 2, quartile);
register('QUARTILE.INC', 2, 2, quartile);

/** Pairs of numbers (x, y) where both are numbers, for CORREL, SLOPE … */
function pairs(ys: Value, xs: Value, ctx: Ctx): { x: number[]; y: number[] } {
  const a = flat(ys, ctx), b = flat(xs, ctx);
  if (a.length !== b.length) throw ERR.na;
  const x: number[] = [], y: number[] = [];
  a.forEach((v, i) => {
    const w = b[i];
    if (v instanceof XlError) throw v;
    if (w instanceof XlError) throw w;
    if (typeof v === 'number' && typeof w === 'number') { y.push(v); x.push(w); }
  });
  return { x, y };
}
function fit(ys: Value, xs: Value, ctx: Ctx) {
  const { x, y } = pairs(ys, xs, ctx);
  if (x.length < 1) throw ERR.div0;
  const mx = mean(x), my = mean(y);
  const sxy = sum(x.map((v, i) => (v - mx) * (y[i] - my)));
  const sxx = sum(x.map((v) => (v - mx) ** 2)), syy = sum(y.map((v) => (v - my) ** 2));
  return { mx, my, sxy, sxx, syy, n: x.length };
}
register('SLOPE', 2, 2, ([y, x], ctx) => { const f = fit(y, x, ctx); if (f.sxx === 0) throw ERR.div0; return f.sxy / f.sxx; });
register('INTERCEPT', 2, 2, ([y, x], ctx) => { const f = fit(y, x, ctx); if (f.sxx === 0) throw ERR.div0; return f.my - (f.sxy / f.sxx) * f.mx; });
const correl = ([y, x]: Value[], ctx: Ctx) => { const f = fit(y, x, ctx); if (f.sxx === 0 || f.syy === 0) throw ERR.div0; return f.sxy / Math.sqrt(f.sxx * f.syy); };
register('CORREL', 2, 2, correl);
register('PEARSON', 2, 2, correl);
register('RSQ', 2, 2, (a, ctx) => (correl(a, ctx) as number) ** 2);
register('STEYX', 2, 2, ([y, x], ctx) => { const f = fit(y, x, ctx); if (f.n < 3 || f.sxx === 0) throw ERR.div0; return Math.sqrt((f.syy - (f.sxy * f.sxy) / f.sxx) / (f.n - 2)); });
const forecast = ([x0, y, x]: Value[], ctx: Ctx) => {
  const f = fit(y, x, ctx);
  if (f.sxx === 0) throw ERR.div0;
  const b = f.sxy / f.sxx;
  return lift([x0], ctx, ([v]) => f.my + b * (N(v) - f.mx));
};
register('FORECAST', 3, 3, forecast);
register('FORECAST.LINEAR', 3, 3, forecast);
register('COVARIANCE.P', 2, 2, ([y, x], ctx) => { const f = fit(y, x, ctx); return f.sxy / f.n; });
register('COVARIANCE.S', 2, 2, ([y, x], ctx) => { const f = fit(y, x, ctx); if (f.n < 2) throw ERR.div0; return f.sxy / (f.n - 1); });
const normDist = ([x, m, s, c]: Scalar[]) => {
  const sd = N(s);
  if (sd <= 0) throw ERR.num;
  const z = (N(x) - N(m)) / sd;
  return B(c) ? 0.5 * erfc(-z / Math.SQRT2) : Math.exp(-z * z / 2) / (sd * Math.sqrt(2 * Math.PI));
};
scalarFn('NORM.DIST', 4, 4, normDist);
scalarFn('NORMDIST', 4, 4, normDist);
scalarFn('NORM.S.DIST', 2, 2, ([z, c]) => normDist([z, 0, 1, c]));
scalarFn('NORMSDIST', 1, 1, ([z]) => 0.5 * (1 + erf(N(z) / Math.SQRT2)));
const normInvFn = ([p, m, s]: Scalar[]) => {
  const q = N(p), sd = N(s);
  if (q <= 0 || q >= 1 || sd <= 0) throw ERR.num;
  return N(m) + sd * normInv(q);
};
scalarFn('NORM.INV', 3, 3, normInvFn);
scalarFn('NORMINV', 3, 3, normInvFn);
scalarFn('NORM.S.INV', 1, 1, ([p]) => normInvFn([p, 0, 1]));
scalarFn('NORMSINV', 1, 1, ([p]) => normInvFn([p, 0, 1]));

// ---------------------------------------------------------------- matrices

register('MMULT', 2, 2, ([a, b], ctx) => {
  const A = matrix(a, ctx), Bm = matrix(b, ctx);
  if (!A.length || A[0].length !== Bm.length) throw ERR.value;
  return new Arr(A.map((row) => Bm[0].map((_, j) => sum(row.map((x, k) => x * Bm[k][j])))));
});
/** Gauss–Jordan with partial pivoting; returns the inverse and the determinant. */
function invert(A: number[][]): { inv: number[][] | null; det: number } {
  const n = A.length;
  if (A.some((r) => r.length !== n)) throw ERR.value;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  let det = 1;
  const scale = Math.max(1e-300, ...A.flat().map(Math.abs));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) <= 1e-15 * scale) return { inv: null, det: 0 };
    if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; det = -det; }
    const piv = M[c][c];
    det *= piv;
    for (let j = 0; j < 2 * n; j++) M[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c || M[r][c] === 0) continue;
      const f = M[r][c];
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return { inv: M.map((r) => r.slice(n)), det };
}
register('MINVERSE', 1, 1, ([a], ctx) => {
  const { inv } = invert(matrix(a, ctx));
  if (!inv) throw ERR.num;
  return new Arr(inv);
});
register('MDETERM', 1, 1, ([a], ctx) => invert(matrix(a, ctx)).det);
register('SEQUENCE', 1, 4, (a, ctx) => {
  const h = Math.trunc(N(opt(a, 0, ctx, 1))), w = Math.trunc(N(opt(a, 1, ctx, 1)));
  const start = N(opt(a, 2, ctx, 1)), step = N(opt(a, 3, ctx, 1));
  if (h < 1 || w < 1 || h * w > 1e6) throw ERR.calc;
  return new Arr(Array.from({ length: h }, (_, i) => Array.from({ length: w }, (_, j) => start + (i * w + j) * step)));
});

/**
 * LINEST(known_y, [known_x], [const], [stats]): least squares y = m1·x1 + … + mk·xk + b.
 * The first row is mk … m1, b (Excel's reversed order); with stats, rows of standard
 * errors, r² and the standard error of y, F and the degrees of freedom, and the sums of squares.
 */
register('LINEST', 1, 4, (a, ctx) => {
  const yg = matrix(a[0], ctx);
  const byRows = yg.length === 1;
  const y = byRows ? yg[0] : yg.map((r) => r[0]);
  if (!byRows && yg[0].length !== 1) throw ERR.ref;
  const n = y.length;
  let X: number[][];
  if (a.length > 1 && a[1] !== null) {
    const xg = matrix(a[1], ctx);
    X = byRows ? xg[0].map((_, j) => xg.map((r) => r[j])) : xg;
    if (X.length !== n) throw ERR.ref;
  } else X = y.map((_, i) => [i + 1]);
  const k = X[0].length;
  const withConst = a.length > 2 && a[2] !== null ? B(E(scalar(a[2], ctx))) : true;
  const stats = a.length > 3 && a[3] !== null ? B(E(scalar(a[3], ctx))) : false;
  const cols = withConst ? k + 1 : k;
  const D = X.map((r) => (withConst ? [...r, 1] : r));
  const XtX = Array.from({ length: cols }, (_, i) => Array.from({ length: cols }, (_, j) => sum(D.map((r) => r[i] * r[j]))));
  const Xty = Array.from({ length: cols }, (_, i) => sum(D.map((r, t) => r[i] * y[t])));
  const { inv } = invert(XtX);
  if (!inv) throw ERR.num;
  const beta = inv.map((row) => sum(row.map((v, j) => v * Xty[j])));
  const coef = [...beta.slice(0, k).reverse(), withConst ? beta[k] : 0];
  if (!stats) return new Arr([coef]);
  const yhat = D.map((r) => sum(r.map((v, j) => v * beta[j])));
  const ssResid = sum(y.map((v, t) => (v - yhat[t]) ** 2));
  const my = withConst ? mean(y) : 0;
  const ssReg = sum(yhat.map((v) => (v - my) ** 2));
  const df = n - cols;
  const sey = df > 0 ? Math.sqrt(ssResid / df) : ERR.num;
  const se = inv.map((row, i) => (typeof sey === 'number' ? Math.sqrt(row[i]) * sey : ERR.num));
  const seRow: Scalar[] = [...se.slice(0, k).reverse(), withConst ? se[k] : ERR.na];
  const pad = (xs: Scalar[]) => [...xs, ...Array(k + 1 - xs.length).fill(ERR.na)];
  const total = ssReg + ssResid;
  const F = df > 0 && ssResid > 0 ? ssReg / k / (ssResid / df) : ERR.num;
  return new Arr([coef, seRow, pad([total > 0 ? ssReg / total : ERR.num, sey]), pad([F, df]), pad([ssReg, ssResid])]);
});

// ---------------------------------------------------------------- calling by name

/** Call a registered function on values (SUBTOTAL uses it). */
function callFn(name: string, args: Value[], ctx: Ctx): Value {
  const def = FUNCTIONS.get(name)!;
  return def.fn ? def.fn(args, ctx) : def.lazy!(args.map((a) => () => a), ctx);
}
