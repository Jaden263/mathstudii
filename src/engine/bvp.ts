// Initial and boundary value problems Y′ = f(t, Y) on plain numbers with conditions
// Y_i(t_k) = v_k at one or more points. Conditions at one point are an initial value
// problem, integrated both ways from there. At several points the problem is shot
// from the point with the most conditions: Newton on the unknown starting values,
// with sensitivities from replays on a frozen mesh. When the solution grows too fast
// for that (a beam on an elastic foundation, y″ = 400 y …), multiple shooting cuts
// the interval into pieces whose starting states are all unknown, tied together by
// continuity (Stoer & Bulirsch, Introduction to Numerical Analysis, 7.3).
import { solveIvp, type OdeMethod, type OdeSolution, type Rhs } from './ode';
import * as N from './numeric';

/** Y_i(point) = value. */
export interface PointCondition {
  i: number;
  point: number;
  value: number;
}

export interface ShootingOptions {
  method: OdeMethod;
  rtol: number;
  steps?: number;
  /** The unknown functions, for messages ("y", "x, y"). */
  names: string;
}

/** A dense solution over [lo, hi]. */
export interface PiecewiseSolution {
  lo: number;
  hi: number;
  at(t: number): number[];
  /** The largest |Y_i| along the solution. */
  peak: number[];
  /** 1 for single shooting (or an initial value problem), else the number of pieces. */
  pieces: number;
}

/** Integrate from t0 to t1; with a reference solution, on its mesh (smooth in y0). */
function solve(f: Rhs, t0: number, y0: number[], t1: number, o: ShootingOptions, ref?: OdeSolution | null): OdeSolution | null {
  if (t1 === t0) return null;
  const replay = ref ? { mesh: ref.ts, meshKinds: ref.kinds } : {};
  return solveIvp(f, t0, y0, t1, { method: o.method, rtol: o.rtol, steps: o.steps, ...replay });
}

function peakOf(y0: number[], sols: (OdeSolution | null)[]): number[] {
  const peak = y0.map(Math.abs);
  for (const s of sols) if (s) for (const y of s.ys) y.forEach((v, i) => (peak[i] = Math.max(peak[i], Math.abs(v))));
  return peak;
}

interface TwoWays {
  fwd: OdeSolution | null;
  bwd: OdeSolution | null;
  at(t: number): number[];
  peak: number[];
}

/** Integrate forwards to hi and backwards to lo from the starting point. */
function fromPoint(f: Rhs, start: number, y0: number[], lo: number, hi: number, o: ShootingOptions, ref?: TwoWays): TwoWays {
  const fwd = solve(f, start, y0, hi, o, ref?.fwd);
  const bwd = solve(f, start, y0, lo, o, ref?.bwd);
  const at = (t: number) => {
    const s = t >= start ? fwd ?? bwd : bwd ?? fwd;
    return s ? s.at(t) : y0.slice();
  };
  return { fwd, bwd, at, peak: peakOf(y0, [fwd, bwd]) };
}

/** An initial value problem: every component given at `start`. */
export function solveFromPoint(f: Rhs, start: number, y0: number[], lo: number, hi: number, o: ShootingOptions): PiecewiseSolution {
  const p = fromPoint(f, start, y0, lo, hi, o);
  return { lo, hi, at: p.at, peak: p.peak, pieces: 1 };
}

class NotMet extends Error {}

/**
 * Conditions at two or more points (exactly one per component in all). Single
 * shooting first; multiple shooting when that fails.
 */
export function solveBvp(f: Rhs, dim: number, conds: PointCondition[], lo: number, hi: number, o: ShootingOptions): PiecewiseSolution {
  const scaleOf = (i: number, peak: number[]) =>
    Math.max(peak[i], ...conds.filter((c) => c.i === i).map((c) => Math.abs(c.value)), 1e-300);
  const goal = Math.max(1e-10, 50 * o.rtol);
  let singular = false;
  try {
    return singleShooting(f, dim, conds, lo, hi, o, scaleOf, goal);
  } catch (e) {
    if (!(e instanceof NotMet) && !/ODE solver|Radau/.test((e as Error).message)) throw e;
    singular = e instanceof NotMet && e.message === 'singular';
  }
  for (const pieces of [8, 32]) {
    try {
      return multipleShooting(f, dim, conds, lo, hi, o, scaleOf, goal, pieces);
    } catch (e) {
      if (!(e instanceof NotMet) && !/ODE solver|Radau/.test((e as Error).message)) throw e;
      singular = e instanceof NotMet && e.message === 'singular';
    }
  }
  if (singular) throw new Error('The boundary conditions do not determine the solution (they may contradict each other)');
  throw new Error(`The boundary conditions could not be met (shooting did not converge for ${o.names})`);
}

