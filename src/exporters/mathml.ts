// Mathcad's math markup ("ml") from the neutral tree (tree.ts): math50 for Mathcad Prime and
// math30 for Mathcad 11–15, element for element as the importer (importers/mathcad.ts) reads
// them. The two differ in names (labels and XAML subscripts in Prime, a subscript attribute
// in 15), in how a quantity is written (scale, mult), in the bounds of Σ and ∫ (lowerBound and
// upperBound, bounds), in the solve block functions (keywords, operator elements) and in
// programs (if / else if / else in Prime, "if" lines and "otherwise" in 15).
import type { Unit } from 'mathjs';
import { math, isUnit } from '../engine/math';
import { NotRepresentable, PRIME_CONSTANTS, TreeReader, plainNumber, type PStmt, type Role, type Statement, type Target, type X } from './tree';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const XAML = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation';
const PTC_WPF = 'clr-namespace:Ptc.Wpf;assembly=Ptc.Core';

/** mathjs unit names that Mathcad spells otherwise (the importer's UNIT_MAP the other way). */
const MC_UNIT: Record<string, string> = {
  degC: '°C', degF: '°F', ohm: 'Ω', kohm: 'kΩ', Mohm: 'MΩ', inch: 'in', year: 'yr', angstrom: 'Å',
  h: 'hr', hour: 'hr', gram: 'gm', minute: 'min', second: 's', meter: 'm', liter: 'L', l: 'L', t: 'tonne',
};

export function mathcadUnit(name: string): string {
  if (MC_UNIT[name]) return MC_UNIT[name];
  // um → μm, uF → μF
  if (/^u[A-Za-z]/.test(name)) return `μ${name.slice(1)}`;
  return name;
}

const LABEL: Record<Role, string> = { var: 'VARIABLE', fn: 'FUNCTION', unit: 'UNIT', const: 'CONSTANT', keyword: 'KEYWORD' };

/** Mathcad 15 writes the solve block functions as operators of their own. */
const MC15_SOLVERS: Record<string, string> = { find: 'Find', minerr: 'Minerr', minimize: 'Minimize', maximize: 'Maximize' };
/** Prime spells these in lower case, Mathcad 15 with a capital. */
const SOLVER_NAMES: Record<string, [prime: string, mc15: string]> = {
  odesolve: ['odesolve', 'Odesolve'], Odesolve: ['odesolve', 'Odesolve'],
  pdesolve: ['pdesolve', 'Pdesolve'], Pdesolve: ['pdesolve', 'Pdesolve'],
};

const OPS: Partial<Record<string, string>> = {
  plus: 'plus', minus: 'minus', mult: 'mult', div: 'div', pow: 'pow', neg: 'neg', not: 'not', and: 'and', or: 'or', xor: 'xor',
  equal: 'equal', notEqual: 'notEqual', lessThan: 'lessThan', greaterThan: 'greaterThan', lessOrEqual: 'lessOrEqual',
  greaterOrEqual: 'greaterOrEqual', factorial: 'factorial', transpose: 'transpose',
};

const COMPARISONS = new Set(['equal', 'notEqual', 'lessThan', 'greaterThan', 'lessOrEqual', 'greaterOrEqual', 'and', 'or', 'xor', 'not']);

/** Is the expression a check (a comparison or a combination of them)? */
export const isCheck = (x: X): boolean => (x.k === 'op' && COMPARISONS.has(x.op)) || (x.k === 'parens' && isCheck(x.a));

/** Units of each kind Mathcad has, for a unit whose name the worksheet uses for a variable. */
const UNIT_KINDS = [
  'm', 'mm', 'cm', 'km', 'ft', 'inch', 's', 'ms', 'min', 'hr', 'kg', 'gram', 'tonne', 'lb', 'N', 'kN', 'MN', 'lbf', 'Pa', 'kPa', 'MPa',
  'GPa', 'bar', 'psi', 'J', 'kJ', 'MJ', 'W', 'kW', 'MW', 'A', 'mA', 'V', 'mV', 'kV', 'ohm', 'kohm', 'F', 'uF', 'nF', 'pF', 'C', 'H',
  'mH', 'Hz', 'kHz', 'MHz', 'L', 'mL', 'rad', 'deg', 'T', 'Wb', 'mol', 'K',
];

