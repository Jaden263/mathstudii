// Excel formulas: tokens, a parser to a small syntax tree, and token-level rewriting for
// copying (relative references move, $ parts stay), for files (_xlfn. prefixes) and for
// tidying what was typed (=sum(a1) → =SUM(A1)).
//
// Precedence, highest first, as in Excel: ":" and " " (range, intersection), unary minus,
// %, ^ (left to right: 2^3^2 = 64), * /, + -, &, comparisons. So -2^2 = 4.
import { colIndex, colName, MAX_COLS, MAX_ROWS, type Area } from './refs';
import { ERR, errorOf, XlError, type Scalar } from './values';

export class FormulaError extends Error {
  /** What Excel shows for a formula like this one (a reference into another workbook is #REF!). */
  constructor(message: string, readonly shows: '#NAME?' | '#REF!' = '#NAME?') {
    super(message);
  }
}

/** A reference as written: each end of the area relative or absolute ($). */
export interface RefSpec {
  sheet?: string;
  /** Last sheet of a 3-D reference (Sheet1:Sheet3!A1). */
  sheet2?: string;
  area: Area;
  /** Absolute flags: row 1, column 1, row 2, column 2. */
  abs: [boolean, boolean, boolean, boolean];
  /** Whole columns (A:C) or rows (2:5). */
  whole?: 'cols' | 'rows';
  /** A one-cell reference (not A1:A1). */
  cell?: boolean;
}

export type Node =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'err'; v: XlError }
  | { t: 'ref'; ref: RefSpec }
  | { t: 'name'; name: string; sheet?: string }
  | { t: 'fn'; name: string; args: Node[] }
  | { t: 'un'; op: '-' | '+'; a: Node }
  | { t: 'pct'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'arr'; rows: Scalar[][] }
  | { t: 'none' };

type Tok =
  | { k: 'num'; v: number; s: string }
  | { k: 'str'; v: string; s: string }
  | { k: 'err'; v: XlError; s: string }
  | { k: 'ref'; ref: RefSpec; s: string }
  | { k: 'name'; v: string; sheet?: string; s: string }
  | { k: 'fn'; v: string; s: string }
  | { k: 'op'; v: string; s: string }
  | { k: 'punct'; v: string; s: string }
  | { k: 'ws'; s: string };

const WORD = /^[\p{L}_\\][\p{L}\p{N}_.\\?]*/u;
const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

function cellSpec(s: string): { r: number; c: number; ar: boolean; ac: boolean } | null {
  const m = CELL.exec(s);
  if (!m) return null;
  const c = colIndex(m[2]), r = Number(m[4]) - 1;
  if (c < 0 || r < 0 || r >= MAX_ROWS) return null;
  return { r, c, ac: !!m[1], ar: !!m[3] };
}