/** Newton with a backtracking line search on the scaled residual; returns the last state. */
function newton<S>(
  x0: number[],
  evaluate: (x: number[]) => { state: S; r: number[]; norm: number },
  jacobian: (x: number[], at: { state: S; r: number[] }) => number[][],
  xScale: (x: number[], state: S) => number[],
  o: ShootingOptions,
  goal: number,
): S {
  let x = x0;
  let cur = evaluate(x);
  for (let it = 0; it < 20 && cur.norm > goal; it++) {
    const J = jacobian(x, cur);
    let dx: number[];
    try {
      dx = N.solveLinear(J, cur.r.map((v) => -v));
    } catch {
      throw new NotMet('singular');
    }
    // a step far beyond the solution's size: the matrix is singular to within the
    // integration error (conditions that leave a solution free, or contradict)
    const sc = xScale(x, cur.state);
    if (!dx.every((v, q) => Math.abs(v) <= Math.max(1e4, 0.01 / o.rtol) * sc[q])) throw new NotMet('singular');
    let lambda = 1;
    let next: typeof cur | null = null;
    for (let ls = 0; ls < 8 && !next; ls++, lambda /= 2) {
      const xn = x.map((v, q) => v + lambda * dx[q]);
      try {
        const e = evaluate(xn);
        if (e.norm < cur.norm) { next = e; x = xn; }
      } catch {
        /* overshoot: a shorter step */
      }
    }
    // no decrease along the Newton direction: this formulation will not get there
    if (!next) break;
    cur = next;
  }
  if (!(cur.norm <= 10 * goal)) throw new NotMet('not met');
  return cur.state;
}

function singleShooting(
  f: Rhs, dim: number, conds: PointCondition[], lo: number, hi: number, o: ShootingOptions,
  scaleOf: (i: number, peak: number[]) => number, goal: number,
): PiecewiseSolution {
  // shoot from the point with the most conditions (the leftmost of equals)
  const points = [...new Set(conds.map((c) => c.point))];
  const count = (p: number) => conds.filter((c) => c.point === p).length;
  const start = points.reduce((a, b) => (count(b) > count(a) || (count(b) === count(a) && b < a) ? b : a));
  const atStart = conds.filter((c) => c.point === start);
  const others = conds.filter((c) => c.point !== start);
  const free = Array.from({ length: dim }, (_, i) => i).filter((i) => !atStart.some((c) => c.i === i));
  const y0 = (x: number[]) => {
    const y = new Array(dim).fill(0);
    for (const c of atStart) y[c.i] = c.value;
    free.forEach((i, q) => (y[i] = x[q]));
    return y;
  };
  const residual = (p: TwoWays) => others.map((c) => p.at(c.point)[c.i] - c.value);
  const norm = (r: number[], p: TwoWays) => Math.max(...r.map((v, k) => Math.abs(v) / scaleOf(others[k].i, p.peak)));
  const evaluate = (x: number[]) => {
    const state = fromPoint(f, start, y0(x), lo, hi, o);
    const r = residual(state);
    return { state, r, norm: norm(r, state) };
  };
  const p = newton(
    new Array(free.length).fill(0),
    evaluate,
    (x, cur) => {
      // sensitivities on the same mesh, so that the map from x to r is smooth
      const J = cur.r.map(() => new Array(free.length).fill(0));
      free.forEach((i, q) => {
        const d = 1e-6 * Math.max(Math.abs(x[q]), cur.state.peak[i] || 1);
        const xp = x.slice();
        xp[q] += d;
        let rp: number[];
        try {
          rp = residual(fromPoint(f, start, y0(xp), lo, hi, o, cur.state));
        } catch {
          rp = residual(fromPoint(f, start, y0(xp), lo, hi, o));
        }
        for (let k = 0; k < rp.length; k++) J[k][q] = (rp[k] - cur.r[k]) / d;
      });
      // the integration error, amplified this much on its way to the far end, swamps the
      // conditions there: a case for multiple shooting
      const xs = free.map((i, q) => Math.max(Math.abs(x[q]), cur.state.peak[i]) || 1);
      const amp = Math.max(...J.flatMap((row, k) => row.map((v, q) => (Math.abs(v) * xs[q]) / scaleOf(others[k].i, cur.state.peak))));
      if (amp * o.rtol > 0.1) throw new NotMet('not met');
      return J;
    },
    (x, state) => free.map((i, q) => Math.max(Math.abs(x[q]), state.peak[i]) || 1),
    o,
    goal,
  );
  return { lo, hi, at: p.at, peak: p.peak, pieces: 1 };
}

