// Import Mathcad worksheets:
//   .mcdx  Mathcad Prime (a zip/OPC package; math in mathcad/worksheet.xml)
//   .xmcd  Mathcad 11–15 (plain XML)
// Both store math as an "ml" expression tree (namespaces math50 / math30). The
// element vocabulary below follows the structure of real Prime files as
// documented by the MIT-licensed mcad2py project, plus the Mathcad 15 variants.
import { unzipSync, gunzipSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import {
  createRegion, emptyWorksheet, PAGE_MARGIN, PAGE_WIDTH,
  type Region, type PlotTrace,
} from '../model/types';
import { fitToPage, isNumberLiteral, P, sanitize, toBase64, Unsupported, unitName, type Ex, type ImportResult, type SavedResult } from './common';
import { isUnitName } from '../engine/math';

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

// ------------------------------------------------------------ expressions

const BINOPS: Record<string, { op: string; p: number }> = {
  plus: { op: ' + ', p: P.ADD }, minus: { op: ' - ', p: P.ADD }, mult: { op: '*', p: P.MUL }, div: { op: '/', p: P.MUL },
  pow: { op: '^', p: P.POW }, lessThan: { op: ' < ', p: P.CMP }, greaterThan: { op: ' > ', p: P.CMP },
  lessOrEqual: { op: ' ≤ ', p: P.CMP }, greaterOrEqual: { op: ' ≥ ', p: P.CMP }, equal: { op: ' == ', p: P.CMP },
  notEqual: { op: ' ≠ ', p: P.CMP }, and: { op: ' ∧ ', p: P.AND }, or: { op: ' ∨ ', p: P.OR }, xor: { op: ' ⊕ ', p: P.OR },
};

class Converter {
  warnings: string[] = [];
  /** Names the worksheet defines anywhere (Mathcad 15 does not label units: an undefined unit name is one). */
  defined = new Set<string>();
  /** Names defined at the top level of the worksheet (variables a unit of the same name would clash with). */
  variables = new Set<string>();
  /** The numeric factor dropped from the last display unit (the saved result is a multiple of it). */
  scale = '';
  /** Inside a display unit (unitOverride, a plot axis unit), where unlabelled names are units. */
  private unitSlot = 0;

  wrap(e: Ex, min: number): string {
    return e.p < min ? `(${e.s})` : e.s;
  }

  name(el: El): string {
    const raw = rawName(el);
    const label = el.getAttribute('labels') ?? '';
    if (label === 'UNIT' || raw === '%') {
      const u = unitName(raw);
      // Prime tells a unit from a variable of the same name by its label; here the unit is written out
      return this.variables.has(raw) && !this.unitSlot && !/[()*/^ ]/.test(u) ? `unit(1, "${u}")` : u;
    }
    if (label === 'CONSTANT' && CONSTANT_MAP[raw]) return CONSTANT_MAP[raw];
    // unlabelled (Mathcad 15) or auto-labelled (*, sheets converted from 15) names that are units
    if (label === '' || label === '*') {
      const u = unitName(raw);
      if (!this.defined.has(raw) && (this.unitSlot || u !== raw) && isUnitName(u.replace(/^\((.*)\)$/, '$1').split(/[*/^ ]/)[0])) return u;
    }
    return sanitize(raw);
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
    const vars = bv ? kids(bv).filter((c) => local(c) === 'id').map((c) => sanitize(rawName(c))) : [];
    const body = kids(el).find((c) => local(c) !== 'boundVars');
    return { vars, body: body ? this.expr(body).s : '0' };
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
    // Mathcad 15 writes the solve block functions as operators: <ml:Find/>, <ml:Minerr/> …
    if (/^(find|minerr|minimize|maximize|odesolve)$/i.test(h)) return { s: `${h.toLowerCase()}(${this.args(rest).join(', ')})`, p: P.ATOM };
    if (BINOPS[h] && rest.length === 2) {
      const { op, p } = BINOPS[h];
      const vop = op;
      const [a, b] = [e(0), e(1)];
      if (h === 'pow') return { s: `${this.wrap(a, P.POW + 1)}${vop}${isNumberLiteral(b.s) ? b.s : this.wrap(b, P.POW)}`, p };
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
      case 'absval': return { s: `abs(${e(0).s})`, p: P.ATOM };
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

  call(head: El, rest: El[]): Ex {
    const raw = rawName(head);
    let fn = sanitize(raw);
    const args = this.args(rest);
    // y′′(t), y′(0): prime notation of a function (odesolve), when y′′ is not a name of its own
    const primed = /^(.*?)(['′]+)$/.exec(raw);
    if (primed && primed[1] && !this.defined.has(raw)) return { s: `${sanitize(primed[1])}${"'".repeat(primed[2].length)}(${args.join(', ')})`, p: P.ATOM };
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
    throw new Unsupported('a multi-line program inside an expression');
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
      return local(inner) === 'program' ? this.inlineProgram(inner) : this.expr(inner).s;
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
        for (let k = i; k < j; k++) {
          const [c, v] = kids(items[k]);
          out.push(`${indent}${k > i && hasOtherwise ? 'else if' : 'if'} ${this.expr(c).s}`, ...this.stmt(v, indent + '  '));
        }
        if (hasOtherwise) {
          out.push(`${indent}else`, ...this.stmt(kids(items[j])[0], indent + '  '));
          j++;
        }
        i = j - 1;
        continue;
      }
      out.push(...this.stmt(it, indent));
    }
    return out;
  }

  stmt(el: El, indent: string): string[] {
    const t = local(el);
    const ks = kids(el);
    switch (t) {
      case 'program':
        return this.programLines(el, indent);
      case 'localDefine':
        return [`${indent}${this.target(ks[0])} ← ${this.expr(ks[1]).s}`];
      case 'for': {
        const iter = this.expr(ks[1]).s;
        return [`${indent}for ${this.name(ks[0])} ∈ ${iter}`, ...this.stmt(ks[2], indent + '  ')];
      }
      case 'while':
        return [`${indent}while ${this.expr(ks[0]).s}`, ...this.stmt(ks[1], indent + '  ')];
      case 'if': {
        const out: string[] = [];
        let first = true;
        const walk = (n: El) => {
          let test: string | null = null;
          for (const c of kids(n)) {
            const ct = local(c);
            if (ct === 'test') test = this.expr(kids(c)[0]).s;
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
        return [`${indent}if ${this.expr(ks[0]).s}`, ...this.stmt(ks[1], indent + '  ')];
      case 'otherwise':
        return [`${indent}else`, ...this.stmt(ks[0], indent + '  ')];
      case 'return':
        return [`${indent}return ${ks[0] ? this.expr(ks[0]).s : '0'}`];
      case 'break':
        return [`${indent}break`];
      case 'continue':
        return [`${indent}continue`];
      case 'tryCatch':
      case 'onError':
        return [`${indent}try`, ...this.stmt(ks[0], indent + '  '), `${indent}on error`, ...this.stmt(ks[1], indent + '  ')];
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
    if (local(el) !== 'ComboBoxControl') throw new Unsupported(`an input control (${local(el).replace(/Control$/, '')})`);
    const rows = Number(el.getAttribute('rows') ?? 0), cols = Number(el.getAttribute('cols') ?? 0);
    const sel = Number(el.getAttribute('SelectedRow') ?? 0);
    const names = kids(child(el, 'ComboBoxRowNames') ?? el).filter((c) => local(c) === 'rowName').map((c) => (c.textContent ?? '').trim());
    const values = kids(child(el, 'ComboBoxValues') ?? el);
    const scales = kids(child(el, 'ComboBoxScaleFactors') ?? el);
    const picked = names[sel] ?? String(sel);
    this.warnings.push(`The input control for ${lhs} (a list of ${names.length || rows} choices) is imported as its selected value, “${picked}”`);
    // without a table of values the choice itself is the value (a "Yes"/"No" flag)
    if (!values.length) return JSON.stringify(picked);
    const at = (j: number) => {
      const v = values[sel * cols + j];
      if (!v || isPlaceholder(v)) return '0';
      const x = this.expr(v);
      const sc = scales[j] && !isPlaceholder(scales[j]) ? this.unit(scales[j]) : '';
      return sc ? `${this.wrap(x, P.MUL)} ${sc}` : x.s;
    };
    const vals = Array.from({ length: cols }, (_, j) => at(j));
    return vals.length === 1 ? vals[0] : `[${vals.join('; ')}]`;
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
      if (local(valEl) === 'program') return `${lhs} ${op}\n${this.programLines(valEl, '  ').join('\n')}`;
      if (local(valEl) === 'eval') {
        const v = this.expr(kids(valEl)[0]);
        const unit = this.unitOverride(valEl);
        return `${lhs} ${op} ${v.s} =${unit ? ' ' + unit : ''}`;
      }
      if (/Control$/.test(local(valEl))) return `${lhs} ${op} ${this.control(lhs, valEl)}`;
      return `${lhs} ${op} ${this.expr(valEl).s}`;
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

function textFromXmcd(el: El, conv: Converter): string {
  const paras: string[] = [];
  const inline = (n: XNode): string => {
    let s = '';
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) s += c.nodeValue ?? '';
      else if (c.nodeType === 1) {
        const t = local(c);
        const inner = inline(c);
        if (t === 'b' || t === 'strong') s += inner.trim() ? `**${inner}**` : inner;
        else if (t === 'i' || t === 'em') s += inner.trim() ? `*${inner}*` : inner;
        else if (t === 'math') {
          try {
            s += `\`${conv.statement(c as El)}\``;
          } catch {
            s += '`(math)`';
          }
        } else if (t === 'br') s += '\n';
        else s += inner;
      }
    }
    return s;
  };
  const ps = kids(el).filter((c) => local(c) === 'p');
  for (const p of ps.length ? ps : [el]) {
    const style = p.getAttribute('style') ?? '';
    let line = inline(p).replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;
    if (/heading\s*1|title/i.test(style)) line = `# ${line}`;
    else if (/heading\s*2/i.test(style)) line = `## ${line}`;
    else if (/heading/i.test(style)) line = `### ${line}`;
    paras.push(line);
  }
  return paras.join('\n\n');
}

function textFromXaml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const paras: string[] = [];
  const all = doc.getElementsByTagNameNS('*', 'Paragraph');
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    let s = '';
    const walk = (n: XNode, bold: boolean, italic: boolean) => {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) {
          const t = c.nodeValue ?? '';
          s += bold && t.trim() ? `**${t}**` : italic && t.trim() ? `*${t}*` : t;
        } else if (c.nodeType === 1) {
          const e = c as El;
          const t = local(e);
          walk(e, bold || t === 'Bold' || e.getAttribute('FontWeight') === 'Bold', italic || t === 'Italic' || e.getAttribute('FontStyle') === 'Italic');
        }
      }
    };
    walk(p, p.getAttribute('FontWeight') === 'Bold', false);
    s = s.replace(/\*\*\*\*/g, '').trim();
    if (!s) continue;
    const size = Number(p.getAttribute('FontSize') ?? 0);
    if (size >= 20) s = `# ${s.replace(/\*\*/g, '')}`;
    else if (size >= 16) s = `## ${s.replace(/\*\*/g, '')}`;
    paras.push(s);
  }
  return paras.join('\n\n');
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

function readMcdx(data: Uint8Array): Package {
  const files = unzipSync(data);
  const ws = Object.keys(files).find((k) => k.toLowerCase() === 'mathcad/worksheet.xml');
  if (!ws) throw new Error('This zip file is not a Mathcad Prime worksheet (no mathcad/worksheet.xml)');
  const rels: Record<string, string> = {};
  const relsKey = Object.keys(files).find((k) => k.toLowerCase() === 'mathcad/_rels/worksheet.xml.rels');
  if (relsKey) {
    const doc = new DOMParser().parseFromString(strFromU8(files[relsKey]), 'text/xml');
    const list = doc.getElementsByTagNameNS('*', 'Relationship');
    for (let i = 0; i < list.length; i++) {
      const id = list[i].getAttribute('Id');
      let target = list[i].getAttribute('Target') ?? '';
      if (!target.startsWith('/')) target = 'mathcad/' + target;
      if (id) rels[id] = target.replace(/^\//, '');
    }
  }
  return { worksheet: strFromU8(files[ws]), rels, files };
}

// ------------------------------------------------------------ saved results

/** Mathcad's unit names (meter, kilonewton …) are mathjs names too; anything else is not compared. */
function unitMonomial(el: El): string | null {
  const parts: string[] = [];
  for (const r of kids(el).filter((c) => local(c) === 'unitReference')) {
    const name = r.getAttribute('unit') ?? '';
    if (!isUnitName(name)) return null;
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
    const [re, im] = kids(el).map(savedExpr);
    return re !== null && im !== null ? `(${re} + ${im})` : null;
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

/** Every name the worksheet defines: definitions, function parameters, program locals, loop counters. */
function definedNames(root: El, out: Set<string>) {
  const visit = (el: El) => {
    const t = local(el);
    const target = t === 'define' || t === 'globalDefine' || t === 'localDefine' || t === 'for' ? kids(el)[0] : undefined;
    const add = (n: El | undefined) => {
      if (!n) return;
      const k = local(n);
      if (k === 'id') out.add(rawName(n));
      else if (k === 'function') kids(n).forEach(add);
      else if (k === 'boundVars' || k === 'matrix') kids(n).forEach(add);
      else if (k === 'apply' && local(kids(n)[0] ?? n) === 'indexer') add(kids(n)[1]);
    };
    add(target);
    if (t === 'boundVars') kids(el).forEach(add);
    kids(el).forEach(visit);
  };
  visit(root);
}

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
  definedNames(root, conv.defined);
  for (const d of doc.getElementsByTagNameNS('*', 'define')) {
    const t = kids(d)[0];
    if (t && local(t) === 'id') conv.variables.add(rawName(t));
  }

  // ORIGIN: Prime's calculation settings, Mathcad 15's <builtInVariables>
  const settingsXml = pkg ? findFile(pkg.files, 'mathcad/settings/calculation.xml') : undefined;
  const settingsDoc = settingsXml ? new DOMParser({ onError: () => {} }).parseFromString(strFromU8(settingsXml).replace(/^﻿/, ''), 'text/xml') : doc;
  const biv = settingsDoc.getElementsByTagNameNS('*', 'builtInVariables')[0];
  if (biv?.getAttribute('array-origin') === '1') ws.settings.origin = 1;
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
  type Placed = { region: El; x: number; y: number; order: number };
  const flatten = (container: El, dx: number, dy: number): Placed[] => {
    const out: Placed[] = [];
    for (const r of kids(container).filter((c) => local(c) === 'region')) {
      const x = dx + Number(r.getAttribute('left') ?? 0) * PX;
      const y = dy + Number(r.getAttribute('top') ?? 0) * PX;
      const alignY = r.getAttribute('align-y');
      const order = !pkg && alignY !== null ? dy + Number(alignY) * PX : y;
      const area = child(r, 'Area') ?? child(r, 'area');
      // Prime: <Area><regions>…; Mathcad 15: a collapsed <area> holds its regions itself
      const inner = area ? child(area, 'regions') ?? (kids(area).some((c) => local(c) === 'region') ? area : undefined) : undefined;
      if (inner) out.push(...flatten(inner, x, y));
      else if (!area) out.push({ region: r, x, y, order });
    }
    return out;
  };
  const placed = flatten(regionsEl, 0, 0).sort((a, b) => a.order - b.order || a.x - b.x);

  const regions: Region[] = [];
  let pageBreaks = 0;
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
  // math regions are placed at their baseline less a line's ascent, so that our reading order
  // (by the top of a region) is Mathcad's
  const mathY = (at: Placed) => (at.order !== at.y ? at.order - 12 : at.y);

  // Mathcad 15 "Given … Find" solve blocks span several free regions
  let solve: { guesses: string[]; constraints: string[]; at: Placed } | null = null;

  for (const at of placed) {
    const r = at.region;
    const body = kids(r).find((c) => local(c) !== 'rendering');
    if (!body) continue;
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
        const reg = createRegion('math', at.x, mathY(at), { source: src, disabled: body.getAttribute('disable-calc') === 'true' || undefined });
        regions.push(reg);
        const ref = body.getAttribute('resultRef');
        const value = ref !== null ? cached.get(ref) : savedOfEval(body);
        if (value !== undefined && value !== null && / =( |$)/.test(src.split('\n')[0])) {
          saved.push({ regionId: reg.id, expr: conv.scale ? `(${value})*(${conv.scale})` : value });
        }
      } else if (kind === 'text') {
        let md = '';
        const idref = body.getAttribute('item-idref');
        if (pkg && idref && pkg.rels[idref]) {
          const xaml = findFile(pkg.files, pkg.rels[idref]);
          if (xaml) {
            const inner = unzipSync(xaml);
            const docKey = Object.keys(inner).find((k) => /document\.xaml$/i.test(k));
            if (docKey) md = textFromXaml(strFromU8(inner[docKey]));
          }
        } else md = textFromXmcd(body, conv);
        if (md.trim()) regions.push(createRegion('text', at.x, at.y, { markdown: md, width: Math.max(160, Number(r.getAttribute('width') ?? 0) * PX || 360) }));
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
          y += 40;
        }
      } else if (kind === 'pageBreak') {
        pageBreaks++;
      } else if (kind === 'reference') {
        // Mathcad 15 "Reference": the definitions of another worksheet, read when this one calculates
        const href = body.getElementsByTagNameNS('*', 'originRef')[0]?.getAttribute('href') ?? '';
        const file = href.split(/[\\/]/).pop() || 'another worksheet';
        warnings.push(`A reference to ${file} at ${Math.round(at.y)} px: what that worksheet defines is not imported (import it too and copy the definitions here)`);
        regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Reference to “${file}”: its definitions are not imported.*`, width: 300 }));
      } else if (!rendering(at, kind === 'ole' ? 'Embedded object' : kind === 'component' ? 'Component' : `A ${kind} region`)) {
        warnings.push(`Skipped a ${kind} region at ${Math.round(at.y)} px`);
      } else {
        warnings.push(`A ${kind} region at ${Math.round(at.y)} px is shown as Mathcad's picture of it`);
      }
    } catch (e) {
      fail(kind === 'math' ? 'math' : kind, e, at);
    }
  }
  if (solve) warnings.push('A "Given" block has no Find/Minerr call; its constraints were dropped');
  void pageBreaks; // page breaks follow from our own page layout

  const moved = fitToPage(regions, pageWidth);
  if (moved) warnings.push(`${moved} region${moved > 1 ? 's' : ''} to the right of Mathcad's page ${moved > 1 ? 'were' : 'was'} moved onto the page`);
  ws.regions = regions;
  return { ws, warnings, format: pkg ? 'Mathcad Prime (.mcdx)' : 'Mathcad 11–15 (.xmcd)', saved };
}

/** A Mathcad 15 shown result: the <result> inside the region's <ml:eval>. */
function savedOfEval(math: El): string | null {
  const ev = math.getElementsByTagNameNS('*', 'eval')[0];
  const res = ev ? kids(ev).find((c) => local(c) === 'result') : undefined;
  return res ? savedExpr(res) : null;
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
