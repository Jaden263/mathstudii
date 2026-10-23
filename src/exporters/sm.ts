// SMath Studio .sm: XML with every formula as a postfix (RPN) list of tokens, as SMath 0.99
// saves it (and 1.x still reads): operands, units (style="unit"), strings, operators and
// functions with their argument counts; a shown result is a <result> after the input, its
// unit a <contract>. SMath has no solve blocks, global definitions or range sums, and counts
// from 1: a worksheet that counts from 0 has its indices shifted by one.
import { isUnit, isMatrix, math } from '../engine/math';
import { unitParts } from '../engine/format';
import { esc, isCheck } from './mathml';
import { paragraphs, plain } from './richText';
import { itemSize, notExported, type Item, type Plan } from './plan';
import { NotRepresentable, PRIME_CONSTANTS, TreeReader, plainNumber, type PStmt, type Statement, type Target, type X } from './tree';
import { toBase64 } from '../importers/common';

const operand = (t: string) => `<e type="operand">${esc(t)}</e>`;
const unitTok = (t: string) => `<e type="operand" style="unit">${esc(t)}</e>`;
const strTok = (t: string) => `<e type="operand" style="string">${esc(t)}</e>`;
const op = (o: string, args = 2) => `<e type="operator" args="${args}">${esc(o)}</e>`;
const fn = (name: string, args: number) => `<e type="function" args="${args}">${esc(name)}</e>`;
const BRACKET = '<e type="bracket">(</e>';

/** A number as SMath writes one: 1.38e-23 is 1.38·10^(−23) there (it reads no exponent notation). */
function number(v: string): string {
  const m = /^(\d*\.?\d*)e([+-]?)(\d+)$/i.exec(v);
  if (!m) return operand(v);
  return operand(m[1]) + operand('10') + operand(String(Number(m[3]))) + (m[2] === '-' ? op('-', 1) : '') + op('^') + op('*');
}

const OPS: Record<string, [string, number]> = {
  plus: ['+', 2], minus: ['-', 2], mult: ['*', 2], div: ['/', 2], pow: ['^', 2], neg: ['-', 1], not: ['¬', 1],
  and: ['&', 2], or: ['|', 2], xor: ['⊕', 2], equal: ['≡', 2], notEqual: ['≠', 2], lessThan: ['<', 2], greaterThan: ['>', 2],
  lessOrEqual: ['≤', 2], greaterOrEqual: ['≥', 2], factorial: ['!', 1],
};

/** Our names of SMath's built-ins (the importer's FN_MAP the other way; atan stays atan, as a file SMath 0.99 saved has it). */
const FN_OUT: Record<string, string> = {
  asin: 'arcsin', acos: 'arccos', acot: 'arccot', asec: 'arcsec', acsc: 'arccsc', asinh: 'arcsinh',
  acosh: 'arccosh', atanh: 'arctanh', acoth: 'arccoth', gamma: 'Gamma', Γ: 'Gamma', rnd: 'random', prod: 'product',
  // what the SMath import maps SMath's at, Zeros and Ones to
  subs: 'at', zeros: 'Zeros', ones: 'Ones', lsplineAt: 'lspline',
};

/** Built-ins with arguments that are indices (counted from 1 in SMath): submatrix(M, ir, jr, ic, jc), csort(M, j). */
const INDEX_ARGS: Record<string, number[]> = { submatrix: [1, 2, 3, 4], csort: [1], rsort: [1] };

/** mathjs unit names that SMath spells otherwise. */
const SM_UNIT: Record<string, string> = {
  inch: 'in', tonne: 't', L: 'l', liter: 'l', gram: 'g', gm: 'g', hr: 'h', hour: 'h', degC: '°C', degF: '°F', ohm: 'Ω',
  kohm: 'kΩ', Mohm: 'MΩ', year: 'yr', minute: 'min', second: 's', meter: 'm',
};
export function smathUnit(name: string): string {
  if (SM_UNIT[name]) return SM_UNIT[name];
  if (/^u[A-Za-z]/.test(name)) return `μ${name.slice(1)}`;
  return name;
}

/** f_ck is f with the literal subscript ck: SMath writes it f.ck. */
const smName = (name: string) => name.replace(/_/g, '.');

class SmWriter {
  private units = new TreeReader([]);
  /** The worksheet's range variables (i := 0 .. n), for the sums over them. */
  readonly ranges = new Map<string, Extract<X, { k: 'range' }>>();
  constructor(private shift: number) {}

