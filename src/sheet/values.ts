// Spreadsheet values as Excel sees them: numbers, text, logicals, errors and blank, plus
// references and arrays while a formula is evaluated. Coercions follow Excel's rules
// ("3" + 1 = 4, TRUE + 1 = 2, blank = 0 or ""), not JavaScript's.
import type { Area } from './refs';
import { parseDateText } from './dates';

export type ErrCode = '#NULL!' | '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#NUM!' | '#N/A' | '#SPILL!' | '#CALC!' | '#CIRC!';

/**
 * An error value. #CIRC! is this engine's own: a cell in a circular reference (Excel warns
 * and shows 0, LibreOffice shows Err:522). It is never written to a file.
 */
export class XlError {
  private constructor(readonly code: ErrCode) {}
  private static all = new Map<string, XlError>();
  static of(code: ErrCode): XlError {
    let e = XlError.all.get(code);
    if (!e) XlError.all.set(code, (e = new XlError(code)));
    return e;
  }
  toString() {
    return this.code;
  }
}

export const ERR = {
  null: XlError.of('#NULL!'),
  div0: XlError.of('#DIV/0!'),
  value: XlError.of('#VALUE!'),
  ref: XlError.of('#REF!'),
  name: XlError.of('#NAME?'),
  num: XlError.of('#NUM!'),
  na: XlError.of('#N/A'),
  spill: XlError.of('#SPILL!'),
  calc: XlError.of('#CALC!'),
  circ: XlError.of('#CIRC!'),
};

export const ERROR_CODES: ErrCode[] = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#SPILL!', '#CALC!', '#CIRC!'];
export const errorOf = (s: string): XlError | null => (ERROR_CODES.includes(s.toUpperCase() as ErrCode) ? XlError.of(s.toUpperCase() as ErrCode) : null);

/** A cell value. null is a blank cell. */
export type Scalar = number | string | boolean | XlError | null;

/** A reference to cells while a formula is evaluated (functions such as SUM treat these differently from values). */
export class Ref implements Area {
  constructor(readonly sheet: number, readonly r1: number, readonly c1: number, readonly r2: number, readonly c2: number, readonly sheet2 = sheet) {}
  get rows() {
    return this.r2 - this.r1 + 1;
  }
  get cols() {
    return this.c2 - this.c1 + 1;
  }
  get single() {
    return this.r1 === this.r2 && this.c1 === this.c2 && this.sheet === this.sheet2;
  }
}

/** An array value (an array constant, or what TRANSPOSE, MMULT or A1:A3*2 give). */
export class Arr {
  constructor(readonly rows: Scalar[][]) {}
  get h() {
    return this.rows.length;
  }
  get w() {
    return this.rows[0]?.length ?? 0;
  }
}

export type Value = Scalar | Ref | Arr;

export const isErr = (v: unknown): v is XlError => v instanceof XlError;

// ---------------------------------------------------------------- numbers as text

/** Excel keeps 15 significant digits; values that differ beyond them count as equal. */
export function round15(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(15));
}

/** A number as text the way Excel's General format writes it in formulas ("&", TEXT, VALUE): up to 15 digits. */
export function numberText(x: number): string {
  if (!Number.isFinite(x)) return ERR.num.code;
  if (x === 0) return '0';
  const ax = Math.abs(x);
  if (ax >= 1e15 || ax < 1e-9) {
    const [m, e] = x.toExponential(14).split('e');
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    const ex = Number(e);
    return `${mant}E${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`;
  }
  let s = round15(x).toString();
  if (/e/.test(s)) s = round15(x).toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/**
 * A number in a cell of General format, as a grid column of about 11 characters shows it:
 * rounded to fit, exponential for very large or small values.
 */
export function generalDisplay(x: number, width = 11): string {
  if (!Number.isFinite(x)) return ERR.num.code;
  if (x === 0) return '0';
  const ax = Math.abs(x);
  const sign = x < 0 ? 1 : 0;
  if (ax < 1e11 && ax >= 1e-5) {
    // as many decimals as fit
    const intDigits = Math.max(1, Math.floor(Math.log10(ax)) + 1);
    const dec = Math.max(0, Math.min(10 - intDigits, width - sign - intDigits - 1));
    const s = Number(round15(x).toFixed(dec)).toString();
    if (!/e/.test(s) && s.length <= width && s !== '0' && s !== '-0') return s;
  }
  for (let p = Math.max(1, width - sign - 5); p >= 1; p--) {
    const [m, e] = x.toExponential(p - 1).split('e');
    const mant = m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '') : m;
    const ex = Number(e);
    const s = `${mant}E${ex < 0 ? '-' : '+'}${String(Math.abs(ex)).padStart(2, '0')}`;
    if (s.length <= width) return s;
  }
  return x.toExponential(0).toUpperCase();
}

