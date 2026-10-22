// Import Mathcad worksheets:
//   .mcdx  Mathcad Prime (a zip/OPC package; math in mathcad/worksheet.xml)
//   .xmcd  Mathcad 11–15 (plain XML)
// Both store math as an "ml" expression tree (namespaces math50 / math30). The
// element vocabulary below follows the structure of real Prime files as
// documented by the MIT-licensed mcad2py project, plus the Mathcad 15 variants.
import { unzipSync, gunzipSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import {
  createRegion, emptyWorksheet, PAGE_HEIGHT, PAGE_MARGIN, PAGE_WIDTH,
  type AreaRegion, type MathChoices, type PageBand, type Region, type PlotTrace, type TextRegion,
} from '../model/types';
import { AREA_BAR, AREA_PAD, collapseArea, nestBands, withContents } from '../model/areas';
import { fitToPage, isNumberLiteral, P, sanitize, toBase64, Unsupported, unitName, type Ex, type ImportResult, type SavedResult } from './common';
import { isUnitName, math } from '../engine/math';
import { cssColor, normalSize, toMarkdown, type RunStyle, type TextPara, type TextRun } from './textFormat';
import { bandOf, mc15Fields, mc15Text, primeField, type BandPiece } from './mathcadPage';
import type { NumberFormat, NumberStyle } from '../engine/format';

export type { ImportResult } from './common';

type El = XElement;

const local = (el: XNode): string => (el as El).localName || el.nodeName.replace(/^.*:/, '');
/** The bookkeeping inside <ml:provenance>, which wraps math pasted from another worksheet. */
const PROVENANCE = new Set(['originRef', 'parentRef', 'comment', 'originComment', 'contentHash', 'hash']);
const elements = (el: XNode): El[] => {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as El);
  return out;
};
/** Child elements, looking through provenance wrappers to the math they carry. */
const kids = (el: XNode): El[] => elements(el).map(function unwrap(c: El): El {
  if (local(c) !== 'provenance') return c;
  const inner = elements(c).filter((x) => !PROVENANCE.has(local(x))).pop();
  return inner ? unwrap(inner) : c;
});
const child = (el: XNode, name: string): El | undefined => kids(el).find((c) => local(c) === name);
const isPlaceholder = (el: El | undefined) => !el || local(el) === 'placeholder';

// ------------------------------------------------------------ names, units, constants

/** Mathcad's built-in constants (labels="CONSTANT"), by display name with subscripts as _. */
const CONSTANT_MAP: Record<string, string> = {
  π: 'π', e: 'e', '∞': '∞', g: 'g', c: 'speedOfLight', G: 'gravitationConstant', h: 'planckConstant',
  k: 'boltzmann', NA: 'avogadro', R: 'gasConstant', ε0: 'vacuumPermittivity', μ0: 'vacuumPermeability',
  me: 'electronMass', mp: 'protonMass', q: 'elementaryCharge', σ: 'stefanBoltzmann',
  ℏ: 'reducedPlanckConstant', e_c: 'elementaryCharge', m_e: 'electronMass', m_p: 'protonMass', m_u: 'atomicMass',
  N_A: 'avogadro', 'R_∞': 'rydberg', α: 'fineStructure', ε_0: 'vacuumPermittivity', μ_0: 'vacuumPermeability',
  Φ_0: 'magneticFluxQuantum', k_B: 'boltzmann',
  // the Euler–Mascheroni constant
  γ: '0.57721566490153286',
};

/** Display name of an <ml:id>, with Prime XAML subscripts or the Mathcad 15 subscript attribute. */
function rawName(el: El): string {
  let s = '';
  const walk = (n: XNode) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue ?? '';
      else if (c.nodeType === 1) {
        if (/subscript$/i.test(local(c))) s += '_';
        walk(c);
      }
    }
  };
  walk(el);
  s = s.trim();
  const sub = el.getAttribute('subscript');
  if (sub) s += `_${sub}`;
  return s;
}

/**
 * A name as Mathcad 15 tells names apart: by its spelling and its math style (font). The
 * function in(x, v) in a style of its own is not the unit in.
 */
function nameKey(el: El): string {
  const font = el.getAttribute('font');
  return font && font !== '0' ? `${rawName(el)}#${font}` : rawName(el);
}

// ------------------------------------------------------------ expressions

const BINOPS: Record<string, { op: string; p: number }> = {
  plus: { op: ' + ', p: P.ADD }, minus: { op: ' - ', p: P.ADD }, mult: { op: '*', p: P.MUL }, div: { op: '/', p: P.MUL },
  pow: { op: '^', p: P.POW }, lessThan: { op: ' < ', p: P.CMP }, greaterThan: { op: ' > ', p: P.CMP },
  lessOrEqual: { op: ' ≤ ', p: P.CMP }, greaterOrEqual: { op: ' ≥ ', p: P.CMP }, equal: { op: ' == ', p: P.CMP },
  notEqual: { op: ' ≠ ', p: P.CMP }, and: { op: ' ∧ ', p: P.AND }, or: { op: ' ∨ ', p: P.OR }, xor: { op: ' ⊕ ', p: P.OR },
};

class Converter {
  warnings: string[] = [];
  /** Names defined so far, as the regions are read (Mathcad 15 does not label units: an undefined unit name is one). */
  defined: { has(name: string): boolean } = new Set<string>();
  /** Names defined at the top level of the worksheet (variables a unit of the same name would clash with). */
  variables = new Set<string>();
  /** The numeric factor dropped from the last display unit (the saved result is a multiple of it). */
  scale = '';
  /** Inside a display unit (unitOverride, a plot axis unit), where unlabelled names are units. */
  private unitSlot = 0;
  /** The input control of the last statement read: its choices (the region keeps them). */
  choices: MathChoices | undefined;

  wrap(e: Ex, min: number): string {
    return e.p < min ? `(${e.s})` : e.s;
  }

  name(el: El): string {
    const raw = rawName(el);
    const label = el.getAttribute('labels') ?? '';
    // % on its own (x/%): 1 % is 0.01
    if (raw === '%' && !this.unitSlot) return '(1 %)';
    if (label === 'UNIT' || raw === '%') {
      const u = unitName(raw);
      // Prime tells a unit from a variable of the same name by its label; here the unit is written out
      return this.variables.has(raw) && !this.unitSlot && !/[()*/^ ]/.test(u) ? `unit(1, "${u}")` : u;
    }
    if (label === 'CONSTANT' && CONSTANT_MAP[raw]) return CONSTANT_MAP[raw];
    // Mathcad 15's ∞ has no label (it is no letter, so no name of ours either)
    if (raw === '∞' && label !== 'VARIABLE') return '∞';
    // unlabelled (Mathcad 15) or auto-labelled (*, sheets converted from 15) names that are units
    if (label === '' || label === '*') {
      const u = unitName(raw);
      if (!this.defined.has(nameKey(el)) && (this.unitSlot || u !== raw) && isUnitName(u.replace(/^\((.*)\)$/, '$1').split(/[*/^ ]/)[0])) return u;
    }
    return this.ident(el);
  }

  /** Names spelled without a math style of their own (Mathcad 15), anywhere in the file. */
  plainNames = new Set<string>();

  /**
   * A name as an identifier here. Mathcad 15 tells names apart by their math style too: a
   * function max or in written in a style of its own is not the built-in max or the unit in,
   * so such a name gets a _ of its own when its spelling is taken.
   */
  ident(el: El): string {
    const raw = rawName(el);
    const s = sanitize(raw);
    if (nameKey(el) === raw) return s;
    const taken = this.plainNames.has(raw) || typeof (math as unknown as Record<string, unknown>)[raw] === 'function' || isUnitName(unitName(raw));
    return taken && !s.endsWith('_') ? `${s}_` : s;
  }

  /** A display unit: the expression, without a numeric scale Mathcad allows there (10⁻³⁴ kg·m²/s). */
  unit(el: El): string {
    const numeric = (n: El): boolean => local(n) !== 'id' && kids(n).every(numeric);
    let u = el;
    if (numeric(u)) {
      this.scale = this.expr(u).s;
      this.warnings.push(`A result shown as a multiple of ${this.scale} is shown as a plain number`);
      return '';
    }
    if (local(u) === 'apply' && /^(mult|scale)$/.test(local(kids(u)[0])) && numeric(kids(u)[1])) {
      this.scale = this.expr(kids(u)[1]).s;
      this.warnings.push(`A result shown in ${this.scale}·(…) is shown in the unit alone`);
      u = kids(u)[2];
    }
    this.unitSlot++;
    try {
      return this.expr(u).s;
    } finally {
      this.unitSlot--;
    }
  }

  /** Arguments of a call, flattening a single <sequence>. */
  args(rest: El[]): string[] {
    const list = rest.length === 1 && local(rest[0]) === 'sequence' ? kids(rest[0]) : rest;
    return list.map((a) => this.expr(a).s);
  }

  lambda(el: El): { vars: string[]; body: string } {
    const bv = child(el, 'boundVars');
    const vars = bv ? kids(bv).filter((c) => local(c) === 'id').map((c) => this.ident(c)) : [];
    const body = kids(el).find((c) => local(c) !== 'boundVars');
    return { vars, body: body ? this.lazily(() => this.expr(body).s) : '0' };
  }

  // ---------------------------------------------------------------- programs as operands
  //
  // Mathcad nests a program anywhere a value goes: x := 2 + ⟨program⟩. Here a program is
  // a definition's or a local definition's whole value, so such a program is computed first
  // into a local of its own (p_1 ← ⟨program⟩) and the expression uses that. Where the operand
  // is evaluated later or not at all (integrands, branches of if) that is not the same, and
  // the program is not imported.

  /** Lines that compute the programs of the statement being converted, and their indent. */
  private hoist: { indent: string; lines: string[] } | null = null;
  /** Inside a part of an expression evaluated later or not at all. */
  private lazy = 0;
  private temps = 0;

  lazily<T>(f: () => T): T {
    this.lazy++;
    try {
      return f();
    } finally {
      this.lazy--;
    }
  }

  /** A name for a program's value no name of the worksheet has. */
  private temp(): string {
    let n: string;
    do n = `p_${++this.temps}`; while (this.plainNames.has(n) || this.defined.has(n));
    return n;
  }

  /** Convert with programs in it computed into locals first: the lines that do that, and the result. */
  withHoist<T>(indent: string, f: () => T): { lines: string[]; value: T } {
    const saved = this.hoist, savedLazy = this.lazy;
    this.hoist = { indent, lines: [] };
    this.lazy = 0;
    try {
      const value = f();
      return { lines: this.hoist.lines, value };
    } finally {
      this.hoist = saved;
      this.lazy = savedLazy;
    }
  }

  /** Elements that stand for a whole program where a value is expected. */
  isProgram(el: El | undefined): boolean {
    return !!el && /^(program|for|while|tryCatch|onError|localDefine|return|ifThen|otherwise|break|continue)$/.test(local(el));
  }

  /** The lines of a program-valued operand, as a block at this indent. */
  block(el: El, indent: string): string[] {
    return local(el) === 'program' ? this.programLines(el, indent) : this.stmt(el, indent);
  }

  bounds(rest: El[]): [string, string] | null {
    const lo = rest.find((c) => local(c) === 'lowerBound');
    const hi = rest.find((c) => local(c) === 'upperBound');
    if (lo || hi) {
      // Σ over a range variable has an empty upper bound and no lower one
      if (!lo || !hi || (isPlaceholder(kids(lo)[0]) && isPlaceholder(kids(hi)[0]))) return null;
      return [this.expr(kids(lo)[0]).s, this.expr(kids(hi)[0]).s];
    }
    const b = rest.find((c) => local(c) === 'bounds');
    if (b) {
      const [a, z] = kids(b);
      if (isPlaceholder(a) && isPlaceholder(z)) return null;
      return [this.expr(a).s, this.expr(z).s];
    }
    return null;
  }

