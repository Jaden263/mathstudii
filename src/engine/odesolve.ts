// odesolve in solve blocks (Mathcad's Given … Odesolve): differential equations in
// prime (y''(t)) or diff(y(t), t, 2) notation with initial or boundary conditions.
// Higher orders become first-order systems, the equations are solved for the
// highest derivatives at every step (directly when they are explicit, by Newton
// otherwise), boundary-value problems are shot from one end, and the result is a
// function of the independent variable with dense output and units.
import type { MathNode, Unit } from 'mathjs';
import { math, isUnit, splitUnit, quantity } from './math';
import { ChainScope, snapshot, type ScopeLike } from './scope';
import { parseExpr, transformForEval, freeSymbols } from './compile';
import { isIdentifier, splitTop, findTop, findEvalEquals, parseLhs } from './syntax';
import { tick } from './library';
import { solveIvp, type OdeMethod, type OdeSolution } from './ode';
import * as N from './numeric';

type AnyNode = MathNode & Record<string, unknown>;

export interface OdeLine {
  lhs: string;
  op: string;
  rhs: string;
}

/** A solution function y(t); its derivatives y'(t), y''(t) … come from the state. */
export type OdeFunction = ((t: unknown, ...rest: unknown[]) => unknown) & { odeDerivative?: (k: number, t: unknown) => unknown };

interface Call {
  unknowns: string[];
  indep: string;
  end: string;
  options: string[];
}

const METHODS: Record<string, OdeMethod> = {
  adaptive: 'auto', auto: 'auto', adams: 'auto', adamsbdf: 'auto',
  rkadapt: 'dopri', nonstiff: 'dopri', dopri: 'dopri',
  radau: 'radau', stiff: 'radau', bdf: 'radau', stiffb: 'radau', stiffr: 'radau',
  fixed: 'rk4', rkfixed: 'rk4', rk4: 'rk4',
};

/** "y''" for messages (y^(4) beyond three primes). */
function derivName(name: string, k: number): string {
  return k <= 3 ? name + "'".repeat(k) : `${name}^(${k})`;
}

/** Read odesolve(t, b …) or odesolve([x, y], t, b …); the single form takes its unknown from the left side. */
function parseCall(args: string[], lhsNames: string[]): Call {
  if (args.length === 0) throw new Error('odesolve(t, b): give the variable and the end of the interval');
  const first = args[0].trim();
  const vm = /^\[(.*)\]$/s.exec(first);
  if (vm) {
    const unknowns = vm[1].split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    if (!unknowns.length || !unknowns.every(isIdentifier)) throw new Error('odesolve([x, y], t, b): list the unknown functions by name');
    if (args.length < 3) throw new Error('odesolve([x, y], t, b): give the variable and the end of the interval');
    const indep = args[1].trim();
    if (!isIdentifier(indep)) throw new Error(`odesolve: "${indep}" is not a variable name`);
    return { unknowns, indep, end: args[2], options: args.slice(3) };
  }
  if (!isIdentifier(first)) throw new Error(`odesolve: "${first}" is not a variable name`);
  if (args.length < 2) throw new Error(`odesolve(${first}, b): give the end of the interval`);
  if (lhsNames.length !== 1) throw new Error('Assign the solution to the unknown function: y := odesolve(t, 10 s)');
  return { unknowns: lhsNames, indep: first, end: args[1], options: args.slice(2) };
}

/** The independent variable and unknown functions of an odesolve solver line (for display), or []. */
export function odesolveNames(solver: string): string[] {
  const p = findTop(solver, ':=');
  let rest = p >= 0 ? solver.slice(p + 2) : solver;
  const e = findEvalEquals(rest);
  if (e >= 0) rest = rest.slice(0, e);
  const args = odesolveArgs(rest);
  if (!args) return [];
  let lhsNames: string[] = [];
  try {
    const lhs = p >= 0 ? parseLhs(solver.slice(0, p)) : null;
    lhsNames = !lhs ? [] : lhs.kind === 'destructure' ? lhs.names : lhs.kind === 'index' ? [] : [lhs.name];
  } catch {
    /* shown with its error by the solver */
  }
  try {
    const c = parseCall(args, lhsNames.length ? lhsNames : ['_']);
    return [c.indep, ...c.unknowns];
  } catch {
    return [];
  }
}

