// Import SMath Studio worksheets:
//   .sm   plain XML (namespace http://smath.info/schemas/worksheet/1.0)
//   .smz  the same XML, compressed
// Math is stored as a postfix (RPN) token list: <e type="operand|operator|function|bracket">
// with an "args" count on operators and functions. Matrices, programs and plot lists put
// their row and column counts in the last two arguments. The structure follows real files
// saved by SMath Studio 0.96–0.99 (the program's bundled examples).
import { unzipSync, gunzipSync, decompressSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { createRegion, emptyWorksheet, PAGE_MARGIN, PAGE_WIDTH, type Region, type PlotTrace } from '../model/types';
import { fitToPage, isNumberLiteral, P, sanitize, Unsupported, unitName, wrap, type Ex, type ImportResult, type SavedResult } from './common';

type El = XElement;

const local = (el: XNode): string => (el as El).localName || el.nodeName.replace(/^.*:/, '');
const kids = (el: XNode): El[] => {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as El);
  return out;
};
const child = (el: XNode, name: string): El | undefined => kids(el).find((c) => local(c) === name);

// ------------------------------------------------------------ tokens → tree

interface Tok {
  type: 'operand' | 'operator' | 'function' | 'bracket';
  text: string;
  style?: string;
  args: Tok[];
}

/** An empty or "..." slot in a display-only formula. */
class Placeholder extends Error {}

function parseRpn(container: El | undefined): Tok[] {
  const st: Tok[] = [];
  if (!container) return st;
  for (const e of kids(container)) {
    if (local(e) !== 'e') continue;
    const type = (e.getAttribute('type') ?? 'operand') as Tok['type'];
    const raw = e.textContent ?? '';
    if (type === 'operand') {
      const style = e.getAttribute('style') || undefined;
      st.push({ type, text: style === 'string' ? raw : raw.trim(), style, args: [] });
    } else if (type === 'bracket') {
      const a = st.pop();
      if (!a) throw new Error('Malformed expression (empty bracket)');
      st.push({ type, text: '(', args: [a] });
    } else {
      const n = Number(e.getAttribute('args') ?? (type === 'operator' ? 2 : 1));
      if (st.length < n) throw new Error(`Malformed expression ("${raw.trim()}" needs ${n} arguments)`);
      st.push({ type, text: raw.trim(), args: st.splice(st.length - n, n) });
    }
  }
  return st;
}

const isFn = (t: Tok | undefined, ...names: string[]) => !!t && t.type === 'function' && names.includes(t.text);
const isOp = (t: Tok | undefined, op: string) => !!t && t.type === 'operator' && t.text === op;
const isVar = (t: Tok | undefined) => !!t && t.type === 'operand' && !t.style && /^[^\d.]/.test(t.text) && !isPlaceholderText(t.text);
const isPlaceholderText = (s: string) => s === '' || s === '#' || s === '.' || s === '?' || s === '…';
/** Items of a list function (line, mat, sys) without the trailing row and column counts. */
const listItems = (t: Tok) => t.args.slice(0, Math.max(0, t.args.length - 2));

/** SMath writes literal subscripts as "L.A". */
const smName = (raw: string) => sanitize(raw.replace(/\./g, '_'));

function walk(t: Tok, f: (t: Tok) => void) {
  f(t);
  for (const a of t.args) walk(a, f);
}

/** Variable and function names a tree reads. */
function namesUsed(t: Tok, out: Set<string>) {
  walk(t, (n) => {
    if ((n.type === 'operand' && !n.style && isVar(n)) || n.type === 'function') out.add(smName(n.text));
  });
}

/** Base name of a definition target: x, x[i] (el), f(x). */
function targetName(t: Tok): string | null {
  if (isVar(t)) return smName(t.text);
  if (isFn(t, 'el') && isVar(t.args[0])) return smName(t.args[0].text);
  if (t.type === 'function') return smName(t.text);
  return null;
}

/** Names a tree assigns with ":" (anywhere inside it), and the loop counters among them. */
function assignments(t: Tok): { all: string[]; element: Set<string>; counters: Set<string> } {
  const all: string[] = [];
  const element = new Set<string>(), counters = new Set<string>();
  walk(t, (n) => {
    if (isOp(n, ':')) {
      const name = targetName(n.args[0]);
      if (name && !all.includes(name)) all.push(name);
      if (name && isFn(n.args[0], 'el')) element.add(name);
    }
    if (isFn(n, 'for') && n.args.length === 3 && isVar(n.args[0])) counters.add(smName(n.args[0].text));
    if (isFn(n, 'for') && n.args.length === 4 && isOp(n.args[0], ':')) {
      const c = targetName(n.args[0].args[0]);
      if (c) counters.add(c);
    }
  });
  return { all, element, counters };
}