  expr(el: El): Ex {
    const tag = local(el);
    switch (tag) {
      case 'real': {
        const t = (el.textContent ?? '0').trim();
        return { s: t, p: t.startsWith('-') ? P.NEG : P.ATOM };
      }
      case 'imag': {
        const t = (el.textContent ?? '1').trim();
        return { s: `${t}i`, p: P.ATOM };
      }
      case 'str':
        return { s: JSON.stringify(el.textContent ?? ''), p: P.ATOM };
      case 'id':
        return { s: this.name(el), p: P.ATOM };
      case 'parens': {
        const c = kids(el)[0];
        return { s: `(${c ? this.expr(c).s : ''})`, p: P.ATOM };
      }
      case 'placeholder':
        throw new Unsupported('an empty placeholder');
      case 'matrix':
        return this.matrix(el);
      case 'range': {
        const seq = child(el, 'sequence');
        if (seq) {
          const [a, b] = kids(seq).map((c) => this.expr(c).s);
          const last = kids(el).find((c) => local(c) !== 'sequence');
          return { s: `${a}${b !== undefined ? `, ${b}` : ''} .. ${last ? this.expr(last).s : ''}`, p: P.RANGE };
        }
        const [a, z] = kids(el).map((c) => this.expr(c).s);
        return { s: `${a} .. ${z}`, p: P.RANGE };
      }
      case 'sequence':
        return { s: kids(el).map((c) => this.expr(c).s).join(', '), p: P.ATOM };
      case 'eval':
        return this.expr(kids(el)[0]);
      case 'apply':
        return this.apply(el);
      case 'program':
      case 'if':
        return { s: this.inlineProgram(el), p: P.ATOM };
      case 'function': {
        const id = child(el, 'id');
        return { s: id ? this.name(id) : '?', p: P.ATOM };
      }
      default:
        throw new Unsupported(`the “${tag}” element`);
    }
  }