/**
 * Text as a number the way Excel reads it in arithmetic and VALUE: "1,234.5", " 12 ", "50%",
 * "$1,000", "1e3", "(5)" (negative), ISO and US dates, times. null when it is not a number.
 */
export function parseNumberText(s: string, date1904 = false): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  let pct = false;
  if (t.endsWith('%')) { pct = true; t = t.slice(0, -1).trim(); }
  t = t.replace(/^([-+]?)\s*\$\s*/, '$1');
  if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d*)?([eE][-+]?\d+)?$/.test(t) && /\d/.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    const v = (neg ? -n : n) * (pct ? 0.01 : 1);
    return pct ? round15(v) : v;
  }
  if (pct || neg) return null;
  return parseDateText(t, date1904);
}

// ---------------------------------------------------------------- coercion

/** A scalar as a number (#VALUE! for text that is not one). */
export function toNumber(v: Scalar): number | XlError {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof XlError) return v;
  const n = parseNumberText(v);
  return n === null ? ERR.value : n;
}

export function toText(v: Scalar): string | XlError {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

export function toBool(v: Scalar): boolean | XlError {
  if (typeof v === 'boolean') return v;
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  if (v instanceof XlError) return v;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return ERR.value;
}

/** Type rank in comparisons: numbers < text < logicals (blank compares as 0 or ""). */
const rank = (v: Scalar) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);

/**
 * Compare two scalars as Excel's comparison operators do: -1, 0 or 1. Text is compared
 * without regard to case, numbers to 15 significant digits.
 */
export function compare(a: Scalar, b: Scalar): number {
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b) return 0;
    // only values within rounding of each other need the (slow) 15-digit comparison
    if (Math.abs(a - b) > 1e-13 * Math.max(Math.abs(a), Math.abs(b))) return a < b ? -1 : 1;
    const x = round15(a), y = round15(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase(), y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a === b ? 0 : a ? 1 : -1;
}

/** What a cell shows for a value in General format. */
export function displayText(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'number') return generalDisplay(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof XlError) return v.code;
  return v;
}

/**
 * Cell input as typed: "=…" is a formula, numbers, TRUE / FALSE and error literals are
 * values, "'…" forces text, everything else is text.
 */
export function parseInput(text: string): { formula: string } | { value: Scalar } {
  if (text.startsWith('=') && text.length > 1) return { formula: text.slice(1) };
  if (text === '') return { value: null };
  if (text.startsWith("'")) return { value: text.slice(1) };
  const t = text.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return { value: Number(t) };
  const u = t.toUpperCase();
  if (u === 'TRUE' || u === 'FALSE') return { value: u === 'TRUE' };
  const e = errorOf(t);
  if (e) return { value: e };
  // "12.5%" and "1,234" are numbers too, as Excel reads them when typed
  if (/^[-+]?[\d,]*\.?\d+\s*%$/.test(t) || /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    const n = parseNumberText(t);
    if (n !== null) return { value: n };
  }
  return { value: text };
}

/** The cell input that stores a value (the inverse of parseInput). */
export function inputOf(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ERR.num.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof XlError) return v.code;
  const p = parseInput(v);
  return 'value' in p && p.value === v ? v : `'${v}`;
}
