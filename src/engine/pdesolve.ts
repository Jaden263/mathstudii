// Pdesolve in solve blocks (Mathcad's Given … Pdesolve) and numol: partial differential
// equations in u(x, t) on an interval, by the method of lines. Second-order central
// differences in x make one ODE per grid node: Dirichlet ends are not unknowns at all,
// Neumann and Robin ends use a ghost node (so an insulated rod keeps ∫u dx exactly), and
// Radau IIA (ode.ts) integrates in t on a banded Jacobian. The result is a function
// u(x, t): the dense solution in t, a not-a-knot cubic spline through the nodes in x.
//
// Notation, as in Mathcad: partial derivatives are subscripts spelling the variables,
// u_t(x, t), u_tt(x, t), u_x(x, t), u_xx(x, t) (diff(u(x, t), x, 2) also works); the
// initial condition is u(x, 0) = f(x) (and u_t(x, 0) = g(x) for u_tt); the boundary
// conditions are u(0, t) = …, u_x(L, t) = … or any equation in u and u_x at an end
// (Robin, e.g. k u_x(0, t) = h (u(0, t) − T_a)).
import type { MathNode, Unit } from 'mathjs';
import { math, isUnit, isMatrix, splitUnit, quantity } from './math';
import { ChainScope, snapshot, type ScopeLike } from './scope';
import { parseExpr, transformForEval, freeSymbols } from './compile';
import { isIdentifier, splitTop, findTop, findEvalEquals, parseLhs } from './syntax';
import { tick, vec, engineCtx } from './library';
import { solveIvp } from './ode';
import type { OdeLine } from './odesolve';
import * as N from './numeric';

type AnyNode = MathNode & Record<string, unknown>;
type Compiled = ReturnType<MathNode['compile']>;

/** Grid nodes in x when the call does not say (h = L/200: the heat-equation test is good to 2·10⁻⁵). */
export const DEFAULT_XPTS = 201;

// ---------------------------------------------------------------- the numeric core

export interface MolBoundary {
  /** value: u at the end is given; flux: ∂u/∂x at the end, which may depend on u there (Robin). */
  kind: 'value' | 'flux';
  at(t: number, u: number): number;
}

export interface MolUnknown {
  /** Highest time derivative in the equations (1: u_t, 2: u_tt). */
  tOrder: number;
  /** Highest x derivative (0 … 2). */
  xOrder: number;
  left?: MolBoundary;
  right?: MolBoundary;
  /** Initial values [u, u_t …][node]. */
  init: number[][];
}

/** One unknown at a node. */
export interface NodeValues { u: number; ux: number; uxx: number; ut: number }

export interface MolProblem {
  xs: number[];
  t0: number;
  t1: number;
  unknowns: MolUnknown[];
  /** The highest time derivative of every unknown at node i. */
  rate(i: number, t: number, v: NodeValues[]): number[];
  rtol: number;
  /** At least this many steps in t. */
  steps?: number;
}

export interface MolSolution {
  /** Nodal values [unknown][node] at time t, the ends included. */
  at(t: number): number[][];
  steps: number;
}

export function solveMol(p: MolProblem): MolSolution {
  const { xs, unknowns: U } = p;
  const n = xs.length;
  if (n < 5) throw new Error('Pdesolve: use at least 5 points in x');
  const h = (xs[n - 1] - xs[0]) / (n - 1);
  const fixedAt = (u: MolUnknown, i: number) => (i === 0 && u.left?.kind === 'value') || (i === n - 1 && u.right?.kind === 'value');
  // state layout: node by node, then unknown, then u, u_t …
  const idx = U.map((u) => Array.from({ length: u.tOrder }, () => new Array<number>(n).fill(-1)));
  const first: number[] = [], last: number[] = [];
  let dim = 0;
  for (let i = 0; i < n; i++) {
    first.push(dim);
    U.forEach((u, j) => {
      if (!fixedAt(u, i)) for (let k = 0; k < u.tOrder; k++) idx[j][k][i] = dim++;
    });
    last.push(dim - 1);
  }
  // an end without a flux condition is differenced one-sided, over four nodes
  const reachL = U.every((u) => u.left?.kind === 'flux') ? 1 : 3;
  const reachR = U.every((u) => u.right?.kind === 'flux') ? 1 : 3;
  let band = 0;
  for (let i = 0; i < n; i++) {
    if (last[i] < first[i]) continue;
    const r = i === 0 ? reachL : i === n - 1 ? reachR : 1;
    const lo = first[Math.max(0, i - r)], hi = last[Math.min(n - 1, i + r)];
    band = Math.max(band, last[i] - lo, hi - first[i]);
  }

  const span = p.t1 - p.t0;
  const valueRate = (b: MolBoundary, t: number) => {
    const d = 1e-6 * Math.abs(span);
    return (b.at(t + d, NaN) - b.at(t - d, NaN)) / (2 * d);
  };
  const nodal = (t: number, Y: number[]) => U.map((u, j) => {
    const v = new Array<number>(n);
    for (let i = 0; i < n; i++) v[i] = idx[j][0][i] >= 0 ? Y[idx[j][0][i]] : NaN;
    if (u.left?.kind === 'value') v[0] = u.left.at(t, NaN);
    if (u.right?.kind === 'value') v[n - 1] = u.right.at(t, NaN);
    return v;
  });
  const values = (j: number, i: number, t: number, Y: number[], v: number[], flux: number[]): NodeValues => {
    const u = U[j];
    let ux: number, uxx: number;
    if (i > 0 && i < n - 1) {
      ux = (v[i + 1] - v[i - 1]) / (2 * h);
      uxx = (v[i + 1] - 2 * v[i] + v[i - 1]) / (h * h);
    } else if (i === 0 && u.left?.kind === 'flux') {
      // ghost node v₋₁ = v₁ − 2h u_x
      ux = flux[0];
      uxx = (2 * (v[1] - v[0]) - 2 * h * ux) / (h * h);
    } else if (i === n - 1 && u.right?.kind === 'flux') {
      ux = flux[1];
      uxx = (2 * (v[n - 2] - v[n - 1]) + 2 * h * ux) / (h * h);
    } else if (i === 0) {
      ux = (-3 * v[0] + 4 * v[1] - v[2]) / (2 * h);
      uxx = (2 * v[0] - 5 * v[1] + 4 * v[2] - v[3]) / (h * h);
    } else {
      ux = (3 * v[n - 1] - 4 * v[n - 2] + v[n - 3]) / (2 * h);
      uxx = (2 * v[n - 1] - 5 * v[n - 2] + 4 * v[n - 3] - v[n - 4]) / (h * h);
    }
    let ut = NaN;
    if (u.tOrder === 2) {
      if (idx[j][1][i] >= 0) ut = Y[idx[j][1][i]];
      else ut = valueRate(i === 0 ? u.left! : u.right!, t);
    }
    return { u: v[i], ux, uxx, ut };
  };
  const rhs = (t: number, Y: number[]): number[] => {
    tick();
    const v = nodal(t, Y);
    const flux = U.map((u, j) => [
      u.left?.kind === 'flux' ? u.left.at(t, v[j][0]) : NaN,
      u.right?.kind === 'flux' ? u.right.at(t, v[j][n - 1]) : NaN,
    ]);
    const dY = new Array<number>(dim);
    for (let i = 0; i < n; i++) {
      if (last[i] < first[i]) continue;
      const r = p.rate(i, t, U.map((_, j) => values(j, i, t, Y, v[j], flux[j])));
      U.forEach((u, j) => {
        if (idx[j][0][i] < 0) return;
        for (let k = 0; k + 1 < u.tOrder; k++) dY[idx[j][k][i]] = Y[idx[j][k + 1][i]];
        dY[idx[j][u.tOrder - 1][i]] = r[j];
      });
    }
    return dY;
  };

  const Y0 = new Array<number>(dim).fill(0);
  U.forEach((u, j) => {
    for (let k = 0; k < u.tOrder; k++) for (let i = 0; i < n; i++) if (idx[j][k][i] >= 0) Y0[idx[j][k][i]] = u.init[k][i];
  });
  // errors relative to each unknown's size, so that nodes starting at zero do not need 10⁻³⁰⁰
  const atol = new Array<number>(dim).fill(0);
  U.forEach((u, j) => {
    const ends = [u.left, u.right].filter((b) => b?.kind === 'value').map((b) => Math.abs(b!.at(p.t0, NaN)));
    const size = Math.max(...u.init[0].map(Math.abs), ...ends, 0) || 1;
    for (let k = 0; k < u.tOrder; k++) {
      const s = k === 0 ? size : Math.max(...u.init[k].map(Math.abs), size / Math.abs(span));
      for (let i = 0; i < n; i++) if (idx[j][k][i] >= 0) atol[idx[j][k][i]] = 1e-3 * p.rtol * s;
    }
  });
  const sol = dim === 0 ? null : solveIvp(rhs, p.t0, Y0, p.t1, { method: 'radau', rtol: p.rtol, atol, band, steps: p.steps });
  return {
    at: (t: number) => nodal(t, sol ? sol.at(t) : []),
    steps: sol?.steps ?? 0,
  };
}