  matrix(el: El): Ex {
    const rows = Number(el.getAttribute('rows') ?? 0);
    const cols = Number(el.getAttribute('cols') ?? 0);
    const items = kids(el).filter((c) => local(c) !== 'display').map((c) => this.expr(c).s);
    const r = rows || items.length;
    const c = cols || 1;
    // the XML lists elements column by column
    const at = (i: number, j: number) => items[j * r + i] ?? '0';
    const rowsOut = Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => at(i, j)).join(', '));
    return { s: `[${rowsOut.join('; ')}]`, p: P.ATOM };
  }

  apply(el: El): Ex {
    const [head, ...rest] = kids(el);
    if (!head) throw new Unsupported('an empty operator');
    const h = local(head);
    const e = (i: number) => this.expr(rest[i]);
    if (h === 'id') return this.call(head, rest);
    // f′(x): Prime's prime notation applies <functionDerivative/> to the function's name
    if (h === 'apply') {
      const d = this.primes(head);
      if (!d) throw new Unsupported('a call of a value that is itself a call (f(a)(b))');
      return { s: `${d.name}${"'".repeat(d.n)}(${this.args(rest).join(', ')})`, p: P.ATOM };
    }
    if (h === 'functionDerivative') throw new Unsupported('a derivative f′ written without its argument');
    // Mathcad 15 writes the solve block functions as operators: <ml:Find/>, <ml:Minerr/> …
    if (/^(find|minerr|minimize|maximize|odesolve)$/i.test(h)) return { s: `${h.toLowerCase()}(${this.args(rest).join(', ')})`, p: P.ATOM };
    if (BINOPS[h] && rest.length === 2) {
      const { op, p } = BINOPS[h];
      const vop = op;
      const [a, b] = [e(0), e(1)];
      if (h === 'pow') return { s: `${this.wrap(a, P.POW + 1)}${vop}${isNumberLiteral(b.s) ? b.s : this.wrap(b, P.POW)}`, p };
      // 40·% is 40 % (a ratio of 0.4), %·x is x %
      const isPercent = (c: El) => local(c) === 'id' && rawName(c) === '%';
      if (h === 'mult' && isPercent(rest[1])) return { s: `${this.wrap(a, P.ATOM)} %`, p: P.MUL };
      if (h === 'mult' && isPercent(rest[0])) return { s: `${this.wrap(b, P.ATOM)} %`, p: P.MUL };
      // number × unit reads naturally as "5 m"
      if (h === 'mult' && isNumberLiteral(a.s) && local(rest[1]) === 'id' && rest[1].getAttribute('labels') === 'UNIT') {
        return { s: `${a.s} ${b.s}`, p: P.MUL };
      }
      return { s: `${this.wrap(a, p)}${vop}${this.wrap(b, p + 1)}`, p };
    }
    switch (h) {
      case 'neg': return { s: `-${this.wrap(e(0), P.NEG)}`, p: P.NEG };
      case 'not': return { s: `¬${this.wrap(e(0), P.NOT)}`, p: P.NOT };
      case 'scale': {
        if (isPlaceholder(rest[1])) return e(0);
        const v = e(0), u = e(1);
        const unit = u.p >= P.ATOM ? u.s : `(${u.s})`;
        return { s: isNumberLiteral(v.s) ? `${v.s} ${unit}` : `${this.wrap(v, P.MUL)}*${unit}`, p: P.MUL };
      }
      case 'indexer': {
        const base = this.wrap(e(0), P.ATOM);
        const idx = local(rest[1]) === 'sequence' ? kids(rest[1]).map((c) => this.expr(c).s).join(', ') : e(1).s;
        return { s: `${base}[${idx}]`, p: P.ATOM };
      }
      case 'transpose': return { s: `${this.wrap(e(0), P.POST)}'`, p: P.POST };
      case 'factorial': return { s: `${this.wrap(e(0), P.POST)}!`, p: P.POST };
      case 'percent': return { s: `${this.wrap(e(0), P.MUL)}/100`, p: P.MUL };
      case 'matcol': return { s: `col(${e(0).s}, ${e(1).s})`, p: P.ATOM };
      case 'matrow': return { s: `row(${e(0).s}, ${e(1).s})`, p: P.ATOM };
      // |x|: the length of a vector and the determinant of a square matrix, as in Mathcad
      case 'absval': return { s: `mag(${e(0).s})`, p: P.ATOM };
      case 'determinant': return { s: `mag(${e(0).s})`, p: P.ATOM };
      case 'sqrt': return { s: `sqrt(${e(0).s})`, p: P.ATOM };
      case 'nthRoot': {
        if (isPlaceholder(rest[0])) return { s: `sqrt(${e(1).s})`, p: P.ATOM };
        return { s: `nthRoot(${e(1).s}, ${e(0).s})`, p: P.ATOM };
      }
      case 'crossProduct': return { s: `cross(${e(0).s}, ${e(1).s})`, p: P.ATOM };
      case 'vectorSum': return { s: `sum(${e(0).s})`, p: P.ATOM };
      case 'vectorize':
        // scalar functions and programs apply element by element, which .* alone does not give
        return { s: `vectorize(${e(0).s})`, p: P.ATOM };
      case 'integral': {
        const lam = rest.find((c) => local(c) === 'lambda');
        if (!lam) throw new Unsupported('an integral without integrand');
        const { vars, body } = this.lambda(lam);
        const b = this.bounds(rest);
        return { s: b ? `integral(${body}, ${vars[0]}, ${b[0]}, ${b[1]})` : `integrate(${body}, ${vars[0]})`, p: P.ATOM };
      }
      case 'summation':
      case 'product':
      case 'rangeSummation':
      case 'rangeProduct': {
        const fn = /product/i.test(h) ? 'prod' : 'sum';
        const lam = rest.find((c) => local(c) === 'lambda');
        if (!lam) return { s: `${fn}(${e(0).s})`, p: P.ATOM };
        const { vars, body } = this.lambda(lam);
        const b = this.bounds(rest);
        if (!vars.length) return { s: `${fn}(${body})`, p: P.ATOM };
        // no bounds: the index is a range variable defined on the sheet, summed over all its values
        return { s: b ? `${fn}(${body}, ${vars[0]}, ${b[0]}, ${b[1]})` : `${fn}(${body}, ${vars[0]})`, p: P.ATOM };
      }
      case 'derivative':
      case 'nthDerivative': {
        const lam = rest.find((c) => local(c) === 'lambda');
        if (!lam) throw new Unsupported('a derivative without function');
        const { vars, body } = this.lambda(lam);
        const deg = rest.find((c) => local(c) === 'degree') ?? (h === 'nthDerivative' ? rest.find((c) => local(c) !== 'lambda') : undefined);
        const degEl = deg && local(deg) === 'degree' ? kids(deg)[0] : deg;
        const n = degEl && !isPlaceholder(degEl) ? this.expr(degEl).s : '';
        return { s: `diff(${body}, ${vars[0]}${n && n !== '1' ? `, ${n}` : ''})`, p: P.ATOM };
      }
      default:
        throw new Unsupported(`the "${h}" operator`);
    }
  }

  /** <apply><functionDerivative/>f</apply>, nested once per prime: the function and the order. */
  primes(el: El): { name: string; n: number } | null {
    const [head, arg] = kids(el);
    if (local(el) !== 'apply' || !head || local(head) !== 'functionDerivative' || !arg) return null;
    if (local(arg) === 'id') return { name: this.ident(arg), n: 1 };
    const inner = this.primes(arg);
    return inner && { name: inner.name, n: inner.n + 1 };
  }

  call(head: El, rest: El[]): Ex {
    const raw = rawName(head);
    let fn = this.ident(head);
    const args = this.args(rest);
    // y′′(t), y′(0): prime notation of a function (odesolve), when y′′ is not a name of its own
    const primed = /^(.*?)(['′]+)$/.exec(raw);
    if (primed && primed[1] && !this.defined.has(nameKey(head))) return { s: `${sanitize(primed[1])}${"'".repeat(primed[2].length)}(${args.join(', ')})`, p: P.ATOM };
    if (raw === 'Γ') fn = 'gamma';
    if (raw === 'mod') fn = 'mod'; // a function here, not the reserved operator
    if (raw === 'if') fn = 'if'; // Mathcad's inline if(cond, a, b), labelled KEYWORD
    if (/^(Find|Minerr|Minimize|Maximize)$/.test(raw)) fn = raw.toLowerCase();
    if (raw === 'atan2' && args.length === 2) return { s: `atan2(${args[1]}, ${args[0]})`, p: P.ATOM }; // Mathcad: atan2(x, y)
    if (raw === 'angle' && args.length === 2) return { s: `mod(atan2(${args[1]}, ${args[0]}), 2 π)`, p: P.ATOM };
    return { s: `${fn}(${args.join(', ')})`, p: P.ATOM };
  }

  /** Programs used as values must collapse to if(…) chains. */
  inlineProgram(el: El): string {
    const lines = kids(el).filter((c) => !isPlaceholder(c));
    if (local(el) === 'if') return this.ifChain(el);
    if (lines.length === 1) {
      const only = lines[0];
      if (local(only) === 'if') return this.ifChain(only);
      return this.expr(only).s;
    }
    // Mathcad 15: ifThen … otherwise
    if (lines.every((l) => ['ifThen', 'otherwise'].includes(local(l)))) {
      const otherwise = lines.find((l) => local(l) === 'otherwise');
      let acc = otherwise ? this.expr(kids(otherwise)[0]).s : 'NaN';
      for (const l of lines.filter((x) => local(x) === 'ifThen').reverse()) {
        const [c, v] = kids(l);
        acc = `if(${this.expr(c).s}, ${this.expr(v).s}, ${acc})`;
      }
      return acc;
    }
    if (this.hoist && !this.lazy) {
      const name = this.temp();
      const { indent, lines: out } = this.hoist;
      out.push(`${indent}${name} ←`, ...this.programLines(el, indent + '  '));
      return name;
    }
    throw new Unsupported(this.lazy ? 'a multi-line program in an integrand or a branch of if' : 'a multi-line program inside an expression');
  }

  ifChain(el: El): string {
    const branches: [string | null, El][] = [];
    const collect = (n: El) => {
      let test: string | null = null;
      for (const c of kids(n)) {
        const t = local(c);
        if (t === 'test') test = this.expr(kids(c)[0]).s;
        else if (t === 'then') branches.push([test, c]);
        else if (t === 'elseif' || t === 'alsoif') collect(c);
        else if (t === 'else') branches.push([null, c]);
      }
    };
    collect(el);
    const val = (body: El) => {
      const inner = kids(body)[0];
      if (!inner) return 'NaN';
      return this.lazily(() => (local(inner) === 'program' ? this.inlineProgram(inner) : this.expr(inner).s));
    };
    let acc = 'NaN';
    for (const [test, body] of [...branches].reverse()) acc = test === null ? val(body) : `if(${test}, ${val(body)}, ${acc})`;
    return acc;
  }

  // ------------------------------------------------------------ programs (multi-line)

  programLines(el: El, indent: string): string[] {
    const items = kids(el).filter((c) => !isPlaceholder(c));
    const out: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const t = local(it);
      if (t === 'ifThen') {
        // Mathcad 15: a run of "x if c" lines, optionally closed by "otherwise"
        let j = i;
        while (j < items.length && local(items[j]) === 'ifThen') j++;
        const hasOtherwise = j < items.length && local(items[j]) === 'otherwise';
        const run = this.withHoist(indent, () => {
          const lines: string[] = [];
          for (let k = i; k < j; k++) {
            const [c, v] = kids(items[k]);
            // an else-if's test is evaluated only when the tests before it fail
            const test = k > i && hasOtherwise ? this.lazily(() => this.expr(c).s) : this.expr(c).s;
            lines.push(`${indent}${k > i && hasOtherwise ? 'else if' : 'if'} ${test}`, ...this.block(v, indent + '  '));
          }
          if (hasOtherwise) lines.push(`${indent}else`, ...this.block(kids(items[j])[0], indent + '  '));
          return lines;
        });
        out.push(...run.lines, ...run.value);
        i = hasOtherwise ? j : j - 1;
        continue;
      }
      out.push(...this.stmt(it, indent));
    }
    return out;
  }

  /** A program statement, after the lines that compute the programs among its operands. */
  stmt(el: El, indent: string): string[] {
    if (local(el) === 'program') return this.programLines(el, indent);
    const { lines, value } = this.withHoist(indent, () => this.stmtLines(el, indent));
    return [...lines, ...value];
  }

  private stmtLines(el: El, indent: string): string[] {
    const t = local(el);
    const ks = kids(el);
    switch (t) {
      case 'localDefine':
        // a program of its own as the value: r ← and the program indented below
        if (this.isProgram(ks[1])) return [`${indent}${this.target(ks[0])} ←`, ...this.block(ks[1], indent + '  ')];
        return [`${indent}${this.target(ks[0])} ← ${this.expr(ks[1]).s}`];
      case 'for': {
        const iter = this.expr(ks[1]).s;
        return [`${indent}for ${this.name(ks[0])} ∈ ${iter}`, ...this.block(ks[2], indent + '  ')];
      }
      case 'while':
        // the condition is evaluated before every pass
        return [`${indent}while ${this.lazily(() => this.expr(ks[0]).s)}`, ...this.block(ks[1], indent + '  ')];
      case 'if': {
        const out: string[] = [];
        let first = true;
        const walk = (n: El) => {
          let test: string | null = null;
          for (const c of kids(n)) {
            const ct = local(c);
            if (ct === 'test') test = first ? this.expr(kids(c)[0]).s : this.lazily(() => this.expr(kids(c)[0]).s);
            else if (ct === 'then') {
              out.push(`${indent}${first ? 'if' : 'else if'} ${test}`, ...this.stmt(kids(c)[0], indent + '  '));
              first = false;
            } else if (ct === 'elseif' || ct === 'alsoif') walk(c);
            else if (ct === 'else') out.push(`${indent}else`, ...this.stmt(kids(c)[0], indent + '  '));
          }
        };
        walk(el);
        return out;
      }
      case 'ifThen':
        return [`${indent}if ${this.expr(ks[0]).s}`, ...this.block(ks[1], indent + '  ')];
      case 'otherwise':
        return [`${indent}else`, ...this.block(ks[0], indent + '  ')];
      case 'return': {
        if (!this.isProgram(ks[0])) return [`${indent}return ${ks[0] ? this.expr(ks[0]).s : '0'}`];
        const name = this.temp();
        return [`${indent}${name} ←`, ...this.block(ks[0], indent + '  '), `${indent}return ${name}`];
      }
      case 'break':
        return [`${indent}break`];
      case 'continue':
        return [`${indent}continue`];
      case 'tryCatch':
      case 'onError':
        return [`${indent}try`, ...this.block(ks[0], indent + '  '), `${indent}on error`, ...this.block(ks[1], indent + '  ')];
      default:
        return [`${indent}${this.expr(el).s}`];
    }
  }

  /** Left-hand side of a definition. */
  target(el: El): string {
    switch (local(el)) {
      case 'id':
        return this.name(el);
      case 'function': {
        const id = child(el, 'id');
        const bv = child(el, 'boundVars');
        const params = bv ? kids(bv).filter((c) => local(c) === 'id').map((c) => this.name(c)) : [];
        return `${id ? this.name(id) : 'f'}(${params.join(', ')})`;
      }
      case 'matrix': {
        const items = kids(el).filter((c) => local(c) !== 'display');
        if (!items.every((c) => local(c) === 'id')) throw new Unsupported('a system of element definitions ([x[i + 1]; y[i + 1]] := …)');
        // the names are listed column by column, our list takes the values row by row
        const rows = Number(el.getAttribute('rows') ?? items.length) || items.length, cols = Math.max(1, Math.round(items.length / rows));
        const names = items.map((c) => this.name(c));
        return `[${Array.from({ length: rows * cols }, (_, k) => names[(k % cols) * rows + Math.floor(k / cols)]).join('; ')}]`;
      }
      case 'apply':
        return this.expr(el).s;
      default:
        throw new Unsupported(`a definition of “${local(el)}”`);
    }
  }

  unitOverride(el: El): string {
    const uo = child(el, 'unitOverride');
    const u = uo ? kids(uo)[0] : undefined;
    if (!u || isPlaceholder(u)) return '';
    return this.unit(u);
  }

  /**
   * An input control as the value of a definition. A combo box (a table of rows to pick from)
   * becomes the selected row's values; script controls run JScript and are not imported.
   */
  control(lhs: string, el: El): string {
    if (local(el) === 'ListBoxScriptableControl') return this.listBox(lhs, el);
    if (local(el) !== 'ComboBoxControl') throw new Unsupported(`an input control (${local(el).replace(/Control$/, '')})`);
    const rows = Number(el.getAttribute('rows') ?? 0), cols = Number(el.getAttribute('cols') ?? 0);
    const sel = Number(el.getAttribute('SelectedRow') ?? 0);
    const names = kids(child(el, 'ComboBoxRowNames') ?? el).filter((c) => local(c) === 'rowName').map((c) => (c.textContent ?? '').trim());
    const values = kids(child(el, 'ComboBoxValues') ?? el);
    const scales = kids(child(el, 'ComboBoxScaleFactors') ?? el);
    const count = Math.max(names.length, rows);
    const label = (i: number) => names[i] ?? String(i + 1);
    // without a table of values the choice itself is the value (a "Yes"/"No" flag)
    const row = (i: number) => {
      if (!values.length) return JSON.stringify(label(i));
      const at = (j: number) => {
        const v = values[i * cols + j];
        if (!v || isPlaceholder(v)) return '0';
        const x = this.expr(v);
        const sc = scales[j] && !isPlaceholder(scales[j]) ? this.unit(scales[j]) : '';
        return sc ? `${this.wrap(x, P.MUL)} ${sc}` : x.s;
      };
      const vals = Array.from({ length: cols }, (_, j) => at(j));
      return vals.length === 1 ? vals[0] : `[${vals.join('; ')}]`;
    };
    // the region keeps the control: its choices, and the picked one's value as the definition's
    if (count > 1) this.choices = { labels: Array.from({ length: count }, (_, i) => label(i)), values: Array.from({ length: count }, (_, i) => row(i)), selected: Math.min(sel, count - 1) };
    return row(sel);
  }

  /**
   * A list box whose script (JScript) gives the value: the value it gave when the worksheet was
   * saved (its RL attribute), since the script does not run here.
   */
  listBox(lhs: string, el: El): string {
    const items = el.getElementsByTagNameNS('*', 'val');
    const sel = Number(el.getAttribute('SelectedIndex') ?? 0);
    const picked = items[sel]?.textContent?.trim() ?? String(sel);
    const rl = el.getAttribute('RL');
    let value: string | null = null;
    try {
      value = rl ? primeValue(atob(rl)) : null;
    } catch {
      value = null;
    }
    if (value === null) throw new Unsupported('an input control (ListBoxScriptable) without a saved value');
    this.warnings.push(`The list box for ${lhs} runs a script (JScript), which does not run here: it is imported as the value it gave for “${picked}”, ${value}; the other ${items.length - 1} choices are not offered`);
    return value;
  }

  /** A script control on its own: its input expression, shown (often a check such as λ < λ_lim). */
  scriptControl(el: El): string {
    const field = el.getElementsByTagNameNS('*', 'inputControlInputField')[0];
    const inner = field ? kids(field)[0] : undefined;
    if (!inner || isPlaceholder(inner)) throw new Unsupported('a script control without an input');
    const msg = (el.getElementsByTagNameNS('*', 'val')[0]?.textContent ?? '').trim();
    this.warnings.push(`A script (JScript) control became its input ${this.expr(inner).s}${msg ? `; its message “${msg}” is not shown` : ''}`);
    const src = this.expr(inner).s;
    return / (<|>|≤|≥|==|≠) /.test(src) ? src.replace(/^\((.*)\)$/, '$1') : `${src} =`;
  }

  /** One <math> region → mathstudii statement source. */
  statement(math: El): string {
    const inner = kids(math)[0];
    if (!inner) throw new Unsupported('an empty math region');
    const t = local(inner);
    if (t === 'define' || t === 'globalDefine') {
      const [lhsEl, valEl] = kids(inner);
      const op = t === 'globalDefine' ? '≡' : ':=';
      const lhs = this.target(lhsEl);
      if (/Control$/.test(local(valEl))) return `${lhs} ${op} ${this.control(lhs, valEl)}`;
      // x := ⟨value⟩ = unit shows the value
      const shown = local(valEl) === 'eval';
      const unit = shown ? this.unitOverride(valEl) : '';
      const show = shown ? ` =${unit ? ' ' + unit : ''}` : '';
      let value = shown ? kids(valEl)[0] : valEl;
      while (value && local(value) === 'parens' && this.isProgram(kids(value)[0])) value = kids(value)[0];
      // a program, or one program statement standing for it
      if (this.isProgram(value)) return `${lhs} ${op}${show}\n${this.block(value, '  ').join('\n')}`;
      // Mathcad 15's list of values for an element definition, x[i] := 0.2, 1, 2: the vector of them
      if (value && local(value) === 'sequence' && local(lhsEl) === 'apply' && local(kids(lhsEl)[0] ?? lhsEl) === 'indexer') {
        const name = this.expr(kids(lhsEl)[1]).s;
        return `${name} ${op} [${kids(value).map((c) => this.expr(c).s).join('; ')}]${show}`;
      }
      // programs among the operands are computed first, which makes the definition a program
      const { lines, value: v } = this.withHoist('  ', () => this.expr(value).s);
      if (lines.length) return `${lhs} ${op}${show}\n${lines.join('\n')}\n  ${v}`;
      return `${lhs} ${op} ${v}${show}`;
    }
    if (/ScriptableControl$/.test(t)) return this.scriptControl(inner);
    if (t === 'eval') {
      const unit = this.unitOverride(inner);
      return `${this.expr(kids(inner)[0]).s} =${unit ? ' ' + unit : ''}`;
    }
    if (t === 'symEval') return this.symEval(inner);
    if (t === 'apply' && local(kids(inner)[0] ?? inner) === 'equal') {
      const [, a, b] = kids(inner);
      return `${this.expr(a).s} == ${this.expr(b).s}`;
    }
    return this.expr(inner).s;
  }

  symEval(el: El): string {
    let expr = '';
    let kw = '';
    for (const c of kids(el)) {
      const t = local(c);
      if (t === 'command' || t === 'keywords' || t === 'symbolicKeyword') {
        const seq = child(c, 'sequence');
        const parts = seq ? kids(seq) : kids(c);
        if (parts.length && !isPlaceholder(parts[0])) {
          const name = rawName(parts[0]).toLowerCase().replace(/^parfrac$/, 'partfrac');
          // an equation among the arguments (substitute, x = 2) is written with a plain =
          kw = [name, ...parts.slice(1).map((p) => this.expr(p).s.replace(/ == /g, ' = '))].join(', ');
        }
      } else if (t === 'symResult' || t === 'result') {
        /* cached result: recomputed by our CAS */
      } else if (!expr) {
        expr = this.expr(c).s.replace(/ == /g, ' = ');
      }
    }
    return `${expr} →${kw ? ' ' + kw : ''}`;
  }
}