const hasShadowed = (x: X): boolean => (x.k === 'id' && !!x.shadowed) || (x.k === 'op' && x.args.some(hasShadowed)) || (x.k === 'parens' && hasShadowed(x.a));
const unitText = (x: X): string => (x.k === 'id' ? x.name : x.k === 'num' ? x.v : x.k === 'parens' ? `(${unitText(x.a)})` : x.k === 'op' ? x.args.map(unitText).join(x.op === 'div' ? '/' : x.op === 'pow' ? '^' : '·') : '');

export class MlWriter {
  private units = new TreeReader([]);
  /** Units written in another unit of their kind (Mathcad 15), for the export's warnings. */
  readonly respelled = new Map<string, string>();
  /** Display units Mathcad 15 would read as variables, left out (for the export's warnings). */
  readonly droppedUnits = new Set<string>();
  /** shadowed: the worksheet's names, which in Mathcad 15 hide the units so named. */
  constructor(readonly prime: boolean, private shadowed = new Set<string>()) {}

  /**
   * A unit. Mathcad 15 tells units from variables by name only: where the worksheet has a
   * variable m (a mass), the unit m would read as it, so it is written in another unit of its
   * kind, (1000 mm), which means the same there.
   */
  private unitId(name: string): string {
    if (this.prime) return this.id(name, 'unit', true);
    let u: Unit;
    try {
      u = math.unit(1, name) as Unit;
    } catch {
      return this.id(name, 'unit', true);
    }
    for (const alt of UNIT_KINDS) {
      if (alt === name || this.shadowed.has(alt) || this.shadowed.has(mathcadUnit(alt))) continue;
      let k: number;
      try {
        const v = math.unit(1, alt) as Unit;
        // an offset scale (°C) is no multiple of another unit
        if (!u.equalBase(v) || (u.units[0]?.unit as { offset?: number })?.offset || (v.units[0]?.unit as { offset?: number })?.offset) continue;
        k = u.toNumeric(alt) as number;
      } catch {
        continue;
      }
      this.respelled.set(name, `${+k.toPrecision(12)} ${mathcadUnit(alt)}`);
      return this.el('parens', this.apply(this.el('mult'), this.el('real', plainNumber(String(+k.toPrecision(15)))), this.id(alt, 'unit', true)));
    }
    return this.id(name, 'unit', true);
  }

  private el(tag: string, inner = '', attrs = ''): string {
    return inner ? `<ml:${tag}${attrs}>${inner}</ml:${tag}>` : `<ml:${tag}${attrs} />`;
  }

  /** A name: f_ck is f with the literal subscript ck. */
  id(name: string, role: Role, unit = false): string {
    const shown = unit ? mathcadUnit(name) : name;
    const cut = shown.indexOf('_');
    const base = cut > 0 && cut < shown.length - 1 ? shown.slice(0, cut) : shown;
    const sub = base === shown ? '' : shown.slice(cut + 1);
    if (!this.prime) return `<ml:id xml:space="preserve"${sub ? ` subscript="${esc(sub)}"` : ''}>${esc(base)}</ml:id>`;
    const text = sub ? `<Span xmlns="${XAML}" xmlns:pw="${PTC_WPF}">${esc(base)}<pw:Subscript>${esc(sub)}</pw:Subscript></Span>` : esc(base);
    return `<ml:id labels="${LABEL[role]}" xml:space="preserve">${text}</ml:id>`;
  }

  private apply(head: string, ...args: string[]): string {
    return `<ml:apply>${head}${args.join('')}</ml:apply>`;
  }