/** Function names in files carry the version prefixes of newer functions. */
export const stripPrefix = (name: string) => name.replace(/^(_xlfn\.)?(_xlws\.)?/i, '').toUpperCase();

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const rest = () => src.slice(i);
  while (i < src.length) {
    const ch = src[i];
    let m: RegExpExecArray | null;
    if (/\s/.test(ch)) {
      m = /^\s+/.exec(rest())!;
      out.push({ k: 'ws', s: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1, v = '';
      for (; j < src.length; j++) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { v += '"'; j++; continue; }
          break;
        }
        v += src[j];
      }
      if (j >= src.length) throw new FormulaError('A text in quotes is not closed');
      out.push({ k: 'str', v, s: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      m = /^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|SPILL!|CALC!|GETTING_DATA)/i.exec(rest());
      if (!m) throw new FormulaError(`Unknown error value ${rest().slice(0, 8)}`);
      out.push({ k: 'err', v: errorOf(m[0]) ?? ERR.na, s: m[0] });
      i += m[0].length;
      continue;
    }
    // a sheet prefix, quoted or plain, then a reference
    let sheet: string | undefined, sheet2: string | undefined, start = i;
    if (ch === "'") {
      m = /^'((?:[^']|'')+)'!/.exec(rest());
      if (!m) throw new FormulaError('A quoted sheet name must be followed by !');
      const parts = m[1].replace(/''/g, "'").split(':');
      sheet = parts[0];
      sheet2 = parts[1];
      i += m[0].length;
    } else if ((m = /^([\p{L}\p{N}_.]+)(?::([\p{L}\p{N}_.]+))?!/u.exec(rest()))) {
      sheet = m[1];
      sheet2 = m[2];
      i += m[0].length;
    } else if ((m = /^\[\d+\]/.exec(rest()))) {
      // a reference into another workbook: not something this engine can read
      throw new FormulaError('References to other workbooks are not supported', '#REF!');
    }
    const r = rest();
    // rows: 2:5, $2:$5
    if ((m = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![\d.(\p{L}])/u.exec(r))) {
      const r1 = Number(m[2]) - 1, r2 = Number(m[4]) - 1;
      out.push({ k: 'ref', ref: { sheet, sheet2, area: { r1: Math.min(r1, r2), c1: 0, r2: Math.max(r1, r2), c2: MAX_COLS - 1 }, abs: [!!m[1], true, !!m[3], true], whole: 'rows' }, s: src.slice(start, i + m[0].length) });
      i += m[0].length;
      continue;
    }
    if (!sheet && /[\d.]/.test(ch) && (m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(r))) {
      out.push({ k: 'num', v: Number(m[0]), s: m[0] });
      i += m[0].length;
      continue;
    }
    // columns: A:C, $A:$C
    if ((m = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\p{L}\p{N}_.(!])/u.exec(r)) && colIndex(m[2]) >= 0 && colIndex(m[4]) >= 0) {
      const c1 = colIndex(m[2]), c2 = colIndex(m[4]);
      out.push({ k: 'ref', ref: { sheet, sheet2, area: { r1: 0, c1: Math.min(c1, c2), r2: MAX_ROWS - 1, c2: Math.max(c1, c2) }, abs: [true, !!m[1], true, !!m[3]], whole: 'cols' }, s: src.slice(start, i + m[0].length) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?(?![\p{L}\p{N}_.(])/u.exec(r))) {
      const [a, b] = m[0].split(':');
      const p = cellSpec(a), q = b ? cellSpec(b) : p;
      if (p && q) {
        // A1:B2 written in any corner order is the same area; the flags follow the corners
        const area = { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
        const top = p.r <= q.r ? p : q, left = p.c <= q.c ? p : q, bottom = top === p ? q : p, right = left === p ? q : p;
        out.push({ k: 'ref', ref: { sheet, sheet2, area, abs: [top.ar, left.ac, bottom.ar, right.ac], cell: !b }, s: src.slice(start, i + m[0].length) });
        i += m[0].length;
        continue;
      }
    }
    if (sheet) {
      // Sheet1!name: a sheet-level defined name
      if ((m = WORD.exec(r))) {
        out.push({ k: 'name', v: m[0], sheet, s: src.slice(start, i + m[0].length) });
        i += m[0].length;
        continue;
      }
      throw new FormulaError(`Expected a reference after ${src.slice(start, i)}`);
    }
    if ((m = WORD.exec(r))) {
      // a function name is followed straight by its bracket
      if (src[i + m[0].length] === '(') out.push({ k: 'fn', v: m[0], s: m[0] });
      else out.push({ k: 'name', v: m[0], s: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = /^(<=|>=|<>|[-+*/^&=<>%:])/.exec(r))) {
      out.push({ k: 'op', v: m[0], s: m[0] });
      i += m[0].length;
      continue;
    }
    if ('(),;{}'.includes(ch)) {
      out.push({ k: 'punct', v: ch, s: ch });
      i++;
      continue;
    }
    throw new FormulaError(`Unexpected "${ch}"`);
  }
  return out;
}

// ---------------------------------------------------------------- parser

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(skipWs = true): Tok | undefined {
    let j = this.i;
    if (skipWs) while (this.toks[j]?.k === 'ws') j++;
    return this.toks[j];
  }
  private next(): Tok | undefined {
    while (this.toks[this.i]?.k === 'ws') this.i++;
    return this.toks[this.i++];
  }
  private isOp(v: string) {
    const t = this.peek();
    return t?.k === 'op' && t.v === v;
  }
  private isPunct(v: string) {
    const t = this.peek();
    return t?.k === 'punct' && t.v === v;
  }

  parse(): Node {
    const n = this.expr();
    const t = this.peek();
    if (t) throw new FormulaError(`Unexpected "${t.s}"`);
    return n;
  }

  private expr(): Node {
    let a = this.concat();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
        this.next();
        a = { t: 'bin', op: t.v, a, b: this.concat() };
      } else return a;
    }
  }
  private concat(): Node {
    let a = this.additive();
    while (this.isOp('&')) {
      this.next();
      a = { t: 'bin', op: '&', a, b: this.additive() };
    }
    return a;
  }
  private additive(): Node {
    let a = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        a = { t: 'bin', op: t.v, a, b: this.multiplicative() };
      } else return a;
    }
  }
  private multiplicative(): Node {
    let a = this.power();
    for (;;) {
      const t = this.peek();
      if (t?.k === 'op' && (t.v === '*' || t.v === '/')) {
        this.next();
        a = { t: 'bin', op: t.v, a, b: this.power() };
      } else return a;
    }
  }
  private power(): Node {
    let a = this.percent();
    while (this.isOp('^')) {
      this.next();
      a = { t: 'bin', op: '^', a, b: this.percent() };
    }
    return a;
  }
  private percent(): Node {
    let a = this.unary();
    while (this.isOp('%')) {
      this.next();
      a = { t: 'pct', a };
    }
    return a;
  }
  private unary(): Node {
    const t = this.peek();
    if (t?.k === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      return { t: 'un', op: t.v, a: this.unary() };
    }
    return this.range();
  }
  private range(): Node {
    let a = this.primary();
    for (;;) {
      if (this.isOp(':')) {
        this.next();
        a = { t: 'bin', op: ':', a, b: this.primary() };
        continue;
      }
      // a space between two references is their intersection
      const ws = this.toks[this.i];
      const after = this.peek();
      if (ws?.k === 'ws' && after && (after.k === 'ref' || (after.k === 'name' && !/^(TRUE|FALSE)$/i.test(after.v))) && isRefNode(a)) {
        a = { t: 'bin', op: ' ', a, b: this.primary() };
        continue;
      }
      return a;
    }
  }
  private primary(): Node {
    const t = this.next();
    if (!t) throw new FormulaError('The formula ends too early');
    switch (t.k) {
      case 'num': return { t: 'num', v: t.v };
      case 'str': return { t: 'str', v: t.v };
      case 'err': return { t: 'err', v: t.v };
      case 'ref': return { t: 'ref', ref: t.ref };
      case 'name': {
        if (!t.sheet && /^(TRUE|FALSE)$/i.test(t.v)) return { t: 'bool', v: t.v.toUpperCase() === 'TRUE' };
        return { t: 'name', name: t.v, sheet: t.sheet };
      }
      case 'fn': {
        this.next(); // (
        const args: Node[] = [];
        if (this.isPunct(')')) {
          this.next();
          return { t: 'fn', name: stripPrefix(t.v), args };
        }
        for (;;) {
          if (this.isPunct(',') || this.isPunct(')')) args.push({ t: 'none' });
          else args.push(this.expr());
          const sep = this.next();
          if (sep?.k === 'punct' && sep.v === ',') continue;
          if (sep?.k === 'punct' && sep.v === ')') break;
          throw new FormulaError(`Expected , or ) in ${t.v}(`);
        }
        return { t: 'fn', name: stripPrefix(t.v), args };
      }
      case 'punct':
        if (t.v === '(') {
          const e = this.expr();
          const c = this.next();
          if (c?.k !== 'punct' || c.v !== ')') throw new FormulaError('A bracket is not closed');
          return e;
        }
        if (t.v === '{') return this.array();
        throw new FormulaError(`Unexpected "${t.s}"`);
      case 'op':
        throw new FormulaError(`Unexpected "${t.s}"`);
      default:
        throw new FormulaError('Unexpected end');
    }
  }
  private array(): Node {
    const rows: Scalar[][] = [[]];
    for (;;) {
      let t = this.next();
      let neg = false;
      if (t?.k === 'op' && (t.v === '-' || t.v === '+')) { neg = t.v === '-'; t = this.next(); }
      if (!t) throw new FormulaError('An array constant is not closed');
      let v: Scalar;
      if (t.k === 'num') v = neg ? -t.v : t.v;
      else if (t.k === 'str' && !neg) v = t.v;
      else if (t.k === 'err' && !neg) v = t.v;
      else if (t.k === 'name' && /^(TRUE|FALSE)$/i.test(t.v) && !neg) v = t.v.toUpperCase() === 'TRUE';
      else throw new FormulaError('Array constants hold numbers, text, TRUE/FALSE or errors');
      rows[rows.length - 1].push(v);
      const sep = this.next();
      if (sep?.k === 'punct' && sep.v === ',') continue;
      if (sep?.k === 'punct' && sep.v === ';') { rows.push([]); continue; }
      if (sep?.k === 'punct' && sep.v === '}') break;
      throw new FormulaError('Expected , ; or } in an array constant');
    }
    if (rows.some((r) => r.length !== rows[0].length)) throw new FormulaError('The rows of an array constant must be the same length');
    return { t: 'arr', rows };
  }
}

