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
  type Region, type Worksheet, type PlotTrace,
} from '../model/types';

export interface ImportResult {
  ws: Worksheet;
  warnings: string[];
  format: 'Mathcad Prime (.mcdx)' | 'Mathcad 11–15 (.xmcd)';
}

type El = XElement;

class Unsupported extends Error {}

const local = (el: XNode): string => (el as El).localName || el.nodeName.replace(/^.*:/, '');
const kids = (el: XNode): El[] => {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as El);
  return out;
};
const child = (el: XNode, name: string): El | undefined => kids(el).find((c) => local(c) === name);
const isPlaceholder = (el: El | undefined) => !el || local(el) === 'placeholder';

// ------------------------------------------------------------ names, units, constants

const RESERVED = new Set(['in', 'to', 'and', 'or', 'not', 'xor', 'mod', 'end', 'if', 'for', 'while', 'return', 'else', 'break', 'continue']);

const UNIT_MAP: Record<string, string> = {
  '°': 'deg', '°C': 'degC', '°F': 'degF', 'Δ°C': 'K', 'Δ°F': '(5/9 K)', Ω: 'ohm', kΩ: 'kohm', MΩ: 'Mohm',
  yr: 'year', Å: 'angstrom', lbm: 'lb', lb: 'lb', ozm: 'oz', ton: 'ton', tonne: 'tonne', mtonne: 'tonne',
  psf: '(lbf/ft^2)', kgf: 'kgf', '%': '%', rev: 'rev', rpm: 'rpm', L: 'L', liter: 'L', galUK: 'galUK',
};

