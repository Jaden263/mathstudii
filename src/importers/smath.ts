// Import SMath Studio worksheets:
//   .sm   plain XML (namespace http://smath.info/schemas/worksheet/1.0)
//   .smz  the same XML, compressed
// Math is stored as a postfix (RPN) token list: <e type="operand|operator|function|bracket">
// with an "args" count on operators and functions. Matrices, programs and plot lists put
// their row and column counts in the last two arguments. The structure follows real files
// saved by SMath Studio 0.96–0.99 (the program's bundled examples).
import { unzipSync, gunzipSync, decompressSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement, type Node as XNode } from '@xmldom/xmldom';
import { createRegion, emptyWorksheet, PAGE_MARGIN, PAGE_WIDTH, type Region, type RegionStyle, type PlotTrace } from '../model/types';
import { AREA_BAR, AREA_PAD, collapseArea } from '../model/areas';
import { isUnitName } from '../engine/math';
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

/** Variable and function names a tree reads (with the worksheet's own units). */
function namesUsed(t: Tok, out: Set<string>, userUnits?: Set<string>) {
  walk(t, (n) => {
    if ((n.type === 'operand' && !n.style && isVar(n)) || n.type === 'function') out.add(smName(n.text));
    else if (n.type === 'operand' && n.style === 'unit' && userUnits?.has(n.text)) out.add(smName(n.text));
  });
}

/** A unit the worksheet defines (its name in unit style on the left of ":"). */
const isUserUnit = (t: Tok | undefined) => !!t && t.type === 'operand' && t.style === 'unit' && /^[^\d.]/.test(t.text);

