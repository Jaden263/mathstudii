// Worksheet math as a neutral tree for the Mathcad and SMath writers. Our input is mathjs
// syntax with Mathcad conventions (syntax.ts); here every name gets the role Mathcad gives
// it (a worksheet variable, a unit, a built-in function, a constant), numbers times units
// become quantities, and Mathcad's operators (Σ, ∫, d/dx, √, |x|, M⟨j⟩ …) are told apart
// from function calls, so that each writer only has to spell them.
import type { MathNode } from 'mathjs';
import { math, isUnitName } from '../engine/math';
import { parseExpr } from '../engine/compile';
import { parseStatement, parseRange, splitTop, findEvalEquals, type Lhs } from '../engine/syntax';
import { parseProgram, type ProgramStmt } from '../engine/program';

type AnyNode = MathNode & Record<string, unknown>;

export type Role = 'var' | 'unit' | 'fn' | 'const' | 'keyword';

export type Op =
  | 'plus' | 'minus' | 'mult' | 'div' | 'pow' | 'neg' | 'not' | 'and' | 'or' | 'xor'
  | 'equal' | 'notEqual' | 'lessThan' | 'greaterThan' | 'lessOrEqual' | 'greaterOrEqual'
  | 'factorial' | 'transpose';

export type X =
  | { k: 'num'; v: string }
  | { k: 'imag'; v: string }
  | { k: 'str'; v: string }
  | { k: 'id'; name: string; role: Role }
  | { k: 'op'; op: Op; args: X[] }
  /** A number times a unit: 5 kN, (0.85·30) MPa. */
  | { k: 'scale'; value: X; unit: X }
  | { k: 'call'; fn: string; role: Role; args: X[] }
  | { k: 'index'; base: X; idx: X[] }
  | { k: 'matrix'; rows: X[][] }
  | { k: 'parens'; a: X }
  | { k: 'range'; first: X; second?: X; last: X }
  | { k: 'integral'; v: string; body: X; lo: X; hi: X }
  /** Σ and Π with bounds, or over a range variable. */
  | { k: 'sum' | 'prod'; v: string; body: X; lo?: X; hi?: X }
  | { k: 'vsum'; a: X }
  | { k: 'deriv'; v: string; body: X; n: number }
  /** y''(t), y'(0): Mathcad's prime notation of an unknown function in odesolve. */
  | { k: 'prime'; f: string; n: number; args: X[] }
  | { k: 'sqrt'; a: X }
  | { k: 'root'; n: X; a: X }
  | { k: 'abs'; a: X }
  | { k: 'col' | 'row'; m: X; j: X }
  | { k: 'cross'; a: X; b: X }
  | { k: 'vectorize'; a: X }
  | { k: 'if'; cond: X; a: X; b: X };

export type Target =
  | { k: 'var'; name: string }
  | { k: 'fn'; name: string; params: string[] }
  | { k: 'index'; name: string; idx: X[] }
  | { k: 'col'; name: string; j: X }
  | { k: 'list'; names: string[] };

export type PStmt =
  | { k: 'local'; target: Target; value: X }
  | { k: 'if'; branches: { cond: X | null; body: PStmt[] }[] }
  | { k: 'for'; v: string; iter: X; body: PStmt[] }
  | { k: 'while'; cond: X; body: PStmt[] }
  | { k: 'try'; body: PStmt[]; onError: PStmt[] }
  | { k: 'return'; value: X }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'expr'; value: X };

export type Statement =
  | { k: 'define'; global: boolean; target: Target; value: X; show: boolean; unit?: X }
  | { k: 'program'; global: boolean; target: Target; body: PStmt[] }
  | { k: 'eval'; expr: X; unit?: X }
  /** expr → keyword, its arguments (solve, x · substitute, x = 2 · float, 5). */
  | { k: 'symbolic'; expr: X; keyword?: { name: string; args: X[] } }
  /** A comparison or other expression shown for its value (a check). */
  | { k: 'expr'; expr: X };

/** Thrown for input the target format cannot hold; the writer turns it into a note. */
export class NotRepresentable extends Error {}

/** Mathcad's functions whose arguments or names differ from ours. */
const FN_NAME: Record<string, string> = { gamma: 'Γ', mag: 'mag' };

/** Names that are values the worksheet always has (they are not units). */
const CONSTANTS: Record<string, string> = { pi: 'π', π: 'π', Infinity: '∞', NaN: 'NaN' };

