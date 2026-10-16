// Units in symbolic evaluation (→). For the CAS a unit is its SI scale times a product of
// base-dimension symbols (u__kg, u__m, u__s …), so 1 m + 10 cm becomes (1 + 1/10)·u__m and a
// dimension is just a monomial. The result's unit part is read back and shown the way "="
// shows a quantity: 1.1 m, 20 kN·m, x·m/s. Which names are units is decided with care, since
// in symbolic math most single letters are variables (q·L²/8, F/A, s² + 3 s + 2).
import type { MathNode } from 'mathjs';
import { math, isUnit, isUnitName } from './math';
import { compatibleUnits, dimsOf, quantityName } from './unitCatalog';
import { unitStringTex, valueTex, type FormatOptions } from './format';

/** SI units of mathjs' base dimensions: mass, length, time, current, temperature, luminous intensity, amount, angle, bit. */
const BASE = ['kg', 'm', 's', 'A', 'K', 'cd', 'mol', 'rad', 'b'];
/** CAS symbol of each base dimension. */
const SYM = BASE.map((b) => `u__${b}`);
const SYM_INDEX = new Map(SYM.map((s, i) => [s, i]));
/** Radians are numbers in symbolic results (sin(2 rad) = sin(2)). */
const ANGLE = 7;

export const hasUnitSymbols = (s: string) => s.includes('u__');

/**
 * Single letters that are units only when written as a quantity: after a number (2 m, 3 s,
 * 9.81 m/s^2) with no variable in the same product, or next to a unit of several letters
 * (x·kN/m). Other single-letter units (L, A, F … would be litre, ampere, farad) are always
 * variables here.
 */
const SINGLE = new Set(['m', 's', 'N']);

/** Units of several letters, read as units wherever they appear (not names of variables). */
const MULTI = new Set([
  'mm', 'cm', 'dm', 'km', 'um', 'kN', 'MN', 'GN', 'mN', 'Nm', 'kNm', 'MNm', 'Nmm', 'kNmm',
  'Pa', 'kPa', 'MPa', 'GPa', 'hPa', 'bar', 'mbar', 'kg', 'mg', 'gm', 'tonne', 'ton',
  'ms', 'min', 'hr', 'hour', 'day', 'week', 'year', 'kJ', 'MJ', 'Wh', 'kWh', 'MWh', 'kW', 'MW',
  'Hz', 'kHz', 'MHz', 'rpm', 'rad', 'mL', 'kV', 'mV', 'mA', 'kA', 'ohm', 'kohm', 'mol',
  'ft', 'inch', 'yd', 'mi', 'mile', 'lbf', 'lbm', 'lb', 'kip', 'kipf', 'tonf', 'psi', 'ksi', 'mph', 'kph', 'kmh', 'knot',
  'hp', 'atm', 'torr', 'mmHg', 'cal', 'kcal', 'BTU', 'eV', 'erg', 'dyn', 'ha', 'gal', 'slug',
  'metre', 'meter', 'second', 'minute', 'newton', 'pascal', 'joule', 'watt', 'hertz', 'litre', 'liter',
]);

/** Velocities and gradients in base units read as units even after a variable (x·m/s). */
const COMPOUND: Record<string, number>[] = [{ m: 1, s: -1 }, { m: 1, s: -2 }, { N: 1, m: -1 }, { N: 1, m: -2 }];

export interface UnitScope {
  /** Defined in the worksheet (a variable or function): never a unit. */
  isDefined(name: string): boolean;
  /** Its value, for defined names. */
  value(name: string): unknown;
}

type AnyNode = MathNode & { name?: string; fn?: string | { name?: string }; args?: MathNode[]; implicit?: boolean; content?: MathNode; value?: unknown };

const isNumberConst = (n: AnyNode) => n.type === 'ConstantNode' && typeof n.value === 'number';
const CONSTANTS = new Set(['pi', 'e', 'π', 'Infinity']);

/** A scalar quantity with a unit (a variable defined as 10 kN). */
const isQuantity = (v: unknown) => isUnit(v) && typeof v.value === 'number';

/**
 * The names in an expression that are units. Multi-letter units are units wherever they are;
 * the single letters in SINGLE only where every occurrence is part of a quantity written with
 * a number (and no variable in its product) or of a compound like m/s.
 */