  /** Arguments of a call: one directly, several in a sequence. */
  private args(xs: X[], fn = ''): string {
    // Mathcad's ranges for pdesolve and numol are vectors: [0, L] is a column there
    const list = /^(pdesolve|Pdesolve|numol)$/.test(fn) ? xs.map((a) => (a.k === 'matrix' && a.rows.length === 1 ? { ...a, rows: a.rows[0].map((c) => [c]) } : a)) : xs;
    if (list.length === 1) return this.x(list[0]);
    return this.el('sequence', list.map((a) => this.x(a)).join(''));
  }

  private lambda(v: string, body: X): string {
    return this.el('lambda', this.el('boundVars', this.id(v, 'var')) + this.x(body));
  }

  private bounds(lo: X, hi: X): string {
    return this.prime ? this.el('lowerBound', this.x(lo)) + this.el('upperBound', this.x(hi)) : this.el('bounds', this.x(lo) + this.x(hi));
  }

  private constant(name: string): string {
    if (['π', 'e', '∞', 'g', 'NaN'].includes(name)) return this.prime ? this.id(name, 'const') : this.id(name, 'var');
    if (this.prime && PRIME_CONSTANTS[name]) return this.id(PRIME_CONSTANTS[name], 'const');
    // a physical constant Mathcad 15 has no name for: its value
    const v = (math as unknown as Record<string, unknown>)[name];
    if (typeof v === 'number') return this.el('real', plainNumber(String(v)));
    if (!isUnit(v)) throw new NotRepresentable(`the constant ${name}`);
    const si = v.toSI();
    const u = si.formatUnits();
    return this.x({ k: 'scale', value: { k: 'num', v: plainNumber(String(si.toNumeric(u))) }, unit: this.units.unit(u) });
  }