// ------------------------------------------------------------ text

/** A Mathcad 15 text style: its font (size in pt), colour, alignment and list, from <textStyles>. */
interface Mc15TextStyle { base?: string; style: RunStyle; align?: string; list?: string }

/** Mathcad 15's text styles by name, each resolved over the style it is based on. */
function mc15TextStyles(doc: { getElementsByTagNameNS(ns: string, name: string): ArrayLike<El> }): Map<string, Mc15TextStyle> {
  const raw = new Map<string, Mc15TextStyle>();
  const list = doc.getElementsByTagNameNS('*', 'textStyle');
  for (let i = 0; i < list.length; i++) {
    const ts = list[i];
    const inl = child(ts, 'inlineAttr'), blk = child(ts, 'blockAttr');
    raw.set(ts.getAttribute('name') ?? '', { base: ts.getAttribute('base-style') ?? undefined, style: inl ? mc15Inline(inl, {}) : {}, align: blk?.getAttribute('text-align') ?? undefined, list: blk?.getAttribute('list-style-type') ?? undefined });
  }
  const resolved = new Map<string, Mc15TextStyle>();
  const resolve = (name: string, depth = 0): Mc15TextStyle => {
    const own = raw.get(name);
    if (!own) return { style: {} };
    const base = own.base && depth < 10 ? resolve(own.base, depth + 1) : { style: {} };
    const keep = (v: string | undefined, b: string | undefined) => (v && v !== 'inherit' ? v : b);
    return { style: { ...base.style, ...own.style }, align: keep(own.align, base.align), list: keep(own.list, base.list) };
  };
  for (const name of raw.keys()) resolved.set(name, resolve(name));
  return resolved;
}

/** Mathcad 15 <inlineAttr>, <f> (size in pt) and <c> attributes over a style. */
function mc15Inline(el: El, over: RunStyle): RunStyle {
  const out: RunStyle = { ...over };
  const a = (n: string) => {
    const v = el.getAttribute(n);
    return v === null || v === '' || v === 'inherit' ? undefined : v;
  };
  const size = a('font-size') ?? a('size');
  if (size && Number(size) > 0) out.size = Number(size) * (96 / 72);
  const family = a('font-family') ?? a('family');
  if (family) out.family = family;
  const color = cssColor(a('color') ?? a('val'));
  if (color) out.color = color;
  const bg = cssColor(a('background-color'));
  if (bg) out.background = bg;
  const w = a('font-weight');
  if (w) out.bold = /bold/i.test(w);
  const st = a('font-style');
  if (st) out.italic = /italic|oblique/i.test(st);
  const u = a('underline');
  if (u) out.underline = u === 'true';
  const lt = a('line-through');
  if (lt) out.strike = lt === 'true';
  const va = a('vertical-align');
  if (va) {
    out.sub = va === 'sub';
    out.sup = va === 'super';
  }
  return out;
}

/** Mathcad 15 text as paragraphs of styled runs; inline math as `code`. */
function textFromXmcd(el: El, conv: Converter, styles: Map<string, Mc15TextStyle>): TextPara[] {
  const paras: TextPara[] = [];
  const walk = (n: XNode, st: RunStyle, out: TextRun[]) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        // Mathcad indents the markup: a line break and what follows it is not text (that is <br/>)
        out.push({ text: (c.nodeValue ?? '').replace(/[ \t]*[\r\n]\s*/g, ''), style: st });
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as El;
      switch (local(e)) {
        case 'b': case 'strong': walk(e, { ...st, bold: true }, out); break;
        case 'i': case 'em': walk(e, { ...st, italic: true }, out); break;
        case 'u': walk(e, { ...st, underline: true }, out); break;
        case 'sub': walk(e, { ...st, sub: true }, out); break;
        case 'sup': walk(e, { ...st, sup: true }, out); break;
        case 'f': case 'c': case 'inlineAttr': case 'span': walk(e, mc15Inline(e, st), out); break;
        case 'link': case 'a': walk(e, { ...st, link: e.getAttribute('href') ?? undefined }, out); break;
        case 'sp': out.push({ text: ' '.repeat(Math.max(1, Number(e.getAttribute('count') ?? 1))), style: st }); break;
        case 'tab': out.push({ text: '    ', style: st }); break;
        case 'br': out.push({ text: '\n', style: st }); break;
        case 'math': case 'region': {
          const m = local(e) === 'math' ? e : child(e, 'math');
          let src = '(math)';
          try {
            if (m) src = conv.statement(m);
          } catch {
            /* shown as (math) */
          }
          out.push({ text: `\`${src.replace(/`/g, "'")}\``, style: st, markup: true });
          break;
        }
        default: walk(e, st, out);
      }
    }
  };
  const ps = kids(el).filter((c) => local(c) === 'p');
  for (const p of ps.length ? ps : [el]) {
    const name = p.getAttribute('style') ?? 'Normal';
    const ts = styles.get(name) ?? styles.get('Normal') ?? { style: {} };
    const runs: TextRun[] = [];
    walk(p, ts.style, runs);
    // spaces at the ends of a paragraph do nothing
    if (runs.length) {
      runs[0] = { ...runs[0], text: runs[0].markup ? runs[0].text : runs[0].text.replace(/^ +/, '') };
      const k = runs.length - 1;
      runs[k] = { ...runs[k], text: runs[k].markup ? runs[k].text : runs[k].text.replace(/ +$/, '') };
    }
    const align = (v: string | null | undefined) => (v && v !== 'inherit' ? v : undefined);
    const a = align(p.getAttribute('text-align')) ?? ts.align;
    const l = align(p.getAttribute('list-style-type')) ?? ts.list;
    const hm = /(?:heading|header|überschrift|заголовок|titre|título)\s*(\d)/i.exec(name);
    paras.push({
      runs,
      ...(a === 'center' || a === 'right' || a === 'justify' ? { align: a } : {}),
      ...(l && l !== 'none' ? { list: /decimal|alpha|roman/.test(l) ? 'number' : 'bullet' } : {}),
      ...(hm ? { heading: Math.min(3, Math.max(1, Number(hm[1]))) as 1 | 2 | 3 } : /^title$/i.test(name) ? { heading: 1 as const } : {}),
    });
  }
  return paras;
}

/** Prime XAML attributes (FontSize in px, colours as #AARRGGBB) over the inherited style. */
function xamlStyle(e: El, over: RunStyle): RunStyle {
  const out: RunStyle = { ...over };
  const a = (n: string) => e.getAttribute(n) || undefined;
  const size = Number(a('FontSize'));
  if (size > 0) out.size = size;
  if (a('FontFamily')) out.family = a('FontFamily');
  const fg = a('Foreground');
  if (fg) out.color = cssColor(fg);
  const bg = a('Background');
  if (bg) out.background = cssColor(bg);
  const w = a('FontWeight');
  if (w) out.bold = /bold|black|heavy/i.test(w);
  const st = a('FontStyle');
  if (st) out.italic = /italic|oblique/i.test(st);
  const deco = a('TextDecorations');
  if (deco !== undefined) {
    out.underline = /underline/i.test(deco);
    out.strike = /strikethrough/i.test(deco);
  }
  // <Run.TextDecorations><TextDecoration Location="Underline"/></Run.TextDecorations>
  for (const pe of kids(e).filter((c) => local(c).endsWith('.TextDecorations'))) {
    for (const d of Array.from(pe.getElementsByTagNameNS('*', 'TextDecoration'))) {
      const loc = d.getAttribute('Location') ?? '';
      if (/underline/i.test(loc)) out.underline = true;
      if (/strikethrough/i.test(loc)) out.strike = true;
    }
  }
  const va = a('BaselineAlignment') ?? a('Typography.Variants');
  if (va) {
    out.sub = /subscript/i.test(va);
    out.sup = /superscript/i.test(va);
  }
  return out;
}

/** A Prime text (FlowDocument XAML) as paragraphs of styled runs. */
function textFromXaml(root: El | null): TextPara[] {
  const paras: TextPara[] = [];
  const inline = (n: El, st: RunStyle, out: TextRun[]) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        out.push({ text: c.nodeValue ?? '', style: st });
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as El;
      const t = local(e);
      if (t.includes('.')) continue; // property elements (Run.TextDecorations)
      if (t === 'LineBreak') out.push({ text: '\n', style: st });
      else if (t === 'Bold') inline(e, { ...xamlStyle(e, st), bold: true }, out);
      else if (t === 'Italic') inline(e, { ...xamlStyle(e, st), italic: true }, out);
      else if (t === 'Underline') inline(e, { ...xamlStyle(e, st), underline: true }, out);
      else if (t === 'Hyperlink') inline(e, { ...xamlStyle(e, st), link: e.getAttribute('NavigateUri') ?? undefined }, out);
      else inline(e, xamlStyle(e, st), out);
    }
  };
  const block = (n: El, st: RunStyle, align: string | undefined, list: TextPara['list']) => {
    for (const e of kids(n)) {
      const t = local(e);
      if (t.includes('.')) continue;
      const own = xamlStyle(e, st);
      const al = e.getAttribute('TextAlignment') ?? align;
      if (t === 'Paragraph') {
        const runs: TextRun[] = [];
        inline(e, own, runs);
        paras.push({ runs, ...(al === 'Center' || al === 'Right' || al === 'Justify' ? { align: al.toLowerCase() as 'center' | 'right' | 'justify' } : {}), ...(list ? { list } : {}) });
      } else if (t === 'List') {
        const marker = e.getAttribute('MarkerStyle') ?? 'Disc';
        block(e, own, al, /decimal|letter|roman/i.test(marker) ? 'number' : 'bullet');
      } else block(e, own, al, list);
    }
  };
  if (root) block(root, xamlStyle(root, {}), undefined, undefined);
  return paras;
}

// ------------------------------------------------------------ packages

/** The image type from its first bytes: Mathcad often stores BMP data under a .png name. */
function sniffMime(bytes: Uint8Array, name: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
}