const CONSTANT_MAP: Record<string, string> = {
  π: 'π', e: 'e', '∞': '∞', g: 'g', c: 'speedOfLight', G: 'gravitationConstant', h: 'planckConstant',
  k: 'boltzmann', NA: 'avogadro', R: 'gasConstant', ε0: 'vacuumPermittivity', μ0: 'vacuumPermeability',
  me: 'electronMass', mp: 'protonMass', q: 'elementaryCharge', σ: 'stefanBoltzmann',
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

function sanitize(name: string): string {
  let s = [...name].map((ch) => (/[\p{L}\p{N}_']/u.test(ch) ? ch : '_')).join('').replace(/_+/g, '_').replace(/^_+(?=.)/, '');
  if (!s) s = '_';
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s += '_';
  return s;
}

function unitName(name: string): string {
  if (UNIT_MAP[name]) return UNIT_MAP[name];
  // μ / µ prefixes become "u" (μm → um)
  return name.replace(/^[μµ]/, 'u');
}

// ------------------------------------------------------------ expressions

const P = { ATOM: 100, POST: 90, POW: 80, NEG: 70, MUL: 60, ADD: 50, CMP: 40, NOT: 35, AND: 30, OR: 20, RANGE: 5 };

interface Ex {
  s: string;
  p: number;
}

const BINOPS: Record<string, { op: string; p: number }> = {
  plus: { op: ' + ', p: P.ADD }, minus: { op: ' - ', p: P.ADD }, mult: { op: '*', p: P.MUL }, div: { op: '/', p: P.MUL },
  pow: { op: '^', p: P.POW }, lessThan: { op: ' < ', p: P.CMP }, greaterThan: { op: ' > ', p: P.CMP },
  lessOrEqual: { op: ' ≤ ', p: P.CMP }, greaterOrEqual: { op: ' ≥ ', p: P.CMP }, equal: { op: ' == ', p: P.CMP },
  notEqual: { op: ' ≠ ', p: P.CMP }, and: { op: ' ∧ ', p: P.AND }, or: { op: ' ∨ ', p: P.OR }, xor: { op: ' ⊕ ', p: P.OR },
};

const VECTORIZED: Record<string, string> = { mult: ' .* ', div: ' ./ ', pow: '.^' };

class Converter {
  warnings: string[] = [];
  private vectorize = 0;

  wrap(e: Ex, min: number): string {
    return e.p < min ? `(${e.s})` : e.s;
  }

  name(el: El): string {
    const raw = rawName(el);
    const label = el.getAttribute('labels') ?? '';
    if (label === 'UNIT' || raw === '%') return unitName(raw);
    if (label === 'CONSTANT' && CONSTANT_MAP[raw]) return CONSTANT_MAP[raw];
    return sanitize(raw);
  }

  /** Arguments of a call, flattening a single <sequence>. */
  args(rest: El[]): string[] {
    const list = rest.length === 1 && local(rest[0]) === 'sequence' ? kids(rest[0]) : rest;
    return list.map((a) => this.expr(a).s);
  }

  lambda(el: El): { vars: string[]; body: string } {
    const bv = child(el, 'boundVars');
    const vars = bv ? kids(bv).filter((c) => local(c) === 'id').map((c) => this.name(c)) : [];
    const body = kids(el).find((c) => local(c) !== 'boundVars');
    return { vars, body: body ? this.expr(body).s : '0' };
  }

  bounds(rest: El[]): [string, string] | null {
    const lo = rest.find((c) => local(c) === 'lowerBound');
    const hi = rest.find((c) => local(c) === 'upperBound');
    if (lo || hi) {
      if (isPlaceholder(kids(lo!)[0]) && isPlaceholder(kids(hi!)[0])) return null;
      return [this.expr(kids(lo!)[0]).s, this.expr(kids(hi!)[0]).s];
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
    if (BINOPS[h] && rest.length === 2) {
      const { op, p } = BINOPS[h];
      const vop = this.vectorize && VECTORIZED[h] ? VECTORIZED[h] : op;
      const [a, b] = [e(0), e(1)];
      if (h === 'pow') return { s: `${this.wrap(a, P.POW + 1)}${vop}${this.wrap(b, P.POW)}`, p };
      // number × unit reads naturally as "5 m"
      if (h === 'mult' && /^-?[\d.]+(e[+-]?\d+)?$/i.test(a.s) && local(rest[1]) === 'id' && rest[1].getAttribute('labels') === 'UNIT') {
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
        return { s: /^-?[\d.]+(e[+-]?\d+)?$/i.test(v.s) ? `${v.s} ${unit}` : `${this.wrap(v, P.MUL)}*${unit}`, p: P.MUL };
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
      case 'vectorize': {
        this.vectorize++;
        try {
          return e(0);
        } finally {
          this.vectorize--;
        }
      }
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
    if (raw === 'Γ') fn = 'gamma';
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
      case 'matrix':
        return `[${kids(el).filter((c) => local(c) === 'id').map((c) => this.name(c)).join('; ')}]`;
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
    return this.expr(u).s;
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
        return `${lhs} ${op} ${v.s} =${this.unitOverride(valEl) ? ' ' + this.unitOverride(valEl) : ''}`;
      }
      if (/Control$/.test(local(valEl))) throw new Unsupported('an input control');
      return `${lhs} ${op} ${this.expr(valEl).s}`;
    }
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
          kw = [name, ...parts.slice(1).map((p) => this.expr(p).s)].join(', ');
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

function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function mimeOf(name: string): string {
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

// ------------------------------------------------------------ main

const PX = 1; // Mathcad positions are device-independent pixels (1/96 inch), like ours

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

  // binary items of Mathcad 15 (pictures)
  const binary: Record<string, { data: string; enc: string }> = {};
  const bc = doc.getElementsByTagNameNS('*', 'binaryContent')[0];
  if (bc) for (const it of kids(bc)) binary[it.getAttribute('item-id') ?? ''] = { data: (it.textContent ?? '').replace(/\s+/g, ''), enc: it.getAttribute('content-encoding') ?? '' };

  const regionsEl = kids(root).find((c) => local(c) === 'regions') ?? doc.getElementsByTagNameNS('*', 'regions')[0];
  if (!regionsEl) throw new Error('The worksheet has no regions');

  type Placed = { region: El; x: number; y: number };
  const flatten = (container: El, dx: number, dy: number): Placed[] => {
    const out: Placed[] = [];
    for (const r of kids(container).filter((c) => local(c) === 'region')) {
      const x = dx + Number(r.getAttribute('left') ?? 0) * PX;
      const y = dy + Number(r.getAttribute('top') ?? 0) * PX;
      const area = child(r, 'Area') ?? child(r, 'area');
      const inner = area ? child(area, 'regions') : undefined;
      if (inner) out.push(...flatten(inner, x, y));
      else out.push({ region: r, x, y });
    }
    return out;
  };
  const placed = flatten(regionsEl, 0, 0).sort((a, b) => a.y - b.y || a.x - b.x);

  const regions: Region[] = [];
  const fail = (what: string, e: unknown, at: Placed) => {
    const msg = e instanceof Unsupported ? `uses ${e.message}, which mathstudii cannot import yet` : (e as Error).message;
    warnings.push(`${what} at ${Math.round(at.y)} px: ${msg}`);
    regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Not imported (${what}):* ${msg}`, width: 300 }));
  };

  // Mathcad 15 "Given … Find" solve blocks span several free regions
  let solve: { guesses: string[]; constraints: string[]; at: Placed } | null = null;

  for (const at of placed) {
    const r = at.region;
    const body = kids(r)[0];
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
        const src = conv.statement(body);
        if (solve) {
          if (/\b(find|minerr|minimize|maximize)\(/.test(src)) {
            regions.push(createRegion('solve', solve.at.x, solve.at.y, { guesses: solve.guesses.join('\n'), constraints: solve.constraints.join('\n'), solver: src }));
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
        regions.push(createRegion('math', at.x, at.y, { source: src, disabled: body.getAttribute('disable-calc') === 'true' || undefined }));
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
        regions.push(plot(body, conv, at));
      } else if (kind === 'spec-table') {
        let y = at.y;
        for (const m of kids(body).filter((c) => local(c) === 'math')) {
          regions.push(createRegion('math', at.x, y, { source: conv.statement(m) }));
          y += 40;
        }
      } else {
        warnings.push(`Skipped a ${kind} region at ${Math.round(at.y)} px`);
      }
    } catch (e) {
      fail(kind === 'math' ? 'math' : kind, e, at);
    }
  }
  if (solve) warnings.push('A "Given" block has no Find/Minerr call; its constraints were dropped');

  // keep everything on the page
  const maxRight = Math.max(...regions.map((q) => q.x + ('width' in q ? (q as { width: number }).width : 200)), 0);
  const limit = PAGE_WIDTH - PAGE_MARGIN / 2;
  const sx = maxRight > limit ? limit / maxRight : 1;
  for (const q of regions) {
    q.x = Math.max(8, Math.round(q.x * sx));
    q.y = Math.max(8, Math.round(q.y));
  }
  ws.regions = regions;
  return { ws, warnings, format: pkg ? 'Mathcad Prime (.mcdx)' : 'Mathcad 11–15 (.xmcd)' };
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
    if (bytes) return `data:${mimeOf(pkg.rels[ref])};base64,${toBase64(bytes)}`;
  }
  if (ref && binary[ref]) {
    const b = binary[ref];
    let bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
    if (/gzip/i.test(b.enc)) bytes = gunzipSync(bytes);
    return `data:image/png;base64,${toBase64(bytes)}`;
  }
  const inline = kids(el).find((c) => /^(png|jpeg|jpg|gif|bmp)$/i.test(local(c)));
  if (inline) return `data:${mimeOf('x.' + local(inline))};base64,${(inline.textContent ?? '').replace(/\s+/g, '')}`;
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
      if (maths[1] && kids(maths[1])[0] && !isPlaceholder(kids(maths[1])[0])) unit = conv.expr(kids(maths[1])[0]).s;
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