/** Program constructs: these become indented mathstudii programs. */
function isProgram(t: Tok): boolean {
  if (isFn(t, 'line', 'for', 'while', 'try')) return true;
  if (isFn(t, 'if')) {
    let found = false;
    walk(t, (n) => {
      if (isOp(n, ':') || isFn(n, 'line', 'for', 'while', 'break', 'continue')) found = true;
    });
    return found;
  }
  return false;
}

// ------------------------------------------------------------ conversion

const BINOPS: Record<string, { op: string; p: number }> = {
  '+': { op: ' + ', p: P.ADD }, '-': { op: ' - ', p: P.ADD }, '*': { op: '*', p: P.MUL }, '·': { op: '*', p: P.MUL },
  '/': { op: '/', p: P.MUL }, '÷': { op: '/', p: P.MUL }, '^': { op: '^', p: P.POW },
  '<': { op: ' < ', p: P.CMP }, '>': { op: ' > ', p: P.CMP }, '≤': { op: ' ≤ ', p: P.CMP }, '≥': { op: ' ≥ ', p: P.CMP },
  '≠': { op: ' ≠ ', p: P.CMP }, '≡': { op: ' == ', p: P.CMP }, '=': { op: ' == ', p: P.CMP },
  '&': { op: ' ∧ ', p: P.AND }, '∧': { op: ' ∧ ', p: P.AND }, '|': { op: ' ∨ ', p: P.OR }, '∨': { op: ' ∨ ', p: P.OR },
  '⊕': { op: ' ⊕ ', p: P.OR },
};

/** SMath built-ins whose mathstudii name differs. */
const FN_MAP: Record<string, string> = {
  arcsin: 'asin', arccos: 'acos', arctan: 'atan', arccot: 'acot', arcsec: 'asec', arccsc: 'acsc',
  arcsinh: 'asinh', arccosh: 'acosh', arctanh: 'atanh', arccoth: 'acoth', Gamma: 'gamma', Γ: 'gamma',
  random: 'rnd', product: 'prod', mod: 'mod', Min: 'min', Max: 'max',
};

/** SMath unit names that mean something else here (g is gravity in Mathcad convention). */
const SMATH_UNITS: Record<string, string> = { g: 'gm', in: 'inch', h: 'hr', min: 'min', t: 'tonne', l: 'L', '°': 'deg' };

const CONSTANTS: Record<string, string> = { π: 'π', e: 'e', '∞': '∞' };

class Converter {
  warnings: string[] = [];
  /** Names the worksheet assigns anywhere: a unit with the same name must be written unit("…"). */
  assigned = new Set<string>();
  private helpers = 0;
  /** A fresh name for the results of a top-level loop. */
  helperName(): string {
    let n: string;
    do n = `loop${++this.helpers}`;
    while (this.assigned.has(n));
    this.assigned.add(n);
    return n;
  }

  /** The region being converted ignores units (SMath's ignoreUnits="true"). */
  ignoreUnits = false;

  /** Plot variable renaming (x → x_plot when x is already a worksheet variable). */
  rename: Record<string, string> = {};

  unit(raw: string): Ex {
    // a region marked "ignore units" calculates with every unit as 1
    if (this.ignoreUnits) return { s: '1', p: P.ATOM };
    const name = SMATH_UNITS[raw] ?? unitName(raw);
    if (this.assigned.has(name) || this.assigned.has(raw)) return { s: `unit(1, "${name}")`, p: P.ATOM };
    return { s: name, p: P.ATOM };
  }

  name(raw: string): string {
    const n = smName(raw);
    return this.rename[n] ?? n;
  }

  expr(t: Tok): Ex {
    switch (t.type) {
      case 'operand':
        return this.operand(t);
      case 'bracket':
        return { s: `(${this.expr(t.args[0]).s})`, p: P.ATOM };
      case 'operator':
        return this.operator(t);
      case 'function':
        return this.call(t);
    }
  }