interface Package {
  worksheet: string;
  /** relationship id → zip path */
  rels: Record<string, string>;
  files: Record<string, Uint8Array>;
}

/** Zip entry by path (case-insensitive), falling back to the file name alone. */
function findFile(files: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  const want = path.replace(/\\/g, '/').replace(/^\//, '').toLowerCase();
  const keys = Object.keys(files);
  const exact = keys.find((k) => k.toLowerCase() === want);
  if (exact) return files[exact];
  const base = want.split('/').pop();
  const byName = keys.find((k) => k.toLowerCase().split('/').pop() === base);
  return byName ? files[byName] : undefined;
}

/** The relationships of a part of the package (mathcad/_rels/<part>.rels): id → zip path. */
function readRels(files: Record<string, Uint8Array>, part: string): Record<string, string> {
  const rels: Record<string, string> = {};
  const relsKey = Object.keys(files).find((k) => k.toLowerCase() === `mathcad/_rels/${part}.rels`);
  if (relsKey) {
    const doc = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(files[relsKey]).replace(/^\uFEFF/, ''), 'text/xml');
    const list = doc.getElementsByTagNameNS('*', 'Relationship');
    for (let i = 0; i < list.length; i++) {
      const id = list[i].getAttribute('Id');
      let target = list[i].getAttribute('Target') ?? '';
      if (!target.startsWith('/')) target = 'mathcad/' + target;
      if (id) rels[id] = target.replace(/^\//, '');
    }
  }
  return rels;
}

function readMcdx(data: Uint8Array): Package {
  const files = unzipSync(data);
  const ws = Object.keys(files).find((k) => k.toLowerCase() === 'mathcad/worksheet.xml');
  if (!ws) throw new Error('This zip file is not a Mathcad Prime worksheet (no mathcad/worksheet.xml)');
  return { worksheet: strFromU8(files[ws]), rels: readRels(files, 'worksheet.xml'), files };
}

// ------------------------------------------------------------ saved results

/** Mathcad's names of saved units that mathjs spells otherwise (most, meter or kilonewton, it shares). */
const SAVED_UNITS: Record<string, string> = {
  pascal: 'Pa', micron: 'um', gravitational_acceleration: '(9.80665 m/s^2)', becquerel: '(1/s)', pound: 'lb',
  pound_force: 'lbf', kips_per_sq_inch: 'ksi', pounds_per_sq_inch: 'psi', knots: 'knot', International_BTU: 'BTU',
  gallons_per_minute: '(gal/minute)', kip: 'kip', degree: 'deg',
};
const LONG_PREFIX: Record<string, string> = {
  yotta: 'Y', zetta: 'Z', exa: 'E', peta: 'P', tera: 'T', giga: 'G', mega: 'M', kilo: 'k', hecto: 'h', deca: 'da',
  deci: 'd', centi: 'c', milli: 'm', micro: 'u', nano: 'n', pico: 'p', femto: 'f', atto: 'a',
};

/** A saved unit name as ours: as it is, from the table, or a long SI prefix on a name from it (megapascal). */
function savedUnit(name: string): string | null {
  if (SAVED_UNITS[name]) return SAVED_UNITS[name];
  if (isUnitName(name)) return name;
  const m = /^(yotta|zetta|exa|peta|tera|giga|mega|kilo|hecto|deca|deci|centi|milli|micro|nano|pico|femto|atto)(.+)$/.exec(name);
  const base = m ? SAVED_UNITS[m[2]] : undefined;
  return base && /^[A-Za-z]+$/.test(base) && isUnitName(LONG_PREFIX[m![1]] + base) ? LONG_PREFIX[m![1]] + base : null;
}

/** A saved result's unit (a product of powers of named units); null when one is not known here. */
function unitMonomial(el: El): string | null {
  const parts: string[] = [];
  for (const r of kids(el).filter((c) => local(c) === 'unitReference')) {
    const name = savedUnit(r.getAttribute('unit') ?? '');
    if (name === null) return null;
    const num = Number(r.getAttribute('power-numerator') ?? 1), den = Number(r.getAttribute('power-denominator') ?? 1);
    const pw = num / den;
    parts.push(pw === 1 ? name : `${name}^(${Number.isInteger(pw) ? pw : `${num}/${den}`})`);
  }
  return parts.join('*');
}

/** A cached result (<ml:result> in Prime's result.xml, <result> in a Mathcad 15 eval) as an expression. */
function savedExpr(el: El): string | null {
  const t = local(el);
  if (t === 'result') {
    const inner = kids(el)[0];
    return inner ? savedExpr(inner) : null;
  }
  if (t === 'real') return (el.textContent ?? '').trim();
  if (t === 'str') return JSON.stringify(el.textContent ?? '');
  if (t === 'imag') return `${(el.textContent ?? '').trim()}i`;
  if (t === 'complex') {
    // a part that is 0 may be left out
    const re = kids(el).find((c) => local(c) === 'real'), im = kids(el).find((c) => local(c) === 'imag');
    const a = re ? savedExpr(re) : '0', b = im ? savedExpr(im) : '0i';
    return a !== null && b !== null ? `(${a} + ${b})` : null;
  }
  if (t === 'unitedValue') {
    const [v, u] = kids(el);
    const value = v ? savedExpr(v) : null;
    const unit = u ? unitMonomial(u) : '';
    if (value === null || unit === null) return null;
    return unit ? `(${value})*${unit}` : value;
  }
  if (t === 'matrix') {
    const rows = Number(el.getAttribute('rows') ?? 0), cols = Number(el.getAttribute('cols') ?? 0);
    const items = kids(el).map(savedExpr);
    if (!rows || !cols || items.length !== rows * cols || items.some((x) => x === null)) return null;
    // column by column, as Mathcad writes matrices
    return `[${Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => items[j * rows + i]).join(', ')).join('; ')}]`;
  }
  return null;
}

/** Prime keeps results apart from the math, in mathcad/result.xml, keyed by the math's resultRef. */
function primeResults(pkg: Package): Map<string, string> {
  const out = new Map<string, string>();
  const bytes = findFile(pkg.files, 'mathcad/result.xml');
  if (!bytes) return out;
  const doc = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(bytes).replace(/^﻿/, ''), 'text/xml');
  const list = doc.getElementsByTagNameNS('*', 'resultData');
  for (let i = 0; i < list.length; i++) {
    const r = child(list[i], 'result');
    const e = r ? savedExpr(r) : null;
    if (e !== null) out.set(list[i].getAttribute('result-id') ?? '', e);
  }
  return out;
}

// ------------------------------------------------------------ main

/**
 * The names a region defines: on the worksheet (definitions, functions, element definitions,
 * solve blocks) and only inside itself (function parameters, program locals, loop counters).
 */
function definedNames(root: El): { sheet: Set<string>; inside: Set<string> } {
  const sheet = new Set<string>(), inside = new Set<string>();
  const add = (n: El | undefined, out: Set<string>) => {
    if (!n) return;
    const k = local(n);
    if (k === 'id') out.add(nameKey(n));
    else if (k === 'function') {
      add(child(n, 'id'), out);
      add(child(n, 'boundVars'), inside);
    } else if (k === 'boundVars' || k === 'matrix') kids(n).forEach((c) => add(c, out));
    else if (k === 'apply' && local(kids(n)[0] ?? n) === 'indexer') add(kids(n)[1], out);
  };
  const visit = (el: El) => {
    const t = local(el);
    if (t === 'define' || t === 'globalDefine') add(kids(el)[0], sheet);
    else if (t === 'localDefine' || t === 'for') add(kids(el)[0], inside);
    else if (t === 'boundVars') add(el, inside);
    kids(el).forEach(visit);
  };
  visit(root);
  return { sheet, inside };
}

/**
 * A result format (<general>, <decimal>, <scientific>, <engineering> with precision,
 * exponential-threshold, show-trailing-zeros), from a region's <resultFormat> or the
 * worksheet's <results>.
 */
function numberFormat(el: El | undefined): NumberFormat | null {
  const f = el ? kids(el).find((c) => /^(general|decimal|scientific|engineering)$/.test(local(c))) : undefined;
  if (!f) return null;
  const out: NumberFormat = { style: local(f) as NumberStyle };
  const precision = f.getAttribute('precision');
  if (precision !== null && precision !== '' && Number.isInteger(Number(precision))) out.precision = Math.max(0, Math.min(15, Number(precision)));
  const threshold = f.getAttribute('exponential-threshold');
  if (threshold !== null && threshold !== '' && Number.isInteger(Number(threshold))) out.expThreshold = Math.max(1, Math.min(15, Number(threshold)));
  if (f.getAttribute('show-trailing-zeros') === 'true') out.trailingZeros = true;
  return out;
}

/** Height of a row of a Prime spec table, which is imported as one math region a row. */
const SPEC_ROW = 40;