export function unitNamesIn(node: MathNode, scope: UnitScope, bound: Set<string>): Set<string> {
  const candidate = (name: string) => !bound.has(name) && !scope.isDefined(name) && isUnitName(name);
  const multi = (name: string) => MULTI.has(name) && candidate(name);
  const single = (name: string) => SINGLE.has(name) && candidate(name);
  const out = new Set<string>();
  const unitUse = new Map<string, number>();
  const varUse = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

  type Kind = 'num' | 'unit' | 'qty' | null;
  // what a subtree is: a number, units only, a number with units, or something else
  const kinds = new Map<MathNode, Kind>();
  const kindOf = (n: AnyNode): Kind => {
    if (kinds.has(n)) return kinds.get(n)!;
    let k: Kind = null;
    if (isNumberConst(n)) k = 'num';
    else if (n.type === 'SymbolNode') {
      const name = n.name!;
      if (CONSTANTS.has(name)) k = 'num';
      else if (multi(name) || single(name)) k = 'unit';
      else if (scope.isDefined(name) && !bound.has(name)) {
        const v = scope.value(name);
        k = typeof v === 'number' ? 'num' : isQuantity(v) ? 'qty' : null;
      }
    } else if (n.type === 'ParenthesisNode') k = kindOf(n.content as AnyNode);
    else if (n.type === 'FunctionNode') k = (n.args ?? []).every((a) => kindOf(a as AnyNode) === 'num') ? 'num' : null;
    else if (n.type === 'OperatorNode') {
      const a = (n.args ?? []) as AnyNode[];
      const [p, q] = a.map(kindOf);
      switch (n.fn) {
        case 'unaryMinus':
        case 'unaryPlus':
          k = p;
          break;
        case 'multiply':
          if (p === 'num' && q === 'num') k = 'num';
          // "2 m" (number then unit, implicit) is a quantity; "2*m" is twice the variable m
          else if (p === 'num' && q === 'unit') k = n.implicit ? 'qty' : null;
          else if (p === 'unit' && q === 'unit') k = 'unit';
          else if ((p === 'qty' && (q === 'unit' || q === 'qty' || q === 'num')) || (q === 'qty' && (p === 'num' || p === 'unit'))) k = 'qty';
          break;
        case 'divide':
          if (p === 'num' && q === 'num') k = 'num';
          else if (p === 'unit' && q === 'unit') k = 'unit';
          else if (p === 'qty' && q !== null) k = 'qty';
          else if ((p === 'num' || p === 'unit') && q === 'qty') k = 'qty';
          break;
        case 'pow':
          if (q === 'num') k = p;
          break;
      }
    }
    kinds.set(n, k);
    return k;
  };

  const MULT = new Set(['multiply', 'divide', 'unaryMinus', 'unaryPlus', 'pow']);
  const isMultNode = (n: AnyNode) => (n.type === 'OperatorNode' && MULT.has(n.fn as string)) || n.type === 'ParenthesisNode';
  const parts = (n: AnyNode): AnyNode[] => (n.type === 'ParenthesisNode' ? [n.content as AnyNode] : ((n.args ?? []) as AnyNode[]));
  /** Factors of a product chain with their exponents (only through * / − and ^number on a symbol). */
  const factors = (n: AnyNode, e: number, out: { node: AnyNode; e: number }[]) => {
    if (n.type === 'ParenthesisNode') return factors(n.content as AnyNode, e, out);
    if (n.type === 'OperatorNode') {
      const a = n.args as AnyNode[];
      if (n.fn === 'multiply') { factors(a[0], e, out); factors(a[1], e, out); return; }
      if (n.fn === 'divide') { factors(a[0], e, out); factors(a[1], -e, out); return; }
      if (n.fn === 'unaryMinus' || n.fn === 'unaryPlus') return factors(a[0], e, out);
      if (n.fn === 'pow' && a[0].type === 'SymbolNode' && isNumberConst(a[1])) return factors(a[0], e * (a[1].value as number), out);
    }
    out.push({ node: n, e });
  };
  /** The symbols of a product chain, and the parts of it that are no product (sums, functions, exponents). */
  const chain = (n: AnyNode, leaves: AnyNode[], rest: AnyNode[]) => {
    parts(n).forEach((c, i) => {
      if (n.type === 'OperatorNode' && n.fn === 'pow' && i === 1) rest.push(c);
      else if (c.type === 'SymbolNode') leaves.push(c);
      else if (isMultNode(c)) chain(c, leaves, rest);
      else rest.push(c);
    });
  };

  const visit = (n: AnyNode) => {
    if (n.type === 'SymbolNode') {
      if (multi(n.name!)) out.add(n.name!);
      // a lone m or s (not in a product with a number) is a variable
      else if (single(n.name!)) bump(varUse, n.name!);
      return;
    }
    if (!isMultNode(n)) {
      const kids = n.type === 'ArrayNode' ? (n as unknown as { items: AnyNode[] }).items : parts(n);
      kids.forEach(visit);
      return;
    }
    const leaves: AnyNode[] = [], rest: AnyNode[] = [];
    chain(n, leaves, rest);
    const fs: { node: AnyNode; e: number }[] = [];
    factors(n, 1, fs);
    // a free variable in the product (a symbol that is no unit, number or quantity) makes m and s variables too
    const free = fs.some(({ node }) => node.type !== 'ConstantNode' && kindOf(node) === null);
    const singles = leaves.filter((l) => single(l.name!));
    const powers: Record<string, number> = {};
    for (const f of fs) if (f.node.type === 'SymbolNode' && single(f.node.name!)) powers[f.node.name!] = (powers[f.node.name!] ?? 0) + f.e;
    const compound = COMPOUND.some((c) => Object.keys(c).length === Object.keys(powers).length && Object.entries(c).every(([k, v]) => powers[k] === v));
    const inQty = new Set<MathNode>();
    const mark = (m: AnyNode) => {
      if (kindOf(m) === 'qty') m.traverse((x: MathNode) => { inQty.add(x); });
      else if (isMultNode(m)) parts(m).forEach(mark);
    };
    if (!free) mark(n);
    // next to a unit of several letters (x·kN/m, x·kN·m) m and s are units as well
    const anchored = leaves.some((l) => multi(l.name!));
    for (const l of singles) bump(compound || anchored || inQty.has(l) ? unitUse : varUse, l.name!);
    for (const l of leaves) if (multi(l.name!)) out.add(l.name!);
    rest.forEach(visit);
  };
  visit(node as AnyNode);
  for (const name of unitUse.keys()) if (!varUse.has(name)) out.add(name);
  return out;
}