  operand(t: Tok): Ex {
    if (t.style === 'unit') return this.unit(t.text);
    if (t.style === 'string') return { s: JSON.stringify(t.text), p: P.ATOM };
    if (isPlaceholderText(t.text)) throw new Placeholder();
    if (/^\d*\.?\d+([eE][+-]?\d+)?$/.test(t.text)) return { s: t.text.replace(/^\./, '0.'), p: P.ATOM };
    if (CONSTANTS[t.text]) return { s: CONSTANTS[t.text], p: P.ATOM };
    if (t.text === 'break' || t.text === 'continue') throw new Unsupported(`“${t.text}” outside a program`);
    return { s: this.name(t.text), p: P.ATOM };
  }

  /** True when every leaf is a unit (or an exponent): such factors read naturally as "5 kN/m". */
  unitOnly(t: Tok): boolean {
    let units = 0, other = 0;
    walk(t, (n) => {
      if (n.type === 'function') other++;
      else if (n.type === 'operand') {
        if (n.style === 'unit') units++;
        else if (!/^\d/.test(n.text)) other++;
      }
    });
    return units > 0 && other === 0;
  }

  operator(t: Tok): Ex {
    const [a, b] = t.args;
    const op = t.text;
    if (t.args.length === 1) {
      const x = this.expr(a);
      if (op === '-') return { s: `-${wrap(x, P.NEG)}`, p: P.NEG };
      if (op === '+') return x;
      if (op === '!') return { s: `${wrap(x, P.POST)}!`, p: P.POST };
      if (op === '¬') return { s: `¬${wrap(x, P.NOT)}`, p: P.NOT };
      throw new Unsupported(`the “${op}” operator`);
    }
    if (op === ':') throw new Unsupported('a definition inside an expression');
    const bin = BINOPS[op];
    if (!bin || t.args.length !== 2) throw new Unsupported(`the “${op}” operator`);
    const x = this.expr(a), y = this.expr(b);
    if (op === '^') return { s: `${wrap(x, P.POW + 1)}^${wrap(y, P.POW)}`, p: P.POW };
    if (op === '*' && this.ignoreUnits && this.unitOnly(b)) return x;
    // 10 % is 10/100 here (% is a display unit only)
    if (op === '*' && y.s === '%') return { s: `${wrap(x, P.MUL)}/100`, p: P.MUL };
    if (op === '*' && isNumberLiteral(x.s) && this.unitOnly(b)) return { s: `${x.s} ${y.s}`, p: P.MUL };
    return { s: `${wrap(x, bin.p)}${bin.op}${wrap(y, bin.p + 1)}`, p: bin.p };
  }

  args(t: Tok): string[] {
    return t.args.map((a) => this.expr(a).s);
  }

  matrix(t: Tok): Ex {
    const items = listItems(t);
    const rows = Number(t.args[t.args.length - 2]?.text), cols = Number(t.args[t.args.length - 1]?.text);
    if (!(rows > 0 && cols > 0) || rows * cols !== items.length) throw new Error('Malformed matrix');
    const cells = items.map((c) => this.expr(c).s);
    // SMath lists matrix elements row by row
    const out = Array.from({ length: rows }, (_, i) => cells.slice(i * cols, (i + 1) * cols).join(', '));
    return { s: `[${out.join('; ')}]`, p: P.ATOM };
  }

  range(t: Tok): Ex {
    // range(start, end) or range(start, end, second value)
    const [a, b, c] = this.args(t);
    return { s: c !== undefined ? `${a}, ${c} .. ${b}` : `${a} .. ${b}`, p: P.RANGE };
  }