  /** An index, counted from 1 in SMath. */
  private index(i: X): string {
    if (!this.shift) return this.x(i);
    if (i.k === 'num' && /^\d+$/.test(i.v)) return operand(String(Number(i.v) + this.shift));
    return this.x(i) + operand(String(this.shift)) + op('+');
  }

  x(e: X): string {
    switch (e.k) {
      case 'num':
        return number(e.v);
      case 'imag':
        // i is a variable name here: √(−1) is the imaginary unit in SMath as in mathstudii
        return operand(e.v) + operand('1') + op('-', 1) + fn('sqrt', 1) + op('*');
      case 'str':
        return strTok(e.v);
      case 'id':
        if (e.role === 'unit') return unitTok(smathUnit(e.name));
        if (e.role === 'const') return this.constant(e.name);
        return operand(smName(e.name));
      case 'op': {
        const o = OPS[e.op];
        if (e.op === 'transpose') return this.x(e.args[0]) + fn('transpose', 1);
        if (!o) throw new NotRepresentable(`the ${e.op} operator`);
        return e.args.map((a) => this.x(a)).join('') + op(o[0], o[1]);
      }
      case 'scale':
        return this.x(e.value) + this.x(e.unit) + op('*');
      case 'call': {
        if (/^(find|minerr|minimize|maximize|odesolve|Odesolve|Pdesolve|pdesolve)$/.test(e.fn)) throw new NotRepresentable(`${e.fn} outside a solve block`);
        // text compared with text is SMath's =; every root between a and b its solve(f, x, a, b)
        if (e.role === 'fn' && e.fn === 'equalText' && e.args.length === 2) return this.x(e.args[0]) + this.x(e.args[1]) + op('≡');
        const name = e.role === 'var' ? smName(e.fn) : e.fn === 'roots' && e.args.length === 4 ? 'solve' : FN_OUT[e.fn] ?? e.fn;
        const at = e.role === 'fn' ? INDEX_ARGS[e.fn] : undefined;
        return e.args.map((a, i) => (at?.includes(i) ? this.index(a) : this.x(a))).join('') + fn(name, e.args.length);
      }
      case 'index':
        return this.x(e.base) + e.idx.map((i) => this.index(i)).join('') + fn('el', 1 + e.idx.length);
      case 'matrix': {
        const rows = e.rows.length, cols = e.rows[0]?.length ?? 0;
        // row by row, then the row and column counts
        return e.rows.flat().map((c) => this.x(c)).join('') + operand(String(rows)) + operand(String(cols)) + fn('mat', rows * cols + 2);
      }
      case 'parens':
        return this.x(e.a) + BRACKET;
      case 'range':
        return this.x(e.first) + this.x(e.last) + (e.second ? this.x(e.second) : '') + fn('range', e.second ? 3 : 2);
      case 'integral':
        return this.x(e.body) + operand(smName(e.v)) + this.x(e.lo) + this.x(e.hi) + fn('int', 4);
      case 'sum':
      case 'prod': {
        // over a range variable i := a .. b: Σ from a to b (SMath has bounds only, in steps of one)
        const r = e.lo && e.hi ? { first: e.lo, last: e.hi } : this.ranges.get(e.v);
        if (!r || ('second' in r && r.second)) throw new NotRepresentable('a sum over a range variable');
        return this.x(e.body) + operand(smName(e.v)) + this.x(r.first) + this.x(r.last) + fn(e.k === 'sum' ? 'sum' : 'product', 4);
      }
      case 'vsum':
        return this.x(e.a) + fn('sum', 1);
      case 'deriv':
        return this.x(e.body) + operand(smName(e.v)) + (e.n > 1 ? operand(String(e.n)) : '') + fn('diff', e.n > 1 ? 3 : 2);
      case 'prime': {
        const at = e.args[0];
        if (e.args.length !== 1 || at.k !== 'id') throw new NotRepresentable(`the derivative ${e.f}${"'".repeat(e.n)} at a point`);
        return operand(smName(at.name)) + fn(smName(e.f), 1) + operand(smName(at.name)) + (e.n > 1 ? operand(String(e.n)) : '') + fn('diff', e.n > 1 ? 3 : 2);
      }
      case 'sqrt':
        return this.x(e.a) + fn('sqrt', 1);
      case 'root':
        // ⁿ√a as a^(1/n), the same for the positive numbers it is used on
        return this.x(e.a) + operand('1') + this.x(e.n) + op('/') + BRACKET + op('^');
      case 'abs':
        return this.x(e.a) + fn('abs', 1);
      case 'col':
      case 'row':
        return this.x(e.m) + this.index(e.j) + fn(e.k, 2);
      case 'cross':
        return this.x(e.a) + this.x(e.b) + fn('cross', 2);
      case 'vectorize':
        return this.x(e.a) + fn('vectorize', 1);
      case 'if':
        return this.x(e.cond) + this.x(e.a) + this.x(e.b) + fn('if', 3);
    }
  }