/** Is this solver call odesolve(…)? Returns the argument list. */
export function odesolveArgs(src: string): string[] | null {
  const m = /^\s*odesolve\s*\((.*)\)\s*$/is.exec(src);
  return m ? splitTop(m[1], ',').map((a) => a.trim()) : null;
}

// ---------------------------------------------------------------- reading the equations

interface Ref {
  j: number;
  k: number;
  arg: MathNode;
}

function constantInt(n: MathNode | undefined, what: string): number {
  const a = n as AnyNode | undefined;
  const v = a && a.type === 'ConstantNode' ? Number(a.value) : NaN;
  if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number`);
  return v;
}

/** A reference to an unknown function: y(arg), y''(arg) (as __d(y, 2, arg)) or diff(y(t), t, 2). */
function refOf(node: MathNode, unknowns: Map<string, number>, indep: string): Ref | null {
  const n = node as AnyNode;
  if (n.type !== 'FunctionNode') return null;
  const fn = n.fn as AnyNode;
  if (fn.type !== 'SymbolNode') return null;
  const name = fn.name as string;
  const args = n.args as MathNode[];
  if (unknowns.has(name)) {
    if (args.length !== 1) throw new Error(`${name}(…) takes one argument here`);
    return { j: unknowns.get(name)!, k: 0, arg: args[0] };
  }
  if (name === '__d') {
    const f = args[0] as AnyNode;
    if (f?.type !== 'SymbolNode' || !unknowns.has(f.name as string)) return null;
    if (args.length !== 3) throw new Error(`${f.name}'(…) takes one argument here`);
    return { j: unknowns.get(f.name as string)!, k: constantInt(args[1], 'The derivative order'), arg: args[2] };
  }
  if ((name === 'diff' || name === 'deriv') && args.length >= 2) {
    const inner = args[0] as AnyNode;
    const v = args[1] as AnyNode;
    if (inner.type !== 'FunctionNode' || (inner.fn as AnyNode).type !== 'SymbolNode') return null;
    const fname = (inner.fn as AnyNode).name as string;
    if (!unknowns.has(fname)) return null;
    const ia = inner.args as AnyNode[];
    if (v.type !== 'SymbolNode' || v.name !== indep || ia.length !== 1 || ia[0].type !== 'SymbolNode' || ia[0].name !== indep) {
      throw new Error(`Write the derivative as diff(${fname}(${indep}), ${indep}) or ${fname}'(${indep})`);
    }
    const k = args.length >= 3 ? constantInt(args[2], 'The derivative order') : 1;
    return { j: unknowns.get(fname)!, k, arg: ia[0] };
  }
  return null;
}

function collectRefs(node: MathNode, unknowns: Map<string, number>, indep: string, out: Ref[]): Ref[] {
  const r = refOf(node, unknowns, indep);
  if (r) {
    if (collectRefs(r.arg, unknowns, indep, []).length) throw new Error('An unknown function cannot appear inside its own argument');
    out.push(r);
    return out;
  }
  const n = node as AnyNode;
  if (n.type === 'SymbolNode' && unknowns.has(n.name as string)) {
    throw new Error(`Write ${n.name}(${indep}) with its argument, not ${n.name} alone`);
  }
  node.forEach((child: MathNode) => collectRefs(child, unknowns, indep, out));
  return out;
}

const placeholder = (j: number, k: number) => `__ode${j}_${k}`;

/** Replace every unknown-function reference by its state placeholder. */
function withPlaceholders(node: MathNode, unknowns: Map<string, number>, indep: string): MathNode {
  return node.transform((n: MathNode) => {
    const r = refOf(n, unknowns, indep);
    return r ? new math.SymbolNode(placeholder(r.j, r.k)) : n;
  });
}

const isIndep = (n: MathNode, indep: string) => (n as AnyNode).type === 'SymbolNode' && (n as AnyNode).name === indep;

function unwrap(n: MathNode): MathNode {
  let a = n as AnyNode;
  while (a.type === 'ParenthesisNode') a = a.content as AnyNode;
  return a;
}