export function importMathcad(data: Uint8Array, fileName = 'worksheet'): ImportResult {
  const isZip = data[0] === 0x50 && data[1] === 0x4b;
  const pkg: Package | null = isZip ? readMcdx(data) : null;
  const xml = pkg ? pkg.worksheet : strFromU8(data).replace(/^﻿/, '');
  if (!/<\s*([\w-]+:)?worksheet[\s>]/.test(xml)) throw new Error('Not a Mathcad worksheet (.mcdx or .xmcd)');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('The file is not valid XML');
  const conv = new Converter();
  const warnings = conv.warnings;
  const ws = emptyWorksheet();
  ws.title = fileName.replace(/\.(mcdx|xmcd)$/i, '');
  // Prime places regions in device-independent pixels (1/96 inch) like us, Mathcad 15 in points
  const PX = pkg ? 1 : 96 / 72;
  // Mathcad 15 does not label units: a name is a unit unless the worksheet has defined it above
  // (or the region defines it itself); global definitions (≡) come first
  const sheetNames = new Set<string>();
  for (const d of doc.getElementsByTagNameNS('*', 'globalDefine')) definedNames(d).sheet.forEach((n) => sheetNames.add(n));
  let insideNames = new Set<string>();
  conv.defined = { has: (n: string) => sheetNames.has(n) || insideNames.has(n) };
  for (const id of doc.getElementsByTagNameNS('*', 'id')) if (nameKey(id) === rawName(id)) conv.plainNames.add(rawName(id));
  for (const d of doc.getElementsByTagNameNS('*', 'define')) {
    const t = kids(d)[0];
    if (t && local(t) === 'id') conv.variables.add(rawName(t));
  }

  // ORIGIN: Prime's calculation settings, Mathcad 15's <builtInVariables>
  const settingsXml = pkg ? findFile(pkg.files, 'mathcad/settings/calculation.xml') : undefined;
  const settingsDoc = settingsXml ? new DOMParser({ onError: () => {} }).parseFromString(strFromU8(settingsXml).replace(/^﻿/, ''), 'text/xml') : doc;
  const biv = settingsDoc.getElementsByTagNameNS('*', 'builtInVariables')[0];
  if (biv?.getAttribute('array-origin') === '1') ws.settings.origin = 1;

  // how numbers are shown: the worksheet's result format (Prime keeps it in presentation.xml)
  const presentationXml = pkg ? findFile(pkg.files, 'mathcad/settings/presentation.xml') : undefined;
  const presentation = presentationXml ? new DOMParser({ onError: () => {} }).parseFromString(strFromU8(presentationXml).replace(/^\uFEFF/, ''), 'text/xml') : doc;
  const sheetFormat = numberFormat(presentation.getElementsByTagNameNS('*', 'results')[0]);
  if (sheetFormat?.precision !== undefined) ws.settings.precision = sheetFormat.precision;
  if (sheetFormat?.expThreshold !== undefined) ws.settings.expThreshold = sheetFormat.expThreshold;
  /** A region's own result format: what differs from the worksheet's. */
  const regionFormat = (math: El): NumberFormat | undefined => {
    const f = numberFormat(child(math, 'resultFormat'));
    if (!f) return undefined;
    const out: NumberFormat = {};
    if (f.precision !== undefined && f.precision !== ws.settings.precision) out.precision = f.precision;
    if (f.expThreshold !== undefined && f.expThreshold !== ws.settings.expThreshold) out.expThreshold = f.expThreshold;
    if (f.style && f.style !== 'general') out.style = f.style;
    if (f.trailingZeros) out.trailingZeros = true;
    return Object.keys(out).length ? out : undefined;
  };
  let originSet = false;

  // the page width, beyond which Mathcad users keep side calculations
  const pageModel = doc.getElementsByTagNameNS('*', 'pageModel')[0];
  const pageWidth = Number(pageModel?.getAttribute('page-width') ?? 0) * PX || (pkg ? 816 : 0);

  // binary items of Mathcad 15 (pictures, the rendering of every region)
  const binary: Record<string, { data: string; enc: string }> = {};
  const bc = doc.getElementsByTagNameNS('*', 'binaryContent')[0];
  if (bc) for (const it of kids(bc)) binary[it.getAttribute('item-id') ?? ''] = { data: (it.textContent ?? '').replace(/\s+/g, ''), enc: it.getAttribute('content-encoding') ?? '' };
  const saved: SavedResult[] = [];
  const cached = pkg ? primeResults(pkg) : new Map<string, string>();

  const regionsEl = kids(root).find((c) => local(c) === 'regions') ?? doc.getElementsByTagNameNS('*', 'regions')[0];
  if (!regionsEl) throw new Error('The worksheet has no regions');

  // order: Prime by the region's top; Mathcad 15 by the baseline of its math (align-y), so that
  // h := (b − a)/N, whose fraction rises above the line, comes after N := 5 to its left
  type Placed = { region: El; x: number; y: number; order: number; included?: string };
  /** An area as it is expanded: its bar at (x, y), its band `height` tall. */
  type AreaPlace = { x: number; y: number; height: number; collapsed: boolean; locked: boolean; title: string; depth: number };
  const areas: AreaPlace[] = [];
  const sizeOf = (r: El) => {
    // a spec table becomes one math region a row (SPEC_ROW apart)
    const table = child(r, 'spec-table');
    if (table) return kids(table).filter((c) => local(c) === 'math').length * SPEC_ROW;
    return Number(r.getAttribute('height') ?? r.getAttribute('actualHeight') ?? 0) * PX || 20;
  };
  /**
   * The regions of a container placed as on the expanded page. Prime places an area's regions
   * relative to the area; Mathcad 15 relative to a collapsed area but on the page in an open
   * one. Both save what follows a collapsed area where it is with the area collapsed, so that
   * moves down by what the area hides; the import collapses the area again afterwards.
   * Returns the bottom of what it placed.
   */
  /** A Prime reference's worksheet as Prime cached it in the package (mathcad/include/…): its regions. */
  const cachedReference = (ref: El): El | null => {
    const idref = ref.getAttribute('item-idref');
    const path = pkg && idref ? pkg.rels[idref] : undefined;
    const bytes = path ? findFile(pkg!.files, path) : undefined;
    if (!bytes) return null;
    const cached = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(bytes).replace(/^\uFEFF/, ''), 'text/xml').documentElement;
    return cached ? child(cached, 'regions') ?? null : null;
  };
  const refFile = (ref: El) => (ref.getAttribute('href') ?? ref.getElementsByTagNameNS('*', 'originRef')[0]?.getAttribute('href') ?? '').split(/[\\/]/).pop() || 'another worksheet';
  const layout = (container: El, ox: number, oy: number, depth: number, out: Placed[], included?: string): number => {
    const items = kids(container).filter((c) => local(c) === 'region').sort((a, b) => Number(a.getAttribute('top') ?? 0) - Number(b.getAttribute('top') ?? 0));
    const pushes: { at: number; by: number }[] = [];
    let bottom = oy;
    for (const r of items) {
      const top = Number(r.getAttribute('top') ?? 0) * PX;
      const shift = pushes.reduce((acc, p) => acc + (p.at < top - 0.5 ? p.by : 0), 0);
      const x = ox + Number(r.getAttribute('left') ?? 0) * PX;
      const y = oy + top + shift;
      const alignY = r.getAttribute('align-y');
      const order = !pkg && alignY !== null ? oy + Number(alignY) * PX + shift : y;
      const area = child(r, 'Area') ?? child(r, 'area');
      // a reference whose worksheet Prime cached: its definitions in a collapsed, locked area there
      const ref = child(r, 'reference');
      const cached = ref ? cachedReference(ref) : null;
      if (ref && cached) {
        const file = refFile(ref);
        const at = areas.length;
        areas.push({ x, y, height: 0, collapsed: true, locked: true, title: `Reference: ${file}`, depth });
        const end = layout(cached, x, y + AREA_BAR, depth + 1, out, file);
        areas[at].height = Math.max(AREA_BAR + AREA_PAD, end - y + AREA_PAD);
        pushes.push({ at: top, by: areas[at].height - AREA_BAR });
        referenced.push(file);
        bottom = Math.max(bottom, y + areas[at].height);
        continue;
      }
      if (!area) {
        // what a referenced worksheet shows is not needed to calculate with it
        if (included && !/^(math|solveblock|spec-table)$/.test(local(kids(r).find((c) => local(c) !== 'rendering') ?? r))) continue;
        out.push({ region: r, x, y, order, ...(included ? { included } : {}) });
        bottom = Math.max(bottom, y + sizeOf(r));
        continue;
      }
      // Prime: <Area><regions>…; Mathcad 15: the area holds its regions itself
      const inner = child(area, 'regions') ?? area;
      const collapsed = /^true$/i.test(area.getAttribute('IsCollapsed') ?? area.getAttribute('is-collapsed') ?? '');
      const locked = /^true$/i.test(area.getAttribute('IsLocked') ?? area.getAttribute('is-locked') ?? '');
      const relative = !!pkg || collapsed;
      const at = areas.length;
      areas.push({ x, y, height: 0, collapsed, locked, title: area.getAttribute('show-name') === 'false' ? '' : area.getAttribute('name') ?? '', depth });
      const end = layout(inner, relative ? x : ox, relative ? y : oy + shift, depth + 1, out, included);
      // the band holds the contents; an open area of Mathcad 15 also saves its own height
      const saved = !collapsed && !pkg ? sizeOf(r) : 0;
      const height = Math.max(AREA_BAR + AREA_PAD, end - y + AREA_PAD, saved);
      areas[at].height = height;
      if (collapsed) pushes.push({ at: top, by: height - AREA_BAR });
      bottom = Math.max(bottom, y + height);
    }
    return bottom;
  };
  const flat: Placed[] = [];
  const referenced: string[] = [];
  layout(regionsEl, 0, 0, 0, flat);
  for (const file of referenced) {
    warnings.push(`The worksheet references ${file}: its definitions come from the copy Prime saved with this file, in the collapsed area “Reference: ${file}” (locked; they do not change when ${file} does)`);
  }
  const placed = flat.sort((a, b) => a.order - b.order || a.x - b.x);

  const regions: Region[] = [];
  /** Text regions, written once the whole worksheet's normal text size is known. */
  const texts: { region: TextRegion; paras: TextPara[]; highlight?: string }[] = [];
  const textStyles = pkg ? new Map<string, Mc15TextStyle>() : mc15TextStyles(doc);
  /** Where the worksheet has page breaks (expanded layout). */
  const pageBreaks: number[] = [];
  const fail = (what: string, e: unknown, at: Placed) => {
    const msg = e instanceof Unsupported ? `uses ${e.message}, which mathstudii cannot import yet` : (e as Error).message;
    warnings.push(`${what} at ${Math.round(at.y)} px: ${msg}`);
    regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Not imported (${what}):* ${msg}`, width: 300 }));
  };
  // Mathcad 15 stores a picture of every region: what cannot be converted is shown as that
  const rendering = (at: Placed, what: string): boolean => {
    const ref = child(at.region, 'rendering')?.getAttribute('item-idref');
    const src = ref ? binaryImage(binary[ref]) : null;
    if (!src) return false;
    const width = Math.min(PAGE_WIDTH - 2 * PAGE_MARGIN, Number(at.region.getAttribute('width') ?? 0) * PX || 240);
    regions.push(createRegion('text', at.x, at.y, { markdown: `*${what} (picture from Mathcad):*`, width: Math.min(width, 300) }));
    regions.push(createRegion('image', at.x, at.y + 18, { src, width }));
    return true;
  };
  /**
   * Mathcad 15's File Read component (outputs, no inputs, a data file) becomes
   * out := READPRN("file") (READCSV for .csv, READEXCEL for a workbook); a File Write component
   * (inputs and a file) is noted, as nothing here writes files. False for other components.
   */
  const componentRead = (body: El, at: Placed): boolean => {
    const ref = body.getAttribute('item-idref');
    const file = ref ? componentFile(binary[ref]) : null;
    if (!file) return false;
    const ins = kids(child(body, 'inputs') ?? body).filter((c) => local(c) !== 'inputs' && local(c) !== 'outputs');
    const outs = kids(child(body, 'outputs') ?? body).filter((c) => local(c) !== 'inputs' && local(c) !== 'outputs');
    const name = file.split(/[\\/]/).pop() ?? file;
    if (outs.length === 1 && !ins.length) {
      const lhs = conv.target(outs[0]);
      const fn = /\.csv$/i.test(name) ? 'READCSV' : /\.xlsx?$/i.test(name) ? 'READEXCEL' : 'READPRN';
      regions.push(createRegion('math', at.x, at.y, { source: `${lhs} := ${fn}(${JSON.stringify(file)})` }));
      warnings.push(`The File Read component for ${lhs} at ${Math.round(at.y)} px became ${lhs} := ${fn}("${name}"): attach ${name} in File ▸ Data files… (a component set to read only some rows or columns reads them all here)`);
      return true;
    }
    if (ins.length && !outs.length && rendering(at, 'File Write component')) {
      warnings.push(`The File Write component at ${Math.round(at.y)} px (it writes ${ins.map((c) => conv.expr(c).s).join(', ')} to ${name}) is shown as Mathcad's picture of it: worksheets here do not write files`);
      return true;
    }
    return false;
  };
  // math regions are placed at their baseline less a line's ascent, so that our reading order
  // (by the top of a region) is Mathcad's
  const mathY = (at: Placed) => (at.order !== at.y ? at.order - 12 : at.y);

  // Mathcad 15 "Given … Find" solve blocks span several free regions
  let solve: { guesses: string[]; constraints: string[]; at: Placed } | null = null;

  for (const at of placed) {
    const r = at.region;
    const body = kids(r).find((c) => local(c) !== 'rendering');
    if (!body) continue;
    const names = definedNames(r);
    names.sheet.forEach((n) => sheetNames.add(n));
    insideNames = names.inside;
    const kind = local(body);
    try {
      if (kind === 'math') {
        const inner = kids(body)[0];
        // Mathcad 15 solve block keywords
        if (inner && local(inner) === 'id' && /^given$/i.test(rawName(inner))) {
          solve = { guesses: [], constraints: [], at };
          continue;
        }
        conv.scale = '';
        conv.choices = undefined;
        const src = conv.statement(body);
        // ORIGIN := 1 is a setting here
        const om = /^ORIGIN := ([01])$/.exec(src);
        if (om && !originSet) {
          ws.settings.origin = Number(om[1]) as 0 | 1;
          originSet = true;
          regions.push(createRegion('text', at.x, mathY(at), { markdown: `ORIGIN := ${om[1]} *(the worksheet's first array index; set in Format → Worksheet)*`, width: 260 }));
          continue;
        }
        if (solve) {
          if (/\b(find|minerr|minimize|maximize|odesolve|pdesolve)\(/i.test(src)) {
            regions.push(createRegion('solve', solve.at.x, mathY(solve.at), { guesses: solve.guesses.join('\n'), constraints: solve.constraints.join('\n'), solver: src }));
            solve = null;
            continue;
          }
          if (/ (==|<|>|≤|≥|≠) /.test(src) && !src.includes(':=')) {
            solve.constraints.push(src.replace(' == ', ' = '));
            continue;
          }
          if (src.includes(':=')) {
            solve.guesses.push(src);
            continue;
          }
        }
        const format = regionFormat(body);
        const choices = conv.choices;
        const reg = createRegion('math', at.x, mathY(at), { source: src, disabled: body.getAttribute('disable-calc') === 'true' || undefined, ...(format ? { format } : {}), ...(choices ? { choices } : {}) });
        regions.push(reg);
        const ref = body.getAttribute('resultRef');
        // a referenced worksheet's results are not in this file's result.xml
        const value = at.included ? undefined : ref !== null ? cached.get(ref) : savedOfEval(body);
        if (value !== undefined && value !== null && / =( |$)/.test(src.split('\n')[0])) {
          saved.push({ regionId: reg.id, expr: conv.scale ? `(${value})*(${conv.scale})` : value });
        }
      } else if (kind === 'text') {
        let paras: TextPara[] = [];
        const idref = body.getAttribute('item-idref');
        const flow = child(body, 'FlowDocument');
        if (pkg && idref && pkg.rels[idref]) {
          const xaml = findFile(pkg.files, pkg.rels[idref]);
          if (xaml) {
            const inner = unzipSync(xaml);
            const docKey = Object.keys(inner).find((k) => /document\.xaml$/i.test(k));
            if (docKey) paras = textFromXaml(new DOMParser({ onError: () => {} }).parseFromString(strFromU8(inner[docKey]), 'text/xml').documentElement as unknown as El);
          }
        } else if (flow) paras = textFromXaml(flow); // converted from Mathcad 15: the document itself
        else paras = textFromXmcd(body, conv, textStyles);
        if (paras.some((p) => p.runs.some((x) => x.text.trim()))) {
          const reg = createRegion('text', at.x, at.y, { markdown: '', width: Math.max(160, Number(r.getAttribute('width') ?? 0) * PX || 360) });
          // Mathcad 15 highlights a region with its own background colour
          const highlight = r.getAttribute('show-highlight') === 'true' ? cssColor(r.getAttribute('background-color')) ?? '#ffff80' : cssColor(r.getAttribute('background-color'));
          texts.push({ region: reg as TextRegion, paras, highlight });
          regions.push(reg);
        }
      } else if (kind === 'solveblock') {
        regions.push(solveBlock(body, conv, at));
      } else if (kind === 'picture') {
        const src = picture(body, pkg, binary);
        if (src) regions.push(createRegion('image', at.x, at.y, { src, width: Math.min(PAGE_WIDTH - 2 * PAGE_MARGIN, Number(r.getAttribute('width') ?? 0) * PX || 240) }));
        else warnings.push(`Picture at ${Math.round(at.y)} px: image data not found`);
      } else if (kind === 'plot') {
        // Mathcad 15 keeps plots in a binary format: its picture of the plot is what can be shown
        if (body.getAttribute('item-idref') && !kids(body).length) {
          if (rendering(at, 'Plot')) warnings.push(`Plot at ${Math.round(at.y)} px: Mathcad 15 plots are stored in a binary format; shown as Mathcad's picture of it`);
          else warnings.push(`Plot at ${Math.round(at.y)} px: Mathcad 15 plots are stored in a binary format and could not be converted`);
        } else regions.push(plot(body, conv, at));
      } else if (kind === 'spec-table') {
        let y = at.y;
        for (const m of kids(body).filter((c) => local(c) === 'math')) {
          regions.push(createRegion('math', at.x, y, { source: conv.statement(m) }));
          y += SPEC_ROW;
        }
      } else if (kind === 'pageBreak') {
        pageBreaks.push(at.y);
      } else if (kind === 'reference') {
        // Mathcad 15 "Reference": the definitions of another worksheet, read when this one calculates
        const href = body.getElementsByTagNameNS('*', 'originRef')[0]?.getAttribute('href') ?? '';
        const file = href.split(/[\\/]/).pop() || 'another worksheet';
        warnings.push(`A reference to ${file} at ${Math.round(at.y)} px: what that worksheet defines is not imported (import it too and copy the definitions here)`);
        regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Reference to “${file}”: its definitions are not imported.*`, width: 300 }));
      } else if (kind === 'component' && componentRead(body, at)) {
        // a File Read component: the function reading that file
      } else {
        // what is not converted: Mathcad's picture of it, named as precisely as the file allows
        const what = kind === 'ole' ? oleKind(body) : kind === 'component' ? componentKind(body, conv) : `A ${kind} region`;
        if (!rendering(at, what.replace(/ \(.*$/, ''))) warnings.push(`${what} at ${Math.round(at.y)} px was not imported: the file has no picture of it`);
        else warnings.push(`${what} at ${Math.round(at.y)} px is shown as Mathcad's picture of it`);
      }
    } catch (e) {
      fail(kind === 'math' ? 'math' : kind, e, at);
    }
  }
  if (solve) warnings.push('A "Given" block has no Find/Minerr call; its constraints were dropped');
  startPages(regions, areas, pageBreaks);

  // the page header and footer: the page's own lines (Report tab), with their fields
  const page = pkg ? primePage(pkg, pageWidth || 816, binary, warnings) : mc15Page(pageModel, binary);
  if (page.header || page.footer) {
    ws.settings.report = { enabled: true, ...(page.header ? { header: page.header } : {}), ...(page.footer ? { footer: page.footer } : {}), ...(page.logo ? { logo: page.logo } : {}) };
  }

  // text: the size most of it has is the normal size here; a serif worksheet keeps its serif
  const normal = normalSize(texts.map((t) => t.paras));
  for (const t of texts) {
    const { markdown, style } = toMarkdown(t.paras, normal);
    t.region.markdown = markdown;
    if (t.highlight && !style.background) style.background = t.highlight;
    if (Object.keys(style).length) t.region.style = style;
  }
  const families = texts.flatMap((t) => t.paras.flatMap((p) => p.runs.map((x) => [x.style.family ?? '', x.text.length] as const)));
  const serif = families.reduce((n, [f, len]) => n + (/times|georgia|garamond|cambria|serif/i.test(f) && !/sans/i.test(f) ? len : -len), 0) > 0;
  if (serif) ws.settings.format = { ...ws.settings.format, textFont: 'serif' };

  // areas: their bars (drawn first, under the regions), collapsed again as in the file
  const bars = areas.map((a) => createRegion('area', a.x, a.y, { title: a.title, height: Math.round(a.height) }) as AreaRegion);
  regions.unshift(...bars);
  const moved = fitToPage(regions, pageWidth);
  if (moved) warnings.push(`${moved} region${moved > 1 ? 's' : ''} to the right of Mathcad's page ${moved > 1 ? 'were' : 'was'} moved onto the page`);
  ws.regions = regions;
  let out = nestBands(ws);
  // a locked area's regions cannot be edited (Mathcad asks for its password to unlock it)
  const locked = new Set(bars.filter((_, i) => areas[i].locked).flatMap((b) => [...withContents(out.regions, [b.id])]));
  if (locked.size) out = { ...out, regions: out.regions.map((r) => (locked.has(r.id) ? { ...r, locked: true } : r)) };
  for (const i of areas.map((_, k) => k).sort((p, q) => areas[q].depth - areas[p].depth)) {
    if (areas[i].collapsed) out = collapseArea(out, bars[i].id);
  }
  return { ws: out, warnings, format: pkg ? 'Mathcad Prime (.mcdx)' : 'Mathcad 11–15 (.xmcd)', saved };
}