// ---------------------------------------------------------------- to the CAS

/** An exact decimal for the CAS: 0.0254 → (254/10000), 1e-9 → (1/10^9). */
export function exactNumber(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return String(x);
  const s = String(x);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s);
  if (!m) return `(${s})`;
  const [, sign, int, frac = '', ex = '0'] = m;
  const digits = (int + frac).replace(/^0+(?=\d)/, '');
  const pow = Number(ex) - frac.length;
  return pow >= 0 ? `(${sign}${digits}*10^${pow})` : `(${sign}${digits}/10^${-pow})`;
}

/** SI scale and dimensions of a quantity (angles dropped: radians are numbers here). */
function siParts(u: import('mathjs').Unit): { scale: number; dims: number[] } {
  const dims = dimsOf(u);
  dims[ANGLE] = 0;
  return { scale: u.value as number, dims };
}

function monomial(dims: number[]): string {
  return dims.map((d, i) => (d ? `*${SYM[i]}^(${exactNumber(d)})` : '')).join('');
}

/** The CAS node for a quantity: (scale·u__kg^a·u__m^b …). */
function quantityNode(scale: number, dims: number[]): MathNode {
  return math.parse(`(${exactNumber(scale)}${monomial(dims)})`);
}

/** The CAS node for a unit name (km → 1000·u__m), or for a variable defined as a quantity. */
export function unitNode(name: string): MathNode {
  const { scale, dims } = siParts(math.unit(1, name));
  return quantityNode(scale, dims);
}

export function valueNode(v: unknown): MathNode | null {
  if (!isQuantity(v)) return null;
  const { scale, dims } = siParts(v as import('mathjs').Unit);
  return quantityNode(scale, dims);
}

// ---------------------------------------------------------------- dimension check

type Dims = number[] | null;
const ZERO = () => BASE.map(() => 0);
const same = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
const isZero = (a: number[]) => a.every((x) => Math.abs(x) < 1e-9);

/** Base dimensions the unit catalogue has no family for. */
const BASE_NAMES = ['mass', 'length', 'time', 'current', 'temperature', 'luminous intensity', 'amount of substance'];