  private constant(name: string): string {
    if (name === 'π' || name === 'e' || name === '∞') return operand(name);
    // standard gravity is a unit in SMath (gₑ)
    if (name === 'g') return unitTok('g.e');
    const v = (math as unknown as Record<string, unknown>)[name];
    if (name in PRIME_CONSTANTS && typeof v === 'number') return this.x({ k: 'num', v: plainNumber(String(v)) });
    if (!(name in PRIME_CONSTANTS) || !isUnit(v)) throw new NotRepresentable(`the constant ${name}`);
    const si = v.toSI();
    const u = si.formatUnits();
    return this.x({ k: 'scale', value: { k: 'num', v: plainNumber(String(si.toNumeric(u))) }, unit: this.units.unit(u) });
  }

  target(t: Target): string {
    switch (t.k) {
      case 'var':
        return operand(smName(t.name));
      case 'fn':
        return t.params.map((p) => operand(smName(p))).join('') + fn(smName(t.name), t.params.length);
      case 'index':
        return operand(smName(t.name)) + t.idx.map((i) => this.index(i)).join('') + fn('el', 1 + t.idx.length);
      case 'col':
        throw new NotRepresentable('a column assignment');
      case 'row':
        throw new NotRepresentable('a row assignment');
      case 'list':
        throw new NotRepresentable('a definition of several names at once');
      case 'elements':
        throw new NotRepresentable('a definition of elements of several arrays at once');
    }
  }

  /** Statements as an SMath program: line(s₁, s₂, …, n, 1); its value is the last one's. */
  program(body: PStmt[]): string {
    return body.map((s, i) => this.pstmt(s, i === body.length - 1)).join('') + operand(String(body.length)) + operand('1') + fn('line', body.length + 2);
  }

  private block(body: PStmt[], last: boolean): string {
    return body.length === 1 ? this.pstmt(body[0], last) : body.map((s, i) => this.pstmt(s, last && i === body.length - 1)).join('') + operand(String(body.length)) + operand('1') + fn('line', body.length + 2);
  }

  pstmt(s: PStmt, last: boolean): string {
    switch (s.k) {
      case 'local':
        if (s.target.k === 'col') throw new NotRepresentable('a column assignment in a program');
        return this.target(s.target) + this.x(s.value) + op(':');
      case 'localProgram':
        return this.target(s.target) + this.program(s.body) + op(':');
      case 'if': {
        const chain = (bs: typeof s.branches): string => {
          const [b, ...rest] = bs;
          if (!b.cond) return this.block(b.body, last);
          const other = rest.length ? chain(rest) : operand('#');
          return this.x(b.cond) + this.block(b.body, last) + other + fn('if', 3);
        };
        return chain(s.branches);
      }
      case 'for': {
        const v = operand(smName(s.v));
        return v + this.x(s.iter) + this.block(s.body, false) + fn('for', 3);
      }
      case 'while':
        return this.x(s.cond) + this.block(s.body, false) + fn('while', 2);
      case 'try':
        return this.block(s.body, last) + this.block(s.onError, last) + fn('try', 2);
      case 'return':
        // a program's value is its last statement's: a return elsewhere has no counterpart
        if (!last) throw new NotRepresentable('a return before the end of a program');
        return this.x(s.value);
      case 'break':
        return operand('break');
      case 'continue':
        return operand('continue');
      case 'expr':
        return this.x(s.value);
    }
  }
}

/** The size of a display unit a plain number can be shown in: deg is π/180, % is 1/100 (1 for any other). */
function plainScale(unit: string): number {
  if (!unit) return 1;
  if (unit === '%') return 0.01;
  try {
    const u = math.unit(1, unit);
    return u.equalBase(math.unit('rad')) || u.dimensions.every((d) => d === 0) ? ((u.value as number | null) ?? 1) : 1;
  } catch {
    return 1;
  }
}