/**
 * A page break starts a new page: what follows it, if it would begin on the break's page here,
 * moves down to the top of our next page (with everything below it). An area the break lies in
 * grows by as much.
 */
function startPages(regions: Region[], areas: { y: number; height: number }[], breaks: number[]): void {
  let moved = 0;
  for (const at of [...breaks].sort((a, b) => a - b)) {
    const b = at + moved;
    const below = regions.filter((r) => r.y > b);
    if (!below.length) break;
    const first = Math.min(...below.map((r) => r.y));
    const page = Math.floor(b / PAGE_HEIGHT);
    if (first >= (page + 1) * PAGE_HEIGHT) continue;
    const by = (page + 1) * PAGE_HEIGHT + PAGE_MARGIN - first;
    for (const r of below) r.y += by;
    for (const a of areas) {
      if (a.y > b) a.y += by;
      else if (a.y + a.height > b) a.height += by;
    }
    moved += by;
  }
}

/**
 * A value Prime saved in its own notation (a script control's RL attribute):
 * (number 3:0x…), (op_matrix:0x… (unboxed rows) (unboxed cols) (list …)) column by column,
 * (string "…"). Null for anything else.
 */
export function primeValue(src: string): string | null {
  type Node = string | Node[];
  let i = 0;
  const parse = (): Node => {
    while (/\s/.test(src[i] ?? '')) i++;
    if (src[i] === '(') {
      i++;
      const out: Node[] = [];
      for (;;) {
        while (/\s/.test(src[i] ?? '')) i++;
        if (i >= src.length) throw new Error('unbalanced');
        if (src[i] === ')') {
          i++;
          return out;
        }
        out.push(parse());
      }
    }
    if (src[i] === '"') {
      const m = /^"((?:[^"\\]|\\.)*)"/.exec(src.slice(i));
      if (!m) throw new Error('string');
      i += m[0].length;
      return m[0];
    }
    const m = /^[^\s()]+/.exec(src.slice(i));
    if (!m) throw new Error('atom');
    i += m[0].length;
    return m[0];
  };
  const head = (n: Node) => (Array.isArray(n) && typeof n[0] === 'string' ? n[0].replace(/:0x[0-9a-f]+$/i, '') : '');
  const value = (n: Node): string | null => {
    if (!Array.isArray(n)) return null;
    const h = head(n);
    if (h === 'number' && typeof n[1] === 'string') {
      const v = n[1].replace(/:0x[0-9a-f]+$/i, '');
      return isNumberLiteral(v) ? v : null;
    }
    if (h === 'string' && typeof n[1] === 'string') return n[1].startsWith('"') ? n[1] : JSON.stringify(n[1]);
    if (h === 'op_matrix') {
      const dim = (k: Node) => (Array.isArray(k) && head(k) === 'unboxed' ? Number(k[1]) : NaN);
      const rows = dim(n[1]), cols = dim(n[2]), list = n[3];
      if (!(rows > 0 && cols > 0) || !Array.isArray(list) || head(list) !== 'list' || list.length - 1 !== rows * cols) return null;
      const items = list.slice(1).map(value);
      if (items.some((v) => v === null)) return null;
      return `[${Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => items[c * rows + r]).join(', ')).join('; ')}]`;
    }
    return null;
  };
  return value(parse());
}

/** A Mathcad 15 shown result: the <result> inside the region's <ml:eval>. */
function savedOfEval(math: El): string | null {
  const ev = math.getElementsByTagNameNS('*', 'eval')[0];
  const res = ev ? kids(ev).find((c) => local(c) === 'result') : undefined;
  return res ? savedExpr(res) : null;
}