/** "a length", "a force" … or the SI unit for dimensions without a name. */
function describe(d: number[]): string {
  if (isZero(d)) return 'a number';
  const base = d.findIndex((x) => x !== 0);
  const q = quantityName(d)?.split(',')[0] ?? (d.filter((x) => x !== 0).length === 1 && d[base] === 1 ? BASE_NAMES[base] : undefined);
  return q ? `a ${q}` : `[${siUnit(d).formatUnits()}]`;
}

const TRANSCENDENTAL = new Set([
  'exp', 'log', 'log10', 'log2', 'ln', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'asin', 'acos', 'atan', 'acot',
  'sinh', 'cosh', 'tanh', 'coth', 'asinh', 'acosh', 'atanh', 'erf', 'erfc', 'gamma', 'factorial',
]);
const SAME_DIMS = new Set(['abs', 're', 'im', 'conj', 'floor', 'ceil', 'round', 'fix']);

/**
 * Check that a CAS expression (units already turned into u__ symbols) adds and compares
 * like with like. Variables may be anything, so only sure mismatches are errors.
 */
export function checkDimensions(node: MathNode): Dims {
  const n = node as AnyNode;
  const kids = () => (n.args ?? []) as MathNode[];
  switch (n.type) {
    case 'ConstantNode':
      return typeof n.value === 'number' ? ZERO() : null;
    case 'SymbolNode': {
      const i = SYM_INDEX.get(n.name!);
      if (i !== undefined) {
        const d = ZERO();
        d[i] = 1;
        return d;
      }
      return CONSTANTS.has(n.name!) ? ZERO() : null;
    }
    case 'ParenthesisNode':
      return checkDimensions(n.content as MathNode);
    case 'OperatorNode': {
      const [a, b] = kids().map(checkDimensions);
      switch (n.fn) {
        case 'unaryMinus':
        case 'unaryPlus':
          return a;
        case 'add':
        case 'subtract':
        case 'equal':
        case 'unequal':
        case 'smaller':
        case 'larger':
        case 'smallerEq':
        case 'largerEq':
        case 'mod': {
          if (a && b && !same(a, b)) {
            const verb = n.fn === 'add' ? 'add' : n.fn === 'subtract' ? 'subtract' : 'compare';
            throw new Error(`Cannot ${verb} ${describe(a)} and ${describe(b)}`);
          }
          return a ?? b;
        }
        case 'multiply':
          return a && b ? a.map((x, i) => x + b[i]) : null;
        case 'divide':
          return a && b ? a.map((x, i) => x - b[i]) : null;
        case 'pow': {
          if (b && !isZero(b)) throw new Error('An exponent cannot have a unit');
          if (!a || isZero(a)) return a;
          let p: number;
          try {
            p = Number(kids()[1].evaluate());
          } catch {
            throw new Error('A quantity with a unit can only be raised to a number');
          }
          if (!Number.isFinite(p)) throw new Error('A quantity with a unit can only be raised to a number');
          return a.map((x) => x * p);
        }
        case 'factorial':
          if (a && !isZero(a)) throw new Error(`The factorial needs a number, not ${describe(a)}`);
          return a;
        default:
          return null;
      }
    }
    case 'FunctionNode': {
      const name = typeof n.fn === 'object' ? n.fn?.name ?? '' : '';
      const ds = kids().map(checkDimensions);
      const a = ds[0];
      if (name === 'sqrt') return a && a.map((x) => x / 2);
      if (name === 'cbrt') return a && a.map((x) => x / 3);
      if (SAME_DIMS.has(name)) return a;
      if (name === 'sign') return ZERO();
      if (TRANSCENDENTAL.has(name)) {
        ds.forEach((d) => {
          if (d && !isZero(d)) throw new Error(`${name} needs a number, not ${describe(d)}`);
        });
        return ZERO();
      }
      if (name === 'min' || name === 'max') {
        const known = ds.filter((d): d is number[] => !!d);
        if (known.some((d) => !same(d, known[0]))) throw new Error(`Cannot compare ${describe(known[0])} and ${describe(known.find((d) => !same(d, known[0]))!)}`);
        return known.length === ds.length ? known[0] : null;
      }
      return null;
    }
    case 'ArrayNode':
      (n as unknown as { items: MathNode[] }).items.forEach(checkDimensions);
      return null;
    default:
      n.forEach?.((c: MathNode) => { checkDimensions(c); });
      return null;
  }
}

// ---------------------------------------------------------------- back from the CAS

interface Nerd {
  (expr: string): { toString(): string; toTeX(option?: string): string; variables(): string[]; evaluate(): { text(mode: string): string } };
}