  call(t: Tok): Ex {
    const name = t.text;
    const n = t.args.length;
    const A = (i: number) => this.expr(t.args[i]);
    switch (name) {
      case 'el': {
        const base = wrap(A(0), P.ATOM);
        return { s: `${base}[${t.args.slice(1).map((a) => this.expr(a).s).join(', ')}]`, p: P.ATOM };
      }
      case 'mat':
        return this.matrix(t);
      case 'range':
        return this.range(t);
      case 'eval':
        return A(0);
      case 'transpose':
        return { s: `${wrap(A(0), P.POST)}'`, p: P.POST };
      case 'invert':
        return { s: `${wrap(A(0), P.POW + 1)}^-1`, p: P.POW };
      case 'int':
        if (n === 4) return { s: `integral(${this.args(t).join(', ')})`, p: P.ATOM };
        if (n === 2) return { s: `integrate(${this.args(t).join(', ')})`, p: P.ATOM };
        break;
      case 'sum':
      case 'product': {
        const fn = name === 'sum' ? 'sum' : 'prod';
        if (n === 4 || n === 1) return { s: `${fn}(${this.args(t).join(', ')})`, p: P.ATOM };
        break;
      }
      case 'diff':
        return { s: `diff(${this.args(t).join(', ')})`, p: P.ATOM };
      case 'cinterp': {
        if (n !== 3) break;
        const [x, y, v] = this.args(t);
        return { s: `interp(cspline(${x}, ${y}), ${x}, ${y}, ${v})`, p: P.ATOM };
      }
      case 'if':
        if (n === 3) return { s: `if(${this.args(t).join(', ')})`, p: P.ATOM };
        break;
      case 'solve':
        if (n === 4 && isOp(t.args[0], '≡')) {
          const [lhs, rhs] = t.args[0].args.map((a) => this.expr(a));
          return { s: `root(${lhs.s} - ${wrap(rhs, P.ADD + 1)}, ${A(1).s}, ${A(2).s}, ${A(3).s})`, p: P.ATOM };
        }
        if (n === 4) return { s: `root(${this.args(t).join(', ')})`, p: P.ATOM };
        throw new Unsupported('solve(…) inside an expression');
      case 'line':
      case 'for':
      case 'while':
      case 'try':
        throw new Unsupported('a program inside an expression');
      case 'sys':
        throw new Unsupported('a sys(…) block (system of equations)');
    }
    const fn = FN_MAP[name] ?? this.name(name);
    return { s: `${fn}(${this.args(t).join(', ')})`, p: P.ATOM };
  }

  // ------------------------------------------------------------ programs

  target(t: Tok): string {
    if (isVar(t)) return this.name(t.text);
    if (isFn(t, 'el')) return this.expr(t).s;
    if (t.type === 'function') {
      if (!t.args.every(isVar)) throw new Unsupported('a function definition with non-name parameters');
      return `${this.name(t.text)}(${t.args.map((a) => this.name(a.text)).join(', ')})`;
    }
    throw new Unsupported('a definition of an expression');
  }

  stmt(t: Tok, ind: string): string[] {
    const inner = ind + '  ';
    if (isOp(t, ':')) return [`${ind}${this.target(t.args[0])} ← ${this.expr(t.args[1]).s}`];
    if (t.type === 'operand' && (t.text === 'break' || t.text === 'continue')) return [`${ind}${t.text}`];
    if (t.type === 'function') {
      const a = t.args;
      switch (t.text) {
        case 'line':
          return listItems(t).flatMap((s) => this.stmt(s, ind));
        case 'while':
          return [`${ind}while ${this.expr(a[0]).s}`, ...this.stmt(a[1], inner)];
        case 'for':
          if (a.length === 3) return [`${ind}for ${this.name(a[0].text)} ∈ ${this.expr(a[1]).s}`, ...this.stmt(a[2], inner)];
          if (a.length === 4) return this.cFor(a[0], a[1], a[2], a[3], ind);
          break;
        case 'if': {
          if (a.length !== 3) break;
          const out = [`${ind}if ${this.expr(a[0]).s}`, ...this.stmt(a[1], inner)];
          let rest = a[2];
          while (isFn(rest, 'if') && rest.args.length === 3) {
            out.push(`${ind}else if ${this.expr(rest.args[0]).s}`, ...this.stmt(rest.args[1], inner));
            rest = rest.args[2];
          }
          if (!(rest.type === 'operand' && isPlaceholderText(rest.text))) out.push(`${ind}else`, ...this.stmt(rest, inner));
          return out;
        }
        case 'try':
          if (a.length === 2) return [`${ind}try`, ...this.stmt(a[0], inner), `${ind}on error`, ...this.stmt(a[1], inner)];
          break;
      }
    }
    return [`${ind}${this.expr(t).s}`];
  }

  /** for(init, condition, increment, body). The common counting loop becomes "for k ∈ a .. b". */
  cFor(init: Tok, cond: Tok, incr: Tok, body: Tok, ind: string): string[] {
    const v = isOp(init, ':') && isVar(init.args[0]) ? smName(init.args[0].text) : null;
    const counts = v && (isOp(cond, '≤') || isOp(cond, '<')) && isVar(cond.args[0]) && smName(cond.args[0].text) === v
      && isOp(incr, ':') && isVar(incr.args[0]) && smName(incr.args[0].text) === v
      && isOp(incr.args[1], '+') && isVar(incr.args[1].args[0]) && smName(incr.args[1].args[0].text) === v
      && incr.args[1].args[1].text === '1';
    if (counts && isOp(cond, '≤')) {
      return [`${ind}for ${this.name(v!)} ∈ ${this.expr(init.args[1]).s} .. ${this.expr(cond.args[1]).s}`, ...this.stmt(body, ind + '  ')];
    }
    return [
      ...this.stmt(init, ind),
      `${ind}while ${this.expr(cond).s}`,
      ...this.stmt(body, ind + '  '),
      ...this.stmt(incr, ind + '  '),
    ];
  }
}