/** Embedded objects Mathcad 15 files hold, by their class id. */
const OLE_KINDS: Record<string, string> = {
  '0002CE03-0000-0000-C000-000000000046': 'An equation (Microsoft Equation 3.0)',
  '00020906-0000-0000-C000-000000000046': 'A Word document',
  'F4754C9B-64F5-4B40-8AF4-679732AC0607': 'A Word document',
  '00020830-0000-0000-C000-000000000046': 'An Excel workbook',
  '00020820-0000-0000-C000-000000000046': 'An Excel workbook',
  'D3E34B21-9D75-101A-8C3D-00AA001A1652': 'A Paint picture',
  '64818D11-4F9B-11CF-86EA-00AA00B929E8': 'A PowerPoint slide',
  '64818D10-4F9B-11CF-86EA-00AA00B929E8': 'A PowerPoint presentation',
};

/** An embedded (OLE) object of Mathcad 15, named by what it is when its class is known. */
function oleKind(el: El): string {
  const id = (el.getAttribute('clsid') ?? '').replace(/[{}]/g, '').toUpperCase();
  return `${OLE_KINDS[id] ?? 'An embedded object'} (OLE${el.getAttribute('type') === 'static' ? ', static' : ''})`;
}

/** A Mathcad 15 component, named with what goes in and comes out of it. */
function componentKind(el: El, conv: Converter): string {
  const names = (part: string) => kids(child(el, part) ?? el).filter((c) => local(c) !== 'inputs' && local(c) !== 'outputs').map((c) => {
    try {
      return conv.expr(c).s;
    } catch {
      return '?';
    }
  });
  const ins = names('inputs'), outs = names('outputs');
  const io = [ins.length ? `inputs ${ins.join(', ')}` : '', outs.length ? `outputs ${outs.join(', ')}, not defined here` : ''].filter(Boolean).join('; ');
  return `A component${io ? ` (${io})` : ''}`;
}

/**
 * The data file a Mathcad 15 component reads or writes, from its saved state (an OLE stream):
 * the first name with an extension after the stream's "Contents", as saved (often relative).
 */
function componentFile(item: { data: string; enc: string } | undefined): string | null {
  if (!item?.data) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(item.data), (c) => c.charCodeAt(0));
    if (/gzip/i.test(item.enc)) bytes = gunzipSync(bytes);
  } catch {
    return null;
  }
  // UTF-16 strings, at even or odd offsets: runs of printable code units
  const found: { at: number; s: string }[] = [];
  for (const start of [0, 1]) {
    let cur = '', from = start;
    for (let i = start; i + 1 < bytes.length; i += 2) {
      const c = bytes[i] | (bytes[i + 1] << 8);
      // (a length byte before 0xFF, which starts a saved string, is no character)
      if (((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c < 0xd800)) && (c & 0xff) !== 0xff) cur += String.fromCharCode(c);
      else {
        if (cur.length >= 3) found.push({ at: from, s: cur });
        cur = '';
        from = i + 2;
      }
    }
    if (cur.length >= 3) found.push({ at: from, s: cur });
  }
  const strings = found.sort((a, b) => a.at - b.at).map((f) => f.s);
  const after = strings.indexOf('Contents');
  if (after < 0) return null;
  return strings.slice(after + 1).find((t) => !/^OlePres/.test(t) && /[^\\/:*?"<>|]\.[A-Za-z0-9]{1,6}$/.test(t)) ?? null;
}

function binaryImage(item: { data: string; enc: string } | undefined): string | null {
  if (!item?.data) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(item.data), (c) => c.charCodeAt(0));
    if (/gzip/i.test(item.enc)) bytes = gunzipSync(bytes);
  } catch {
    return null;
  }
  const mime = sniffMime(bytes, '');
  return `data:${mime};base64,${toBase64(bytes)}`;
}

function solveBlock(el: El, conv: Converter, at: { x: number; y: number }): Region {
  const guesses: string[] = [], constraints: string[] = [];
  let solver = '';
  const regs = child(el, 'regions');
  for (const sub of regs ? kids(regs) : []) {
    const cat = sub.getAttribute('solve-block-category') ?? '';
    const math = child(sub, 'math');
    if (!math || !kids(math).length) continue;
    const src = conv.statement(math);
    if (cat === 'guess-value') guesses.push(src);
    else if (cat === 'constraint') constraints.push(src.replace(' == ', ' = '));
    else if (cat === 'solver') solver = src;
  }
  return createRegion('solve', at.x, at.y, { guesses: guesses.join('\n'), constraints: constraints.join('\n'), solver });
}

function picture(el: El, pkg: Package | null, binary: Record<string, { data: string; enc: string }>): string | null {
  const ref = el.getAttribute('item-idref') ?? kids(el).find((c) => c.getAttribute('item-idref'))?.getAttribute('item-idref');
  if (pkg && ref && pkg.rels[ref]) {
    const bytes = findFile(pkg.files, pkg.rels[ref]);
    if (bytes) return `data:${sniffMime(bytes, pkg.rels[ref])};base64,${toBase64(bytes)}`;
  }
  if (ref && binary[ref]) return binaryImage(binary[ref]);
  const inline = kids(el).find((c) => /^(png|jpeg|jpg|gif|bmp)$/i.test(local(c)));
  if (inline) return `data:${sniffMime(new Uint8Array(0), 'x.' + local(inline))};base64,${(inline.textContent ?? '').replace(/\s+/g, '')}`;
  return null;
}

/** A Prime FlowDocument's plain text: its paragraphs as lines. */
function xamlPlain(root: El | null | undefined): string {
  return root ? textFromXaml(root).map((p) => p.runs.map((r) => r.text).join('')).join('\n') : '';
}

/** Mathcad 15's header and footer (<pageModel>): three RTF texts each, and an {image} as the logo. */
function mc15Page(pageModel: El | undefined, binary: Record<string, { data: string; enc: string }>): { header?: PageBand; footer?: PageBand; logo?: string } {
  const out: { header?: PageBand; footer?: PageBand; logo?: string } = {};
  for (const part of ['header', 'footer'] as const) {
    const el = pageModel ? child(pageModel, part) : undefined;
    if (!el) continue;
    const band: PageBand = {};
    for (const slot of ['left', 'center', 'right'] as const) {
      const s = child(el, slot);
      if (!s) continue;
      const rtf = Array.from({ length: s.childNodes.length }, (_, i) => s.childNodes[i]).filter((n) => n.nodeType === 3 || n.nodeType === 4).map((n) => n.nodeValue ?? '').join('');
      const text = mc15Fields(mc15Text(rtf));
      if (text) band[slot] = text;
      const img = child(s, 'image')?.getAttribute('item-idref');
      if (img && !out.logo) out.logo = binaryImage(binary[img]) ?? undefined;
    }
    if (band.left || band.center || band.right) out[part] = band;
  }
  return out;
}

/** Prime's header and footer (mathcad/header.xml, footer.xml): their text regions and fields by where they sit. */
function primePage(pkg: Package, pageWidth: number, binary: Record<string, { data: string; enc: string }>, warnings: string[]): { header?: PageBand; footer?: PageBand; logo?: string } {
  const out: { header?: PageBand; footer?: PageBand; logo?: string } = {};
  for (const part of ['header', 'footer'] as const) {
    const bytes = findFile(pkg.files, `mathcad/${part}.xml`);
    if (!bytes) continue;
    const root = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(bytes).replace(/^\uFEFF/, ''), 'text/xml').documentElement;
    const regions = root ? child(root, 'regions') : undefined;
    if (!regions) continue;
    const rels = readRels(pkg.files, `${part}.xml`);
    const pieces: BandPiece[] = [];
    for (const r of kids(regions).filter((c) => local(c) === 'region')) {
      const body = kids(r)[0];
      if (!body) continue;
      const kind = local(body);
      let text = '';
      let align: string | undefined;
      if (kind === 'text') {
        const idref = body.getAttribute('item-idref');
        const flow = child(body, 'FlowDocument');
        align = flow?.getAttribute('TextAlignment') ?? undefined;
        const xaml = idref && rels[idref] ? findFile(pkg.files, rels[idref]) : undefined;
        if (xaml) {
          const inner = unzipSync(xaml);
          const docKey = Object.keys(inner).find((k) => /document\.xaml$/i.test(k));
          if (docKey) text = xamlPlain(new DOMParser({ onError: () => {} }).parseFromString(strFromU8(inner[docKey]), 'text/xml').documentElement as unknown as El);
        } else text = xamlPlain(flow);
      } else if (kind === 'fieldText') {
        const field = kids(body).find((c) => local(c) !== 'text');
        align = child(body, 'text') && kids(child(body, 'text')!)[0]?.getAttribute('TextAlignment') || undefined;
        text = field ? primeField(local(field), field.getAttribute('template')) : xamlPlain(kids(child(body, 'text') ?? body)[0]);
        if (field && !text) warnings.push(`The page ${part} has a ${local(field)} field, which is not imported`);
      } else if (kind === 'picture') {
        if (!out.logo) out.logo = picture(body, { ...pkg, rels }, binary) ?? undefined;
        continue;
      } else {
        warnings.push(`The page ${part} has a ${kind === 'excelComponent' ? 'spreadsheet (Excel component)' : kind} region, which is not imported`);
        continue;
      }
      pieces.push({ text, left: Number(r.getAttribute('left') ?? 0), top: Number(r.getAttribute('top') ?? 0), width: Number(r.getAttribute('width') ?? r.getAttribute('actualWidth') ?? 0), align });
    }
    const band = bandOf(pieces, pageWidth);
    if (band) out[part] = band;
  }
  return out;
}

function plot(el: El, conv: Converter, at: { x: number; y: number }): Region {
  const find = (n: El, name: string): El | undefined => {
    for (const c of kids(n)) {
      if (local(c) === name) return c;
      const d = find(c, name);
      if (d) return d;
    }
    return undefined;
  };
  const xy = find(el, 'xyPlot');
  if (!xy) {
    const grid = find(el, 'contourPlot') ?? find(el, 'plot3D');
    if (grid) {
      const pe = find(grid, 'plotEquation');
      const m = pe ? kids(pe).find((c) => local(c) === 'math') : undefined;
      if (!m) throw new Unsupported('a 3-D plot without an equation');
      return createRegion('plot', at.x, at.y, { plotType: local(grid) === 'contourPlot' ? 'contour' : 'surface', z: conv.statement(m), traces: [] });
    }
    throw new Unsupported('this plot type');
  }
  const eqs = (axis: string) => {
    const ax = find(xy, axis);
    const pes = ax ? (find(ax, 'plotEquations') ? kids(find(ax, 'plotEquations')!) : []) : [];
    return pes.filter((p) => local(p) === 'plotEquation').map((p) => {
      const maths = kids(p).filter((c) => local(c) === 'math');
      const expr = maths[0] ? conv.statement(maths[0]) : '';
      let unit = '';
      if (maths[1] && kids(maths[1])[0] && !isPlaceholder(kids(maths[1])[0])) unit = conv.unit(kids(maths[1])[0]);
      return { expr, unit };
    });
  };
  const xs = eqs('xAxis'), ys = eqs('yAxis');
  if (!xs.length || !ys.length) throw new Unsupported('a plot without axis expressions');
  const traces: PlotTrace[] = ys.map((y, i) => ({ y: y.expr, style: 'line', ...(xs[i] && xs[i].expr !== xs[0].expr ? { xExpr: xs[i].expr } : {}) }));
  const limits = (axis: string): [string, string] => {
    const ax = find(xy, axis);
    const dom = ax ? find(ax, 'xyDomain') : undefined;
    const v = (name: string) => {
      const e = dom ? find(dom, name) : undefined;
      const c = e ? kids(e)[0] : undefined;
      return c && !isPlaceholder(c) ? conv.expr(c).s : '';
    };
    return [v('startValue'), v('endValue')];
  };
  const [xmin, xmax] = limits('xAxis');
  const [ymin, ymax] = limits('yAxis');
  return createRegion('plot', at.x, at.y, { xExpr: xs[0].expr, traces, xUnit: xs[0].unit, yUnit: ys[0].unit, xmin, xmax, ymin, ymax });
}