/** A value as SMath shows it: a number in the display unit, a matrix, text. */
function resultTokens(v: unknown, unit: string, metric: boolean): { tokens: string; contract: string } | null {
  const num = (n: number) => {
    const s = plainNumber(String(+n.toPrecision(12)));
    return s.startsWith('-') ? number(s.slice(1)) + op('-', 1) : number(s);
  };
  // a plain number shown in deg or %: in that unit (an angle is a number, 0.6938 is 39.75°; SMath's % is 1/100)
  const scale = plainScale(unit);
  if (typeof v === 'number' && Number.isFinite(v)) return { tokens: num(v / scale), contract: '' };
  if (typeof v === 'boolean') return { tokens: operand(v ? '1' : '0'), contract: '' };
  if (typeof v === 'string') return { tokens: strTok(v), contract: '' };
  if (isUnit(v)) {
    let p: { value: unknown; units: string };
    try {
      p = unitParts(v, unit || undefined, metric);
    } catch {
      return null;
    }
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) return null;
    return { tokens: num(p.value), contract: unit ? '' : p.units };
  }
  if (isMatrix(v) || Array.isArray(v)) {
    const a = (isMatrix(v) ? v.toArray() : v) as unknown[];
    const rows = (a.length && Array.isArray(a[0]) ? a : a.map((x) => [x])) as unknown[][];
    if (!rows.length || rows.length * rows[0].length > 400) return null;
    if (rows.flat().some((c) => typeof c !== 'number' || !Number.isFinite(c))) return null;
    return { tokens: rows.flat().map((c) => num((c as number) / scale)).join('') + operand(String(rows.length)) + operand(String(rows[0].length)) + fn('mat', rows.length * rows[0].length + 2), contract: '' };
  }
  return null;
}

export interface SmOptions {
  precision?: number;
  expThreshold?: number;
  /** The worksheet's first index (SMath's is always 1). */
  origin?: 0 | 1;
  metric?: boolean;
}