function multipleShooting(
  f: Rhs, dim: number, conds: PointCondition[], lo: number, hi: number, o: ShootingOptions,
  scaleOf: (i: number, peak: number[]) => number, goal: number, M: number,
): PiecewiseSolution {
  const nodes = Array.from({ length: M + 1 }, (_, j) => (j === M ? hi : lo + ((hi - lo) * j) / M));
  const pieceOf = (t: number) => Math.min(M - 1, Math.max(0, Math.floor(((t - lo) / (hi - lo)) * M)));
  // starting states from the conditions, interpolated along each component
  const guess = (t: number) => Array.from({ length: dim }, (_, i) => {
    const cs = conds.filter((c) => c.i === i).sort((a, b) => a.point - b.point);
    if (!cs.length) return 0;
    if (t <= cs[0].point) return cs[0].value;
    for (let k = 1; k < cs.length; k++) {
      if (t <= cs[k].point) return cs[k - 1].value + ((cs[k].value - cs[k - 1].value) * (t - cs[k - 1].point)) / (cs[k].point - cs[k - 1].point);
    }
    return cs[cs.length - 1].value;
  });
  const states = (X: number[]) => Array.from({ length: M }, (_, j) => X.slice(j * dim, (j + 1) * dim));
  const condPiece = conds.map((c) => pieceOf(c.point));
  interface State { sols: (OdeSolution | null)[]; s: number[][]; peak: number[] }
  const valueAt = (st: State, j: number, t: number) => (st.sols[j] ? st.sols[j]!.at(t) : st.s[j]);
  const residual = (st: State) => {
    const r: number[] = [];
    for (let j = 0; j + 1 < M; j++) {
      const end = valueAt(st, j, nodes[j + 1]);
      for (let i = 0; i < dim; i++) r.push(end[i] - st.s[j + 1][i]);
    }
    conds.forEach((c, k) => r.push(valueAt(st, condPiece[k], c.point)[c.i] - c.value));
    return r;
  };
  // rows: continuity of each component, then the conditions
  const rowComponent = [...Array.from({ length: (M - 1) * dim }, (_, k) => k % dim), ...conds.map((c) => c.i)];
  const norm = (r: number[], st: State) => Math.max(...r.map((v, k) => Math.abs(v) / scaleOf(rowComponent[k], st.peak)));
  const run = (X: number[], ref?: State): State => {
    const s = states(X);
    const sols = s.map((y, j) => solve(f, nodes[j], y, nodes[j + 1], o, ref?.sols[j]));
    return { sols, s, peak: peakOf(s[0], sols) };
  };
  const evaluate = (X: number[]) => {
    const state = run(X);
    const r = residual(state);
    return { state, r, norm: norm(r, state) };
  };
  const st = newton(
    nodes.slice(0, M).flatMap(guess),
    evaluate,
    (_X, cur) => {
      const n = M * dim;
      const J = Array.from({ length: n }, () => new Array(n).fill(0));
      const s = cur.state.s;
      for (let j = 0; j < M; j++) {
        for (let q = 0; q < dim; q++) {
          const d = 1e-7 * Math.max(Math.abs(s[j][q]), scaleOf(q, cur.state.peak));
          const y = s[j].slice();
          y[q] += d;
          let sol: OdeSolution | null;
          try {
            sol = solve(f, nodes[j], y, nodes[j + 1], o, cur.state.sols[j]);
          } catch {
            sol = solve(f, nodes[j], y, nodes[j + 1], o);
          }
          const at = (t: number) => (sol ? sol.at(t) : y);
          const col = j * dim + q;
          // this piece's end feeds the continuity rows j; the next state enters with −1
          if (j + 1 < M) {
            const end = at(nodes[j + 1]);
            const base = valueAt(cur.state, j, nodes[j + 1]);
            for (let i = 0; i < dim; i++) J[j * dim + i][col] = (end[i] - base[i]) / d;
          }
          if (j > 0) J[(j - 1) * dim + q][col] = -1;
          conds.forEach((c, k) => {
            if (condPiece[k] !== j) return;
            J[(M - 1) * dim + k][col] = (at(c.point)[c.i] - valueAt(cur.state, j, c.point)[c.i]) / d;
          });
        }
      }
      return J;
    },
    (_X, state) => Array.from({ length: M * dim }, (_, k) => scaleOf(k % dim, state.peak)),
    o,
    goal,
  );
  return { lo, hi, at: (t) => valueAt(st, pieceOf(t), t), peak: st.peak, pieces: M };
}