// ------------------------------------------------------------ text

function pickLang(els: El[]): El | undefined {
  return els.find((e) => (e.getAttribute('lang') ?? '') === 'eng') ?? els.find((e) => !e.getAttribute('lang')) ?? els[0];
}

/** Markdown from SMath's <text>/<description> paragraphs. */
function paragraphs(el: El): string {
  const ps = kids(el).filter((c) => local(c) === 'p');
  const out: string[] = [];
  for (const p of ps.length ? ps : [el]) {
    const bold = p.getAttribute('bold') === 'true';
    const italic = p.getAttribute('italic') === 'true';
    const lines = (p.textContent ?? '').split(/\r?\n/).map((l) => l.trim().replace(/\$/g, '&#36;'));
    const fmt = (l: string) => (!l ? l : bold ? `**${l}**` : italic ? `*${l}*` : l);
    const md = lines.map(fmt).join('  \n').trim();
    if (md) out.push(md);
  }
  return out.join('\n\n');
}

// ------------------------------------------------------------ file

/** .smz files are compressed .sm files. */
function readXml(data: Uint8Array): string {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    const files = unzipSync(data);
    const key = Object.keys(files).find((k) => /\.(sm|xml)$/i.test(k)) ?? Object.keys(files)[0];
    if (!key) throw new Error('The .smz archive is empty');
    return readXml(files[key]);
  }
  if (data[0] === 0x1f && data[1] === 0x8b) return readXml(gunzipSync(data));
  const head = strFromU8(data.subarray(0, 64)).replace(/^﻿/, '').trimStart();
  if (!head.startsWith('<')) {
    try {
      return readXml(decompressSync(data));
    } catch {
      throw new Error('Not an SMath worksheet (the file is neither XML nor a compressed .sm)');
    }
  }
  return strFromU8(data).replace(/^﻿/, '');
}

interface Placed {
  region: El;
  x: number;
  y: number;
}

/** Regions in reading order. Collapsible areas hold their regions as children, with page coordinates. */
function flatten(container: El): Placed[] {
  const out: Placed[] = [];
  for (const r of kids(container).filter((c) => local(c) === 'region')) {
    const nested = kids(r).filter((c) => local(c) === 'region');
    if (nested.length) out.push(...flatten(r));
    const body = kids(r).find((c) => local(c) !== 'region');
    if (body && local(body) !== 'area') out.push({ region: r, x: Number(r.getAttribute('left') ?? 0), y: Number(r.getAttribute('top') ?? 0) });
  }
  return out;
}

const regionKinds = (r: El) => kids(r).filter((c) => local(c) !== 'region');

