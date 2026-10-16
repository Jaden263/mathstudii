// Mathcad's ODE functions that return a solution matrix [x, y₀, y₁ …]: rkfixed,
// Rkadapt/rkadapt, Bulstoer/bulstoer, Radau/radau, Stiffb/stiffb, Stiffr/stiffr,
// AdamsBDF, Adams and BDF, all unit-aware (each component of y may carry its own
// unit). Also the prime notation f'(x) for derivatives of worksheet functions.
import type { Unit } from 'mathjs';
import { math, splitUnit, joinUnit, quantity } from './math';
import { engineCtx, tick, toVector, vec, num, int, matrix2D, divUnits } from './library';
import { solveIvp, type OdeMethod, type OdeOptions, type OdeSolution } from './ode';
import type { OdeFunction } from './odesolve';
import * as N from './numeric';

const per = (u: Unit | null, x: Unit | null): Unit | null => (x ? splitUnit(math.divide((u ?? 1) as never, x as never)).unit : u);
const sameDims = (a: Unit | null, b: Unit | null) => (!a && !b) || (!!a && !!b && a.equalBase(b));
const unitText = (u: Unit | null) => (u ? u.formatUnits() : 'no unit');

/** The problem in SI numbers: y₀ and x-range with units, D(x, y) wrapped. */
function setup(fn: string, y0: unknown, x1: unknown, x2: unknown, D: unknown, J?: unknown) {
  if (typeof D !== 'function') throw new Error(`${fn}: D must be a function D(x, y) returning the derivative vector`);
  const items = toVector(y0).map((v) => splitUnit(v));
  const yu = items.map((s) => s.unit);
  const a = splitUnit(x1), b = splitUnit(x2);
  if (a.unit && b.unit && !a.unit.equalBase(b.unit)) throw new Error(`${fn}: x1 and x2 have different units`);
  if (!a.unit !== !b.unit && (a.value !== 0 && b.value !== 0)) throw new Error(`${fn}: x1 and x2 need the same units`);
  const xu = a.unit ?? b.unit;
  const du = yu.map((u) => per(u, xu));
  const d = D as (x: unknown, y: unknown) => unknown;
  let checked = false;
  const f = (x: number, y: number[]): number[] => {
    tick();
    const r = toVector(d(quantity(x, xu), vec(y.map((v, i) => quantity(v, yu[i])))));
    if (r.length !== y.length) throw new Error(`${fn}: D(x, y) returns ${r.length} values for ${y.length} unknowns`);
    return r.map((v, i) => {
      const s = splitUnit(v);
      if (!checked && !(s.value === 0 && !s.unit) && !sameDims(s.unit, du[i])) {
        throw new Error(`${fn}: component ${i + engineCtx.origin} of D(x, y) has units of ${unitText(s.unit)}, expected ${unitText(du[i])}`);
      }
      return s.value;
    });
  };
  // the first call checks the units, later calls trust them
  const fChecked = (x: number, y: number[]) => {
    const r = f(x, y);
    checked = true;
    return r;
  };
  let jac: OdeOptions['jac'];
  if (J !== undefined) {
    if (typeof J !== 'function') throw new Error(`${fn}: J must be a function J(x, y) returning the Jacobian matrix`);
    const jf = J as (x: unknown, y: unknown) => unknown;
    jac = (x, y) => {
      const M = matrix2D(jf(quantity(x, xu), vec(y.map((v, i) => quantity(v, yu[i])))));
      const n = y.length;
      // Mathcad's J is n × (n+1): ∂D/∂x first, then ∂D/∂y
      const off = M[0]?.length === n + 1 ? 1 : 0;
      if (M.length !== n || (M[0]?.length ?? 0) !== n + off) throw new Error(`${fn}: J(x, y) must be ${n}×${n + 1} (or ${n}×${n})`);
      return M.map((row) => row.slice(off).map((v) => splitUnit(v).value));
    };
  }
  return { y: items.map((s) => s.value), yu, a: a.value, b: b.value, xu, f: fChecked, jac };
}

const rtolFromTol = () => Math.min(Math.max(engineCtx.tol, 1e-12), 1e-4);

function table(xs: number[], ys: number[][], xu: Unit | null, yu: (Unit | null)[]) {
  return math.matrix(xs.map((x, k) => [quantity(x, xu), ...ys[k].map((v, i) => quantity(v, yu[i]))]) as never);
}

/** Solution at npts + 1 equally spaced points (rkfixed, Rkadapt, Radau, …). */
function fixedOutput(fn: string, method: OdeMethod, withJacobian: boolean) {
  return (y0: unknown, x1: unknown, x2: unknown, npts: unknown, D: unknown, J?: unknown) => {
    const n = int(npts, `${fn}: number of points`);
    if (n < 1) throw new Error(`${fn}: the number of points must be at least 1`);
    const p = setup(fn, y0, x1, x2, D, withJacobian ? J : undefined);
    const xs = Array.from({ length: n + 1 }, (_, k) => (k === n ? p.b : p.a + ((p.b - p.a) * k) / n));
    const sol = solveIvp(p.f, p.a, p.y, p.b, { method, rtol: rtolFromTol(), jac: p.jac, steps: method === 'rk4' ? n : undefined, stops: method === 'bs' ? xs : undefined });
    return table(xs, xs.map((x) => sol.at(x)), p.xu, p.yu);
  };
}