/** Physical constants of mathjs that Mathcad Prime has under its own name (labelled CONSTANT). */
export const PRIME_CONSTANTS: Record<string, string> = {
  speedOfLight: 'c', gravitationConstant: 'G', planckConstant: 'h', reducedPlanckConstant: 'ℏ', boltzmann: 'k_B',
  avogadro: 'N_A', gasConstant: 'R', vacuumPermittivity: 'ε_0', vacuumPermeability: 'μ_0', electronMass: 'm_e',
  protonMass: 'm_p', atomicMass: 'm_u', elementaryCharge: 'e_c', stefanBoltzmann: 'σ', rydberg: 'R_∞',
  fineStructure: 'α', magneticFluxQuantum: 'Φ_0',
};

/** "1.2e-5" → "0.000012": Mathcad writes numbers out in full. */
export function plainNumber(s: string): string {
  const m = /^(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(s.trim());
  if (!m) return s;
  const [, ip, fp = '', ex] = m;
  const e = Number(ex);
  if (Math.abs(e) > 30) return s;
  let digits = (ip + fp).replace(/^0+(?=\d)/, '');
  let point = ip.replace(/^0+(?=\d)/, '').length + e;
  if (ip.replace(/^0+/, '') === '') {
    // 0.00123e4: count the leading zeros of the fraction
    const lead = fp.length - fp.replace(/^0+/, '').length;
    digits = fp.replace(/^0+/, '');
    point = -lead + e;
  }
  if (!digits) return '0';
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const num = (v: string): X => ({ k: 'num', v: plainNumber(v) });
const id = (name: string, role: Role): X => ({ k: 'id', name, role });

export class TreeReader {
  /** Names the worksheet defines anywhere (they are variables, not units). */
  readonly defined: Set<string>;
  /** Region names whose results are fields (b.M_max): written as one name, b_M_max. */
  constructor(defined: Iterable<string>) {
    this.defined = new Set(defined);
  }

  /** One math region. */
  statement(source: string): Statement | null {
    const st = parseStatement(source);
    switch (st.type) {
      case 'empty':
        return null;
      case 'define': {
        const target = this.target(st.lhs);
        const bound = new Set(target.k === 'fn' ? target.params : []);
        const range = parseRange(st.rhs);
        const value = range ? this.rangeOf(range, bound) : this.expr(st.rhs, bound);
        return { k: 'define', global: st.global, target, value, show: st.show, unit: st.unit ? this.unit(st.unit) : undefined };
      }
      case 'program': {
        const target = this.target(st.lhs);
        const bound = new Set(target.k === 'fn' ? target.params : []);
        return { k: 'program', global: st.global, target, body: this.program(parseProgram(st.body), bound) };
      }
      case 'eval':
        return { k: 'eval', expr: this.expr(st.expr), unit: st.unit ? this.unit(st.unit) : undefined };
      case 'symbolic': {
        // "x^2 = 4 → solve, x": one keyword and its arguments; a lone = is an equation
        const [name, ...args] = st.keywords ? splitTop(st.keywords, ',').map((s) => s.trim()) : [];
        const expr = this.equation(st.expr);
        return { k: 'symbolic', expr, keyword: name ? { name, args: args.map((a) => this.equation(a)) } : undefined };
      }
      case 'expr':
        return { k: 'expr', expr: this.expr(st.expr) };
    }
  }

  target(lhs: Lhs): Target {
    switch (lhs.kind) {
      case 'var': return { k: 'var', name: lhs.name };
      case 'func': return { k: 'fn', name: lhs.name, params: lhs.params };
      case 'index': return { k: 'index', name: lhs.name, idx: lhs.indices.map((i) => this.expr(i)) };
      case 'destructure': return { k: 'list', names: lhs.names };
    }
  }

  rangeOf(r: { first: string; second: string | null; last: string }, bound = new Set<string>()): X {
    return { k: 'range', first: this.expr(r.first, bound), second: r.second ? this.expr(r.second, bound) : undefined, last: this.expr(r.last, bound) };
  }

  /** An expression in which a single = is an equation (Mathcad's bold equals). */
  equation(src: string, bound = new Set<string>()): X {
    const at = findEvalEquals(src);
    if (at < 0) return this.expr(src, bound);
    return { k: 'op', op: 'equal', args: [this.expr(src.slice(0, at), bound), this.expr(src.slice(at + 1), bound)] };
  }

  /** A display unit (x = kN·m): every name in it is a unit. */
  unit(src: string): X {
    // % is a display unit of its own (a ratio shown in percent)
    if (src.trim() === '%') return id('%', 'unit');
    return this.node(parseExpr(src), new Set(), true);
  }

  expr(src: string, bound = new Set<string>()): X {
    const range = parseRange(src);
    if (range) return this.rangeOf(range, bound);
    return this.node(parseExpr(src), bound, false);
  }

  program(stmts: ProgramStmt[], bound: Set<string>): PStmt[] {
    const local = new Set(bound);
    const walk = (list: ProgramStmt[]): PStmt[] => list.map((s): PStmt => {
      switch (s.k) {
        case 'assign': {
          local.add(s.name);
          const value = this.expr(s.expr, local);
          if (s.column) return { k: 'local', target: { k: 'col', name: s.name, j: this.expr(s.index![0], local) }, value };
          return { k: 'local', target: s.index ? { k: 'index', name: s.name, idx: s.index.map((i) => this.expr(i, local)) } : { k: 'var', name: s.name }, value };
        }
        case 'if':
          // a condition's lone = is a comparison (if x = 0), as in Mathcad
          return { k: 'if', branches: s.branches.map((b) => ({ cond: b.cond === null ? null : this.equation(b.cond, local), body: walk(b.body) })) };
        case 'for': {
          local.add(s.v);
          return { k: 'for', v: s.v, iter: this.expr(s.iter, local), body: walk(s.body) };
        }
        case 'while':
          return { k: 'while', cond: this.equation(s.cond, local), body: walk(s.body) };
        case 'try':
          return { k: 'try', body: walk(s.body), onError: walk(s.onError) };
        case 'return':
          return { k: 'return', value: this.expr(s.expr, local) };
        case 'break':
          return { k: 'break' };
        case 'continue':
          return { k: 'continue' };
        case 'expr':
          return { k: 'expr', value: this.expr(s.expr, local) };
      }
    });
    return walk(stmts);
  }

  /** Is this name a value of the worksheet here (not a unit)? */
  private isValue(name: string, bound: Set<string>) {
    return bound.has(name) || this.defined.has(name);
  }

  private symbol(name: string, bound: Set<string>, unitSlot: boolean): X {
    if (!unitSlot && this.isValue(name, bound)) return id(name, 'var');
    if (CONSTANTS[name]) return id(CONSTANTS[name], 'const');
    if (name === 'e' || name === 'g' || PRIME_CONSTANTS[name]) return id(name, 'const');
    if (name === '__I') return { k: 'imag', v: '1' };
    if (name === 'true' || name === 'false') return num(name === 'true' ? '1' : '0');
    if (unitSlot || isUnitName(name)) return id(name, 'unit');
    return id(name, 'var');
  }

  /** Is the node made of units only (a unit expression: kN·m/s²)? */
  private unitOnly(x: X): boolean {
    switch (x.k) {
      case 'id': return x.role === 'unit';
      case 'num': return false;
      case 'parens': return this.unitOnly(x.a);
      case 'op':
        if (x.op === 'pow') return this.unitOnly(x.args[0]) && (x.args[1].k === 'num' || (x.args[1].k === 'op' && x.args[1].op === 'neg' && x.args[1].args[0].k === 'num'));
        if (x.op === 'mult' || x.op === 'div') return x.args.every((a, i) => this.unitOnly(a) || (x.op === 'div' && i === 0 && a.k === 'num' && a.v === '1'));
        return false;
      default:
        return false;
    }
  }

  private isNumber(x: X): boolean {
    return x.k === 'num' || (x.k === 'parens' && this.isNumber(x.a));
  }

  node(n: MathNode, bound: Set<string>, unitSlot: boolean): X {
    const a = n as AnyNode;
    const sub = (c: MathNode, b = bound) => this.node(c, b, unitSlot);
    switch (n.type) {
      case 'ConstantNode': {
        const v = a.value;
        if (typeof v === 'number') return num(String(v));
        if (typeof v === 'string') return { k: 'str', v };
        if (typeof v === 'boolean') return num(v ? '1' : '0');
        throw new NotRepresentable(`the value ${String(v)}`);
      }
      case 'SymbolNode':
        return this.symbol(a.name as string, bound, unitSlot);
      case 'ParenthesisNode':
        return { k: 'parens', a: sub(a.content as MathNode) };
      case 'ArrayNode': {
        const items = a.items as MathNode[];
        const rows = items.length && items.every((it) => it.type === 'ArrayNode')
          ? items.map((it) => ((it as AnyNode).items as MathNode[]).map((c) => sub(c)))
          : [items.map((c) => sub(c))];
        if (rows.some((r) => r.length !== rows[0].length)) throw new NotRepresentable('a matrix with rows of different lengths');
        return { k: 'matrix', rows };
      }
      case 'AccessorNode': {
        const index = a.index as AnyNode & { dotNotation: boolean; dimensions: MathNode[] };
        if (index.dotNotation) {
          // b.M_max: Mathcad names cannot hold a dot
          const field = (index.dimensions[0] as AnyNode).value as string;
          const base = this.node(a.object as MathNode, bound, false);
          if (base.k !== 'id') throw new NotRepresentable('a field of an expression');
          return id(`${base.name}_${field}`, 'var');
        }
        const base = sub(a.object as MathNode);
        const dims = index.dimensions;
        const all = (d: MathNode) => {
          const q = d as AnyNode;
          return (q.type === 'RangeNode' && !q.start && !q.end) || (q.type === 'SymbolNode' && q.name === ':');
        };
        if (dims.length === 2 && all(dims[0]) && !all(dims[1])) return { k: 'col', m: base, j: sub(dims[1]) };
        if (dims.length === 2 && all(dims[1]) && !all(dims[0])) return { k: 'row', m: base, j: sub(dims[0]) };
        if (dims.some(all)) throw new NotRepresentable('an index range (a : in an index)');
        return { k: 'index', base, idx: dims.map((d) => sub(d)) };
      }
      case 'OperatorNode':
        return this.operator(a, bound, unitSlot);
      case 'FunctionNode':
        return this.call(a, bound, unitSlot);
      case 'ConditionalNode':
        return { k: 'if', cond: sub(a.condition as MathNode), a: sub(a.trueExpr as MathNode), b: sub(a.falseExpr as MathNode) };
      default:
        throw new NotRepresentable(`a ${n.type.replace(/Node$/, '').toLowerCase()} expression`);
    }
  }

  private operator(a: AnyNode, bound: Set<string>, unitSlot: boolean): X {
    const fn = a.fn as string;
    const args = (a.args as MathNode[]).map((c) => this.node(c, bound, unitSlot));
    const OPS: Record<string, Op> = {
      add: 'plus', subtract: 'minus', multiply: 'mult', divide: 'div', pow: 'pow', unaryMinus: 'neg', not: 'not',
      and: 'and', or: 'or', xor: 'xor', equal: 'equal', unequal: 'notEqual', smaller: 'lessThan', larger: 'greaterThan',
      smallerEq: 'lessOrEqual', largerEq: 'greaterOrEqual', factorial: 'factorial', ctranspose: 'transpose', transpose: 'transpose',
      dotMultiply: 'mult', dotDivide: 'div', dotPow: 'pow',
    };
    if (fn === 'unaryPlus') return args[0];
    if (fn === 'mod') return { k: 'call', fn: 'mod', role: 'fn', args };
    const op = OPS[fn];
    if (!op) throw new NotRepresentable(`the “${a.op as string}” operator`);
    // 5 kN, 0.85·30 MPa: a quantity (Mathcad's scale)
    if (op === 'mult' && !unitSlot && args.length === 2 && this.isNumber(args[0]) && this.unitOnly(args[1])) {
      return { k: 'scale', value: args[0], unit: args[1] };
    }
    // 5 kN/m reads (5 kN)/m: the whole unit belongs to the quantity
    if ((op === 'div' || op === 'mult') && !unitSlot && args[0].k === 'scale' && this.unitOnly(args[1])) {
      return { k: 'scale', value: args[0].value, unit: { k: 'op', op, args: [args[0].unit, args[1]] } };
    }
    return { k: 'op', op, args };
  }

  private call(a: AnyNode, bound: Set<string>, unitSlot: boolean): X {
    const fnNode = a.fn as AnyNode;
    const raw = a.args as MathNode[];
    if (fnNode.type !== 'SymbolNode') throw new NotRepresentable('a call of an expression');
    const name = fnNode.name as string;
    const sub = (c: MathNode, b = bound) => this.node(c, b, unitSlot);
    const bindName = (c: MathNode | undefined, what: string) => {
      const q = c as AnyNode | undefined;
      if (!q || q.type !== 'SymbolNode') throw new NotRepresentable(`${what} with an expression as its variable`);
      return q.name as string;
    };
    const withBound = (v: string) => new Set([...bound, v]);
    // a worksheet function named like a built-in is the worksheet's
    if (this.isValue(name, bound)) return { k: 'call', fn: name, role: 'var', args: raw.map((c) => sub(c)) };
    switch (name) {
      case '__d': {
        // y''(t), y'(0): the derivative of y, at t or at a point
        const f = bindName(raw[0], 'a derivative');
        return { k: 'prime', f, n: Number((raw[1] as AnyNode).value), args: raw.slice(2).map((c) => sub(c)) };
      }
      case 'unit': {
        // unit(1, "m"): the unit itself where a variable has the unit's name
        const u = (raw[1] as AnyNode)?.value;
        if (typeof u === 'string') return id(u, 'unit');
        break;
      }
      case 'integral': {
        if (raw.length !== 4) throw new NotRepresentable('integral(…) without both limits');
        const v = bindName(raw[1], 'an integral');
        return { k: 'integral', v, body: sub(raw[0], withBound(v)), lo: sub(raw[2]), hi: sub(raw[3]) };
      }
      case 'sum':
      case 'prod': {
        if (raw.length === 1) return name === 'sum' ? { k: 'vsum', a: sub(raw[0]) } : { k: 'call', fn: 'prod', role: 'fn', args: [sub(raw[0])] };
        const v = bindName(raw[1], 'a sum');
        const body = sub(raw[0], withBound(v));
        if (raw.length === 2) return { k: name, v, body };
        if (raw.length === 4) return { k: name, v, body, lo: sub(raw[2]), hi: sub(raw[3]) };
        break;
      }
      case 'diff':
      case 'deriv': {
        if (raw.length < 2) break;
        const v = bindName(raw[1], 'a derivative');
        const n = raw[2] ? Number((raw[2] as AnyNode).value) : 1;
        if (!Number.isInteger(n) || n < 1) throw new NotRepresentable('a derivative of a non-integer order');
        // diff(f(x), x, 2) at a point is diff(f(x), x, 2, a) in our syntax: not Mathcad's
        if (raw.length > 3) throw new NotRepresentable('a derivative at a given point');
        return { k: 'deriv', v, body: sub(raw[0], withBound(v)), n };
      }
      case 'sqrt':
        return { k: 'sqrt', a: sub(raw[0]) };
      case 'nthRoot':
        return { k: 'root', n: sub(raw[1]), a: sub(raw[0]) };
      case 'abs':
        return { k: 'abs', a: sub(raw[0]) };
      case 'col':
        if (raw.length === 2) return { k: 'col', m: sub(raw[0]), j: sub(raw[1]) };
        break;
      case 'row':
        if (raw.length === 2) return { k: 'row', m: sub(raw[0]), j: sub(raw[1]) };
        break;
      case 'cross':
        if (raw.length === 2) return { k: 'cross', a: sub(raw[0]), b: sub(raw[1]) };
        break;
      case 'vectorize':
        return { k: 'vectorize', a: sub(raw[0]) };
      case 'if':
        if (raw.length === 3) return { k: 'if', cond: sub(raw[0]), a: sub(raw[1]), b: sub(raw[2]) };
        break;
      case 'atan2':
        // Mathcad: atan2(x, y)
        if (raw.length === 2) return { k: 'call', fn: 'atan2', role: 'fn', args: [sub(raw[1]), sub(raw[0])] };
        break;
    }
    const builtin = name in math || /^(find|minerr|minimize|maximize|odesolve|Odesolve|Pdesolve|pdesolve|root|polyroots)$/.test(name);
    return { k: 'call', fn: FN_NAME[name] ?? name, role: builtin ? 'fn' : 'var', args: raw.map((c) => sub(c)) };
  }
}

/** Every name a worksheet defines: they are variables wherever they appear. */
export function definedNames(sources: string[]): Set<string> {
  const out = new Set<string>();
  const addLhs = (lhs: Lhs) => {
    if (lhs.kind === 'destructure') lhs.names.forEach((n) => out.add(n));
    else out.add(lhs.name);
    if (lhs.kind === 'func') lhs.params.forEach((p) => out.add(p));
  };
  for (const src of sources) {
    try {
      const st = parseStatement(src);
      if (st.type === 'define' || st.type === 'program') addLhs(st.lhs);
      if (st.type === 'program') {
        for (const line of st.body) {
          const m = /^\s*(?:for\s+(\S+)\s+(?:in|∈)|([\p{L}_][\p{L}\p{N}_]*)\s*(?:\[[^\]]*\])?\s*(?:←|<-))/u.exec(line);
          if (m) out.add(m[1] ?? m[2]);
        }
      }
    } catch {
      /* a region with an error defines nothing */
    }
  }
  return out;
}