/** Top-level additive terms of an expression (for working out units). */
function terms(n: MathNode, out: MathNode[] = []): MathNode[] {
  const a = unwrap(n) as AnyNode;
  if (a.type === 'OperatorNode' && (a.fn === 'add' || a.fn === 'subtract') && (a.args as MathNode[]).length === 2) {
    (a.args as MathNode[]).forEach((x) => terms(x, out));
  } else if (a.type === 'OperatorNode' && a.fn === 'unaryMinus') terms((a.args as MathNode[])[0], out);
  else out.push(a);
  return out;
}

// ---------------------------------------------------------------- units

const BASE_UNITS = ['kg', 'm', 's', 'A', 'K', 'cd', 'mol', 'rad', 'bits'];

function dimsOfValue(v: unknown): number[] {
  if (isUnit(v)) return (v as unknown as { dimensions: number[] }).dimensions.slice();
  return new Array(BASE_UNITS.length).fill(0);
}

function unitFromDims(d: number[]): Unit | null {
  let u: unknown = 1;
  d.forEach((e, i) => {
    if (Math.abs(e) > 1e-9) u = math.multiply(u as never, math.pow(math.unit(1, BASE_UNITS[i]) as never, Math.round(e * 1e6) / 1e6) as never);
  });
  return isUnit(u) ? splitUnit(u).unit : null;
}

const per = (u: Unit | null, t: Unit | null, k: number): Unit | null => {
  if (k === 0 || !t) return u;
  return splitUnit(math.divide((u ?? 1) as never, math.pow(t as never, k) as never)).unit;
};

const sameDims = (a: Unit | null, b: Unit | null) => (!a && !b) || (!!a && !!b && a.equalBase(b));

function unitText(u: Unit | null): string {
  return u ? u.formatUnits() || 'no unit' : 'no unit';
}

function fmt(v: number, unit: Unit | null): string {
  return math.format(quantity(v, unit) as never, { precision: 6 });
}

// ---------------------------------------------------------------- the solve

interface Condition {
  j: number;
  k: number;
  point: number;
  value: number;
  text: string;
}

export interface OdeBlockResult {
  /** One function per unknown, in the order listed. */
  functions: OdeFunction[];
  unknowns: string[];
}