export function importSmath(data: Uint8Array, fileName = 'worksheet'): ImportResult {
  const xml = readXml(data);
  if (!/smath\.info\/schemas\/worksheet|<\?application progid="SMath/i.test(xml)) throw new Error('Not an SMath Studio worksheet (.sm or .smz)');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root) throw new Error('The file is not valid XML');
  // 0.96–0.98: <regions> is the root; 0.99+: <worksheet><regions type="content">
  const regionsEl = local(root) === 'regions' ? root : child(root, 'regions') ?? doc.getElementsByTagNameNS('*', 'regions')[0];
  if (!regionsEl) throw new Error('The worksheet has no regions');

  const conv = new Converter();
  const warnings = conv.warnings;
  const ws = emptyWorksheet();
  ws.title = fileName.replace(/\.smz?$/i, '');
  ws.settings.origin = 1; // SMath indexes from 1
  ws.settings.lateBinding = true; // SMath functions see variables defined after them
  const calc = child(child(root, 'settings') ?? root, 'calculation');
  const prec = Number(calc && child(calc, 'precision')?.textContent);
  if (prec >= 0 && prec <= 15) ws.settings.precision = prec;
  const thr = Number(calc && child(calc, 'exponentialThreshold')?.textContent);
  if (thr > 0 && thr <= 15) ws.settings.expThreshold = thr;

  const placed = flatten(regionsEl).sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));

  // pass 1: parse every formula once; collect what each region reads and what the worksheet assigns
  const inputs = placed.map((at) => {
    const body = regionKinds(at.region)[0];
    const kind = body ? local(body) : '';
    try {
      if (kind === 'math' || kind === 'plot') return parseRpn(child(body!, 'input'));
    } catch {
      /* reported in pass 2 */
    }
    return [] as Tok[];
  });
  const used = inputs.map((toks, i) => {
    const s = new Set<string>();
    const body = regionKinds(placed[i].region)[0];
    const shown = !!body && !!child(body, 'result');
    for (const t of toks) {
      // a formula shown for documentation reads nothing
      if (isOp(t, '≡') && !shown) continue;
      namesUsed(t, s);
    }
    // x in a plot is the plot's own variable
    if (body && local(body) === 'plot') s.delete('x');
    return s;
  });
  for (const toks of inputs) {
    for (const t of toks) {
      for (const n of assignments(t).all) conv.assigned.add(n);
      if (isOp(t, ':') && t.args[0].type === 'function' && !isFn(t.args[0], 'el')) for (const p of t.args[0].args) if (isVar(p)) conv.assigned.add(smName(p.text));
    }
  }
  // SMath collects plot items in a variable: plotter := sys(a, b, c, n, 1)
  const plotLists = new Map<string, Tok[]>();
  const hasStrings = new Set<string>();
  for (const toks of inputs) {
    const t = toks[0];
    if (!t || !isOp(t, ':')) continue;
    const name = targetName(t.args[0]);
    if (!name) continue;
    if (isFn(t.args[1], 'sys') && isVar(t.args[0])) plotLists.set(name, listItems(t.args[1]));
    walk(t.args[1], (n) => {
      if (n.style === 'string') hasStrings.add(name);
    });
  }
  const usedAfter = (i: number) => {
    const s = new Set<string>();
    for (let j = i + 1; j < used.length; j++) for (const n of used[j]) s.add(n);
    return s;
  };

  const regions: Region[] = [];
  const saved: SavedResult[] = [];
  const definedBefore = new Set<string>();
  const fail = (what: string, e: unknown, at: Placed) => {
    const msg = e instanceof Unsupported ? `uses ${e.message}, which mathstudii cannot import yet` : (e as Error).message;
    warnings.push(`${what} at ${Math.round(at.y)} px: ${msg}`);
    regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Not imported (${what}):* ${msg}`, width: 300 }));
  };
  let plotRanges = 0;

  placed.forEach((at, i) => {
    const r = at.region;
    const body = regionKinds(r)[0];
    if (!body) return;
    const kind = local(body);
    const width = Number(r.getAttribute('width') ?? 0);
    try {
      conv.ignoreUnits = kind === 'math' && body.getAttribute('ignoreUnits') === 'true';
      if (conv.ignoreUnits) warnings.push(`math at ${Math.round(at.y)} px: SMath ignores the units in this region (each counts as 1); so does the import`);
      if (kind === 'math') {
        const toks = parseRpn(child(body, 'input'));
        if (!toks.length) return;
        if (toks.length > 1) throw new Unsupported('several formulas in one region');
        const t = toks[0];
        const result = child(body, 'result');
        const action = result?.getAttribute('action') ?? '';
        const contract = parseRpn(child(body, 'contract'))[0];
        const unit = contract && !conv.ignoreUnits ? ` ${conv.expr(contract).s}` : '';
        const show = result ? (action === 'symbolic' ? ' →' : ` =${unit}`) : '';

        if (isOp(t, ':') && isFn(t.args[1], 'sys') && plotLists.has(targetName(t.args[0]) ?? '')) {
          const name = conv.target(t.args[0]);
          regions.push(createRegion('text', at.x, at.y, {
            markdown: `\`${name}\` is an SMath list of plot items (${listItems(t.args[1]).map((a) => conv.expr(a).s).join(', ')}); the plot draws them directly.`,
            width: Math.max(220, width),
          }));
        } else if (isOp(t, ':')) {
          const lhs = conv.target(t.args[0]);
          const rhs = t.args[1];
          const src = isProgram(rhs) ? `${lhs} :=\n${conv.stmt(rhs, '  ').join('\n')}` : `${lhs} := ${conv.expr(rhs).s}${show && !show.includes('→') ? show : ''}`;
          regions.push(createRegion('math', at.x, at.y, { source: src }));
        } else if (isProgram(t)) {
          regions.push(...topLevelProgram(conv, t, at, usedAfter(i), definedBefore));
        } else if (!result && isOp(t, '≡')) {
          // a formula shown for documentation, e.g. "A·x = d"
          try {
            regions.push(createRegion('math', at.x, at.y, { source: conv.expr(t).s }));
          } catch (e) {
            if (!(e instanceof Placeholder)) throw e;
            regions.push(createRegion('text', at.x, at.y, { markdown: '*(formula with “…” placeholders, shown in SMath only)*', width: Math.max(160, width) }));
          }
        } else if (isFn(t, 'solve') && t.args.length === 2 && action !== 'numeric') {
          const eq = isOp(t.args[0], '≡') ? `${conv.expr(t.args[0].args[0]).s} = ${conv.expr(t.args[0].args[1]).s}` : conv.expr(t.args[0]).s;
          regions.push(createRegion('math', at.x, at.y, { source: `${eq} → solve, ${conv.expr(t.args[1]).s}` }));
        } else {
          regions.push(createRegion('math', at.x, at.y, { source: `${conv.expr(t).s}${show}` }));
        }
        // the value SMath showed, in the region's display unit, rounded as it was shown
        const last = regions[regions.length - 1];
        if (result && action !== 'symbolic' && last?.kind === 'math' && / =( |$)/.test(last.source.split('\n')[0])) {
          try {
            const tok = parseRpn(result)[0];
            const value = conv.expr(tok).s;
            // the result has its unit when SMath chose it, else it is a number in the display unit
            let hasUnit = false;
            walk(tok, (n) => { if (n.style === 'unit') hasUnit = true; });
            // rounded to the digits shown: half a unit in the last significant digit
            const digits = (/\d[\d.]*/.exec(value)?.[0] ?? '').replace('.', '').replace(/^0+/, '').length || 1;
            const shownIn = unit.trim() === '%' ? '1/100' : unit.trim();
            saved.push({ regionId: last.id, expr: shownIn && !hasUnit ? `(${value})*(${shownIn})` : value, tol: Math.max(1e-4, 0.5 * 10 ** (1 - digits)) });
          } catch {
            /* a result we cannot read (a matrix of text, a placeholder) is not compared */
          }
        }
        // worksheet-level names only: locals of a function's program stay local
        if (isOp(t, ':')) {
          const n = targetName(t.args[0]);
          if (n && (isVar(t.args[0]) || isFn(t.args[0], 'el'))) definedBefore.add(n);
        } else if (isProgram(t)) for (const n of assignments(t).all) definedBefore.add(n);

        // a comment attached to the formula
        const desc = pickLang(kids(body).filter((c) => local(c) === 'description' && c.getAttribute('active') !== 'false'));
        const md = desc ? paragraphs(desc) : '';
        if (md) regions.push(createRegion('text', at.x + Math.max(60, width) + 16, at.y, { markdown: `*${md.replace(/\*/g, '')}*`, width: 220 }));
      } else if (kind === 'text') {
        const t = pickLang(regionKinds(r).filter((c) => local(c) === 'text'));
        const md = t ? paragraphs(t) : '';
        if (md) regions.push(createRegion('text', at.x, at.y, { markdown: md, width: Math.max(120, width + 20) }));
      } else if (kind === 'picture') {
        const raw = child(body, 'raw');
        const fmt = (raw?.getAttribute('format') ?? 'png').toLowerCase();
        const b64 = (raw?.textContent ?? '').replace(/\s+/g, '');
        if (!b64) throw new Error('image data not found');
        if (/emf|wmf/.test(fmt)) throw new Unsupported(`a ${fmt.toUpperCase()} image (browsers cannot display it)`);
        const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : fmt === 'gif' ? 'image/gif' : fmt === 'bmp' ? 'image/bmp' : 'image/png';
        regions.push(createRegion('image', at.x, at.y, { src: `data:${mime};base64,${b64}`, width: Math.min(PAGE_WIDTH - 2 * PAGE_MARGIN, width || 240) }));
      } else if (kind === 'plot') {
        regions.push(plot(conv, body, at, width, Number(r.getAttribute('height') ?? 0), definedBefore, plotLists, hasStrings));
        plotRanges++;
      } else {
        throw new Unsupported(`the “${kind}” region (an SMath plugin)`);
      }
    } catch (e) {
      fail(kind === 'math' ? 'math' : kind, e, at);
    }
  });
  if (plotRanges) warnings.push(`${plotRanges} plot${plotRanges > 1 ? 's' : ''}: SMath stores a view (zoom and pan), not axis limits, so the axes start from automatic ranges`);

  fitToPage(regions);
  ws.regions = regions;
  return { ws, warnings, format: 'SMath Studio (.sm)', saved };
}