/** Fractions that are short decimals written as fractions (196133/20000 from g = 9.80665 m/s²). */
function decimalFractions(s: string): boolean {
  const dens = [...s.matchAll(/\d+\/(\d+)/g)].map((m) => Number(m[1]));
  const terminating = (d: number) => {
    while (d % 2 === 0) d /= 2;
    while (d % 5 === 0) d /= 5;
    return d === 1;
  };
  return dens.length > 0 && dens.every(terminating) && dens.some((d) => d > 100);
}

/** The SI unit (value 1) of these dimensions. */
function siUnit(dims: number[]): import('mathjs').Unit {
  let u: import('mathjs').Unit | null = null;
  dims.forEach((d, i) => {
    if (!d) return;
    const p = math.pow(math.unit(1, BASE[i]), d) as import('mathjs').Unit;
    u = u ? (math.multiply(u, p) as import('mathjs').Unit) : p;
  });
  if (!u) throw new Error('No unit');
  return u;
}

type Term = { sign: number; factors: { node: MathNode; e: number }[]; dims: number[] };

/** Split a CAS result into terms of a coefficient times a unit monomial (null: a unit symbol sits inside a function or a sum). */
function splitTerms(node: MathNode): Term[] | null {
  const terms: Term[] = [];
  const contains = (m: MathNode) => m.filter((x) => x.type === 'SymbolNode' && SYM_INDEX.has((x as AnyNode).name!)).length > 0;
  const addTerm = (m: MathNode, sign: number) => {
    const t: Term = { sign, factors: [], dims: ZERO() };
    const walk = (x: AnyNode, e: number): boolean => {
      if (!contains(x)) {
        t.factors.push({ node: x, e });
        return true;
      }
      if (x.type === 'SymbolNode') {
        t.dims[SYM_INDEX.get(x.name!)!] += e;
        return true;
      }
      if (x.type === 'ParenthesisNode') return walk(x.content as AnyNode, e);
      if (x.type === 'OperatorNode') {
        const a = x.args as AnyNode[];
        if (x.fn === 'multiply') return walk(a[0], e) && walk(a[1], e);
        if (x.fn === 'divide') return walk(a[0], e) && walk(a[1], -e);
        if (x.fn === 'unaryMinus') {
          t.sign = -t.sign;
          return walk(a[0], e);
        }
        if (x.fn === 'pow' && !contains(a[1])) {
          let p: number;
          try {
            p = Number(a[1].evaluate());
          } catch {
            return false;
          }
          return Number.isFinite(p) && walk(a[0], e * p);
        }
        return false;
      }
      if (x.type === 'FunctionNode') {
        const name = (x.fn as { name?: string }).name;
        const a = x.args as AnyNode[];
        // units are positive: |u| = u, √u = u^½
        if (name === 'abs') return walk(a[0], e);
        if (name === 'sqrt') return walk(a[0], e / 2);
      }
      return false;
    };
    if (!walk(m as AnyNode, 1)) return false;
    terms.push(t);
    return true;
  };
  const sum = (m: AnyNode, sign: number): boolean => {
    if (m.type === 'ParenthesisNode') return sum(m.content as AnyNode, sign);
    if (m.type === 'OperatorNode' && (m.fn === 'add' || m.fn === 'subtract')) {
      const a = m.args as AnyNode[];
      return sum(a[0], sign) && sum(a[1], m.fn === 'add' ? sign : -sign);
    }
    if (m.type === 'OperatorNode' && m.fn === 'unaryMinus' && contains(m)) return sum((m.args as AnyNode[])[0], -sign);
    return addTerm(m, sign);
  };
  return sum(node as AnyNode, 1) ? terms : null;
}

/** A coefficient as CAS text. */
function coefficient(t: Term): string {
  const num = t.factors.filter((f) => f.e > 0).map((f) => (f.e === 1 ? `(${f.node.toString()})` : `(${f.node.toString()})^(${exactNumber(f.e)})`));
  const den = t.factors.filter((f) => f.e < 0).map((f) => (f.e === -1 ? `(${f.node.toString()})` : `(${f.node.toString()})^(${exactNumber(-f.e)})`));
  const n = num.join('*') || '1';
  return `${t.sign < 0 ? '-' : ''}${den.length ? `${n}/(${den.join('*')})` : n}`;
}