export function solveOdeBlock(lines: OdeLine[], args: string[], lhsNames: string[], blockScope: ScopeLike, tol: number): OdeBlockResult {
  const call = parseCall(args, lhsNames);
  const { unknowns: names, indep } = call;
  const unknowns = new Map(names.map((n, i) => [n, i]));
  if (unknowns.has(indep)) throw new Error(`"${indep}" cannot be both the variable and an unknown function`);
  // definitions are captured when the block is solved, as for any function
  const scope = new ChainScope(snapshot(blockScope));
  const evalIn = (src: string | MathNode) => (typeof src === 'string' ? transformForEval(parseExpr(src)) : transformForEval(src)).compile().evaluate(scope);

  // method and steps
  let method: OdeMethod = 'auto';
  let steps: number | undefined;
  for (const o of call.options) {
    const v = evalIn(o);
    if (typeof v === 'string') {
      const m = METHODS[v.toLowerCase()];
      if (!m) throw new Error(`odesolve: unknown method "${v}" (use "adaptive", "rkadapt", "radau" or "fixed")`);
      method = m;
    } else {
      const n = splitUnit(v).value;
      if (!Number.isInteger(n) || n < 1) throw new Error('odesolve: the number of steps must be a whole number ≥ 1');
      steps = n;
    }
  }

  // classify the lines: differential equations (in t) and conditions (at points)
  const odes: { L: MathNode; R: MathNode; refs: Ref[]; text: string }[] = [];
  const condNodes: { ref: Ref; value: MathNode; text: string }[] = [];
  for (const line of lines) {
    const text = `${line.lhs.trim()} = ${line.rhs.trim()}`;
    if (line.op !== '=' && line.op !== '==') throw new Error(`odesolve takes equations only, not "${line.op}" (${text})`);
    const L = parseExpr(line.lhs), R = parseExpr(line.rhs);
    const refs = [...collectRefs(L, unknowns, indep, []), ...collectRefs(R, unknowns, indep, [])];
    if (!refs.length) throw new Error(`"${text}" does not contain ${names.length === 1 ? `the unknown function ${names[0]}` : 'an unknown function'}`);
    const inT = refs.map((r) => isIndep(r.arg, indep));
    if (inT.every(Boolean)) {
      odes.push({ L, R, refs, text });
      continue;
    }
    if (refs.some((r) => freeSymbols(r.arg).has(indep))) {
      throw new Error(`In "${text}" call the unknown functions with ${indep} itself, e.g. ${names[0]}(${indep})`);
    }
    // a condition: one side is y^(k)(a), the other a value
    const lr = refOf(unwrap(L), unknowns, indep), rr = refOf(unwrap(R), unknowns, indep);
    const ref = lr && refs.length === 1 ? lr : rr && refs.length === 1 ? rr : null;
    if (!ref) throw new Error(`Write conditions like ${names[0]}(0) = 1 or ${names[0]}'(0) = 0 (“${text}”)`);
    condNodes.push({ ref, value: ref === lr ? R : L, text });
  }
  if (!odes.length) throw new Error(`Add the differential equation, e.g. ${names[0]}''(${indep}) = -${names[0]}(${indep})`);
  if (odes.length !== names.length) {
    throw new Error(`Give one differential equation per unknown function: ${odes.length} equation${odes.length === 1 ? '' : 's'} for ${names.length} function${names.length === 1 ? '' : 's'}`);
  }

  // orders: the highest derivative of each unknown in the equations
  const order = names.map(() => 0);
  for (const e of odes) for (const r of e.refs) order[r.j] = Math.max(order[r.j], r.k);
  names.forEach((n, j) => {
    if (order[j] === 0) throw new Error(`No derivative of ${n} in the equations: odesolve needs ${n}'(${indep}) or higher`);
  });
  const offset: number[] = [];
  let dim = 0;
  for (const p of order) { offset.push(dim); dim += p; }

  // the independent variable's unit, from the end point and the condition points
  const endV = splitUnit(evalIn(call.end));
  const points = condNodes.map((c) => splitUnit(evalIn(c.ref.arg)));
  let tUnit: Unit | null = endV.unit;
  for (const p of points) if (!tUnit && p.unit) tUnit = p.unit;
  for (const [i, p] of [endV, ...points].entries()) {
    const what = i === 0 ? `the end ${call.end.trim()}` : `the point in “${condNodes[i - 1].text}”`;
    if (p.unit && !sameDims(p.unit, tUnit)) throw new Error(`odesolve: ${what} has units of ${unitText(p.unit)}, the variable ${indep} has ${unitText(tUnit)}`);
    if (!p.unit && tUnit && p.value !== 0) throw new Error(`odesolve: ${what} needs units like ${unitText(tUnit)}`);
  }

  // each unknown's unit, from its conditions (bare zeros say nothing)
  const yUnit: (Unit | null | undefined)[] = names.map(() => undefined);
  const condValues = condNodes.map((c) => splitUnit(evalIn(c.value)));
  condNodes.forEach((c, i) => {
    const v = condValues[i];
    if (!v.unit && v.value === 0) return;
    const u = v.unit && tUnit && c.ref.k > 0 ? splitUnit(math.multiply(v.unit as never, math.pow(tUnit as never, c.ref.k) as never)).unit : v.unit;
    const prev = yUnit[c.ref.j];
    if (prev !== undefined && !sameDims(prev, u)) {
      throw new Error(`“${c.text}”: ${derivName(names[c.ref.j], c.ref.k)} needs units of ${unitText(per(prev, tUnit, c.ref.k))}, as the other conditions give ${names[c.ref.j]} in ${unitText(prev)}`);
    }
    if (prev === undefined || (u && !prev)) yUnit[c.ref.j] = u;
  });
  if (yUnit.some((u) => u === undefined)) inferUnits(yUnit, odes, unknowns, indep, order, tUnit, scope);
  const units = names.map((_, j) => Array.from({ length: order[j] + 1 }, (_, k) => per(yUnit[j] ?? null, tUnit, k)));

  // conditions in SI, checked against the unknowns' units and orders
  const conds: Condition[] = condNodes.map((c, i) => {
    const { j, k } = c.ref;
    if (k >= order[j]) {
      throw new Error(`“${c.text}”: the equations are of order ${order[j]} in ${names[j]}, so conditions can only fix ${Array.from({ length: order[j] }, (_, q) => derivName(names[j], q)).join(', ')}`);
    }
    const v = condValues[i];
    if (!(v.value === 0 && !v.unit) && !sameDims(v.unit, units[j][k])) {
      throw new Error(`“${c.text}”: ${derivName(names[j], k)} has units of ${unitText(units[j][k])}, not ${unitText(v.unit)}`);
    }
    return { j, k, point: points[i].value, value: v.value, text: c.text };
  });

  // compiled residuals G_i(t, Y, U) = lhs − rhs, with U the highest derivatives
  const hiPh = names.map((_, j) => placeholder(j, order[j]));
  const compiled = odes.map((e) => ({
    text: e.text,
    L: transformForEval(withPlaceholders(e.L, unknowns, indep)).compile(),
    R: transformForEval(withPlaceholders(e.R, unknowns, indep)).compile(),
  }));
  // explicit form y^(p)(t) = f(…) for every unknown: no Newton iteration needed
  const explicit: ({ expr: ReturnType<MathNode['compile']>; text: string } | null)[] = names.map(() => null);
  for (const e of odes) {
    for (const [side, other] of [[e.L, e.R], [e.R, e.L]] as const) {
      const r = refOf(unwrap(side), unknowns, indep);
      if (!r || r.k !== order[r.j] || explicit[r.j]) continue;
      const otherRefs = collectRefs(other, unknowns, indep, []);
      if (otherRefs.some((q) => q.k === order[q.j])) continue;
      explicit[r.j] = { expr: transformForEval(withPlaceholders(other, unknowns, indep)).compile(), text: e.text };
      break;
    }
  }
  const allExplicit = explicit.every(Boolean) && new Set(explicit.map((x) => x?.text)).size === names.length;
  const setState = (t: number, Y: number[]) => {
    scope.set(indep, quantity(t, tUnit));
    names.forEach((_, j) => {
      for (let k = 0; k < order[j]; k++) scope.set(placeholder(j, k), quantity(Y[offset[j] + k], units[j][k]));
    });
  };
  const setHighest = (U: number[]) => names.forEach((_, j) => scope.set(hiPh[j], quantity(U[j], units[j][order[j]])));
  const where = (t: number) => `${indep} = ${fmt(t, tUnit)}`;
  const value = (v: unknown, text: string, t: number) => {
    let s: number;
    try {
      s = splitUnit(v).value;
    } catch {
      throw new Error(`“${text}” does not give a single real value at ${where(t)}`);
    }
    return s;
  };
  const residuals = (t: number): number[] => compiled.map((c) => {
    let v: unknown;
    try {
      const l = c.L.evaluate(scope), r = c.R.evaluate(scope);
      // "… = 0" needs no unit on the zero
      v = r === 0 ? l : l === 0 ? math.unaryMinus(r as never) : math.subtract(l as never, r as never);
    } catch (e) {
      const msg = (e as Error).message;
      if (/Units do not match|dimension/i.test(msg)) throw new Error(`The two sides of “${c.text}” have different units`);
      throw e;
    }
    return value(v, c.text, t);
  });

  let lastU: number[] = names.map(() => 0);
  const uScale = names.map(() => 0);
  let jac: number[][] | null = null;
  const highest = (t: number, Y: number[]): number[] => {
    setState(t, Y);
    if (allExplicit) {
      return explicit.map((c) => value(c!.expr.evaluate(scope), c!.text, t));
    }
    // chord Newton on G(U) = 0 from the last solution; G is usually linear in U
    let U = lastU.slice();
    for (let it = 0; it < 30; it++) {
      setHighest(U);
      const G = residuals(t);
      if (!jac || it === 4 || it === 12) {
        jac = G.map(() => new Array(names.length).fill(0));
        for (let q = 0; q < names.length; q++) {
          const d = 1e-7 * Math.max(Math.abs(U[q]), uScale[q]) || 1e-7;
          const Up = U.slice();
          Up[q] += d;
          setHighest(Up);
          const Gp = residuals(t);
          for (let i = 0; i < G.length; i++) jac[i][q] = (Gp[i] - G[i]) / (Up[q] - U[q]);
        }
      }
      let dU: number[];
      try {
        dU = N.solveLinear(jac, G.map((g) => -g));
      } catch {
        throw new Error(`The equations cannot be solved for ${names.map((n, j) => derivName(n, order[j])).join(', ')} at ${where(t)}: does each equation contain a highest derivative?`);
      }
      U = U.map((u, q) => u + dU[q]);
      if (dU.every((d, q) => Math.abs(d) <= 1e-12 * Math.max(Math.abs(U[q]), uScale[q]) || d === 0)) {
        lastU = U;
        U.forEach((u, q) => (uScale[q] = Math.max(uScale[q], Math.abs(u))));
        return U;
      }
    }
    throw new Error(`Could not solve the equations for ${names.map((n, j) => derivName(n, order[j])).join(', ')} at ${where(t)}`);
  };
  const rhs = (t: number, Y: number[]): number[] => {
    tick();
    const U = highest(t, Y);
    const dY = new Array(dim);
    names.forEach((_, j) => {
      for (let k = 0; k < order[j]; k++) dY[offset[j] + k] = k + 1 < order[j] ? Y[offset[j] + k + 1] : U[j];
    });
    return dY;
  };

  // initial or boundary value problem
  const rtol = Math.min(Math.max(tol, 1e-12), 1e-4);
  const groups: { point: number; conds: Condition[] }[] = [];
  const span0 = Math.max(Math.abs(endV.value), ...conds.map((c) => Math.abs(c.point)), 1e-300);
  for (const c of conds) {
    const g = groups.find((x) => Math.abs(x.point - c.point) <= 1e-12 * span0);
    if (g) g.conds.push(c);
    else groups.push({ point: c.point, conds: [c] });
  }
  for (const g of groups) {
    const seen = new Set<string>();
    for (const c of g.conds) {
      const key = `${c.j}:${c.k}`;
      if (seen.has(key)) throw new Error(`Two conditions for ${derivName(names[c.j], c.k)}(${fmt(g.point, tUnit)})`);
      seen.add(key);
    }
  }
  const needed = names.flatMap((_, j) => Array.from({ length: order[j] }, (_, k) => ({ j, k })));
  if (groups.length === 0) throw new Error(`Add initial conditions, e.g. ${names[0]}(0) = …`);
  if (groups.length === 1) {
    const g = groups[0];
    for (const { j, k } of needed) {
      if (!g.conds.some((c) => c.j === j && c.k === k)) throw new Error(`missing initial condition for ${derivName(names[j], k)}`);
    }
  } else if (conds.length !== needed.length) {
    throw new Error(`The equations need ${needed.length} conditions (${needed.map(({ j, k }) => derivName(names[j], k)).join(', ')} at some points); there are ${conds.length}`);
  }
  // shoot from the point with the most conditions
  const start = groups.reduce((a, b) => (b.conds.length > a.conds.length || (b.conds.length === a.conds.length && b.point < a.point) ? b : a));
  const others = conds.filter((c) => !start.conds.includes(c));
  const lo = Math.min(endV.value, ...groups.map((g) => g.point));
  const hi = Math.max(endV.value, ...groups.map((g) => g.point));
  if (lo === hi) throw new Error(`odesolve: the interval is empty (the end ${call.end.trim()} is the starting point)`);
  const freeIdx = needed.filter(({ j, k }) => !start.conds.some((c) => c.j === j && c.k === k)).map(({ j, k }) => offset[j] + k);
  const Y0base = new Array(dim).fill(0);
  for (const c of start.conds) Y0base[offset[c.j] + c.k] = c.value;

  let useMethod = method;
  interface Pieces { fwd: OdeSolution | null; bwd: OdeSolution | null; peak: number[] }
  const integrate = (x: number[], mesh?: Pieces): Pieces => {
    const Y0 = Y0base.slice();
    freeIdx.forEach((i, q) => (Y0[i] = x[q]));
    const go = (t1: number, prev: OdeSolution | null) => {
      if (t1 === start.point) return null;
      const opts = { method: useMethod, rtol, steps, ...(prev ? { mesh: prev.ts } : {}) };
      const sol = solveIvp(rhs, start.point, Y0, t1, opts);
      // a switch to the stiff solver mid-way would not replay: solve stiff throughout
      if (!prev && sol.stiffAt !== undefined && freeIdx.length) {
        useMethod = 'radau';
        return solveIvp(rhs, start.point, Y0, t1, { ...opts, method: 'radau' });
      }
      return sol;
    };
    const fwd = go(hi, mesh?.fwd ?? null);
    const bwd = go(lo, mesh?.bwd ?? null);
    const peak = Y0.map(Math.abs);
    for (const s of [fwd, bwd]) if (s) for (const y of s.ys) y.forEach((v, i) => (peak[i] = Math.max(peak[i], Math.abs(v))));
    return { fwd, bwd, peak };
  };
  const stateAt = (p: Pieces, t: number): number[] => {
    const s = t >= start.point ? p.fwd ?? p.bwd : p.bwd ?? p.fwd;
    return s ? s.at(t) : Y0base.slice();
  };
  const miss = (p: Pieces) => others.map((c) => stateAt(p, c.point)[offset[c.j] + c.k] - c.value);
  const pieces = freeIdx.length ? shoot(integrate, miss, others, freeIdx, offset, rtol, names) : integrate([]);

  // the solution functions
  const tq = (v: unknown, name: string): number => {
    const s = splitUnit(v);
    if (s.unit && !sameDims(s.unit, tUnit)) throw new Error(`${name}(…): the argument has units of ${unitText(s.unit)}, ${indep} has ${unitText(tUnit)}`);
    if (!s.unit && tUnit && s.value !== 0) throw new Error(`${name}(…): the argument needs units like ${unitText(tUnit)}`);
    const pad = 1e-12 * (hi - lo);
    if (s.value < lo - pad || s.value > hi + pad) {
      throw new Error(`${name}(${fmt(s.value, tUnit)}) is outside the solution interval ${fmt(lo, tUnit)} … ${fmt(hi, tUnit)}`);
    }
    return Math.min(hi, Math.max(lo, s.value));
  };
  const at = (j: number, k: number, v: unknown): unknown => {
    const name = derivName(names[j], k);
    const t = tq(v, name);
    const Y = stateAt(pieces, t);
    if (k < order[j]) return quantity(Y[offset[j] + k], units[j][k]);
    if (k === order[j]) return quantity(highest(t, Y)[j], units[j][k]);
    if (k - order[j] > 4) throw new Error(`${name}: derivatives beyond order ${order[j] + 4} are not available`);
    // beyond the equations' order: differentiate the highest derivative numerically
    const clamp = (s: number) => Math.min(hi, Math.max(lo, s));
    const d = N.derivative((s) => highest(clamp(s), stateAt(pieces, clamp(s)))[j], t, k - order[j]);
    return quantity(d, per(yUnit[j] ?? null, tUnit, k));
  };
  const functions = names.map((name, j) => {
    const f = ((v: unknown, ...rest: unknown[]) => {
      if (rest.length) throw new Error(`${name}(${indep}) takes one argument`);
      return at(j, 0, v);
    }) as OdeFunction;
    f.odeDerivative = (k: number, v: unknown) => at(j, k, v);
    return f;
  });
  return { functions, unknowns: names };
}