export function writeSm(plan: Plan, opts: SmOptions = {}): Uint8Array {
  const shift = (opts.origin ?? plan.origin) === 0 ? 1 : 0;
  const w = new SmWriter(shift);
  for (const it of plan.items) if (it.k === 'math' && it.st.k === 'define' && it.st.target.k === 'var' && it.st.value.k === 'range') w.ranges.set(it.st.target.name, it.st.value);
  const units = new TreeReader([]);
  const regions: string[] = [];
  let id = 0, pictures = 0, globals = 0;
  const region = (it: Item, body: string) => {
    const { w: width, h: height } = itemSize(it);
    regions.push(`<region id="${id++}" left="${Math.round(it.x)}" top="${Math.round(it.y)}" width="${Math.round(width)}" height="${Math.round(height)}" color="#000000" bgColor="#ffffff" fontSize="10">${body}</region>`);
  };
  const input = (tokens: string) => `<input>${tokens}</input>`;
  /** The <contract> (display unit) and <result> of a shown value. */
  const shown = (value: unknown, unit?: X, unitSrc = '') => {
    const r = resultTokens(value, unitSrc, opts.metric ?? true);
    let contract = unit ? w.x(unit) : '';
    if (!unit && r?.contract) {
      try {
        contract = w.x(units.unit(r.contract));
      } catch {
        contract = '';
      }
    }
    return `${contract ? `<contract>${contract}</contract>` : ''}<result action="numeric">${r?.tokens ?? operand('#')}</result>`;
  };
  const unitText = (u?: X) => (u ? unitSource(u) : '');

  const statement = (st: Statement, result: unknown): string => {
    switch (st.k) {
      case 'define': {
        if (st.global) globals++;
        const def = w.target(st.target) + w.x(st.value) + op(':');
        return `<math>${input(def)}${st.show ? shown(result, st.unit, unitText(st.unit)) : ''}</math>`;
      }
      case 'program':
        if (st.global) globals++;
        return `<math>${input(w.target(st.target) + w.program(st.body) + op(':'))}</math>`;
      case 'eval':
        return `<math>${input(w.x(st.expr))}${shown(result, st.unit, unitText(st.unit))}</math>`;
      case 'symbolic':
        if (st.keyword) throw new NotRepresentable(`the symbolic keyword “${st.keyword.name}”`);
        return `<math>${input(w.x(st.expr))}<result action="symbolic">${operand('#')}</result></math>`;
      case 'expr':
        return `<math>${input(w.x(st.expr))}${isCheck(st.expr) ? shown(result) : ''}</math>`;
    }
  };

  for (const it of plan.items) {
    try {
      switch (it.k) {
        case 'math':
          region(it, statement(it.st, it.result));
          break;
        case 'text': {
          // SMath 0.99 formats whole paragraphs: bold headings, bold or italic when all of it is
          const ps = paragraphs(it.md).map((p) => {
            const bold = p.kind !== 'p' || p.runs.every((r) => r.bold || !r.text.trim());
            const italic = !bold && p.runs.every((r) => r.italic || !r.text.trim());
            return `<p${bold ? ' bold="true"' : ''}${italic ? ' italic="true"' : ''}>${esc(plain(p))}</p>`;
          });
          region(it, `<text lang="eng">${ps.join('') || '<p />'}</text>`);
          break;
        }
        case 'picture':
          pictures++;
          region(it, `<picture><raw format="png" encoding="base64">${toBase64(it.png)}</raw></picture>`);
          break;
        case 'solve':
        case 'plot':
          // never planned for SMath (plan.ts makes notes, values and pictures)
          break;
      }
    } catch (e) {
      if (!(e instanceof NotRepresentable)) throw e;
      const t = notExported(it, e, 'SMath Studio', plan);
      region(t, `<text lang="eng"><p italic="true">${esc(t.md)}</p></text>`);
    }
  }
  if (globals) plan.warnings.push(`${globals} global definition${globals > 1 ? 's' : ''} (≡) became ordinary ones: SMath has none, so ${globals > 1 ? 'they apply' : 'it applies'} below where ${globals > 1 ? 'they stand' : 'it stands'} only`);
  if (shift) plan.warnings.push('SMath counts from 1: indices were shifted by one (functions that return an index, such as match or lookup, still count from 0)');

  const guid = globalThis.crypto?.randomUUID?.() ?? '00000000-0000-0000-0000-000000000000';
  const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<?application progid="SMath Studio Desktop" version="0.99.7030.1435"?>
<worksheet xmlns="http://smath.info/schemas/worksheet/1.0">
  <settings ppi="96">
    <identity>
      <id>${guid}</id>
      <revision>1</revision>
    </identity>
    <calculation>
      <precision>${Math.min(15, opts.precision ?? 4)}</precision>
      <exponentialThreshold>${Math.min(15, opts.expThreshold ?? 5)}</exponentialThreshold>
      <trailingZeros>false</trailingZeros>
      <significantDigitsMode>false</significantDigitsMode>
      <roundingMode>0</roundingMode>
      <fractions>decimal</fractions>
    </calculation>
    <pageModel active="false" viewMode="2" printGrid="false" printAreas="true" simpleEqualsOnly="false" printBackgroundImages="true">
      <paper id="9" orientation="Portrait" width="827" height="1169" />
      <margins left="39" right="39" top="49" bottom="49" />
      <header alignment="Center" color="#a9a9a9">&amp;[DATE] &amp;[TIME] - &amp;[FILENAME]</header>
      <footer alignment="Center" color="#a9a9a9">&amp;[PAGENUM] / &amp;[COUNT]</footer>
      <backgrounds />
    </pageModel>
    <dependencies>
      <assembly name="SMath Studio Desktop" version="0.99.7030.1435" guid="a37cba83-b69c-4c71-9992-55ff666763bd" />
      <assembly name="Math Region" version="0.99.7030.1435" guid="02f1ab51-215b-466e-a74d-5d8b1cf85e8d" />
      <assembly name="TextRegion" version="1.11.7030.1435" guid="485d28c5-349a-48b6-93be-12a35a1c1e39" />${pictures ? '\n      <assembly name="PictureRegion" version="1.11.7030.1435" guid="06b5df04-393e-4be7-9107-305196fcb861" />' : ''}
    </dependencies>
  </settings>
  <regions type="content">
${regions.map((r) => `    ${r}`).join('\n')}
  </regions>
</worksheet>
`;
  return new TextEncoder().encode(xml);
}

/** A unit expression back in our syntax (for converting a shown value into it). */
function unitSource(u: X): string {
  switch (u.k) {
    case 'id':
      return u.name;
    case 'num':
      return u.v;
    case 'parens':
      return `(${unitSource(u.a)})`;
    case 'op':
      if (u.op === 'neg') return `-${unitSource(u.args[0])}`;
      return u.args.map(unitSource).join({ mult: '*', div: '/', pow: '^', plus: '+', minus: '-' }[u.op as string] ?? '*');
    default:
      return '';
  }
}