// ---------------------------------------------------------------- the solve block call

interface Call {
  unknowns: string[];
  x: string;
  xRange: string;
  t: string;
  tRange: string;
  xpts?: string;
  tpts?: string;
}

/** Pdesolve(u, x, [0, L], t, [0, T] [, xpts [, tpts]]) or …, [xpts, tpts]; [u; v] for systems. */
function parseCall(args: string[], lhsNames: string[]): Call {
  const usage = 'Pdesolve(u, x, [0, L], t, [0, T]): give the unknown function, the variables and their ranges';
  if (args.length < 5) throw new Error(usage);
  const head = args[0].trim();
  const list = /^\[(.*)\]$/s.exec(head);
  const unknowns = list ? list[1].split(/[;,]/).map((s) => s.trim()).filter(Boolean) : [head];
  if (!unknowns.length || !unknowns.every(isIdentifier)) throw new Error(usage);
  const x = args[1].trim(), t = args[3].trim();
  if (!isIdentifier(x)) throw new Error(`Pdesolve: "${x}" is not a variable name`);
  if (!isIdentifier(t)) throw new Error(`Pdesolve: "${t}" is not a variable name`);
  if (x === t) throw new Error('Pdesolve: the space and time variables need different names');
  if (unknowns.includes(x) || unknowns.includes(t)) throw new Error('Pdesolve: a variable cannot also be an unknown function');
  if (lhsNames.length === 1 && unknowns.length === 1 && lhsNames[0] !== unknowns[0]) {
    throw new Error(`Assign the solution to the unknown function: ${unknowns[0]} := Pdesolve(${unknowns[0]}, …)`);
  }
  const call: Call = { unknowns, x, xRange: args[2], t, tRange: args[4] };
  if (args.length > 7) throw new Error(`${usage}, and optionally the numbers of points`);
  const pts = args[5]?.trim();
  const pair = pts ? /^\[(.*)\]$/s.exec(pts) : null;
  if (pair && args.length === 6) {
    const parts = splitTop(pair[1].replace(/;/g, ','), ',').map((s) => s.trim());
    if (parts.length !== 2) throw new Error('Pdesolve: give the numbers of points as [xpts, tpts]');
    [call.xpts, call.tpts] = parts;
  } else {
    call.xpts = pts;
    call.tpts = args[6];
  }
  return call;
}

/** Is this solver call Pdesolve(…)? Returns the argument list. */
export function pdesolveArgs(src: string): string[] | null {
  const m = /^\s*pdesolve\s*\((.*)\)\s*$/is.exec(src);
  return m ? splitTop(m[1], ',').map((a) => a.trim()) : null;
}