/** Newton on the unknown starting values until the conditions at the other points hold. */
function shoot<P extends { peak: number[] }>(
  integrate: (x: number[], mesh?: P) => P,
  miss: (p: P) => number[],
  others: Condition[],
  freeIdx: number[],
  offset: number[],
  rtol: number,
  names: string[],
): P {
  const m = freeIdx.length;
  let x = new Array(m).fill(0);
  let cur = integrate(x);
  let r = miss(cur);
  const scaleOf = (p: P) => others.map((c) => Math.max(Math.abs(c.value), p.peak[offset[c.j] + c.k], 1e-300));
  const norm = (rv: number[], p: P) => {
    const sc = scaleOf(p);
    return Math.max(...rv.map((v, i) => Math.abs(v) / sc[i]));
  };
  let nr = norm(r, cur);
  const goal = Math.max(1e-10, 50 * rtol);
  for (let it = 0; it < 30 && nr > goal; it++) {
    // sensitivities on the same mesh, so that the map from x to r is smooth
    const J: number[][] = r.map(() => new Array(m).fill(0));
    for (let q = 0; q < m; q++) {
      const sig = cur.peak[freeIdx[q]] || 1;
      const d = 1e-6 * Math.max(Math.abs(x[q]), sig);
      const xp = x.slice();
      xp[q] += d;
      let rp: number[];
      try {
        rp = miss(integrate(xp, cur));
      } catch {
        rp = miss(integrate(xp));
      }
      for (let i = 0; i < r.length; i++) J[i][q] = (rp[i] - r[i]) / d;
    }
    let dx: number[];
    try {
      dx = N.solveLinear(J, r.map((v) => -v));
    } catch {
      throw new Error('The boundary conditions do not determine the solution (they may contradict each other)');
    }
    let lambda = 1;
    let accepted = false;
    for (let ls = 0; ls < 10; ls++) {
      const xn = x.map((v, q) => v + lambda * dx[q]);
      try {
        const pn = integrate(xn);
        const rn = miss(pn);
        const nn = norm(rn, pn);
        if (nn < nr || ls === 9) {
          x = xn; cur = pn; r = rn; nr = nn;
          accepted = true;
          break;
        }
      } catch {
        /* overshoot: try a shorter step */
      }
      lambda /= 2;
    }
    if (!accepted) break;
  }
  if (!(nr <= goal * 10)) {
    throw new Error(`The boundary conditions could not be met (shooting on ${freeIdx.length} unknown starting value${freeIdx.length === 1 ? '' : 's'} of ${names.join(', ')} did not converge)`);
  }
  return cur;
}