/**
 * SMath runs loops at the top level and they assign worksheet variables. mathstudii
 * programs are values, so the loop becomes a definition of the variable read later:
 *   GCD :=
 *     while …
 *     return GCD
 * When several of its variables are read later, the program runs once and returns them
 * together ({x: x, y: y}); one definition per variable then takes its value out.
 */
function topLevelProgram(conv: Converter, t: Tok, at: Placed, later: Set<string>, before: Set<string>): Region[] {
  const { all, element, counters } = assignments(t);
  if (!all.length) throw new Unsupported('a program that assigns no variable');
  let keep = all.filter((n) => later.has(n) && !counters.has(n));
  if (!keep.length) keep = [all.filter((n) => !counters.has(n)).pop() ?? all[all.length - 1]];
  const body = conv.stmt(t, '  ');
  // element assignments must start from the existing value, not from an empty local
  const seed = [...element].filter((n) => before.has(n)).map((n) => `  ${n} ← ${n}`);
  if (keep.length === 1) {
    return [createRegion('math', at.x, at.y, { source: `${keep[0]} :=\n${[...seed, ...body, `  return ${keep[0]}`].join('\n')}` })];
  }
  const tmp = conv.helperName();
  const ret = `  return {${keep.map((v) => `${JSON.stringify(v)}: ${v}`).join(', ')}}`;
  // 1 px apart keeps reading order; "separate regions" spreads them out after import
  return [
    createRegion('math', at.x, at.y, { source: `${tmp} :=\n${[...seed, ...body, ret].join('\n')}` }),
    ...keep.map((v, k) => createRegion('math', at.x, at.y + k + 1, { source: `${v} := ${tmp}.${v}` })),
  ];
}