/** Names a Pdesolve block uses (for display): the variables, the unknowns and their derivatives. */
export function pdesolveNames(solver: string): string[] {
  const p = findTop(solver, ':=');
  let rest = p >= 0 ? solver.slice(p + 2) : solver;
  const e = findEvalEquals(rest);
  if (e >= 0) rest = rest.slice(0, e);
  const args = pdesolveArgs(rest);
  if (!args) return [];
  let lhsNames: string[] = [];
  try {
    const lhs = p >= 0 ? parseLhs(solver.slice(0, p)) : null;
    lhsNames = !lhs ? [] : lhs.kind === 'destructure' ? lhs.names : lhs.kind === 'index' || lhs.kind === 'elements' ? [] : [lhs.name];
  } catch {
    /* shown with its error by the solver */
  }
  try {
    const c = parseCall(args, lhsNames);
    const subs = [c.x, c.t, c.x + c.x, c.t + c.t];
    return [c.x, c.t, ...c.unknowns, ...c.unknowns.flatMap((u) => subs.map((s) => `${u}_${s}`))];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- reading the equations

interface Ref {
  j: number;
  kx: number;
  kt: number;
  ax: MathNode;
  at: MathNode;
}

interface Vars {
  unknowns: Map<string, number>;
  names: string[];
  x: string;
  t: string;
}

/** u_xx → (2, 0), u_t → (0, 1): the subscript spells the variables. */
function subscriptOrders(sub: string, v: Vars): [number, number] | null {
  let kx = 0, kt = 0, s = sub;
  const [a, b] = v.x.length >= v.t.length ? [v.x, v.t] : [v.t, v.x];
  while (s) {
    const w = s.startsWith(a) ? a : s.startsWith(b) ? b : '';
    if (!w) return null;
    if (w === v.x) kx++; else kt++;
    s = s.slice(w.length);
  }
  return [kx, kt];
}

const isSymbol = (n: MathNode, name: string) => (n as AnyNode).type === 'SymbolNode' && (n as AnyNode).name === name;

function constantInt(n: MathNode | undefined, what: string): number {
  const a = n as AnyNode | undefined;
  const v = a && a.type === 'ConstantNode' ? Number(a.value) : NaN;
  if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a whole number`);
  return v;
}

/** A reference to an unknown: u(a, b), u_xx(a, b) or diff(u(x, t), x, 2). */
function refOf(node: MathNode, v: Vars): Ref | null {
  const n = node as AnyNode;
  if (n.type !== 'FunctionNode') return null;
  const fn = n.fn as AnyNode;
  if (fn.type !== 'SymbolNode') return null;
  const name = fn.name as string;
  const args = n.args as MathNode[];
  const two = (j: number, kx: number, kt: number, shown: string): Ref => {
    if (args.length !== 2) throw new Error(`${shown}(${v.x}, ${v.t}) takes two arguments`);
    return { j, kx, kt, ax: args[0], at: args[1] };
  };
  if (v.unknowns.has(name)) return two(v.unknowns.get(name)!, 0, 0, name);
  const us = name.indexOf('_');
  if (us > 0 && v.unknowns.has(name.slice(0, us))) {
    const o = subscriptOrders(name.slice(us + 1), v);
    if (o) return two(v.unknowns.get(name.slice(0, us))!, o[0], o[1], name);
  }
  if (name === '__d') {
    const f = args[0] as AnyNode;
    if (f?.type === 'SymbolNode' && v.unknowns.has(f.name as string)) {
      throw new Error(`Write partial derivatives with subscripts, ${f.name}_${v.t}(${v.x}, ${v.t}) and ${f.name}_${v.x}${v.x}(${v.x}, ${v.t}), not primes`);
    }
    return null;
  }
  if ((name === 'diff' || name === 'deriv') && args.length >= 2) {
    const inner = refOf(args[0], v);
    if (!inner) return null;
    const by = args[1] as AnyNode;
    if (!isSymbol(inner.ax, v.x) || !isSymbol(inner.at, v.t) || (by.type !== 'SymbolNode') || (by.name !== v.x && by.name !== v.t)) {
      throw new Error(`Write the derivative as diff(${v.names[inner.j]}(${v.x}, ${v.t}), ${v.x}) or ${v.names[inner.j]}_${v.x}(${v.x}, ${v.t})`);
    }
    const k = args.length >= 3 ? constantInt(args[2], 'The derivative order') : 1;
    return by.name === v.x ? { ...inner, kx: inner.kx + k } : { ...inner, kt: inner.kt + k };
  }
  return null;
}

function collectRefs(node: MathNode, v: Vars, out: Ref[]): Ref[] {
  const r = refOf(node, v);
  if (r) {
    if (collectRefs(r.ax, v, []).length || collectRefs(r.at, v, []).length) throw new Error('An unknown function cannot appear inside its own argument');
    out.push(r);
    return out;
  }
  const n = node as AnyNode;
  if (n.type === 'SymbolNode' && v.unknowns.has(n.name as string)) {
    throw new Error(`Write ${n.name}(${v.x}, ${v.t}) with its arguments, not ${n.name} alone`);
  }
  node.forEach((child: MathNode) => collectRefs(child, v, out));
  return out;
}

function unwrap(n: MathNode): MathNode {
  let a = n as AnyNode;
  while (a.type === 'ParenthesisNode') a = a.content as AnyNode;
  return a;
}

/** Replace unknown references by placeholders named by name(ref). */
function withPlaceholders(node: MathNode, v: Vars, name: (r: Ref) => string): MathNode {
  return node.transform((n: MathNode) => {
    const r = refOf(n, v);
    return r ? new math.SymbolNode(name(r)) : n;
  });
}

const ph = (j: number, kx: number, kt: number) => `__pde${j}_${kx}_${kt}`;
const BC_U = '__pdeb0', BC_UX = '__pdeb1';

// ---------------------------------------------------------------- units

function dimsOf(u: Unit | null): number[] {
  return u ? (u as unknown as { dimensions: number[] }).dimensions : [];
}
const ANGLE = 7;
const sameDims = (a: Unit | null, b: Unit | null) => (!a && !b) || (!!a && !!b && a.equalBase(b));
/** Same dimensions, an angle counting as a plain number. */
function sameDimsLoose(a: Unit | null, b: Unit | null): boolean {
  const da = dimsOf(a), db = dimsOf(b);
  for (let i = 0; i < 9; i++) if (i !== ANGLE && Math.abs((da[i] ?? 0) - (db[i] ?? 0)) > 1e-9) return false;
  return true;
}
const unitText = (u: Unit | null) => (u ? u.formatUnits() || 'no unit' : 'no unit');
/** u / x^kx / t^kt. */
function derivUnit(u: Unit | null, x: Unit | null, kx: number, t: Unit | null, kt: number): Unit | null {
  let q: unknown = u ?? 1;
  if (kx && x) q = math.divide(q as never, math.pow(x as never, kx) as never);
  if (kt && t) q = math.divide(q as never, math.pow(t as never, kt) as never);
  return isUnit(q) ? splitUnit(q).unit : null;
}
const fmt = (v: number, unit: Unit | null) => math.format(quantity(v, unit) as never, { precision: 6 });

/** A scalar's SI value and unit, with a message naming what it is. */
function scalar(v: unknown, what: string): { value: number; unit: Unit | null } {
  try {
    const s = splitUnit(v);
    if (!Number.isFinite(s.value)) throw new Error('not finite');
    return s;
  } catch {
    throw new Error(`${what} does not give a single real value`);
  }
}

// ---------------------------------------------------------------- the solve

/** A solution function u(x, t). */
export type PdeFunction = (x: unknown, t: unknown, ...rest: unknown[]) => unknown;

export interface PdeBlockResult {
  functions: PdeFunction[];
  unknowns: string[];
}

interface BcLine {
  j: number;
  end: 0 | 1;
  flux: boolean;
  text: string;
  L: Compiled;
  R: Compiled;
  /** The target (u, or u_x for a flux) written alone on one side: the other side gives it. */
  explicit: Compiled | null;
}

export function solvePdeBlock(lines: OdeLine[], args: string[], lhsNames: string[], blockScope: ScopeLike, tol: number): PdeBlockResult {
  const call = parseCall(args, lhsNames);
  const names = call.unknowns;
  if (lhsNames.length > 1 && lhsNames.length !== names.length) throw new Error(`Expected ${names.length} names on the left`);
  const v: Vars = { unknowns: new Map(names.map((s, i) => [s, i])), names, x: call.x, t: call.t };
  const scope = new ChainScope(snapshot(blockScope));
  const compile = (n: MathNode) => transformForEval(n).compile();
  const evalIn = (src: string | MathNode) => compile(typeof src === 'string' ? parseExpr(src) : src).evaluate(scope);

  // ranges and grid
  const range = (src: string, what: string) => {
    const r = evalIn(src);
    const items = isMatrix(r) ? (math.flatten(r.toArray() as never) as unknown[]) : Array.isArray(r) ? r.flat() : [r];
    if (items.length !== 2) throw new Error(`Pdesolve: give the ${what} range as two values, e.g. [0, L]`);
    const [a, b] = items.map((q) => scalar(q, `The ${what} range`));
    const unit = a.unit ?? b.unit;
    for (const q of [a, b]) {
      if (q.unit && !sameDims(q.unit, unit)) throw new Error(`Pdesolve: the ends of the ${what} range have different units`);
      if (!q.unit && unit && q.value !== 0) throw new Error(`Pdesolve: both ends of the ${what} range need units`);
    }
    if (!(b.value > a.value)) throw new Error(`Pdesolve: the ${what} range must run from the smaller value to the larger`);
    return { a: a.value, b: b.value, unit };
  };
  const X = range(call.xRange, `${call.x}`);
  const T = range(call.tRange, `${call.t}`);
  const count = (src: string | undefined, dflt: number | undefined, what: string, min: number) => {
    if (src === undefined || src.trim() === '') return dflt;
    const c = splitUnit(evalIn(src)).value;
    if (!Number.isInteger(c) || c < min) throw new Error(`Pdesolve: the number of ${what} points must be a whole number ≥ ${min}`);
    return c;
  };
  const nx = count(call.xpts, DEFAULT_XPTS, call.x, 5)!;
  const nt = count(call.tpts, undefined, call.t, 2);
  if (nx > 5001) throw new Error('Pdesolve: at most 5001 points in x');
  const hx = (X.b - X.a) / (nx - 1);
  const xs = Array.from({ length: nx }, (_, i) => (i === nx - 1 ? X.b : X.a + i * hx));

  // classify the lines: equations in (x, t), initial conditions at t₀, conditions at the ends
  const pdes: { L: MathNode; R: MathNode; refs: Ref[]; text: string }[] = [];
  const ics: { ref: Ref; value: MathNode; text: string }[] = [];
  const bcs: { refs: Ref[]; L: MathNode; R: MathNode; text: string }[] = [];
  const mentions = (n: MathNode) => { const f = freeSymbols(n); return f.has(v.x) || f.has(v.t); };
  for (const line of lines) {
    const text = `${line.lhs.trim()} = ${line.rhs.trim()}`;
    if (line.op !== '=' && line.op !== '==') throw new Error(`Pdesolve takes equations only, not "${line.op}" (${text})`);
    const L = parseExpr(line.lhs), R = parseExpr(line.rhs);
    const refs = [...collectRefs(L, v, []), ...collectRefs(R, v, [])];
    if (!refs.length) throw new Error(`"${text}" does not contain ${names.length === 1 ? `the unknown function ${names[0]}` : 'an unknown function'}`);
    if (refs.every((r) => isSymbol(r.ax, v.x) && isSymbol(r.at, v.t))) {
      pdes.push({ L, R, refs, text });
    } else if (refs.every((r) => isSymbol(r.at, v.t) && !mentions(r.ax))) {
      bcs.push({ refs, L, R, text });
    } else if (refs.every((r) => isSymbol(r.ax, v.x) && !mentions(r.at))) {
      const lr = refOf(unwrap(L), v), rr = refOf(unwrap(R), v);
      const ref = refs.length === 1 ? (lr ?? rr) : null;
      if (!ref) throw new Error(`Write the initial condition as ${names[0]}(${v.x}, 0) = f(${v.x}) (“${text}”)`);
      ics.push({ ref, value: ref === lr ? R : L, text });
    } else {
      throw new Error(`“${text}”: write ${names[0]}(${v.x}, ${v.t}) in the equation, ${names[0]}(${v.x}, 0) = … for the initial condition and ${names[0]}(0, ${v.t}) = … or ${names[0]}_${v.x}(0, ${v.t}) = … at the ends`);
    }
  }
  if (!pdes.length) throw new Error(`Add the partial differential equation, e.g. ${names[0]}_${v.t}(${v.x}, ${v.t}) = α·${names[0]}_${v.x}${v.x}(${v.x}, ${v.t})`);
  if (pdes.length !== names.length) {
    throw new Error(`Give one equation per unknown function: ${pdes.length} equation${pdes.length === 1 ? '' : 's'} for ${names.length} function${names.length === 1 ? '' : 's'}`);
  }

  // orders
  const tOrder = names.map(() => 0), xOrder = names.map(() => 0);
  for (const e of pdes) {
    for (const r of e.refs) {
      if (r.kx > 0 && r.kt > 0) throw new Error(`“${e.text}”: mixed derivatives (${names[r.j]}_${v.x}${v.t}) are not supported`);
      tOrder[r.j] = Math.max(tOrder[r.j], r.kt);
      xOrder[r.j] = Math.max(xOrder[r.j], r.kx);
    }
  }
  names.forEach((s, j) => {
    if (tOrder[j] === 0) throw new Error(`No time derivative of ${s} in the equations: Pdesolve needs ${s}_${v.t}(${v.x}, ${v.t}) or ${s}_${v.t}${v.t}(${v.x}, ${v.t})`);
    if (tOrder[j] > 2) throw new Error(`${s}: Pdesolve takes time derivatives up to ${s}_${v.t}${v.t}`);
    if (xOrder[j] > 2) throw new Error(`${s}: Pdesolve takes space derivatives up to ${s}_${v.x}${v.x}`);
  });
  const shownRef = (j: number, kx: number, kt: number, at = `${v.x}, ${v.t}`) =>
    `${names[j]}${kx + kt ? '_' + v.x.repeat(kx) + v.t.repeat(kt) : ''}(${at})`;

  // initial conditions: values at the nodes (units from the first one that has any)
  const setX = (xv: number) => scope.set(v.x, quantity(xv, X.unit));
  const setT = (tv: number) => scope.set(v.t, quantity(tv, T.unit));
  const uUnit: (Unit | null | undefined)[] = names.map(() => undefined);
  const icRaw = names.map((_, j) => Array.from({ length: tOrder[j] }, () => null as ({ value: number; unit: Unit | null }[] | null)));
  const icText = names.map((_, j) => Array.from({ length: tOrder[j] }, () => ''));
  for (const c of ics) {
    const { j, kt, kx } = c.ref;
    if (kx > 0) throw new Error(`“${c.text}”: the initial condition gives ${names[j]}(${v.x}, 0) (and ${names[j]}_${v.t}(${v.x}, 0) for ${names[j]}_${v.t}${v.t}), not an x derivative`);
    if (kt >= tOrder[j]) throw new Error(`“${c.text}”: the equation is of order ${tOrder[j]} in ${v.t}, so the initial conditions give ${Array.from({ length: tOrder[j] }, (_, k) => shownRef(j, 0, k, `${v.x}, 0`)).join(' and ')}`);
    if (icRaw[j][kt]) throw new Error(`Two initial conditions for ${shownRef(j, 0, kt, `${v.x}, 0`)}`);
    const at = scalar(evalIn(c.ref.at), `The time in “${c.text}”`);
    if ((at.unit || T.unit) && at.value !== 0 && !sameDims(at.unit, T.unit)) throw new Error(`“${c.text}”: the time needs units of ${unitText(T.unit)}`);
    if (Math.abs(at.value - T.a) > 1e-9 * Math.max(Math.abs(T.a), T.b - T.a)) {
      throw new Error(`“${c.text}”: the initial condition is at the start of the ${v.t} range, ${v.t} = ${fmt(T.a, T.unit)}`);
    }
    const compiled = compile(c.value);
    icRaw[j][kt] = xs.map((xv) => {
      setX(xv);
      return scalar(compiled.evaluate(scope), `“${c.text}” at ${v.x} = ${fmt(xv, X.unit)}`);
    });
    icText[j][kt] = c.text;
  }
  names.forEach((_, j) => {
    for (let k = 0; k < tOrder[j]; k++) {
      if (!icRaw[j][k]) throw new Error(`Missing initial condition ${shownRef(j, 0, k, `${v.x}, ${fmt(T.a, T.unit)}`)} = …`);
      for (const q of icRaw[j][k]!) {
        if (!q.unit && q.value === 0) continue;
        const u = k > 0 && q.unit && T.unit ? splitUnit(math.multiply(q.unit as never, math.pow(T.unit as never, k) as never)).unit : q.unit;
        if (uUnit[j] === undefined) uUnit[j] = u;
        else if (!sameDims(uUnit[j]!, u)) {
          throw new Error(`“${icText[j][k]}”: ${shownRef(j, 0, k, `${v.x}, 0`)} needs units of ${unitText(derivUnit(uUnit[j]!, null, 0, T.unit, k))}`);
        }
        break;
      }
    }
  });

  // boundary conditions
  const bcLines: BcLine[] = [];
  for (const b of bcs) {
    const j = b.refs[0].j;
    if (b.refs.some((r) => r.j !== j)) throw new Error(`“${b.text}”: a boundary condition can involve one unknown function`);
    if (xOrder[j] === 0) throw new Error(`“${b.text}”: the equations have no x derivative of ${names[j]}, so it takes no boundary conditions`);
    if (b.refs.some((r) => r.kt > 0)) throw new Error(`“${b.text}”: boundary conditions give ${names[j]} or ${names[j]}_${v.x} at an end, not a time derivative`);
    if (b.refs.some((r) => r.kx > 1)) throw new Error(`“${b.text}”: boundary conditions give ${names[j]} or ${names[j]}_${v.x} at an end`);
    const pts = b.refs.map((r) => scalar(evalIn(r.ax), `The point in “${b.text}”`));
    const p0 = pts[0].value;
    if (pts.some((q) => Math.abs(q.value - p0) > 1e-9 * (X.b - X.a))) throw new Error(`“${b.text}”: all terms of a boundary condition must be at the same end`);
    for (const q of pts) {
      if ((q.unit || X.unit) && q.value !== 0 && !sameDims(q.unit, X.unit)) throw new Error(`“${b.text}”: the point needs units of ${unitText(X.unit)}`);
    }
    const end = Math.abs(p0 - X.a) <= 1e-9 * (X.b - X.a) ? 0 : Math.abs(p0 - X.b) <= 1e-9 * (X.b - X.a) ? 1 : -1;
    if (end < 0) throw new Error(`“${b.text}”: boundary conditions are at the ends of the ${v.x} range, ${v.x} = ${fmt(X.a, X.unit)} or ${fmt(X.b, X.unit)}`);
    const flux = b.refs.some((r) => r.kx === 1);
    if (bcLines.some((q) => q.j === j && q.end === end)) {
      throw new Error(`Two boundary conditions for ${names[j]} at ${v.x} = ${fmt(end ? X.b : X.a, X.unit)}`);
    }
    const name = (r: Ref) => (r.kx ? BC_UX : BC_U);
    const Lp = withPlaceholders(b.L, v, name), Rp = withPlaceholders(b.R, v, name);
    // explicit: u(0, t) = g(t) or u_x(L, t) = h(u(L, t), t)
    let explicit: Compiled | null = null;
    for (const [side, other, raw] of [[b.L, Rp, b.R], [b.R, Lp, b.L]] as const) {
      const r = refOf(unwrap(side), v);
      if (!r || r.kx !== (flux ? 1 : 0)) continue;
      if (collectRefs(raw, v, []).some((q) => q.kx === r.kx)) continue;
      explicit = compile(other);
      break;
    }
    bcLines.push({ j, end: end as 0 | 1, flux, text: b.text, L: compile(Lp), R: compile(Rp), explicit });
  }
  names.forEach((s, j) => {
    if (xOrder[j] < 2) return;
    for (const end of [0, 1] as const) {
      if (!bcLines.some((b) => b.j === j && b.end === end)) {
        throw new Error(`${s} needs a boundary condition at each end: add one at ${v.x} = ${fmt(end ? X.b : X.a, X.unit)}, e.g. ${s}(${fmt(end ? X.b : X.a, X.unit)}, ${v.t}) = … or ${s}_${v.x}(…, ${v.t}) = 0`);
      }
    }
  });
  // an unknown whose initial values are all bare zeros takes its unit from a Dirichlet end
  names.forEach((_, j) => {
    if (uUnit[j] !== undefined) return;
    for (const b of bcLines) {
      if (b.j !== j || b.flux || !b.explicit) continue;
      setT(T.a);
      const q = scalar(b.explicit.evaluate(scope), `“${b.text}”`);
      if (q.unit) { uUnit[j] = q.unit; break; }
    }
    if (uUnit[j] === undefined) uUnit[j] = null;
  });
  const uU = uUnit as (Unit | null)[];
  const dU = (j: number, kx: number, kt: number) => derivUnit(uU[j], X.unit, kx, T.unit, kt);
  // initial values in the unknowns' units
  names.forEach((_, j) => {
    for (let k = 0; k < tOrder[j]; k++) {
      for (const [i, q] of icRaw[j][k]!.entries()) {
        if ((q.unit || q.value !== 0) && !sameDimsLoose(q.unit, dU(j, 0, k))) {
          throw new Error(`“${icText[j][k]}” at ${v.x} = ${fmt(xs[i], X.unit)}: ${shownRef(j, 0, k, `${v.x}, 0`)} has units of ${unitText(dU(j, 0, k))}, not ${unitText(q.unit)}`);
        }
      }
    }
  });

  // boundaries as functions of t (and u at the end, for a flux)
  const boundary = (b: BcLine): MolBoundary => {
    const want = b.flux ? dU(b.j, 1, 0) : uU[b.j];
    const what = b.flux ? shownRef(b.j, 1, 0, '…') : shownRef(b.j, 0, 0, '…');
    let checked = false;
    const check = (val: unknown, side: string) => {
      const q = scalar(val, `“${b.text}”`);
      if (!checked && (q.unit || q.value !== 0)) {
        if (!sameDimsLoose(q.unit, want)) throw new Error(`“${b.text}”: ${what} has units of ${unitText(want)}, ${side} ${unitText(q.unit)}`);
        checked = true;
      }
      return q.value;
    };
    const residual = (target: number) => {
      scope.set(b.flux ? BC_UX : BC_U, quantity(target, want));
      const l = b.L.evaluate(scope), r = b.R.evaluate(scope);
      try {
        return splitUnit(r === 0 ? l : l === 0 ? math.unaryMinus(r as never) : math.subtract(l as never, r as never)).value;
      } catch {
        const a = splitUnit(l), c = splitUnit(r);
        if (!sameDimsLoose(a.unit, c.unit)) throw new Error(`The two sides of “${b.text}” have different units`);
        return a.value - c.value;
      }
    };
    let guess = 0, memoT = NaN, memoU = NaN, memo = NaN;
    const scale = Math.max(...icRaw[b.j][0]!.map((q) => Math.abs(q.value)), 0) / (b.flux ? X.b - X.a : 1) || 1;
    return {
      kind: b.flux ? 'flux' : 'value',
      at(tv: number, u: number) {
        if (tv === memoT && (u === memoU || (Number.isNaN(u) && Number.isNaN(memoU)))) return memo;
        setT(tv);
        if (b.flux) scope.set(BC_U, quantity(u, uU[b.j]));
        let out: number;
        if (b.explicit) out = check(b.explicit.evaluate(scope), 'the other side');
        else {
          // secant on the residual: one step when the condition is linear in the target
          let a = guess, fa = residual(a);
          let c = a + 1e-3 * Math.max(Math.abs(a), scale), fc = residual(c);
          for (let it = 0; it < 50 && fc !== 0; it++) {
            if (fc === fa) throw new Error(`“${b.text}” cannot be solved for ${what} at ${v.t} = ${fmt(tv, T.unit)}`);
            const d = (c - a) * fc / (fc - fa);
            a = c; fa = fc;
            c -= d;
            fc = residual(c);
            if (Math.abs(d) <= 1e-13 * Math.max(Math.abs(c), scale)) break;
          }
          if (!Number.isFinite(c)) throw new Error(`“${b.text}” cannot be solved for ${what} at ${v.t} = ${fmt(tv, T.unit)}`);
          out = c;
          guess = c;
        }
        memoT = tv; memoU = u; memo = out;
        return out;
      },
    };
  };
  const unknowns: MolUnknown[] = names.map((_, j) => {
    const left = bcLines.find((b) => b.j === j && b.end === 0);
    const right = bcLines.find((b) => b.j === j && b.end === 1);
    return {
      tOrder: tOrder[j], xOrder: xOrder[j],
      left: left && boundary(left), right: right && boundary(right),
      init: icRaw[j].map((col) => col!.map((q) => q.value)),
    };
  });

  // the equations, solved at a node for the highest time derivatives
  const used = new Set<string>();
  for (const e of pdes) for (const r of e.refs) used.add(ph(r.j, r.kx, r.kt));
  const usedList = [...used].map((s) => s.slice(5).split('_').map(Number) as [number, number, number]);
  const hi = names.map((_, j) => ph(j, 0, tOrder[j]));
  const named = (r: Ref) => ph(r.j, r.kx, r.kt);
  const forms = pdes.map((e) => ({ text: e.text, L: withPlaceholders(e.L, v, named), R: withPlaceholders(e.R, v, named), raw: e }));
  // u_t(x, t) = f(…) for every unknown: no Newton iteration
  const explicit: ({ node: MathNode; text: string } | null)[] = names.map(() => null);
  for (const f of forms) {
    for (const [side, other, rawOther] of [[f.raw.L, f.R, f.raw.R], [f.raw.R, f.L, f.raw.L]] as const) {
      const r = refOf(unwrap(side), v);
      if (!r || r.kx !== 0 || r.kt !== tOrder[r.j] || explicit[r.j]) continue;
      if (collectRefs(rawOther, v, []).some((q) => q.kt === tOrder[q.j])) continue;
      explicit[r.j] = { node: other, text: f.text };
      break;
    }
  }
  const allExplicit = explicit.every(Boolean) && new Set(explicit.map((q) => q!.text)).size === names.length;
  const typical = names.map((_, j) => Math.max(...icRaw[j][0]!.map((q) => Math.abs(q.value)), 0) || 1);
  const valueOf = (nv: NodeValues[], j: number, kx: number, kt: number) =>
    kt === 0 ? (kx === 0 ? nv[j].u : kx === 1 ? nv[j].ux : nv[j].uxx) : nv[j].ut;

  // the equations evaluated with units (always right) or on SI numbers (fast): worksheet
  // quantities become their SI values; the two are compared on a sample state before the
  // fast form is trusted, and a function of the worksheet that needs units keeps the slow one
  const keep = new Set([v.x, v.t, ...used, ...hi]);
  const numeric = (node: MathNode): MathNode => node.transform((n: MathNode, path: string) => {
    const a = n as AnyNode;
    if (a.type !== 'SymbolNode' || path === 'fn' || keep.has(a.name as string)) return n;
    try {
      const val = compile(n).evaluate(scope);
      if (isUnit(val)) return new math.ConstantNode(splitUnit(val).value);
    } catch {
      /* a bound variable, or not a value */
    }
    return n;
  });
  const numScope = new ChainScope(scope);
  type Eval = { units: Compiled; si: Compiled };
  const both = (node: MathNode): Eval => ({ units: compile(node), si: compile(numeric(node)) });
  const exprs = allExplicit ? explicit.map((q) => both(q!.node)) : [];
  const sides = allExplicit ? [] : forms.map((f) => ({ L: both(f.L), R: both(f.R), text: f.text }));
  let fast = false;
  const setNode = (s: ChainScope, si: boolean, i: number, t: number, nv: NodeValues[], hiVals?: number[]) => {
    s.set(v.x, si ? xs[i] : quantity(xs[i], X.unit));
    s.set(v.t, si ? t : quantity(t, T.unit));
    for (const [j, kx, kt] of usedList) {
      if (kt === tOrder[j]) continue;
      const val = valueOf(nv, j, kx, kt);
      s.set(ph(j, kx, kt), si ? val : quantity(val, dU(j, kx, kt)));
    }
    if (hiVals) names.forEach((_, j) => s.set(hi[j], si ? hiVals[j] : quantity(hiVals[j], dU(j, 0, tOrder[j]))));
  };
  const where = (i: number, t: number) => `${v.x} = ${fmt(xs[i], X.unit)}, ${v.t} = ${fmt(t, T.unit)}`;
  const real = (val: unknown, text: string, i: number, t: number) => {
    if (typeof val === 'number') {
      if (Number.isFinite(val)) return val;
      throw new Error(`“${text}” is not finite at ${where(i, t)}`);
    }
    return scalar(val, `“${text}” at ${where(i, t)}`).value;
  };
  const explicitUnits = names.map(() => false);
  const rateExplicit = (i: number, t: number, nv: NodeValues[], si: boolean): number[] => {
    const s = si ? numScope : scope;
    setNode(s, si, i, t, nv);
    return exprs.map((e, j) => {
      const val = (si ? e.si : e.units).evaluate(s);
      if (!si && !explicitUnits[j]) {
        const q = scalar(val, `“${explicit[j]!.text}” at ${where(i, t)}`);
        if (q.unit || q.value !== 0) {
          const need = dU(j, 0, tOrder[j]);
          if (!sameDimsLoose(q.unit, need)) throw new Error(`“${explicit[j]!.text}”: ${shownRef(j, 0, tOrder[j])} has units of ${unitText(need)}, the other side ${unitText(q.unit)}`);
          explicitUnits[j] = true;
        }
      }
      return real(val, explicit[j]!.text, i, t);
    });
  };
  const residuals = (i: number, t: number, nv: NodeValues[], U: number[], si: boolean): number[] => {
    const s = si ? numScope : scope;
    setNode(s, si, i, t, nv, U);
    return sides.map((c) => {
      const l = (si ? c.L.si : c.L.units).evaluate(s), r = (si ? c.R.si : c.R.units).evaluate(s);
      if (si && typeof l === 'number' && typeof r === 'number') return real(l - r, c.text, i, t);
      try {
        return real(r === 0 ? l : l === 0 ? math.unaryMinus(r as never) : math.subtract(l as never, r as never), c.text, i, t);
      } catch (e) {
        const a = splitUnit(l), b = splitUnit(r);
        if (!sameDimsLoose(a.unit, b.unit)) throw new Error(`The two sides of “${c.text}” have different units`);
        if (/single real value|not finite/.test((e as Error).message)) throw e;
        return a.value - b.value;
      }
    });
  };
  const lastHi: number[][] = [];
  const rateImplicit = (i: number, t: number, nv: NodeValues[], si: boolean): number[] => {
    // Newton from the last solution at this node; the equations are usually linear in it
    let U = (lastHi[i] ?? names.map(() => 0)).slice();
    const m = names.length;
    for (let it = 0; it < 30; it++) {
      const g = residuals(i, t, nv, U, si);
      const J = Array.from({ length: m }, () => new Array<number>(m).fill(0));
      for (let q = 0; q < m; q++) {
        const d = 1e-7 * Math.max(Math.abs(U[q]), typical[q] / (T.b - T.a) ** tOrder[q]);
        const Up = U.slice();
        Up[q] += d;
        const gp = residuals(i, t, nv, Up, si);
        for (let r = 0; r < m; r++) J[r][q] = (gp[r] - g[r]) / d;
      }
      let dU: number[];
      try {
        dU = N.solveLinear(J, g.map((x) => -x));
      } catch {
        throw new Error(`The equations cannot be solved for ${names.map((_, j) => shownRef(j, 0, tOrder[j])).join(', ')} at ${where(i, t)}`);
      }
      U = U.map((u, q) => u + dU[q]);
      if (dU.every((d, q) => Math.abs(d) <= 1e-10 * Math.max(Math.abs(U[q]), 1e-300))) break;
    }
    lastHi[i] = U;
    return U;
  };
  const rate = (i: number, t: number, nv: NodeValues[], si: boolean) => (allExplicit ? rateExplicit(i, t, nv, si) : rateImplicit(i, t, nv, si));

  // the fast form, checked on a made-up state with every value of a typical size
  {
    const i = Math.round(0.37 * (nx - 1)), t = T.a + 0.41 * (T.b - T.a);
    const nv = names.map((_, j) => {
      const s = typical[j] * (1 + 0.13 * j);
      const lx = X.b - X.a, lt = T.b - T.a;
      return { u: 0.83 * s, ux: -0.61 * s / lx, uxx: 0.47 * s / (lx * lx), ut: -0.29 * s / lt };
    });
    try {
      const slow = rate(i, t, nv, false);
      const quick = rate(i, t, nv, true);
      fast = quick.every((q, j) => Math.abs(q - slow[j]) <= 1e-9 * Math.max(Math.abs(q), Math.abs(slow[j])) + 1e-300);
    } catch {
      // outside an equation's domain at the made-up state: the solve itself will tell
      fast = false;
    }
    explicitUnits.fill(false);
    lastHi.length = 0;
  }

  const rtol = Math.min(Math.max(tol, 1e-12), 1e-7);
  const sol = solveMol({
    xs, t0: T.a, t1: T.b, unknowns,
    rate: (i, t, nv) => rate(i, t, nv, fast),
    rtol,
    steps: nt !== undefined ? nt - 1 : undefined,
  });

  // the solution functions: splines in x through the nodes at t, kept for the last few t
  const cache = new Map<number, { y: number[][]; m: number[][] }>();
  const at = (t: number) => {
    let c = cache.get(t);
    if (!c) {
      const y = sol.at(t);
      c = { y, m: y.map((col) => N.splineSecondDerivs(xs, col, 'cubic')) };
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
      cache.set(t, c);
    }
    return c;
  };
  const arg = (q: unknown, range: { a: number; b: number; unit: Unit | null }, name: string, varName: string) => {
    const s = scalar(q, `${name}(…): the ${varName} argument`);
    if (s.unit && !sameDims(s.unit, range.unit)) throw new Error(`${name}(…): ${varName} has units of ${unitText(range.unit)}, not ${unitText(s.unit)}`);
    if (!s.unit && range.unit && s.value !== 0) throw new Error(`${name}(…): ${varName} needs units like ${unitText(range.unit)}`);
    const pad = 1e-9 * (range.b - range.a);
    if (s.value < range.a - pad || s.value > range.b + pad) {
      throw new Error(`${name}(${varName} = ${fmt(s.value, range.unit)}) is outside the solution range ${fmt(range.a, range.unit)} … ${fmt(range.b, range.unit)}`);
    }
    return Math.min(range.b, Math.max(range.a, s.value));
  };
  const functions = names.map((name, j): PdeFunction => (xq: unknown, tq: unknown, ...rest: unknown[]) => {
    if (tq === undefined || rest.length) throw new Error(`${name}(${v.x}, ${v.t}) takes two arguments`);
    const xv = arg(xq, X, name, v.x), tv = arg(tq, T, name, v.t);
    const c = at(tv);
    return quantity(N.splineEval(xs, c.y[j], c.m[j], xv), uU[j]);
  });
  return { functions, unknowns: names };
}

// ---------------------------------------------------------------- numol

/**
 * numol(x_range, xpts, t_range, tpts, num_pde, num_pae, pde_func, pinit, bc_func): Mathcad's
 * method-of-lines solver as a matrix of nodal values, xpts × tpts per unknown side by side.
 * pde_func(x, t, u, u_x, u_xx) gives the vector of u_t, pinit(x) the initial values and
 * bc_func(t) a num_pde × 3 matrix of rows [left, right, "D" or "N"] (Dirichlet values or
 * Neumann slopes; "NA" for an end without a condition).
 */
function numol(xr: unknown, xpts: unknown, tr: unknown, tpts: unknown, npde: unknown, npae: unknown, pde: unknown, pinit: unknown, bc: unknown) {
  const pair = (r: unknown, what: string) => {
    const items = isMatrix(r) ? (math.flatten(r.toArray() as never) as unknown[]) : [r];
    if (items.length !== 2) throw new Error(`numol: give the ${what} end points as a two-element vector`);
    return items.map((q) => splitUnit(q).value) as [number, number];
  };
  const whole = (q: unknown, what: string, min: number) => {
    const n = splitUnit(q).value;
    if (!Number.isInteger(n) || n < min) throw new Error(`numol: ${what} must be a whole number ≥ ${min}`);
    return n;
  };
  const [xa, xb] = pair(xr, 'x'), [ta, tb] = pair(tr, 't');
  if (!(xb > xa) || !(tb > ta)) throw new Error('numol: the end points must be in increasing order');
  const nx = whole(xpts, 'xpts', 5), nt = whole(tpts, 'tpts', 2), m = whole(npde, 'num_pde', 1);
  if (whole(npae, 'num_pae', 0) > 0) throw new Error('numol: partial algebraic equations (num_pae > 0) are not supported');
  for (const [f, what] of [[pde, 'pde_func'], [pinit, 'pinit'], [bc, 'bc_func']] as const) {
    if (typeof f !== 'function') throw new Error(`numol: ${what} must be a function`);
  }
  const call = (f: unknown, ...a: unknown[]) => (f as (...q: unknown[]) => unknown)(...a);
  const vector = (val: unknown, what: string): number[] => {
    const flat = isMatrix(val) ? (math.flatten(val.toArray() as never) as unknown[]) : Array.isArray(val) ? val.flat() : [val];
    if (flat.length !== m) throw new Error(`numol: ${what} must give ${m} value${m === 1 ? '' : 's'}`);
    return flat.map((q) => splitUnit(q).value);
  };
  const xs = Array.from({ length: nx }, (_, i) => (i === nx - 1 ? xb : xa + (i * (xb - xa)) / (nx - 1)));
  const init = xs.map((x) => vector(call(pinit, x), 'pinit(x)'));
  const bcAt = (t: number) => {
    const M = call(bc, t);
    const rows = isMatrix(M) ? (M.toArray() as unknown[][]) : null;
    if (!rows || rows.length !== m || rows.some((r) => !Array.isArray(r) || r.length !== 3)) throw new Error(`numol: bc_func(t) must be a ${m} × 3 matrix`);
    return rows;
  };
  const rows0 = bcAt(ta);
  const unknowns: MolUnknown[] = Array.from({ length: m }, (_, j) => {
    const kind = String(rows0[j][2]).toUpperCase();
    if (kind !== 'D' && kind !== 'N') throw new Error('numol: the third column of bc_func(t) is "D" (Dirichlet) or "N" (Neumann)');
    const side = (e: 0 | 1): MolBoundary | undefined => {
      if (typeof rows0[j][e] === 'string') return undefined; // "NA"
      return { kind: kind === 'D' ? 'value' : 'flux', at: (t: number) => splitUnit(bcAt(t)[j][e]).value };
    };
    const left = side(0), right = side(1);
    return { tOrder: 1, xOrder: left && right ? 2 : 1, left, right, init: [init.map((r) => r[j])] };
  });
  const sol = solveMol({
    xs, t0: ta, t1: tb, unknowns, rtol: Math.min(Math.max(engineCtx.tol, 1e-12), 1e-7), steps: nt - 1,
    rate: (i, t, nv) => vector(call(pde, xs[i], t, vec(nv.map((q) => q.u)), vec(nv.map((q) => q.ux)), vec(nv.map((q) => q.uxx))), 'pde_func'),
  });
  const out = xs.map(() => new Array<number>(nt * m).fill(0));
  for (let k = 0; k < nt; k++) {
    const t = k === nt - 1 ? tb : ta + (k * (tb - ta)) / (nt - 1);
    const y = sol.at(t);
    for (let j = 0; j < m; j++) for (let i = 0; i < nx; i++) out[i][j * nt + k] = y[j][i];
  }
  return math.matrix(out);
}

// the arguments name the unknown and the variables: not evaluated
const outside = Object.assign(() => {
  throw new Error('Pdesolve works as the solver of a solve block: put the equation, the initial and the boundary conditions under Constraints and u := Pdesolve(u, x, [0, L], t, [0, T]) as the solver');
}, { rawArgs: true });
math.import({ numol, Pdesolve: outside, pdesolve: outside }, { override: true });