const isSum = (s: string) => {
  try {
    const n = math.parse(s.replace(/^-/, '')) as AnyNode;
    return n.type === 'OperatorNode' && (n.fn === 'add' || n.fn === 'subtract');
  } catch {
    return false;
  }
};

export interface UnitTexOptions {
  fmt: FormatOptions;
  /** A keyword that shapes the result (factor, expand …), applied again to the coefficient without its unit. */
  reshape?: string;
  texOut: (e: { toTeX(): string }) => string;
}

/** One group of terms with the same unit: a number shown like "=" shows it, or a symbolic coefficient with a unit. */
function groupTex(nerd: Nerd, coef: string, dims: number[], o: UnitTexOptions): string {
  const c = nerd(coef);
  if (isZero(dims)) return o.texOut(c);
  if (!c.variables().length) {
    const v = Number(c.evaluate().text('decimals'));
    if (Number.isFinite(v)) return valueTex(math.multiply(v, siUnit(dims)), o.fmt);
  }
  // a symbolic coefficient: the unit that leaves it simplest (x·kN rather than 1000·x·N)
  const si = siUnit(dims);
  const metric = o.fmt.metric !== false ? compatibleUnits(dims).map((u) => u.u) : [];
  const fallback = math.format(si, { precision: 15 }).replace(/^\s*1\s*/, '') || si.formatUnits();
  let best: { tex: ReturnType<Nerd>; unit: string; len: number } | null = null;
  for (const unit of [...metric, fallback]) {
    let scale: number;
    try {
      scale = math.unit(1, unit).value as number;
    } catch {
      continue;
    }
    const q = scale === 1 ? coef : `(${coef})/${exactNumber(scale)}`;
    let e = nerd(q);
    const expanded = nerd(`expand(${q})`);
    if (expanded.toString().length < e.toString().length) e = expanded;
    if (o.reshape) e = nerd(`${o.reshape}(${e.toString()})`);
    const len = e.toString().length;
    if (!best || len < best.len) best = { tex: e, unit, len };
  }
  const b = best!;
  const ct = o.texOut(decimalFractions(b.tex.toString()) ? { toTeX: () => b.tex.toTeX('decimal') } : b.tex);
  const s = b.tex.toString();
  const ut = unitStringTex(math.unit(1, b.unit).formatUnits());
  if (s === '1') return ut;
  if (s === '-1') return `-${ut}`;
  return `${isSum(s) ? `\\left(${ct}\\right)` : ct}\\,${ut}`;
}

/** TeX of a CAS result that holds unit symbols. */
export function unitResultTex(nerd: Nerd, result: string, o: UnitTexOptions): string {
  let node: MathNode;
  try {
    node = math.parse(result);
  } catch {
    return fallbackTex(nerd, result, o);
  }
  if (node.type === 'ArrayNode') {
    const items = (node as unknown as { items: MathNode[] }).items.map((it) => unitResultTex(nerd, it.toString(), o));
    return `\\left[${items.join(',\\ ')}\\right]`;
  }
  let terms = splitTerms(node);
  // (x + 2 m)² and the like: expanded, every term has its own unit
  if (!terms) {
    try {
      terms = splitTerms(math.parse(nerd(`expand(${result})`).toString()));
    } catch {
      terms = null;
    }
  }
  if (!terms) return fallbackTex(nerd, result, o);
  const groups: { dims: number[]; coefs: string[] }[] = [];
  for (const t of terms) {
    const g = groups.find((x) => same(x.dims, t.dims));
    if (g) g.coefs.push(coefficient(t));
    else groups.push({ dims: t.dims, coefs: [coefficient(t)] });
  }
  if (groups.length > 1) {
    const numeric = groups.filter((g) => !nerd(g.coefs.join('+')).variables().length);
    if (numeric.length > 1) throw new Error(`Cannot add ${describe(numeric[0].dims)} and ${describe(numeric[1].dims)}`);
  }
  return groups
    .map((g) => groupTex(nerd, g.coefs.join('+'), g.dims, o))
    .reduce((acc, tex, i) => (i === 0 ? tex : tex.startsWith('-') ? `${acc} - ${tex.slice(1)}` : `${acc} + ${tex}`), '');
}

/** Units that cannot be separated (inside a function): shown in place. */
function fallbackTex(nerd: Nerd, result: string, o: UnitTexOptions): string {
  return o.texOut(nerd(result)).replace(/u_\{_\{(\w+)\}\}/g, (_, b: string) => `\\mathrm{${b}}`);
}