/** Base name of a definition target: x, x[i] (el), f(x), a unit of the worksheet's own. */
function targetName(t: Tok): string | null {
  if (isVar(t) || isUserUnit(t)) return smName(t.text);
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

/**
 * Functions only SMath plugins or the computer SMath ran on can provide, so the import report
 * says why the regions that use them are not calculated.
 */
const ELSEWHERE: { test: RegExp; what: string }[] = [
  { test: /^CoolProp_/, what: 'functions of the CoolProp plugin (fluid properties), which mathstudii does not have' },
  { test: /^(Maxima|MaximaControl|MaximaTakeover|MaximaLog|MaximaDefine|MaximaFunction|Solve|Assign|Fit|Draw2D|Draw3D|draw2d|draw3d|explicit|implicit|parametric|parametric_surface|cylindrical|spherical|elevation_grid|tube|polygon|quadrilateral|wxdraw2d|wxdraw3d)$/, what: 'functions of the Maxima plugin (computer algebra), which mathstudii does not have' },
  { test: /^include$/, what: 'include(…), which reads another worksheet file that is not part of this one' },
  { test: /^(wfile|rfile|importData|importCells|readTable|writeTable|readFile|writeFile|exportData|appendfile)$/, what: 'file functions that read or write data files that are not part of the worksheet' },
  { test: /^(CurrentDirectory|DocumentDirectory|GetFolderPath|time|date)$/, what: 'functions whose value depends on the computer and the moment SMath ran (folders, the clock)' },
];

/** Names a top-level formula defines on the worksheet: x := …, x[i] := …, a unit of its own, a loop's variables. */
function worksheetDefines(t: Tok): string[] {
  if (isOp(t, ':')) {
    const n = targetName(t.args[0]);
    return n && (isVar(t.args[0]) || isUserUnit(t.args[0]) || isFn(t.args[0], 'el')) ? [n] : [];
  }
  return isProgram(t) ? assignments(t).all : [];
}

/** Variables a formula binds itself: the variable of sum, int, diff, solve …, loop counters, program locals. */
function boundNames(t: Tok): Set<string> {
  const out = new Set<string>(assignments(t).all);
  walk(t, (n) => {
    if (isFn(n, 'sum', 'product', 'int', 'diff', 'solve', 'roots', 'at', 'Solve', 'FindRoot') && isVar(n.args[1])) out.add(smName(n.args[1].text));
    if (isFn(n, 'for') && isVar(n.args[0])) out.add(smName(n.args[0].text));
  });
  return out;
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
  random: 'rnd', product: 'prod', mod: 'mod', Min: 'min', Max: 'max', nthroot: 'nthRoot',
  // at(f, x = a) substitutes; "at" reads as a unit here
  at: 'subs',
  // Zeros(n) a column of n zeros, Zeros(m, n) an m × n matrix; Ones the same of ones
  Zeros: 'zeros', Ones: 'ones',
};

/**
 * SMath unit names that mean something else here (g is gravity in Mathcad convention), and the
 * units SMath shows that the engine has no name for: J/kg is the gray (Gy), mol/s the katal, the
 * tonne-force 1000 kgf.
 */
const SMATH_UNITS: Record<string, string> = {
  g: 'gm', in: 'inch', h: 'hr', min: 'min', t: 'tonne', l: 'L', '°': 'deg', 'g.e': 'g',
  Gy: '(J/kg)', Sv: '(J/kg)', kat: '(mol/s)', tonnef: '(1000 kgf)',
  // units the engine has by these names (the Mathcad import writes them out)
  ksi: 'ksi', kph: 'kph',
};

/** Temperatures with an offset: SMath converts 27 °C to 300.15 K where it is the unit of a value. */
const ABSOLUTE_TEMPERATURE = new Set(['°C', '°F']);

/** Display units that cannot be written as a unit here, and the unit shown instead. */
const SMATH_DISPLAY: Record<string, { unit: string; why: string }> = {
  tonnef: { unit: 'kgf', why: 'tonnef (tonne-force) is not a unit here: shown in kgf (1 tonnef = 1000 kgf)' },
};

/** SMath's physical constants are units (style="unit"): k is Boltzmann's constant, e the elementary charge. */
const SMATH_CONSTANTS: Record<string, string> = {
  k: 'boltzmann', e: 'elementaryCharge', c: 'speedOfLight', 'N.A': 'avogadro',
  'ε.0': 'vacuumPermittivity', 'μ.0': 'vacuumPermeability', 'm.e': 'electronMass', 'm.p': 'protonMass', 'm.n': 'neutronMass',
};

/** A number as SMath writes it: "2.", ".5", "1e-3". */
const NUMBER = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const number = (s: string) => s.replace(/^\./, '0.').replace(/\.(?=$|[eE])/, '');

const CONSTANTS: Record<string, string> = { π: 'π', e: 'e', '∞': '∞' };

/** Names that are values without a definition: SMath's constants and imaginary unit (j as engineers write it). */
const SYMBOLS = new Set(['π', 'e', '∞', 'i', 'j']);
/**
 * A name of two or more letters the worksheet never defines that is a unit (mm, kN, MPa typed
 * without SMath's unit mark): that unit, not a symbol. One letter (l, t, g …) is a symbol.
 */
const unitWord = (name: string) => [...name].length > 1 && isUnitName(name);

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
  /** Functions with the name of a variable (SMath tells them apart by their arguments): their own names here. */
  functionNames: Record<string, string> = {};
  /** Functions the worksheet defines: its own, not a built-in of the name. */
  userFunctions = new Set<string>();

  /** Inside a display unit, where every name is a unit even when a variable has its name. */
  private inContract = false;
  private exactUnits = false;
  private inResult = false;

  /**
   * Variables whose definition reads names only defined further down (SMath keeps those as
   * symbols until the value is used): here functions of those names, called where they are used.
   */
  lazy = new Map<string, string[]>();
  /** The roots SMath showed for x := solve(f, x): where the root is looked for again. */
  solveFrom: string[] | null = null;
  /** Why a display unit is shown in another unit (once per worksheet). */
  displayNotes = new Set<string>();
  /** Units the worksheet defines itself (kcf := 1 kip/ft³): variables here. */
  userUnits = new Set<string>();

  unit(raw: string): Ex {
    // a region marked "ignore units" calculates with every unit as 1
    if (this.ignoreUnits) return { s: '1', p: P.ATOM };
    if (this.userUnits.has(raw)) return { s: this.name(raw), p: P.ATOM };
    if (this.inContract && !this.exactUnits && SMATH_DISPLAY[raw]) {
      this.displayNotes.add(SMATH_DISPLAY[raw].why);
      return { s: SMATH_DISPLAY[raw].unit, p: P.ATOM };
    }
    if (SMATH_CONSTANTS[raw] && !this.inContract) return { s: SMATH_CONSTANTS[raw], p: P.ATOM };
    const name = SMATH_UNITS[raw] ?? unitName(raw);
    if (!this.inContract && (this.assigned.has(name) || this.assigned.has(raw))) return { s: `unit(1, "${name}")`, p: P.ATOM };
    return { s: name, p: P.ATOM };
  }

  /** The unit a result is shown in; exact: as the value SMath saved means it (tonnef stays 1000 kgf). */
  displayUnit(t: Tok, exact = false): string {
    this.inContract = true;
    this.exactUnits = exact;
    try {
      return this.expr(t).s;
    } finally {
      this.inContract = false;
      this.exactUnits = false;
    }
  }

  /**
   * A value SMath showed: its unit as SMath worked it out, so a °C in it is a difference
   * (2 W·23 °C/W shows 46 °C, which is 46 K).
   */
  shownValue(t: Tok): string {
    this.inResult = true;
    try {
      return this.expr(t).s;
    } finally {
      this.inResult = false;
    }
  }

  name(raw: string): string {
    const n = smName(raw);
    return this.rename[n] ?? n;
  }

  expr(t: Tok): Ex {
    switch (t.type) {
      case 'operand':
        return this.operand(t);
      case 'bracket': {
        const inner = this.expr(t.args[0]);
        // (0 .. n) in an expression: the vector of the range
        return inner.p === P.RANGE ? this.value(inner) : { s: `(${inner.s})`, p: P.ATOM };
      }
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
    if (NUMBER.test(t.text)) return { s: number(t.text), p: P.ATOM };
    if (CONSTANTS[t.text]) return { s: CONSTANTS[t.text], p: P.ATOM };
    if (t.text === 'break' || t.text === 'continue') throw new Unsupported(`“${t.text}” outside a program`);
    return { s: this.lazyCall(this.name(t.text)), p: P.ATOM };
  }

  /** A variable, or the call of a definition that waits for names defined further down (which may wait too). */
  lazyCall(name: string, seen = new Set<string>()): string {
    const late = this.lazy.get(name);
    if (!late || seen.has(name)) return name;
    seen.add(name);
    return `${name}(${late.map((p) => this.lazyCall(p, seen)).join(', ')})`;
  }

  /** °C or °F as the unit of a value: an absolute temperature (not in a display unit, not a worksheet's own unit). */
  absolute(t: Tok): boolean {
    return t.type === 'operand' && t.style === 'unit' && ABSOLUTE_TEMPERATURE.has(t.text) && !this.inContract && !this.inResult && !this.ignoreUnits && !this.userUnits.has(t.text);
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
      const x = this.value(this.expr(a));
      if (op === '-') return { s: `-${wrap(x, P.NEG)}`, p: P.NEG };
      if (op === '+') return x;
      if (op === '!') return { s: `${wrap(x, P.POST)}!`, p: P.POST };
      if (op === '¬') return { s: `¬${wrap(x, P.NOT)}`, p: P.NOT };
      throw new Unsupported(`the “${op}” operator`);
    }
    if (op === ':') throw new Unsupported('a definition inside an expression');
    // a † b is the cross product; a ± b both a + b and a − b, as a list
    if (op === '†' && t.args.length === 2) return { s: `cross(${this.value(this.expr(a)).s}, ${this.value(this.expr(b)).s})`, p: P.ATOM };
    if (op === '±' && t.args.length === 2) {
      const x = this.value(this.expr(a)), y = this.value(this.expr(b));
      return { s: `[${wrap(x, P.ADD)} + ${wrap(y, P.ADD + 1)}; ${wrap(x, P.ADD)} - ${wrap(y, P.ADD + 1)}]`, p: P.ATOM };
    }
    const bin = BINOPS[op];
    if (!bin || t.args.length !== 2) throw new Unsupported(`the “${op}” operator`);
    const x = this.value(this.expr(a)), y = this.value(this.expr(b));
    // Fluid = "S": SMath compares text with text (= here compares numbers)
    if ((op === '≡' || op === '=' || op === '≠') && (a.style === 'string' || b.style === 'string')) {
      const same = `equalText(${x.s}, ${y.s})`;
      return { s: op === '≠' ? `not(${same})` : same, p: P.ATOM };
    }
    // m^-1, not m^(-1): a display unit takes a plain exponent
    if (op === '^') return { s: `${wrap(x, P.POW + 1)}^${isNumberLiteral(y.s) ? y.s : wrap(y, P.POW)}`, p: P.POW };
    if (op === '*' && this.ignoreUnits && this.unitOnly(b)) return x;
    // 10 % is 10/100 here (% is a display unit only)
    if (op === '*' && y.s === '%') return { s: `${wrap(x, P.MUL)}/100`, p: P.MUL };
    // SMath's 27 °C is the temperature 300.15 K (k·T with T = 27 °C is k·300.15 K); in a compound unit (°C/W) °C is a difference
    if (op === '*' && this.absolute(b)) return { s: `(${isNumberLiteral(x.s) ? `${x.s} ${y.s}` : `${wrap(x, P.MUL)}*${y.s}`} to K)`, p: P.ATOM };
    // 2·(300 kN) is not "2 300 kN": only a unit (numbers as its exponents) joins a number
    if (op === '*' && isNumberLiteral(x.s) && this.unitOnly(b) && !/^[\d.]/.test(y.s)) return { s: `${x.s} ${y.s}`, p: P.MUL };
    return { s: `${wrap(x, bin.p)}${bin.op}${wrap(y, bin.p + 1)}`, p: bin.p };
  }

  args(t: Tok): string[] {
    return t.args.map((a) => this.value(this.expr(a)).s);
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

  /** Ranges as written (a .. b), and the same range as a vector value (range(a, b)). */
  private rangeValues = new Map<string, string>();

  range(t: Tok): Ex {
    // range(start, end) or range(start, end, second value)
    const [a, b, c] = t.args.map((x) => this.value(this.expr(x)).s);
    const s = c !== undefined ? `${a}, ${c} .. ${b}` : `${a} .. ${b}`;
    const step = c !== undefined ? `, ${wrap(this.expr(t.args[2]), P.ADD + 1)} - ${wrap(this.expr(t.args[0]), P.ADD + 1)}` : '';
    this.rangeValues.set(s, `range(${a}, ${b}${step})`);
    return { s, p: P.RANGE };
  }

  /** A range inside an expression or as an argument is the vector of its values ((0..n)·Δφ). */
  value(e: Ex): Ex {
    return e.p === P.RANGE && this.rangeValues.has(e.s) ? { s: this.rangeValues.get(e.s)!, p: P.ATOM } : e;
  }

  call(t: Tok): Ex {
    const name = t.text;
    const n = t.args.length;
    const A = (i: number) => this.expr(t.args[i]);
    switch (name) {
      case 'el': {
        const base = wrap(A(0), P.ATOM);
        // a range as a subscript takes those elements (v[2..4]): range(a, b) here is a vector a … b
        const index = (a: Tok) => (isFn(a, 'range') && (a.args.length === 2 || a.args.length === 3)
          ? `range(${this.expr(a.args[0]).s}, ${this.expr(a.args[1]).s}${a.args.length === 3 ? `, ${wrap(this.expr(a.args[2]), P.ADD + 1)} - ${wrap(this.expr(a.args[0]), P.ADD + 1)}` : ''})`
          : this.expr(a).s);
        return { s: `${base}[${t.args.slice(1).map(index).join(', ')}]`, p: P.ATOM };
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
      case 'Ceil':
      case 'Floor':
        // the whole number at or above (below) x
        if (n === 1 && !this.userFunctions.has(name)) return { s: `${name.toLowerCase()}(${A(0).s})`, p: P.ATOM };
        break;
      case 'solve':
        // solve(f, x, a, b): every root between a and b
        if (n === 4) return { s: `roots(${this.args(t).join(', ')})`, p: P.ATOM };
        // x := solve(f, x) as SMath showed it: each root found again from the value shown
        if (n === 2 && this.solveFrom?.length) {
          const [f, x] = this.args(t);
          const near = (g: string) => `roots(${f}, ${x}, ${g})`;
          return { s: this.solveFrom.length === 1 ? near(this.solveFrom[0]) : `[${this.solveFrom.map(near).join('; ')}]`, p: P.ATOM };
        }
        throw new Unsupported('solve(…) inside an expression');
      case 'line':
      case 'for':
      case 'while':
      case 'try':
        throw new Unsupported('a program inside an expression');
      case 'sys': {
        // a system (SMath's braced list of values or equations) as a value is a column vector
        const items = listItems(t);
        if (!items.length || Number(t.args[t.args.length - 2]?.text) * Number(t.args[t.args.length - 1]?.text) !== items.length) throw new Error('Malformed sys(…)');
        return { s: `[${items.map((a) => this.expr(a).s).join('; ')}]`, p: P.ATOM };
      }
    }
    const fn = this.functionNames[smName(name)] ?? (this.userFunctions.has(smName(name)) ? undefined : FN_MAP[name]) ?? this.name(name);
    return { s: `${fn}(${this.args(t).join(', ')})`, p: P.ATOM };
  }

  // ------------------------------------------------------------ programs

  target(t: Tok): string {
    if (isVar(t) || isUserUnit(t)) return this.name(t.text);
    if (isFn(t, 'el')) return this.expr(t).s;
    if (t.type === 'function') {
      if (!t.args.every(isVar)) throw new Unsupported('a function definition with non-name parameters');
      return `${this.functionNames[smName(t.text)] ?? this.name(t.text)}(${t.args.map((a) => this.name(a.text)).join(', ')})`;
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
          // if without else
          if (a.length === 2) return [`${ind}if ${this.expr(a[0]).s}`, ...this.stmt(a[1], inner)];
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

/**
 * Text as Markdown that shows it as written: only what Markdown would read as formatting is
 * escaped (emphasis, code, links, HTML tags, strike-through), and $ and {{ that start TeX and values.
 */
const mdEscape = (s: string) => s
  .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
  .replace(/[*`]/g, '\\$&')
  .replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_')
  .replace(/\](?=[([:])/g, '\\]')
  .replace(/<(?=[A-Za-z/!?])/g, '\\<')
  .replace(/~(?=~)|(?<=~)~/g, '\\~')
  .replace(/\$/g, '&#36;')
  .replace(/\{(?=\{)/g, '&#123;');

/** A line that does not start a heading, quote or list (#, >, -, +, 1.). */
const mdLine = (s: string) => s.replace(/^(\s*)(#|>|[-+](?=\s)|\d+\.(?=\s))/, (_m, sp: string, mark: string) => `${sp}${mark.replace(/^(\d+)\./, '$1\\.').replace(/^([#>+-])/, '\\$1')}`);

/** Inline formatting of a run of SMath text (an HTML-like style attribute, or the 0.9x p attributes). */
interface Look {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  /** px, as SMath 1.x writes font sizes in text. */
  size?: number;
}

function cssLook(style: string, base: Look): Look {
  const out = { ...base };
  for (const decl of style.split(';')) {
    const [k, v] = decl.split(':').map((x) => x?.trim().toLowerCase() ?? '');
    if (k === 'font-weight') out.bold = v === 'bold' || Number(v) >= 600;
    else if (k === 'font-style') out.italic = v === 'italic';
    else if (k === 'color' && /^#[0-9a-f]{6}$/.test(v)) out.color = v;
    else if (k === 'font-size') {
      const n = parseFloat(v);
      if (n > 0) out.size = /pt/.test(v) ? (n * 4) / 3 : n;
    }
  }
  return out;
}

/** A text region's content: Markdown lines, the formatting they mostly share, and the regions placed inside it. */
interface RichText {
  md: string;
  /** The look of most of the text (characters counted), for the region's style. */
  look: Look;
  /** Math and pictures inside the text (SMath 1.x \[REGION[id]]\), at positions relative to the text. */
  embedded: El[];
}

/**
 * SMath's text: 0.9x writes <p bold="true" italic="true"> paragraphs; 1.x writes <content> with
 * XHTML-like paragraphs (<p style>, <span style>, <br />) and the math or pictures placed in the
 * text under <regions>, marked \[REGION[id]]\ where they stand.
 */
function richText(el: El, base: Look = {}): RichText {
  const content = local(el) === 'content' ? el : child(el, 'content');
  const holder = content ?? el;
  const embeddedById = new Map<string, El>();
  for (const r of kids(child(el, 'regions') ?? el).filter((c) => local(c) === 'region')) embeddedById.set((r.getAttribute('id') ?? '').toLowerCase(), r);
  const embedded: El[] = [];
  // lines of runs; a run is text in one look, or room for a region placed in the text (gap, in em)
  type Run = { text: string; look: Look } | { gap: number };
  const lines: Run[][] = [[]];
  const emit = (text: string, look: Look) => {
    // a region inside the text: room for it here, the region itself is placed on the page
    const parts = text.split(/\\\[REGION\[([0-9a-f]+)\]\]\\/i);
    const cur = lines[lines.length - 1];
    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        if (part) cur.push({ text: part, look });
        return;
      }
      const r = embeddedById.get(part.toLowerCase());
      if (!r) return;
      embedded.push(r);
      cur.push({ gap: Math.max(1, Math.round(Number(r.getAttribute('width') ?? 0) / 13)) });
    });
  };
  const walkInline = (n: XNode, look: Look) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      // white space as HTML collapses it (a no-break space stays)
      if (c.nodeType === 3 || c.nodeType === 4) emit((c.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' '), look);
      else if (c.nodeType === 1) {
        const e = c as El;
        const tag = local(e).toLowerCase();
        if (tag === 'br') lines.push([]);
        else {
          let l = cssLook(e.getAttribute('style') ?? '', look);
          if (tag === 'b' || tag === 'strong') l = { ...l, bold: true };
          if (tag === 'i' || tag === 'em') l = { ...l, italic: true };
          walkInline(e, l);
        }
      }
    }
  };
  const ps = kids(holder).filter((c) => local(c) === 'p');
  const links = new Map<Run[], string>();
  for (const p of ps.length ? ps : [holder]) {
    let look = cssLook(p.getAttribute('style') ?? '', base);
    if (p.getAttribute('bold') === 'true') look = { ...look, bold: true };
    if (p.getAttribute('italic') === 'true') look = { ...look, italic: true };
    if (content) walkInline(p, look);
    else {
      // 0.9x: the line breaks are in the text itself
      (p.textContent ?? '').split(/\r?\n/).forEach((l, i) => {
        if (i) lines.push([]);
        emit(l, look);
      });
      const href = p.getAttribute('href');
      if (href) links.set(lines[lines.length - 1], href);
    }
    lines.push([]);
  }
  // the look of most of the text becomes the region's (counted in characters); bold and
  // italic only when all of it is, else they stay on the words as ** and *
  const texts = lines.flat().filter((r): r is { text: string; look: Look } => 'text' in r && !!r.text.trim());
  const weight = new Map<string, { look: Look; n: number }>();
  for (const r of texts) {
    const key = JSON.stringify([r.look.color, r.look.size]);
    const w = weight.get(key) ?? { look: r.look, n: 0 };
    w.n += r.text.trim().length;
    weight.set(key, w);
  }
  const main = [...weight.values()].sort((a, b) => b.n - a.n)[0]?.look ?? base;
  const allBold = texts.length > 0 && texts.every((r) => r.look.bold);
  const allItalic = texts.length > 0 && texts.every((r) => r.look.italic);
  const render = (runs: Run[]) => {
    // neighbouring runs of the same weight and slant share their ** and *
    const merged: Run[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if ('text' in r && last && 'text' in last && !!last.look.bold === !!r.look.bold && !!last.look.italic === !!r.look.italic) merged[merged.length - 1] = { text: (last.text + r.text).replace(/ {2,}/g, ' '), look: last.look };
      else merged.push(r);
    }
    return merged.map((r) => {
      if ('gap' in r) return '\u2003'.repeat(r.gap);
      const m = /^(\s*)(.*?)(\s*)$/s.exec(r.text)!;
      if (!m[2]) return m[0];
      const b = r.look.bold && !allBold, i = r.look.italic && !allItalic;
      const mark = b && i ? '***' : b ? '**' : i ? '*' : '';
      return `${m[1]}${mark}${mdEscape(m[2])}${mark}${m[3]}`;
    }).join('').trim();
  };
  const out = lines.map((l) => {
    const md = mdLine(render(l));
    const href = links.get(l);
    return href && md ? `[${md}](${href.replace(/[()\s]/g, encodeURIComponent)})` : md;
  });
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  // an empty line keeps its height
  const md = out.map((l) => l || '\u00a0').join('  \n');
  return { md, look: { ...main, bold: allBold || undefined, italic: allItalic || undefined }, embedded };
}

/** A region's own colours and font size (SMath writes them on <region>), as a mathstudii style. */
function regionStyle(r: El, look: Look = {}, defaultSize = 10): RegionStyle | undefined {
  const st: RegionStyle = {};
  const color = look.color ?? (r.getAttribute('color') ?? '').toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color) && color !== '#000000') st.color = color;
  const bg = (r.getAttribute('bgColor') ?? '').toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(bg) && bg !== '#ffffff') st.background = bg;
  // SMath sizes are points (10 is the default); text sizes in px
  const pt = look.size ? (look.size * 3) / 4 : Number(r.getAttribute('fontSize') ?? defaultSize);
  if (pt > 0 && Math.abs(pt - defaultSize) > 0.01) st.fontScale = Math.round((pt / defaultSize) * 100) / 100;
  if (look.bold) st.bold = true;
  if (look.italic) st.italic = true;
  return Object.keys(st).length ? st : undefined;
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

/** SMath's order of calculation: top to bottom, then left to right. */
const readingSort = (list: Placed[]) => list.sort((a, b) => (Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y));

/**
 * SMath keeps a name it does not know yet as a symbol and calculates it where the value is used.
 * A value defined before definitions beside it on the same line that it reads (Q₀ := −F with
 * F := 2 kN to its right, N[1] := m·g·sin(φ[1]) a little above φ[1] := 0) is placed just under
 * them, so that it is calculated after them; not when a region it would move past reads it.
 */
function sameRowOrder(placed: Placed[]): Placed[] {
  const toks = new Map<Placed, Tok[]>();
  for (const at of placed) {
    const body = regionKinds(at.region)[0];
    let t: Tok[] = [];
    if (body && local(body) === 'math' && body.getAttribute('evaluate') !== 'false') {
      try {
        t = parseRpn(child(body, 'input'));
      } catch {
        /* reported where it is converted */
      }
    }
    toks.set(at, t);
  }
  const defs = (at: Placed) => toks.get(at)!.flatMap(worksheetDefines);
  const reads = (at: Placed) => {
    const s = new Set<string>();
    for (const t of toks.get(at)!) namesUsed(t, s);
    return s;
  };
  for (const at of [...placed]) {
    const t = toks.get(at)![0];
    if (!t || toks.get(at)!.length !== 1 || !isOp(t, ':') || !(isVar(t.args[0]) || isFn(t.args[0], 'el'))) continue;
    const i = placed.indexOf(at);
    const own = new Set(defs(at)), bound = boundNames(t);
    const before = new Set(placed.slice(0, i).flatMap(defs));
    const late = [...reads(at)].filter((n) => !own.has(n) && !bound.has(n) && !before.has(n));
    if (!late.length) continue;
    const bottom = at.y + num(at.region, 'height');
    let target: Placed | null = null;
    for (let j = i + 1; j < placed.length && placed[j].y < bottom; j++) if (defs(placed[j]).some((n) => late.includes(n))) target = placed[j];
    if (!target) continue;
    const was = at.y, after = new Set(placed.slice(i + 1));
    at.y = target.y + 4;
    readingSort(placed);
    const passed = placed.slice(0, placed.indexOf(at)).filter((p) => after.has(p));
    if (!passed.includes(target) || passed.some((p) => [...reads(p)].some((n) => own.has(n)))) {
      at.y = was;
      readingSort(placed);
    }
  }
  return placed;
}

interface Placed {
  region: El;
  x: number;
  y: number;
  /** An area: the lowest bottom of the regions in it (page px). */
  areaBottom?: number;
  /** A region placed inside a text (SMath 1.x): its text region. */
  inText?: El;
}

const num = (e: El, a: string) => Number(e.getAttribute(a) ?? 0) || 0;

/**
 * Regions in reading order. Collapsible areas hold their regions as children, with page
 * coordinates; a text of SMath 1.x holds the math and pictures written inside it, placed
 * relative to the text.
 */
function flatten(container: El): Placed[] {
  const out: Placed[] = [];
  for (const r of kids(container).filter((c) => local(c) === 'region')) {
    const nested = kids(r).filter((c) => local(c) === 'region');
    const body = kids(r).find((c) => local(c) !== 'region');
    const at = { region: r, x: num(r, 'left'), y: num(r, 'top') };
    if (body && local(body) === 'area') {
      if (!nested.length) continue;
      const inside = flatten(r);
      out.push({ ...at, areaBottom: Math.max(...inside.map((q) => q.y + (q.areaBottom !== undefined ? q.areaBottom - q.y : num(q.region, 'height')))) }, ...inside);
      continue;
    }
    if (nested.length) out.push(...flatten(r));
    if (!body) continue;
    out.push(at);
    if (local(body) === 'text') {
      const t = pickLang(kids(r).filter((c) => local(c) === 'text'));
      const holder = t && child(t, 'regions');
      if (holder) for (const e of kids(holder).filter((c) => local(c) === 'region')) out.push({ region: e, x: at.x + num(e, 'left'), y: at.y + num(e, 'top'), inText: r });
    }
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
  const calcSetting = (name: string) => (calc && child(calc, name)?.textContent?.trim()) || undefined;
  const prec = Number(calc && child(calc, 'precision')?.textContent);
  if (prec >= 0 && prec <= 15) ws.settings.precision = prec;
  const thr = Number(calc && child(calc, 'exponentialThreshold')?.textContent);
  if (thr > 0 && thr <= 15) ws.settings.expThreshold = thr;
  // a print layout with header and footer prints a header here too, with the document's title and author
  const settingsEl = child(root, 'settings') ?? root;
  const meta = pickLang(kids(settingsEl).filter((c) => local(c) === 'metadata'));
  const metaTitle = meta && child(meta, 'title')?.textContent?.trim();
  const metaAuthor = meta && child(meta, 'author')?.textContent?.trim();
  const pageModel = child(settingsEl, 'pageModel');
  if (pageModel?.getAttribute('active') === 'true') {
    const header = child(pageModel, 'header')?.textContent ?? '', footer = child(pageModel, 'footer')?.textContent ?? '';
    if (header.trim() || footer.trim()) {
      ws.settings.report = { enabled: true, ...(metaTitle ? { subject: metaTitle } : {}), ...(metaAuthor ? { author: metaAuthor } : {}) };
      const own = (t: string) => t.replace(/&(amp;)*\[(DATE|TIME|FILENAME|PAGENUM|COUNT|FILEPATH)\]/g, '').replace(/[\s\-/|]+/g, ' ').trim();
      if (own(header) || own(footer)) warnings.push(`the page header and footer print as mathstudii's (title, author, date, page numbers); SMath's own text in them (${[own(header), own(footer)].filter(Boolean).join('; ')}) is not repeated`);
    }
  }

  const placed = sameRowOrder(readingSort(flatten(regionsEl)));

  // pass 1: parse every formula once; collect what each region reads and what the worksheet assigns
  const inputs = placed.map((at) => {
    const body = regionKinds(at.region)[0];
    const kind = body ? local(body) : '';
    try {
      if (kind === 'math' || kind === 'plot' || kind === 'xyplot') return parseRpn(child(body!, 'input'));
    } catch {
      /* reported in pass 2 */
    }
    return [] as Tok[];
  });
  // SMath tells a function from a variable of the same name by its arguments (v(Q, d, h) and
  // v := v(Q, d, h_min)): here the function gets a name of its own
  {
    const fns = new Set<string>(), vars = new Set<string>();
    for (const toks of inputs) for (const t of toks) {
      if (isOp(t, ':') && t.args[0].type === 'function' && !isFn(t.args[0], 'el')) fns.add(smName(t.args[0].text));
      else for (const n of worksheetDefines(t)) vars.add(n);
    }
    conv.userFunctions = fns;
    const both = [...fns].filter((n) => vars.has(n));
    for (const n of both) conv.functionNames[n] = `${n}_fn`;
    if (both.length) warnings.push(`${both.join(', ')} ${both.length > 1 ? 'are' : 'is'} both a function and a variable in SMath, which tells them apart by their arguments: the function${both.length > 1 ? 's are' : ' is'} ${both.map((n) => `${n}_fn`).join(', ')} here`);
  }
  // units the worksheet defines (k.1 := 17.5 N/mm) are variables of that name
  for (const toks of inputs) for (const t of toks) if (isOp(t, ':') && isUserUnit(t.args[0])) conv.userUnits.add(t.args[0].text);
  const used = inputs.map((toks, i) => {
    const s = new Set<string>();
    const body = regionKinds(placed[i].region)[0];
    const shown = !!body && !!child(body, 'result');
    for (const t of toks) {
      // a formula shown for documentation reads nothing
      if (isOp(t, '≡') && !shown) continue;
      namesUsed(t, s, conv.userUnits);
    }
    // x in a plot is the plot's own variable
    if (body && (local(body) === 'plot' || local(body) === 'xyplot')) s.delete('x');
    return s;
  });
  for (const toks of inputs) {
    for (const t of toks) {
      for (const n of assignments(t).all) conv.assigned.add(n);
      if (isOp(t, ':') && t.args[0].type === 'function' && !isFn(t.args[0], 'el')) for (const p of t.args[0].args) if (isVar(p)) conv.assigned.add(smName(p.text));
    }
  }
  // SMath collects plot items in a variable a plot draws: plotter := sys(a, b, c, n, 1)
  const plotted = new Set<string>();
  inputs.forEach((toks, i) => {
    const body = regionKinds(placed[i].region)[0];
    if (!body || !/^(plot|xyplot)$/.test(local(body))) return;
    const items = (t: Tok): Tok[] => (isFn(t, 'sys') ? listItems(t).flatMap(items) : [t]);
    for (const t of toks) for (const it of items(t)) if (isVar(it)) plotted.add(smName(it.text));
  });
  const plotLists = new Map<string, Tok[]>();
  const hasStrings = new Set<string>();
  for (const toks of inputs) {
    const t = toks[0];
    if (!t || !isOp(t, ':')) continue;
    const name = targetName(t.args[0]);
    if (!name) continue;
    if (isFn(t.args[1], 'sys') && isVar(t.args[0]) && plotted.has(name)) plotLists.set(name, listItems(t.args[1]));
    walk(t.args[1], (n) => {
      if (n.style === 'string') hasStrings.add(name);
    });
  }
  // where each name is last defined on the worksheet, to tell names defined further down
  const lastDefined = new Map<string, number>();
  const disabled = (at: Placed) => {
    const body = regionKinds(at.region)[0];
    return body?.getAttribute('evaluate') === 'false' || at.region.getAttribute('evaluate') === 'false';
  };
  inputs.forEach((toks, i) => {
    if (!disabled(placed[i])) for (const t of toks) for (const n of worksheetDefines(t)) lastDefined.set(n, i);
  });
  const lazyNotes: string[] = [];
  // functions only a plugin or SMath's computer has: say once which, and how many regions use them
  {
    const defined = new Set<string>();
    for (const toks of inputs) for (const t of toks) if (isOp(t, ':') && t.args[0].type === 'function' && !isFn(t.args[0], 'el')) defined.add(t.args[0].text);
    const hits = ELSEWHERE.map(() => ({ names: new Set<string>(), regions: 0 }));
    inputs.forEach((toks) => {
      const seen = new Set<number>();
      for (const t of toks) walk(t, (n) => {
        if (n.type !== 'function' || defined.has(n.text)) return;
        const k = ELSEWHERE.findIndex((e) => e.test.test(n.text));
        if (k < 0) return;
        hits[k].names.add(n.text);
        seen.add(k);
      });
      for (const k of seen) hits[k].regions++;
    });
    hits.forEach((h, k) => {
      if (!h.regions) return;
      const names = [...h.names];
      warnings.push(`${h.regions} region${h.regions > 1 ? 's use' : ' uses'} ${ELSEWHERE[k].what} (${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}): ${h.regions > 1 ? 'they and what depends on them are' : 'it and what depends on it is'} not calculated`);
    });
    const lastError = inputs.some((toks) => toks.some((t) => { let found = false; walk(t, (n) => { if (isVar(n) && n.text === 'lastError') found = true; }); return found; }));
    if (lastError) warnings.push('lastError (the message of the last error SMath or a plugin reported) is not available here');
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
    const msg = e instanceof Unsupported ? `uses ${e.message}, which mathstudii cannot import yet`
      : e instanceof Placeholder ? 'has an empty placeholder (■), so SMath does not calculate it either'
      : (e as Error).message;
    warnings.push(`${what} at ${Math.round(at.y)} px: ${msg}`);
    regions.push(createRegion('text', at.x, at.y, { markdown: `⚠️ *Not imported (${what}):* ${msg}`, width: 300 }));
  };
  let plotRanges = 0;
  let maximaPlots = 0;

  const areas: { area: Region; collapsed: boolean }[] = [];
  const lostLook = { borders: 0, fonts: new Set<string>(), numberFormats: 0 };
  placed.forEach((at, i) => {
    const r = at.region;
    const body = regionKinds(r)[0];
    if (!body) return;
    const kind = local(body);
    const width = Number(r.getAttribute('width') ?? 0);
    const first = regions.length;
    // formatting there is no place for here, counted for the report
    if (r.getAttribute('border') === 'true') lostLook.borders++;
    if (kind === 'text') {
      const fonts = new Set<string>();
      for (const e of [body, ...body.getElementsByTagName('*')] as El[]) {
        const f = e.getAttribute('fontFamily') ?? /font-family:\s*([^;]+)/i.exec(e.getAttribute('style') ?? '')?.[1];
        if (f) fonts.add(f.replace(/['"]/g, '').split(',')[0].trim());
      }
      for (const f of fonts) if (!/^(arial|times new roman|segoe ui|tahoma|verdana|calibri|liberation sans|helvetica)$/i.test(f)) lostLook.fonts.add(f);
    }
    if (kind === 'math') {
      const dp = body.getAttribute('decimalPlaces');
      if ((dp && Number(dp) !== ws.settings.precision) || body.getAttribute('significantDigitsMode') === 'true') lostLook.numberFormats++;
    }
    try {
      if (at.areaBottom !== undefined) {
        // SMath keeps an area's regions at their places when it is expanded; collapsed after the layout is fitted
        const title = pickLang(kids(body).filter((c) => local(c) === 'title'));
        const area = createRegion('area', at.x, at.y, { title: title ? richText(title).md.replace(/\s*\n\s*/g, ' ') : '', height: Math.max(AREA_BAR, at.areaBottom - at.y + AREA_PAD) });
        regions.push(area);
        areas.push({ area, collapsed: body.getAttribute('collapsed') === 'true' || body.getAttribute('isCollapsed') === 'true' });
        return;
      }
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
        // a unit SMath could not show the value in leaves the rest beside it (G = mS shows 0.5 mS·1/m)
        const rest = contract && result && action !== 'symbolic' ? leftoverUnit(conv, result) : '';
        const unit = contract && !conv.ignoreUnits ? ` ${withLeftover(conv.displayUnit(contract), rest)}` : '';
        const show = result ? (action === 'symbolic' ? ' →' : ` =${unit}`) : '';

        if (isOp(t, ':') && isFn(t.args[1], 'sys') && plotLists.has(targetName(t.args[0]) ?? '')) {
          const name = conv.target(t.args[0]);
          regions.push(createRegion('text', at.x, at.y, {
            markdown: `\`${name}\` is an SMath list of plot items (${listItems(t.args[1]).map((a) => conv.expr(a).s).join(', ')}); the plot draws them directly.`,
            width: Math.max(220, width),
          }));
        } else if (isOp(t, ':')) {
          let lhs = conv.target(t.args[0]);
          const rhs = t.args[1];
          // names this definition reads that are only defined further down, or nowhere: SMath keeps
          // them as symbols and calculates when the value is used, so it becomes a function of them
          const late: string[] = [];
          const name = isVar(t.args[0]) ? smName(t.args[0].text) : null;
          // a number SMath showed for it: every name had a value there (or did not matter)
          let numeric = false;
          if (result && action !== 'symbolic') {
            numeric = true;
            for (const r of parseRpn(result)) walk(r, (n) => {
              if (isVar(n)) numeric = false;
            });
          }
          if (name && !numeric) {
            const bound = boundNames(rhs);
            const unitOperand = (m: string) => !lastDefined.has(m) && unitWord(conv.name(m));
            const add = (n: string) => {
              if (!late.includes(n)) late.push(n);
            };
            walk(rhs, (n) => {
              if (n.type !== 'operand' || !isVar(n)) return;
              const m = smName(n.text);
              if (bound.has(m)) return;
              const waits = conv.lazy.get(m);
              if (waits) for (const p of waits) if (!definedBefore.has(p) && !bound.has(p)) add(p);
              // defined further down, or nowhere on the worksheet (a symbol, as in σ(φ) := … cos(2·φ) solved for φ later)
              if (!waits && m !== name && !definedBefore.has(m) && !SYMBOLS.has(m) && !unitOperand(m) && (lastDefined.get(m) ?? Infinity) > i) add(m);
            });
          }
          // a program shows its value with "x := =" (in the unit it has)
          conv.solveFrom = isFn(rhs, 'solve') && rhs.args.length === 2 && result && action !== 'symbolic' ? shownRoots(conv, result) : null;
          const rhsSrc = isProgram(rhs) ? `${!late.length && show === ' =' ? ' =' : ''}\n${conv.stmt(rhs, '  ').join('\n')}` : ` ${conv.expr(rhs).s}`;
          conv.solveFrom = null;
          if (name) conv.lazy.delete(name);
          if (late.length && name) {
            lhs = `${lhs}(${late.map((n) => conv.name(n)).join(', ')})`;
            conv.lazy.set(name, late.map((n) => conv.name(n)));
            lazyNotes.push(lhs);
          }
          const src = `${lhs} :=${rhsSrc}${!late.length && !isProgram(rhs) && show && !show.includes('→') ? show : ''}`;
          regions.push(createRegion('math', at.x, at.y, { source: src }));
        } else if (isProgram(t)) {
          regions.push(...topLevelProgram(conv, t, at, usedAfter(i), definedBefore, show === ' ='));
        } else if (!result && isOp(t, '≈')) {
          // "R ≈ 14.02 Ω" is a note of a rounded value: text here (≈ calculates nothing)
          const [l, rr] = t.args.map((a) => conv.expr(a).s);
          regions.push(createRegion('text', at.x, at.y, { markdown: mdLine(`${mdEscape(l)} ≈ ${mdEscape(rr)}`), width: Math.max(120, width + 20) }));
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
            const value = conv.shownValue(tok);
            // the result has its unit when SMath chose it, else it is a number in the display unit
            let hasUnit = false;
            walk(tok, (n) => { if (n.style === 'unit') hasUnit = true; });
            // rounded to the digits shown: half a unit in the last significant digit. In SMath's
            // significant-digits mode zeros ending a whole number are rounding (11330 is 11333.3 to 4
            // digits, 1220 is 1225 to 3, rounded half to even), so the precision set counts there
            const mantissa = /\d[\d.]*/.exec(value)?.[0] ?? '';
            const sig = (m: string) => m.replace('.', '').replace(/^0+/, '').length || 1;
            const sigMode = (body.getAttribute('significantDigitsMode') ?? calcSetting('significantDigitsMode')) === 'true';
            const places = Number(body.getAttribute('decimalPlaces') ?? calcSetting('precision') ?? 4) || 4;
            const digits = sigMode && !mantissa.includes('.') && /[1-9]0+$/.test(mantissa) ? Math.max(sig(mantissa.replace(/0+$/, '')), Math.min(places, sig(mantissa))) : sig(mantissa);
            const shownIn = unit.trim() === '%' ? '1/100' : contract ? conv.displayUnit(contract, true) : '';
            // a temperature shown in °C is that temperature (27 °C is 300.15 K), not 27 K
            const absolute = !!contract && contract.type === 'operand' && contract.style === 'unit' && ABSOLUTE_TEMPERATURE.has(contract.text);
            const expr = !shownIn || (hasUnit && !rest) ? value : absolute ? `(${value} ${shownIn} to K)` : `(${value})*(${shownIn})`;
            // a big matrix is saved as the rows and columns in view (matrixOptions: first row, first column, columns, rows)
            const view = /^(\d+),(\d+),(\d+),(\d+)$/.exec(body.getAttribute('matrixOptions') ?? '');
            const window = view ? { row: +view[1], col: +view[2], cols: +view[3], rows: +view[4] } : undefined;
            saved.push({ regionId: last.id, expr, tol: Math.max(1e-4, 0.5 * 10 ** (1 - digits)), ...(window ? { window } : {}) });
          } catch {
            /* a result we cannot read (a matrix of text, a placeholder) is not compared */
          }
        }
        // worksheet-level names only: locals of a function's program stay local
        if (disabled(at)) {
          /* defines nothing */
        } else if (isFn(t, 'Clear')) {
          // Clear(x, y): from here they are undefined again (symbols, fresh vectors)
          for (const a of t.args) if (isVar(a)) definedBefore.delete(smName(a.text));
        } else if (isOp(t, ':')) {
          const n = targetName(t.args[0]);
          if (n && (isVar(t.args[0]) || isUserUnit(t.args[0]) || isFn(t.args[0], 'el'))) definedBefore.add(n);
        } else if (isProgram(t)) for (const n of assignments(t).all) definedBefore.add(n);

        // a comment attached to the formula
        // the region's colours and size; a region SMath does not calculate stays so
        const look = regionStyle(r);
        const off = disabled(at);
        for (let k = first; k < regions.length; k++) {
          if (regions[k].kind !== 'math') continue;
          if (look) regions[k].style = look;
          if (off) regions[k].disabled = true;
        }
        // a comment attached to the formula
        const desc = pickLang(kids(body).filter((c) => local(c) === 'description' && c.getAttribute('active') !== 'false'));
        const note = desc ? richText(desc) : null;
        if (note?.md) {
          // SMath shows it beside the formula (position="Right") or above it
          const above = /^top$/i.test(desc!.getAttribute('position') ?? '');
          const style = regionStyle(r, { ...note.look, italic: true });
          regions.push(createRegion('text', above ? at.x : at.x + Math.max(60, width) + 16, above ? Math.max(0, at.y - 18) : at.y, { markdown: note.md, width: 220, ...(style ? { style } : {}) }));
        }
      } else if (kind === 'text') {
        const t = pickLang(regionKinds(r).filter((c) => local(c) === 'text'));
        const size = Number(t?.getAttribute('fontSize') ?? r.getAttribute('fontSize') ?? 10) || 10;
        const rich = t ? richText(t, { size: (size * 4) / 3 }) : null;
        if (rich?.md) {
          const style = regionStyle(r, rich.look);
          regions.push(createRegion('text', at.x, at.y, { markdown: rich.md, width: Math.max(120, width + 20), ...(style ? { style } : {}) }));
        }
      } else if (kind === 'picture' || kind === 'image') {
        // a picture region, or the Image plugin's (its file kept in the worksheet)
        const raw = kind === 'picture' ? child(body, 'raw') : child(body, 'imagefile');
        const fmt = (kind === 'picture' ? raw?.getAttribute('format') ?? 'png' : (raw?.getAttribute('filename') ?? '.png').replace(/^.*\./, '')).toLowerCase();
        regions.push(imageRegion(raw, fmt, at, width));
      } else if (kind === 'maximaplugin') {
        // the Maxima plugin's plot: the picture Maxima drew (the plot itself needs Maxima)
        const raw = child(body, 'ImageFile');
        if (!raw?.textContent?.trim()) throw new Unsupported('a Maxima plugin region with no saved picture (it needs the Maxima plugin)');
        regions.push(imageRegion(raw, (raw.getAttribute('FileName') ?? '.png').replace(/^.*\./, '').toLowerCase(), at, width));
        maximaPlots++;
      } else if (kind === 'writer') {
        // the Writer plugin's rich text (HTML)
        const xmlDoc = new DOMParser({ onError: () => {} }).parseFromString(`<content>${htmlAsXml(body.textContent ?? '')}</content>`, 'text/xml');
        const rich = xmlDoc.documentElement ? richText(xmlDoc.documentElement) : null;
        if (rich?.md) {
          const style = regionStyle(r, rich.look);
          regions.push(createRegion('text', at.x, at.y, { markdown: rich.md, width: Math.max(120, width + 20), ...(style ? { style } : {}) }));
        }
      } else if (kind === 'slider') {
        // an input control: the variable keeps the value the slider was set to
        const name = parseRpn(child(body, 'input'))[0];
        if (!name || !isVar(name)) throw new Unsupported('a slider with no variable');
        regions.push(createRegion('math', at.x, at.y, { source: `${conv.name(name.text)} := ${number(body.getAttribute('value') ?? '0')}`, input: true }));
        definedBefore.add(smName(name.text));
        warnings.push(`slider at ${Math.round(at.y)} px: imported as ${conv.name(name.text)} := ${body.getAttribute('value')} (the value it was set to, ${body.getAttribute('minValue')}…${body.getAttribute('maxValue')}); mathstudii has no slider, so edit the number`);
      } else if (kind === 'plot') {
        regions.push(plot(conv, body, at, width, Number(r.getAttribute('height') ?? 0), definedBefore, plotLists, hasStrings));
        plotRanges++;
      } else if (kind === 'xyplot') {
        regions.push(xyPlot(conv, body, at, definedBefore, plotLists, hasStrings));
      } else {
        throw new Unsupported(PLUGIN_REGIONS[kind] ?? `the “${kind}” region (an SMath plugin)`);
      }
    } catch (e) {
      fail(kind === 'math' ? 'math' : kind, e, at);
    }
  });
  for (const note of conv.displayNotes) warnings.push(note);
  const sigDigits = calcSetting('significantDigitsMode') === 'true';
  const looks = [
    lostLook.borders ? `borders round ${lostLook.borders} region${lostLook.borders > 1 ? 's' : ''}` : '',
    lostLook.fonts.size ? `the fonts ${[...lostLook.fonts].slice(0, 4).join(', ')} (texts use the worksheet font)` : '',
    lostLook.numberFormats ? `the number format of ${lostLook.numberFormats} formula${lostLook.numberFormats > 1 ? 's' : ''} (results use the worksheet's ${ws.settings.precision} decimal places)` : '',
    sigDigits ? `significant digits: SMath rounds results to ${ws.settings.precision} significant digits, here to ${ws.settings.precision} decimal places` : '',
  ].filter(Boolean);
  if (looks.length) warnings.push(`formatting not kept: ${looks.join('; ')}`);
  if (maximaPlots) warnings.push(`${maximaPlots} Maxima plot${maximaPlots > 1 ? 's are' : ' is'} shown as the picture${maximaPlots > 1 ? 's' : ''} Maxima drew: the Maxima plugin is not part of mathstudii, so ${maximaPlots > 1 ? 'they are' : 'it is'} not redrawn when values change`);
  if (lazyNotes.length) {
    warnings.push(`${lazyNotes.length} definition${lazyNotes.length > 1 ? 's read names' : ' reads names'} defined only further down or not at all (${lazyNotes.slice(0, 4).join(', ')}${lazyNotes.length > 4 ? ' …' : ''}): SMath keeps such names as symbols and calculates when the value is used, so here each is a function of them, called with the values they have where it is used`);
  }
  if (plotRanges) warnings.push(`${plotRanges} plot${plotRanges > 1 ? 's' : ''}: SMath stores a view (zoom and pan), not axis limits, so the axes start from automatic ranges`);

  fitToPage(regions);
  ws.regions = regions;
  // collapse the areas SMath had collapsed, inner ones first (what is below moves up)
  let out = ws;
  for (const { area } of areas.filter((a) => a.collapsed).reverse()) out = collapseArea(out, area.id);
  return { ws: out, warnings, format: 'SMath Studio (.sm)', saved };
}

/** SMath plugin regions that are not converted, as the import report names them. */
const PLUGIN_REGIONS: Record<string, string> = {
  table: 'a region of the Table plugin (a formatted table of values and text)',
  snapshot: 'a Snapshot region (a picture of other regions that SMath draws while it runs; the file keeps no picture)',
  mathcadblock: 'a solve block of the Mathcad Toolbox plugin (its equations are imported as formulas to read, the solution is not calculated)',
};

/** HTML of the Writer plugin as XML: void elements closed, entities XML does not know as characters. */
function htmlAsXml(html: string): string {
  const named: Record<string, string> = { nbsp: '\u00a0', ndash: '–', mdash: '—', laquo: '«', raquo: '»', deg: '°', middot: '·', copy: '©', hellip: '…' };
  return html
    .replace(/<(br|img|hr|input|meta|link|col|area|wbr)\b([^>]*?)\/?>/gi, '<$1$2/>')
    .replace(/<\/?div[^>]*>/gi, '<br/>')
    .replace(/&([a-z]+);/gi, (m, n: string) => (/^(amp|lt|gt|quot|apos)$/i.test(n) ? m : named[n.toLowerCase()] ?? ''));
}

/** An image from base64 data (a picture, the Image plugin, a Maxima plot). */
function imageRegion(raw: El | undefined, fmt: string, at: Placed, width: number): Region {
  const b64 = (raw?.textContent ?? '').replace(/\s+/g, '');
  if (!b64) throw new Error(`the picture is not in the file${raw?.getAttribute('filename') ? ` (it was ${raw.getAttribute('filename')})` : ''}: SMath showed it from a file or an expression`);
  if (/emf|wmf/.test(fmt)) throw new Unsupported(`a ${fmt.toUpperCase()} image (browsers cannot display it)`);
  const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : fmt === 'gif' ? 'image/gif' : fmt === 'bmp' ? 'image/bmp' : fmt === 'svg' ? 'image/svg+xml' : 'image/png';
  return createRegion('image', at.x, at.y, { src: `data:${mime};base64,${b64}`, width: Math.min(PAGE_WIDTH - 2 * PAGE_MARGIN, width || 240) });
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
function topLevelProgram(conv: Converter, t: Tok, at: Placed, later: Set<string>, before: Set<string>, shown = false): Region[] {
  const { all, element, counters } = assignments(t);
  if (!all.length) throw new Unsupported('a program that assigns no variable');
  let keep = all.filter((n) => later.has(n) && !counters.has(n));
  if (!keep.length) keep = [all.filter((n) => !counters.has(n)).pop() ?? all[all.length - 1]];
  const body = conv.stmt(t, '  ');
  // element assignments must start from the existing value, not from an empty local
  const seed = [...element].filter((n) => before.has(n)).map((n) => `  ${n} ← ${n}`);
  if (keep.length === 1) {
    // the value SMath showed is the one the program leaves
    return [createRegion('math', at.x, at.y, { source: `${keep[0]} :=${shown ? ' =' : ''}\n${[...seed, ...body, `  return ${keep[0]}`].join('\n')}` })];
  }
  const tmp = conv.helperName();
  const ret = `  return {${keep.map((v) => `${JSON.stringify(v)}: ${v}`).join(', ')}}`;
  // 1 px apart keeps reading order; "separate regions" spreads them out after import
  return [
    createRegion('math', at.x, at.y, { source: `${tmp} :=\n${[...seed, ...body, ret].join('\n')}` }),
    ...keep.map((v, k) => createRegion('math', at.x, at.y + k + 1, { source: `${v} := ${tmp}.${v}` })),
  ];
}

/** The items a plot draws: sys(…) lists and variables holding them expanded; text labels left out (with a note). */
function plotItems(conv: Converter, input: Tok, at: Placed, lists: Map<string, Tok[]>, hasStrings: Set<string>): Tok[] {
  const expand = (t: Tok): Tok[] => {
    if (isFn(t, 'sys')) return listItems(t).flatMap(expand);
    if (isVar(t) && lists.has(smName(t.text))) return lists.get(smName(t.text))!.flatMap(expand);
    return [t];
  };
  const items = expand(input).filter((t) => {
    // text labels ([x, y, "text", size, colour] rows) have no counterpart here
    if (isVar(t) && hasStrings.has(smName(t.text))) {
      conv.warnings.push(`Plot at ${Math.round(at.y)} px: the text labels in “${smName(t.text)}” are not drawn`);
      return false;
    }
    return true;
  });
  if (!items.length) throw new Unsupported('a plot of text labels only');
  return items;
}

/**
 * Traces of plot items: a function of the plot variable v is drawn over the x-axis, a number
 * as a level line, anything else as a matrix of points (column 1 x, column 2 y).
 */
function plotTraces(conv: Converter, items: Tok[], v: string, xv: string): { xExpr: string; traces: PlotTrace[] } {
  conv.rename = xv === v ? {} : { [v]: xv };
  try {
    const traces: PlotTrace[] = [];
    let hasFunction = false;
    for (const it of items) {
      let usesX = false;
      walk(it, (n) => {
        if (n.type === 'operand' && !n.style && smName(n.text) === v) usesX = true;
        // a definition waiting for the plot variable (σ(φ) := …)
        if (n.type === 'operand' && isVar(n) && conv.lazy.get(smName(n.text))?.includes(v)) usesX = true;
      });
      const e = conv.expr(it).s;
      if (usesX || (it.type === 'operand' && NUMBER.test(it.text))) {
        hasFunction ||= usesX;
        traces.push({ y: e, style: 'line' });
      } else {
        traces.push({ xExpr: `col(${e}, 1)`, y: `col(${e}, 2)`, style: 'line' });
      }
    }
    let xExpr = xv;
    if (!hasFunction && traces[0]?.xExpr) {
      xExpr = traces[0].xExpr;
      delete traces[0].xExpr;
    }
    return { xExpr, traces };
  } finally {
    conv.rename = {};
  }
}

function plot(
  conv: Converter, body: El, at: Placed, width: number, height: number,
  before: Set<string>, lists: Map<string, Tok[]>, hasStrings: Set<string>,
): Region {
  if ((body.getAttribute('type') ?? '2d') !== '2d') throw new Unsupported('a 3-D plot');
  const toks = parseRpn(child(body, 'input'));
  if (toks.length !== 1) throw new Error('the plot has no formula');
  const items = plotItems(conv, toks[0], at, lists, hasStrings);
  // SMath plots functions of x; if x is already a worksheet variable, use another name
  const { xExpr, traces } = plotTraces(conv, items, 'x', before.has('x') ? 'x_plot' : 'x');
  return createRegion('plot', at.x, at.y, {
    xExpr, traces,
    width: Math.max(200, width || 300), height: Math.max(150, height || 240),
  });
}

/** The unit factor of a value SMath showed beside its display unit (0.5·1/m for G = mS), or "". */
function leftoverUnit(conv: Converter, result: El): string {
  let tok = parseRpn(result)[0];
  if (tok && isOp(tok, '-') && tok.args.length === 1) tok = tok.args[0];
  if (!tok || !isOp(tok, '*') || tok.args.length !== 2) return '';
  const [a, b] = tok.args;
  let plain = true;
  walk(a, (n) => {
    if (n.style === 'unit' || isVar(n) || n.type === 'function') plain = false;
  });
  return plain && conv.unitOnly(b) ? conv.displayUnit(b, true) : '';
}

/** A display unit with the factor SMath left beside it: mS and 1/m make mS/m. */
function withLeftover(unit: string, rest: string): string {
  if (!rest) return unit;
  const per = /^1\/(.+)$/.exec(rest);
  if (per) return `${unit}/${/^[\p{L}_]\w*$/u.test(per[1]) ? per[1] : `(${per[1]})`}`;
  return `${unit}*${/^[\p{L}_][\w^]*$/u.test(rest) ? rest : `(${rest})`}`;
}

/** The values SMath showed for solve(f, x): one root, or a column of them (none when it is not numbers). */
function shownRoots(conv: Converter, result: El): string[] | null {
  const tok = parseRpn(result)[0];
  if (!tok) return null;
  const items = isFn(tok, 'mat') ? listItems(tok) : [tok];
  let symbolic = false;
  for (const it of items) walk(it, (n) => {
    if (isVar(n)) symbolic = true;
  });
  return symbolic ? null : items.map((it) => conv.shownValue(it));
}

/** .NET colour names of the X-Y Plot plugin as CSS colours (black stays the default). */
const plotColor = (c: string | null) => (c && c.toLowerCase() !== 'black' && /^[a-z]+$/i.test(c) ? c.toLowerCase() : undefined);

/**
 * The X-Y Plot plugin (JXCharts): functions of one variable over the x-axis it saves, matrices
 * of points, level lines; axis limits, trace colours and styles, title and axis labels.
 */
function xyPlot(conv: Converter, body: El, at: Placed, before: Set<string>, lists: Map<string, Tok[]>, hasStrings: Set<string>): Region {
  const toks = parseRpn(child(body, 'input'));
  if (toks.length !== 1) throw new Error('the plot has no formula');
  const items = plotItems(conv, toks[0], at, lists, hasStrings);
  // the plot variable: the name its functions read that the worksheet does not define (x when several)
  const free = new Set<string>();
  for (const it of items) walk(it, (n) => {
    if (n.type !== 'operand' || !isVar(n) || SYMBOLS.has(n.text)) return;
    const m = smName(n.text);
    const late = conv.lazy.get(m);
    if (late) for (const p of late) if (!before.has(p)) free.add(p);
    if (!late && !before.has(m) && !unitWord(conv.name(m))) free.add(m);
  });
  const v = free.has('x') || !free.size ? 'x' : [...free][0];
  if (free.size > 1) conv.warnings.push(`X-Y plot at ${Math.round(at.y)} px: its functions read ${[...free].join(', ')}, which have no value above it; ${v} is taken as the plot variable`);
  const xv = before.has(v) && v === 'x' ? 'x_plot' : v;
  const { xExpr, traces } = plotTraces(conv, items, v, xv);
  // the plugin's trace settings, in the order of the items
  const settings = kids(child(body, 'traces') ?? body).filter((c) => local(c) === 'trace');
  let labels = 0;
  traces.forEach((t, k) => {
    const s = settings[k];
    if (!s) return;
    const method = (s.getAttribute('plotmethod') ?? 'Lines').toLowerCase();
    if (method === 'labels') labels++;
    const symbols = (s.getAttribute('symboltype') ?? 'None') !== 'None';
    t.style = method === 'points' || method === 'scatter' ? 'points' : symbols ? 'both' : method === 'bars' ? 'bar' : method === 'steps' ? 'step' : 'line';
    const color = plotColor(s.getAttribute('linecolor'));
    if (color) t.color = color;
  });
  if (labels) conv.warnings.push(`X-Y plot at ${Math.round(at.y)} px: ${labels} trace${labels > 1 ? 's' : ''} of text labels ${labels > 1 ? 'are' : 'is'} drawn as points`);
  const ax = child(body, 'xaxes'), ay = child(body, 'yaxes');
  // limits as saved; a limit next to nothing against the other (2.2E-08 for 6.28) is 0
  const lim = (e: El | undefined, a: string, other: string) => {
    const raw = e?.getAttribute(a);
    const n = Number(raw), o = Number(e?.getAttribute(other));
    if (!raw || !Number.isFinite(n)) return '';
    return String(Number.isFinite(o) && Math.abs(n) < 1e-6 * Math.abs(o) ? 0 : n);
  };
  const lab = child(body, 'xylabel');
  const xl = lab?.getAttribute('xlabel') ?? '', yl = lab?.getAttribute('ylabel') ?? '';
  const title = child(body, 'title2d')?.getAttribute('title') || ((xl && xl !== 'x') || (yl && yl !== 'y') ? `${yl || 'y'} over ${xl || 'x'}` : '');
  return createRegion('plot', at.x, at.y, {
    xExpr, traces, title,
    xmin: lim(ax, 'xmin', 'xmax'), xmax: lim(ax, 'xmax', 'xmin'), ymin: lim(ay, 'ymin', 'ymax'), ymax: lim(ay, 'ymax', 'ymin'),
    width: Math.max(200, Number(body.getAttribute('width')) || 300), height: Math.max(150, Number(body.getAttribute('height')) || 240),
  });
}