function plot(
  conv: Converter, body: El, at: Placed, width: number, height: number,
  before: Set<string>, lists: Map<string, Tok[]>, hasStrings: Set<string>,
): Region {
  if ((body.getAttribute('type') ?? '2d') !== '2d') throw new Unsupported('a 3-D plot');
  const toks = parseRpn(child(body, 'input'));
  if (toks.length !== 1) throw new Error('the plot has no formula');
  const expand = (t: Tok): Tok[] => {
    if (isFn(t, 'sys')) return listItems(t).flatMap(expand);
    if (isVar(t) && lists.has(smName(t.text))) return lists.get(smName(t.text))!.flatMap(expand);
    return [t];
  };
  const items = expand(toks[0]).filter((t) => {
    // text labels ([x, y, "text", size, colour] rows) have no counterpart here
    if (isVar(t) && hasStrings.has(smName(t.text))) {
      conv.warnings.push(`Plot at ${Math.round(at.y)} px: the text labels in “${smName(t.text)}” are not drawn`);
      return false;
    }
    return true;
  });
  if (!items.length) throw new Unsupported('a plot of text labels only');
  // SMath plots functions of x; if x is already a worksheet variable, use another name
  const xv = before.has('x') ? 'x_plot' : 'x';
  conv.rename = xv === 'x' ? {} : { x: xv };
  try {
    const traces: PlotTrace[] = [];
    let hasFunction = false;
    for (const it of items) {
      let usesX = false;
      walk(it, (n) => {
        if (n.type === 'operand' && !n.style && n.text === 'x') usesX = true;
      });
      const e = conv.expr(it).s;
      if (usesX) {
        hasFunction = true;
        traces.push({ y: e, style: 'line' });
      } else {
        // a matrix of points: column 1 is x, column 2 is y
        traces.push({ xExpr: `col(${e}, 1)`, y: `col(${e}, 2)`, style: 'line' });
      }
    }
    let xExpr = xv;
    if (!hasFunction && traces[0]?.xExpr) {
      xExpr = traces[0].xExpr;
      delete traces[0].xExpr;
    }
    return createRegion('plot', at.x, at.y, {
      xExpr, traces,
      width: Math.max(200, width || 300), height: Math.max(150, height || 240),
    });
  } finally {
    conv.rename = {};
  }
}