  x(e: X): string {
    switch (e.k) {
      case 'num':
        return this.el('real', e.v);
      case 'imag':
        return `<ml:imag symbol="i">${e.v}</ml:imag>`;
      case 'str':
        return `<ml:str xml:space="preserve">${esc(e.v)}</ml:str>`;
      case 'id':
        if (e.role === 'const') return this.constant(e.name);
        return e.role === 'unit' && e.shadowed ? this.unitId(e.name) : this.id(e.name, e.role, e.role === 'unit');
      case 'op': {
        const op = OPS[e.op];
        if (!op) throw new NotRepresentable(`the ${e.op} operator`);
        return this.apply(this.el(op), ...e.args.map((a) => this.x(a)));
      }
      case 'scale':
        if (this.prime && e.value.k === 'num') return this.apply(this.el('scale'), this.x(e.value), this.x(e.unit));
        return this.apply(this.el('mult'), this.x(e.value), this.x(e.unit));
      case 'call': {
        const solver = MC15_SOLVERS[e.fn.toLowerCase()];
        if (solver && e.role === 'fn') {
          return this.prime ? this.apply(this.id(e.fn.toLowerCase(), 'keyword'), this.args(e.args)) : this.apply(this.el(solver), this.args(e.args));
        }
        const named = SOLVER_NAMES[e.fn];
        const fn = named ? named[this.prime ? 0 : 1] : e.fn;
        return this.apply(this.id(fn, e.role === 'var' ? 'var' : 'fn'), e.args.length ? this.args(e.args, fn) : this.el('sequence'));
      }
      case 'index': {
        const idx = e.idx.length === 1 ? this.x(e.idx[0]) : this.el('sequence', e.idx.map((i) => this.x(i)).join(''));
        return this.apply(this.el('indexer'), this.x(e.base), idx);
      }
      case 'matrix': {
        const rows = e.rows.length, cols = e.rows[0]?.length ?? 0;
        // Mathcad lists the elements column by column
        const items: string[] = [];
        for (let j = 0; j < cols; j++) for (let i = 0; i < rows; i++) items.push(this.x(e.rows[i][j]));
        return `<ml:matrix rows="${rows}" cols="${cols}">${items.join('')}</ml:matrix>`;
      }
      case 'parens':
        return this.el('parens', this.x(e.a));
      case 'range':
        return this.el('range', e.second ? this.el('sequence', this.x(e.first) + this.x(e.second)) + this.x(e.last) : this.x(e.first) + this.x(e.last));
      case 'integral':
        return this.apply(this.prime ? this.el('integral') : this.el('integral', '', ' auto-algorithm="true" algorithm="adaptive"'), this.lambda(e.v, e.body), this.bounds(e.lo, e.hi));
      case 'sum':
      case 'prod': {
        const op = e.k === 'sum' ? 'summation' : 'product';
        if (e.lo && e.hi) return this.apply(this.el(op), this.lambda(e.v, e.body), this.bounds(e.lo, e.hi));
        // over a range variable: no bounds
        if (this.prime) return this.apply(this.el(op), this.lambda(e.v, e.body), this.el('upperBound', this.el('placeholder')));
        return this.apply(this.el(e.k === 'sum' ? 'rangeSummation' : 'rangeProduct'), this.lambda(e.v, e.body));
      }
      case 'vsum':
        if (this.prime) return this.apply(this.el('summation'), this.el('lambda', this.el('boundVars', this.el('placeholder')) + this.x(e.a)), this.el('upperBound', this.el('placeholder')));
        return this.apply(this.el('vectorSum'), this.x(e.a));
      case 'deriv':
        if (this.prime) return this.apply(this.el('derivative'), this.lambda(e.v, e.body), this.el('degree', e.n === 1 ? this.el('placeholder') : this.el('real', String(e.n))));
        if (e.n === 1) return this.apply(this.el('derivative'), this.lambda(e.v, e.body));
        return this.apply(this.el('nthDerivative'), this.el('real', String(e.n)), this.lambda(e.v, e.body));
      case 'prime':
        // Mathcad's prime notation: the primes are part of the name (y′′ applied to t)
        return this.apply(this.id(`${e.f}${'′'.repeat(e.n)}`, 'var'), this.args(e.args));
      case 'sqrt':
        return this.apply(this.el('sqrt'), this.x(e.a));
      case 'root':
        return this.apply(this.el('nthRoot'), this.x(e.n), this.x(e.a));
      case 'abs':
        return this.apply(this.el('absval'), this.x(e.a));
      case 'col':
        return this.apply(this.el('matcol'), this.x(e.m), this.x(e.j));
      case 'row':
        if (this.prime) return this.apply(this.el('matrow'), this.x(e.m), this.x(e.j));
        // Mathcad 15 has columns only: (Mᵀ)⟨i⟩ᵀ
        return this.apply(this.el('transpose'), this.apply(this.el('matcol'), this.apply(this.el('transpose'), this.x(e.m)), this.x(e.j)));
      case 'cross':
        return this.apply(this.el('crossProduct'), this.x(e.a), this.x(e.b));
      case 'vectorize':
        return this.apply(this.el('vectorize'), this.x(e.a));
      case 'if':
        return this.apply(this.id('if', this.prime ? 'keyword' : 'fn'), this.el('sequence', this.x(e.cond) + this.x(e.a) + this.x(e.b)));
    }
  }

  target(t: Target): string {
    switch (t.k) {
      case 'var':
        return this.id(t.name, 'var');
      case 'fn':
        return this.el('function', this.id(t.name, 'var') + this.el('boundVars', t.params.map((p) => this.id(p, 'var')).join('')));
      case 'index':
        return this.apply(this.el('indexer'), this.id(t.name, 'var'), t.idx.length === 1 ? this.x(t.idx[0]) : this.el('sequence', t.idx.map((i) => this.x(i)).join('')));
      case 'col':
        return this.apply(this.el('matcol'), this.id(t.name, 'var'), this.x(t.j));
      case 'row':
        if (this.prime) return this.apply(this.el('matrow'), this.id(t.name, 'var'), this.x(t.i));
        throw new NotRepresentable('a row assignment (Mathcad 15 has column assignments only)');
      case 'list':
        return `<ml:matrix rows="${t.names.length}" cols="1">${t.names.map((n) => this.id(n, 'var')).join('')}</ml:matrix>`;
    }
  }