const isRefNode = (n: Node): boolean => n.t === 'ref' || n.t === 'name' || (n.t === 'bin' && (n.op === ':' || n.op === ' ')) || (n.t === 'fn' && (n.name === 'INDEX' || n.name === 'OFFSET'));

/** Parse a formula (without the leading =). */
export function parseFormula(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

// ---------------------------------------------------------------- rewriting

function refText(ref: RefSpec, area: Area): string {
  const sh = ref.sheet === undefined ? '' : sheetPrefix(ref.sheet, ref.sheet2);
  const d = (b: boolean) => (b ? '$' : '');
  if (ref.whole === 'cols') return `${sh}${d(ref.abs[1])}${colName(area.c1)}:${d(ref.abs[3])}${colName(area.c2)}`;
  if (ref.whole === 'rows') return `${sh}${d(ref.abs[0])}${area.r1 + 1}:${d(ref.abs[2])}${area.r2 + 1}`;
  const a = `${d(ref.abs[1])}${colName(area.c1)}${d(ref.abs[0])}${area.r1 + 1}`;
  if (ref.cell) return sh + a;
  return `${sh}${a}:${d(ref.abs[3])}${colName(area.c2)}${d(ref.abs[2])}${area.r2 + 1}`;
}

function sheetPrefix(sheet: string, sheet2?: string): string {
  const both = sheet2 ? `${sheet}:${sheet2}` : sheet;
  const plain = (s: string) => /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(s) && !CELL.test(s) && !/^(TRUE|FALSE)$/i.test(s);
  return (plain(sheet) && (!sheet2 || plain(sheet2)) ? both : `'${both.replace(/'/g, "''")}'`) + '!';
}

/**
 * The formula as it reads after moving it dr rows and dc columns (copy, fill, shared
 * formulas of a file): relative parts move, absolute ones stay; a reference pushed off the
 * sheet becomes #REF!.
 */
export function translateFormula(src: string, dr: number, dc: number): string {
  if (!dr && !dc) return src;
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch {
    return src;
  }
  return toks.map((t) => {
    if (t.k !== 'ref') return t.s;
    const { area, abs, whole } = t.ref;
    const a = { ...area };
    if (whole !== 'cols') {
      if (!abs[0]) a.r1 += dr;
      if (!abs[2]) a.r2 += dr;
    }
    if (whole !== 'rows') {
      if (!abs[1]) a.c1 += dc;
      if (!abs[3]) a.c2 += dc;
    }
    if (a.r1 < 0 || a.c1 < 0 || a.r2 >= MAX_ROWS || a.c2 >= MAX_COLS) return '#REF!';
    return refText(t.ref, a);
  }).join('');
}

/** Functions Excel stores with the _xlfn. prefix (added after Excel 2007). */
const XLFN = new Set([
  'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'XOR', 'CONCAT', 'TEXTJOIN', 'XLOOKUP', 'XMATCH',
  'CEILING.MATH', 'FLOOR.MATH', 'CEILING.PRECISE', 'FLOOR.PRECISE', 'IFNA', 'DAYS', 'RANK.EQ', 'RANK.AVG', 'PERCENTILE.INC',
  'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC', 'MODE.SNGL', 'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'SEQUENCE',
  'UNIQUE', 'SORT', 'FILTER', 'LET', 'COT', 'SEC', 'CSC', 'ACOT', 'COVARIANCE.P', 'COVARIANCE.S', 'FORECAST.LINEAR', 'NUMBERVALUE',
  'UNICHAR', 'UNICODE', 'ISFORMULA', 'MODE.MULT', 'AGGREGATE', 'NETWORKDAYS.INTL', 'WORKDAY.INTL', 'ISOWEEKNUM',
]);
/** …and the dynamic-array ones with _xlfn._xlws. */
const XLWS = new Set(['SORT', 'FILTER']);

/** A formula for a file: no "=", newer functions with their prefixes. */
export function toFileFormula(src: string): string {
  const body = src.startsWith('=') ? src.slice(1) : src;
  try {
    return tokenize(body).map((t) => {
      if (t.k !== 'fn') return t.s;
      const n = stripPrefix(t.v);
      return XLWS.has(n) ? `_xlfn._xlws.${n}` : XLFN.has(n) ? `_xlfn.${n}` : n;
    }).join('');
  } catch {
    return body;
  }
}

/** A formula from a file as a user would type it: "=" and no version prefixes. */
export function fromFileFormula(f: string): string {
  try {
    return '=' + tokenize(f).map((t) => (t.k === 'fn' ? stripPrefix(t.v) : t.s)).join('');
  } catch {
    return '=' + f;
  }
}

/** Upper-case function names and references, as Excel does when a formula is entered. */
export function tidyFormula(src: string): string {
  if (!src.startsWith('=')) return src;
  try {
    return '=' + tokenize(src.slice(1)).map((t) => {
      if (t.k === 'fn') return t.v.toUpperCase();
      if (t.k === 'ref') return refText(t.ref, t.ref.area);
      if (t.k === 'name' && /^(true|false)$/i.test(t.v)) return t.v.toUpperCase();
      if (t.k === 'err') return t.s.toUpperCase();
      return t.s;
    }).join('');
  } catch {
    return src;
  }
}

/** Names of the functions a formula calls. */
export function functionsIn(node: Node, out = new Set<string>()): Set<string> {
  if (node.t === 'fn') {
    out.add(node.name);
    node.args.forEach((a) => functionsIn(a, out));
  } else if (node.t === 'bin') {
    functionsIn(node.a, out);
    functionsIn(node.b, out);
  } else if (node.t === 'un' || node.t === 'pct') functionsIn(node.a, out);
  return out;
}

/** The formula with references to sheets renamed (old name, any case → new name). */
export function renameSheets(src: string, names: Map<string, string>): string {
  if (!names.size || !src.startsWith('=')) return src;
  const find = (s: string | undefined) => (s === undefined ? undefined : names.get(s.toUpperCase()) ?? s);
  try {
    return '=' + tokenize(src.slice(1)).map((t) => {
      if (t.k === 'ref' && t.ref.sheet !== undefined) return refText({ ...t.ref, sheet: find(t.ref.sheet), sheet2: find(t.ref.sheet2) }, t.ref.area);
      if (t.k === 'name' && t.sheet !== undefined) return sheetPrefix(find(t.sheet)!) + t.v;
      return t.s;
    }).join('');
  } catch {
    return src;
  }
}