/**
 * Units of unknowns whose conditions are bare zeros, from dimensional consistency of
 * the equations: each additive term is evaluated with a probe unit on one unknown.
 */
function inferUnits(
  yUnit: (Unit | null | undefined)[],
  odes: { L: MathNode; R: MathNode; text: string }[],
  unknowns: Map<string, number>,
  indep: string,
  order: number[],
  tUnit: Unit | null,
  scope: ChainScope,
) {
  const open = [...yUnit.keys()].filter((j) => yUnit[j] === undefined);
  const probe = math.unit(1, 'bits') as Unit;
  const BIT = BASE_UNITS.indexOf('bits');
  const setAll = (probeFor: number) => {
    scope.set(indep, quantity(1, tUnit));
    yUnit.forEach((u, j) => {
      const base = u === undefined ? (j === probeFor ? probe : null) : u;
      for (let k = 0; k <= order[j]; k++) scope.set(placeholder(j, k), quantity(1, per(base, tUnit, k)));
    });
  };
  // rows: Σ_j a_j · D_j = c (one row per pair of terms, per base dimension)
  const rows: { a: number[]; c: number[] }[] = [];
  for (const e of odes) {
    const ts = [...terms(e.L), ...terms(e.R)].map((n) => transformForEval(withPlaceholders(n, unknowns, indep)).compile());
    const info: { c0: number[]; a: number[] }[] = [];
    for (const c of ts) {
      let c0: number[];
      try {
        setAll(-1);
        const v = c.evaluate(scope);
        if (v === 0) continue; // a bare zero has any unit
        c0 = dimsOfValue(v);
      } catch {
        continue;
      }
      const a = open.map((j, q) => {
        setAll(j);
        try {
          return dimsOfValue(c.evaluate(scope))[BIT] - c0[BIT];
        } catch {
          // the term only works with this unknown dimensionless (sin(y(t)) …)
          rows.push({ a: open.map((_, r) => (r === q ? 1 : 0)), c: new Array(BASE_UNITS.length).fill(0) });
          return 0;
        }
      });
      info.push({ c0, a });
    }
    for (let i = 1; i < info.length; i++) {
      const a = open.map((_, q) => info[i].a[q] - info[0].a[q]);
      if (a.every((v) => v === 0)) continue;
      rows.push({ a, c: info[0].c0.map((v, d) => v - info[i].c0[d]) });
    }
  }
  // least squares per base dimension
  const n = open.length;
  const AtA = Array.from({ length: n }, (_, p) => Array.from({ length: n }, (_, q) => rows.reduce((s, r) => s + r.a[p] * r.a[q], 0)));
  let solved: number[][] | null = null;
  try {
    solved = BASE_UNITS.map((_, d) => N.solveLinear(AtA, open.map((_, p) => rows.reduce((s, r) => s + r.a[p] * r.c[d], 0))));
  } catch {
    solved = null;
  }
  open.forEach((j, q) => {
    yUnit[j] = solved ? unitFromDims(solved.map((col) => col[q])) : null;
  });
}