  /** A shown value, with its display unit (Prime writes an empty one as a placeholder). */
  private evalOf(value: string, unit?: X): string {
    // Mathcad 15 would read a display unit m as the worksheet's m: the result shows in SI units there
    if (unit && !this.prime && hasShadowed(unit)) {
      this.droppedUnits.add(unitText(unit));
      unit = undefined;
    }
    const u = unit ? this.el('unitOverride', this.x(unit)) : this.prime ? this.el('unitOverride', this.el('placeholder')) : '';
    return this.el('eval', value + u);
  }

  /** The content of a <math> region. */
  statement(st: Statement): string {
    switch (st.k) {
      case 'define': {
        const value = this.x(st.value);
        return this.el(st.global ? 'globalDefine' : 'define', this.target(st.target) + (st.show ? this.evalOf(value, st.unit) : value));
      }
      case 'program':
        return this.el(st.global ? 'globalDefine' : 'define', this.target(st.target) + this.program(st.body));
      case 'eval':
        return this.evalOf(this.x(st.expr), st.unit);
      case 'symbolic': {
        const kw = st.keyword
          ? this.el('command', this.el('sequence', this.id(st.keyword.name, 'keyword') + st.keyword.args.map((a) => this.x(a)).join('')))
          : this.el('command', this.el('placeholder'));
        return this.el('symEval', this.x(st.expr) + kw + this.el('symResult', this.el('placeholder')));
      }
      case 'expr':
        // a check shows its value in Mathcad only when evaluated
        return isCheck(st.expr) ? this.evalOf(this.x(st.expr)) : this.x(st.expr);
    }
  }

  program(body: PStmt[]): string {
    return this.el('program', body.map((s) => this.pstmt(s)).join(''));
  }

  /** A program body where Mathcad 15 takes one statement or a program. */
  private body(stmts: PStmt[]): string {
    return !this.prime && stmts.length === 1 ? this.pstmt(stmts[0]) : this.program(stmts);
  }

  pstmt(s: PStmt): string {
    switch (s.k) {
      case 'local':
        return this.el('localDefine', this.target(s.target) + this.x(s.value));
      case 'localProgram':
        return this.el('localDefine', this.target(s.target) + this.program(s.body));
      case 'if':
        return this.prime ? this.primeIf(s.branches) : this.mc15If(s.branches);
      case 'for':
        return this.el('for', this.id(s.v, 'var') + this.x(s.iter) + this.program(s.body));
      case 'while':
        return this.el('while', this.x(s.cond) + this.program(s.body));
      case 'try':
        return this.prime ? this.el('tryCatch', this.program(s.body) + this.program(s.onError)) : this.el('onError', this.body(s.body) + this.body(s.onError));
      case 'return':
        return this.el('return', this.x(s.value));
      case 'break':
        return this.el('break');
      case 'continue':
        return this.el('continue');
      case 'expr':
        return this.x(s.value);
    }
  }

  private primeIf(branches: { cond: X | null; body: PStmt[] }[]): string {
    const [first, ...rest] = branches;
    let out = this.el('test', this.x(first.cond!)) + this.el('then', this.program(first.body));
    for (const b of rest) {
      if (b.cond) out += this.el('elseif', this.el('test', this.x(b.cond)) + this.el('then', this.program(b.body)));
      else out += this.el('else', this.program(b.body));
    }
    return this.el('if', out);
  }

  /** if / else if / else as nested "if" and "otherwise" lines, which mean exactly that. */
  private mc15If(branches: { cond: X | null; body: PStmt[] }[]): string {
    const [first, ...rest] = branches;
    const line = this.el('ifThen', this.x(first.cond!) + this.body(first.body));
    if (!rest.length) return line;
    const otherwise = rest[0].cond ? this.el('program', this.mc15If(rest)) : this.body(rest[0].body);
    return line + this.el('otherwise', otherwise);
  }
}