/**
 * Mathcad's lower-case adaptive forms: f(y, x1, x2, acc, D, [J,] kmax, save) returns
 * the solver's own steps, at most kmax of them, at least save apart.
 */
function adaptiveOutput(fn: string, method: OdeMethod, withJacobian: boolean) {
  return (...args: unknown[]) => {
    const k = withJacobian ? 1 : 0;
    // rkadapt(y, x1, x2, n, D) keeps the Rkadapt form
    if (args.length === 5 && !withJacobian) return fixedOutput(fn, method, false)(...(args as [unknown, unknown, unknown, unknown, unknown]));
    if (args.length !== 7 + k) throw new Error(`${fn}(y, x1, x2, acc, D, ${withJacobian ? 'J, ' : ''}kmax, save)`);
    const [y0, x1, x2, acc, D] = args;
    const p = setup(fn, y0, x1, x2, D, withJacobian ? args[5] : undefined);
    const kmax = int(args[5 + k], `${fn}: kmax`);
    const save = Math.abs(splitUnit(args[6 + k]).value);
    const tol = num(acc, `${fn}: acc`);
    const sol: OdeSolution = solveIvp(p.f, p.a, p.y, p.b, { method, rtol: Math.min(Math.max(tol, 1e-12), 1e-2), jac: p.jac });
    const xs: number[] = [sol.ts[0]];
    const ys: number[][] = [sol.ys[0]];
    for (let i = 1; i < sol.ts.length; i++) {
      const last = i === sol.ts.length - 1;
      if (!last && (Math.abs(sol.ts[i] - xs[xs.length - 1]) < save || xs.length >= kmax)) continue;
      xs.push(sol.ts[i]);
      ys.push(sol.ys[i]);
    }
    return table(xs, ys, p.xu, p.yu);
  };
}

/**
 * f'(x), f''(x) …: written by the preprocessor as __d(f, k, x). Solutions of odesolve
 * know their derivatives; other functions are differentiated numerically. On a value
 * that is not a function this keeps the old meaning, transpose times (x).
 */
function prime(f: unknown, k: unknown, x: unknown, ...rest: unknown[]) {
  const order = int(k, 'derivative order');
  if (typeof f !== 'function') {
    let v = f;
    for (let i = 0; i < order % 2; i++) v = (math as unknown as Record<string, (a: unknown) => unknown>).mcTranspose(v);
    return math.multiply(v as never, x as never);
  }
  if (rest.length) throw new Error('The prime notation f\'(x) is for functions of one variable');
  const fo = f as OdeFunction;
  if (fo.odeDerivative) return fo.odeDerivative(order, x);
  if (order > 5) throw new Error('Derivatives up to the 5th order only');
  const xs = splitUnit(x);
  const at = (t: number) => {
    tick();
    return (f as (a: unknown) => unknown)(joinUnit(t, xs.unit));
  };
  const fUnit = splitUnit(at(xs.value)).unit;
  return divUnits(N.derivative((t) => splitUnit(at(t)).value, xs.value, order), fUnit, xs.unit, order);
}

const ODE_LIBRARY: Record<string, unknown> = {
  rkfixed: fixedOutput('rkfixed', 'rk4', false),
  Rkadapt: fixedOutput('Rkadapt', 'dopri', false),
  rkadapt: adaptiveOutput('rkadapt', 'dopri', false),
  Bulstoer: fixedOutput('Bulstoer', 'bs', false),
  bulstoer: adaptiveOutput('bulstoer', 'bs', false),
  Radau: fixedOutput('Radau', 'radau', true),
  radau: adaptiveOutput('radau', 'radau', false),
  // Mathcad's Stiffb (Bulirsch–Stoer) and Stiffr (Rosenbrock) both use Radau IIA here
  Stiffb: fixedOutput('Stiffb', 'radau', true),
  stiffb: adaptiveOutput('stiffb', 'radau', true),
  Stiffr: fixedOutput('Stiffr', 'radau', true),
  stiffr: adaptiveOutput('stiffr', 'radau', true),
  // Adams/BDF: Dormand–Prince, switching to Radau when stiff
  AdamsBDF: fixedOutput('AdamsBDF', 'auto', true),
  Adams: fixedOutput('Adams', 'dopri', false),
  BDF: fixedOutput('BDF', 'radau', true),
  __d: prime,
  odesolve: () => {
    throw new Error('odesolve works as the solver of a solve block: put the equations under Constraints and y := odesolve(t, b) as the solver');
  },
};
ODE_LIBRARY.Odesolve = ODE_LIBRARY.odesolve;

const clashes = Object.keys(ODE_LIBRARY).filter((k) => k in math);
if (clashes.length) throw new Error(`ODE function names clash: ${clashes.join(', ')}`);
math.import(ODE_LIBRARY, { override: true });
