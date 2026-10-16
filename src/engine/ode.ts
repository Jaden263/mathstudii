// Initial value problems y′ = f(t, y) on plain numbers (units are handled by the
// callers): Dormand–Prince 5(4) with its continuous extension and stiffness
// detection, Radau IIA of order 5 for stiff systems, classic fixed-step RK4 and
// Gragg–Bulirsch–Stoer extrapolation. Every solver returns a dense solution that
// can be evaluated anywhere in the interval.
//
// References: Hairer, Nørsett & Wanner, Solving ODEs I (DOPRI5, II.4–II.10) and
// Hairer & Wanner, Solving ODEs II (RADAU5, IV.8).
export type Rhs = (t: number, y: number[]) => number[];
/** ∂f/∂y as an n×n matrix. */
export type Jacobian = (t: number, y: number[]) => number[][];
export type OdeMethod = 'auto' | 'dopri' | 'radau' | 'rk4' | 'bs';
/** The method that took a step. */
export type StepKind = 'dopri' | 'radau' | 'rk4' | 'bs';

export interface OdeOptions {
  /** auto = Dormand–Prince, switching to Radau when the problem turns out stiff. */
  method?: OdeMethod;
  rtol?: number;
  /** Absolute error floor per component (SI). Default 0: errors are relative to each component's peak. */
  atol?: number | number[];
  /** rk4: the number of steps; adaptive methods: at least this many steps (h ≤ span/steps). */
  steps?: number;
  jac?: Jacobian;
  /** Replay these mesh points (t0 … t1) without error control, e.g. for finite-difference sensitivities. */
  mesh?: number[];
  /** The method of each replayed step (a solution's kinds); default the method (Dormand–Prince for auto). */
  meshKinds?: StepKind[];
  /** Points to land on exactly (Bulirsch–Stoer output points). */
  stops?: number[];
  maxSteps?: number;
}

export interface Segment {
  a: number;
  b: number;
  at(t: number): number[];
}

export interface OdeSolution {
  t0: number;
  t1: number;
  /** Accepted mesh points, t0 first. */
  ts: number[];
  ys: number[][];
  segments: Segment[];
  /** The method of each step (segment). */
  kinds: StepKind[];
  /** Dense output anywhere between t0 and t1. */
  at(t: number): number[];
  steps: number;
  rejected: number;
  evals: number;
  /** Methods used, in order (auto may switch dopri → radau). */
  methods: string[];
  /** Where auto mode switched to the stiff solver. */
  stiffAt?: number;
}

const EPS = Number.EPSILON;

function rms(v: number[], sc: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const r = v[i] / sc[i];
    s += r * r;
  }
  return Math.sqrt(s / Math.max(1, v.length));
}

function finite(v: number[]): boolean {
  for (const x of v) if (!Number.isFinite(x)) return false;
  return true;
}

/** Error weights: each component relative to the largest value it has had (atol a floor). */
class Scale {
  /** Shared by the methods of one run, so that a switch keeps the tolerance. */
  readonly peak: number[];
  constructor(peak: number[], readonly rtol: number, readonly atol: number[]) {
    this.peak = peak;
  }
  weights(y: number[], yn?: number[]): number[] {
    return y.map((v, i) => {
      const m = Math.max(this.peak[i], Math.abs(v), yn ? Math.abs(yn[i]) : 0);
      return Math.max(this.atol[i] + this.rtol * m, 1e-300);
    });
  }
  update(y: number[]) {
    for (let i = 0; i < y.length; i++) this.peak[i] = Math.max(this.peak[i], Math.abs(y[i]));
  }
}

/** The integration driver shared by the steppers. */
class Run {
  ts: number[];
  ys: number[][];
  segments: Segment[] = [];
  kinds: StepKind[] = [];
  steps = 0;
  rejected = 0;
  evals = 0;
  methods: string[] = [];
  stiffAt?: number;
  readonly dir: number;
  readonly span: number;
  readonly peak: number[];
  readonly f: Rhs;
  readonly maxSteps: number;

  constructor(f: Rhs, readonly t0: number, y0: number[], readonly t1: number, readonly opts: OdeOptions) {
    this.f = (t, y) => {
      this.evals++;
      const r = f(t, y);
      if (r.length !== y.length) throw new Error(`The derivative has ${r.length} components, the state has ${y.length}`);
      return r;
    };
    this.dir = t1 >= t0 ? 1 : -1;
    this.span = Math.abs(t1 - t0);
    this.ts = [t0];
    this.ys = [y0.slice()];
    this.peak = y0.map(Math.abs);
    this.maxSteps = opts.maxSteps ?? 2e6;
  }

  hmax(): number {
    return this.opts.steps ? this.span / this.opts.steps : this.span;
  }

  push(t: number, y: number[], seg: Segment, kind: StepKind) {
    this.ts.push(t);
    this.ys.push(y);
    this.segments.push(seg);
    this.kinds.push(kind);
    if (++this.steps > this.maxSteps) throw new Error('ODE solver: too many steps');
  }

  tooSmall(t: number, h: number): boolean {
    return Math.abs(h) <= 16 * EPS * Math.max(Math.abs(t), this.span * 1e-3, 1e-300);
  }

  failSmall(t: number): never {
    throw new Error(`ODE solver: the step size became too small at t = ${t.toPrecision(6)} (singularity, or a solution growing without bound?)`);
  }

  solution(): OdeSolution {
    const segs = this.segments;
    const lo = Math.min(this.t0, this.t1), hi = Math.max(this.t0, this.t1);
    const y0 = this.ys[0];
    const at = (t: number): number[] => {
      if (segs.length === 0) return y0.slice();
      const tol = 1e-12 * Math.max(hi - lo, Math.abs(lo), Math.abs(hi), 1e-300);
      if (t < lo - tol || t > hi + tol) throw new Error('outside the solution interval');
      // segments run in the direction of integration
      let a = 0, b = segs.length - 1;
      const d = this.dir;
      while (a < b) {
        const m = (a + b) >> 1;
        if (d * (t - segs[m].b) > 0) a = m + 1;
        else b = m;
      }
      return segs[a].at(t);
    };
    return {
      t0: this.t0, t1: this.t1, ts: this.ts, ys: this.ys, segments: segs, kinds: this.kinds, at,
      steps: this.steps, rejected: this.rejected, evals: this.evals, methods: this.methods, stiffAt: this.stiffAt,
    };
  }
}

function atolArray(opts: OdeOptions, n: number): number[] {
  const a = opts.atol ?? 0;
  return Array.isArray(a) ? a.slice(0, n) : new Array(n).fill(a);
}

/**
 * Hairer's starting step (Solving ODEs I, II.4). Components that start at zero are
 * scaled by their first change; those with no value and no slope yet are left out.
 */
function initialStep(run: Run, t: number, y: number[], f0: number[], order: number, rtol: number, atol: number[]): number {
  const hmax = run.hmax();
  const guess = run.span * 1e-3;
  const sc = y.map((v, i) => atol[i] + rtol * Math.max(Math.abs(v), Math.abs(f0[i]) * guess));
  const idx = sc.map((_, i) => i).filter((i) => sc[i] > 0);
  if (idx.length === 0) return Math.min(guess * 1e-3, hmax);
  const norm = (v: number[]) => Math.sqrt(idx.reduce((s, i) => s + (v[i] / sc[i]) ** 2, 0) / idx.length);
  const d0 = norm(y), d1 = norm(f0);
  let h0 = d0 < 1e-5 || d1 < 1e-5 ? guess * 1e-3 : 0.01 * (d0 / d1);
  h0 = Math.min(h0, hmax);
  const y1 = y.map((v, i) => v + run.dir * h0 * f0[i]);
  const f1 = run.f(t + run.dir * h0, y1);
  const d2 = norm(f1.map((v, i) => v - f0[i])) / h0;
  const m = Math.max(d1, d2);
  const h1 = !(m > 1e-15) || !Number.isFinite(m) ? Math.max(guess * 1e-3, h0 * 1e-3) : Math.pow(0.01 / m, 1 / (order + 1));
  return Math.min(100 * h0, h1, hmax);
}

// ---------------------------------------------------------------- Dormand–Prince 5(4)

const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const DP_A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
// b5 − b4: the embedded error estimate
const DP_E = [71 / 57600, 0, -71 / 16695, 71 / 1920, -17253 / 339200, 22 / 525, -1 / 40];
// continuous extension of order 4 (Hairer's dense output for DOPRI5)
const DP_D = [-12715105075 / 11282082432, 0, 87487479700 / 32700410799, -10690763975 / 1880347072, 701980252875 / 199316789632, -1453857185 / 822651844, 69997945 / 29380423];

function dopriSegment(t: number, h: number, r1: number[], r2: number[], r3: number[], r4: number[], r5: number[]): Segment {
  const a = Math.min(t, t + h), b = Math.max(t, t + h);
  return {
    a, b,
    at(tq: number) {
      const th = (tq - t) / h, th1 = 1 - th;
      return r1.map((v, i) => v + th * (r2[i] + th1 * (r3[i] + th * (r4[i] + th1 * r5[i]))));
    },
  };
}

/** Where a stepper stopped and the step size it was taking (mean of its last steps). */
interface Leg {
  t: number;
  y: number[];
  /** end: reached t1 (or the end of the mesh); stiff: found stiff; trial: time to try the implicit method. */
  stop: 'end' | 'stiff' | 'trial';
  h: number;
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** Mean of the last few accepted step sizes. */
class RecentSteps {
  private hs: number[] = [];
  constructor(private readonly size: number) {}
  add(h: number) {
    this.hs.push(Math.abs(h));
    if (this.hs.length > this.size) this.hs.shift();
  }
  mean(): number {
    return this.hs.length ? this.hs.reduce((a, b) => a + b, 0) / this.hs.length : 0;
  }
}

interface StepperOptions {
  /** Replay these points (from the current t) without error control. */
  mesh?: number[];
  /** Stop as stiff on Hairer's test (h|λ| at the stability boundary for 15 steps). */
  detectStiff?: boolean;
  /** Stop for a trial of the implicit method after this many accepted steps. */
  trialAfter?: number;
  /** A trial: stop after this many accepted steps, or more rejected ones. */
  maxSteps?: number;
  /** First step size to try (default: Hairer's estimate). */
  h0?: number;
}

function dopri(run: Run, t: number, y: number[], o: StepperOptions = {}): Leg {
  const n = y.length;
  const rtol = run.opts.rtol ?? 1e-9;
  const atol = atolArray(run.opts, n);
  const scale = new Scale(run.peak, rtol, atol);
  run.methods.push('Dormand–Prince 5(4)');
  const { mesh, detectStiff } = o;
  const recent = new RecentSteps(20);
  let taken = 0;
  let mi = 1;
  let k1 = run.f(t, y);
  if (!finite(k1)) throw new Error(`ODE solver: the derivative is not finite at t = ${t.toPrecision(6)}`);
  let h = mesh ? 0 : o.h0 || initialStep(run, t, y, k1, 5, rtol, atol);
  let facmax = 5;
  let stiffCount = 0, nonStiff = 0;
  const hls: number[] = []; // the last h|λ| estimates
  const k: number[][] = new Array(7);
  const ys = new Array(n);
  while (run.dir * (run.t1 - t) > 0) {
    let hs: number;
    if (mesh) {
      if (mi >= mesh.length) break;
      hs = mesh[mi] - t;
    } else {
      hs = run.dir * Math.min(Math.abs(h), run.hmax());
      // land on t1, without leaving a sliver
      if (run.dir * (t + 1.01 * hs - run.t1) >= 0) hs = run.t1 - t;
    }
    if (!mesh && run.tooSmall(t, hs)) run.failSmall(t);
    k[0] = k1;
    let ysti: number[] = [];
    for (let s = 1; s < 7; s++) {
      const a = DP_A[s];
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let l = 0; l < s; l++) acc += a[l] * k[l][i];
        ys[i] = y[i] + hs * acc;
      }
      if (s === 5) ysti = ys.slice();
      k[s] = run.f(t + DP_C[s] * hs, ys.slice());
    }
    const y5 = ys.slice(); // stage 7 sits at the 5th-order solution (FSAL)
    const errv = new Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let s = 0; s < 7; s++) acc += DP_E[s] * k[s][i];
      errv[i] = hs * acc;
    }
    const ok = finite(y5) && finite(k[6]);
    const err = ok ? rms(errv, scale.weights(y, y5)) : Infinity;
    if (mesh || err <= 1) {
      if (!ok) throw new Error(`ODE solver: the solution is not finite after t = ${t.toPrecision(6)}`);
      const r2 = y5.map((v, i) => v - y[i]);
      const r3 = k1.map((v, i) => hs * v - r2[i]);
      const r4 = r2.map((v, i) => v - hs * k[6][i] - r3[i]);
      const r5 = new Array(n);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let s = 0; s < 7; s++) acc += DP_D[s] * k[s][i];
        r5[i] = hs * acc;
      }
      const tn = mesh ? mesh[mi++] : Math.abs(run.t1 - t - hs) <= EPS * Math.abs(run.t1) ? run.t1 : t + hs;
      run.push(tn, y5, dopriSegment(t, tn - t, y.slice(), r2, r3, r4, r5), 'dopri');
      recent.add(tn - t);
      taken++;
      // stiffness test: h·|λ| ≈ h‖f(y5) − f(ysti)‖ / ‖y5 − ysti‖ near DOPRI5's stability boundary
      if (detectStiff) {
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          num += (k[6][i] - k[5][i]) ** 2;
          den += (y5[i] - ysti[i]) ** 2;
        }
        const hl = den > 0 ? Math.abs(hs) * Math.sqrt(num / den) : 0;
        hls.push(hl);
        if (hls.length > 21) hls.shift();
        if (hl > 3.25) {
          nonStiff = 0;
          if (++stiffCount >= 15) return { t: tn, y: y5, stop: 'stiff', h: recent.mean() };
        } else if (++nonStiff >= 6) stiffCount = 0;
      }
      t = tn;
      y = y5;
      k1 = k[6];
      scale.update(y);
      const fac = err === 0 ? facmax : Math.min(facmax, Math.max(0.2, 0.9 * Math.pow(err, -0.2)));
      h = Math.abs(hs) * fac;
      facmax = 5;
      // a trial only where the fastest mode is barely resolved (h|λ| ≳ 0.1): below that the
      // steps are set by accuracy, and no method could stride further
      if (o.trialAfter && taken >= o.trialAfter && run.dir * (run.t1 - t) > 0 && median(hls) >= 0.1) {
        return { t, y, stop: 'trial', h: recent.mean() };
      }
    } else {
      run.rejected++;
      h = Math.abs(hs) * Math.max(0.2, 0.9 * Math.pow(err, -0.2));
      facmax = 1; // no growth right after a rejection
    }
  }
  return { t, y, stop: 'end', h: recent.mean() };
}

// ---------------------------------------------------------------- Radau IIA (order 5)

const S6 = Math.sqrt(6);
const RC = [(4 - S6) / 10, (4 + S6) / 10, 1];
const RA = [
  [(88 - 7 * S6) / 360, (296 - 169 * S6) / 1800, (-2 + 3 * S6) / 225],
  [(296 + 169 * S6) / 1800, (88 + 7 * S6) / 360, (-2 - 3 * S6) / 225],
  [(16 - S6) / 36, (16 + S6) / 36, 1 / 9],
];
// γ₀: the real eigenvalue of A⁻¹ is 1/γ₀; the embedded 3rd-order formula gives
// err = (I − hγ₀J)⁻¹ [γ₀ h f(t, y) + Σ eᵢ zᵢ] with e = γ₀·(−(13+7√6)/3, (−13+7√6)/3, −1/3)
const G0 = (6 + Math.cbrt(81) - Math.cbrt(9)) / 30;
const RE = [(-(13 + 7 * S6) / 3) * G0, ((-13 + 7 * S6) / 3) * G0, (-1 / 3) * G0];

/** LU decomposition with partial pivoting (in place); returns the pivot order. */
function luFactor(M: number[][]): number[] {
  const n = M.length;
  const piv = Array.from({ length: n }, (_, i) => i);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) throw new Error('singular');
    if (p !== c) { [M[c], M[p]] = [M[p], M[c]]; [piv[c], piv[p]] = [piv[p], piv[c]]; }
    const d = M[c][c];
    for (let r = c + 1; r < n; r++) {
      const f = (M[r][c] /= d);
      if (f !== 0) for (let k = c + 1; k < n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return piv;
}

function luSolve(LU: number[][], piv: number[], b: number[]): number[] {
  const n = LU.length;
  const x = piv.map((p) => b[p]);
  for (let i = 0; i < n; i++) for (let k = 0; k < i; k++) x[i] -= LU[i][k] * x[k];
  for (let i = n - 1; i >= 0; i--) {
    for (let k = i + 1; k < n; k++) x[i] -= LU[i][k] * x[k];
    x[i] /= LU[i][i];
  }
  return x;
}

/** Forward-difference Jacobian. */
export function numericJacobian(f: Rhs, t: number, y: number[], fy: number[], typical: number[]): number[][] {
  const n = y.length;
  const J: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let j = 0; j < n; j++) {
    const scale = Math.max(Math.abs(y[j]), typical[j]);
    const d = Math.sqrt(EPS) * (scale > 0 ? scale : 1);
    const yp = y.slice();
    yp[j] += d;
    const step = yp[j] - y[j];
    const fp = f(t, yp);
    for (let i = 0; i < n; i++) J[i][j] = (fp[i] - fy[i]) / step;
  }
  return J;
}

function radauSegment(t: number, h: number, y0: number[], z: number[][]): Segment {
  const a = Math.min(t, t + h), b = Math.max(t, t + h);
  // collocation polynomial through (0, 0), (c₁, z₁), (c₂, z₂), (1, z₃)
  return {
    a, b,
    at(tq: number) {
      const th = (tq - t) / h;
      const w = RC.map((ci, i) => {
        let l = th / ci;
        for (let j = 0; j < 3; j++) if (j !== i) l *= (th - RC[j]) / (ci - RC[j]);
        return l;
      });
      return y0.map((v, p) => v + w[0] * z[0][p] + w[1] * z[1][p] + w[2] * z[2][p]);
    },
  };
}

function radau(run: Run, t: number, y: number[], o: StepperOptions = {}): Leg {
  const n = y.length;
  const rtol = Math.max(run.opts.rtol ?? 1e-9, 1e-12);
  const atol = atolArray(run.opts, n);
  const scale = new Scale(run.peak, rtol, atol);
  run.methods.push('Radau IIA (order 5)');
  const { mesh } = o;
  const recent = new RecentSteps(5);
  let taken = 0;
  const rejected0 = run.rejected;
  let mi = 1;
  const fnewt = Math.max((10 * EPS) / rtol, Math.min(0.03, Math.sqrt(rtol)));
  let fy = run.f(t, y);
  if (!finite(fy)) throw new Error(`ODE solver: the derivative is not finite at t = ${t.toPrecision(6)}`);
  let h = mesh ? 0 : o.h0 || initialStep(run, t, y, fy, 3, rtol, atol);
  let J: number[][] | null = null;
  let jacFresh = false;
  let prev: Segment | null = null;
  let first = true, reject = false;
  let faccon = 1;
  let patient = false;
  const jac = () => {
    J = run.opts.jac ? run.opts.jac(t, y) : numericJacobian(run.f, t, y, fy, scale.peak);
    jacFresh = true;
  };
  while (run.dir * (run.t1 - t) > 0) {
    let hs: number;
    if (mesh) {
      if (mi >= mesh.length) break;
      hs = mesh[mi] - t;
    } else {
      hs = run.dir * Math.min(Math.abs(h), run.hmax());
      if (run.dir * (t + 1.01 * hs - run.t1) >= 0) hs = run.t1 - t;
      if (run.tooSmall(t, hs)) run.failSmall(t);
      // a trial that keeps failing has its answer
      if (o.maxSteps && run.rejected - rejected0 > o.maxSteps) return { t, y, stop: 'trial', h: recent.mean() };
    }
    if (!J) jac();
    const Jm = J!;
    const sc = scale.weights(y);
    // M = I − h (A ⊗ J) on the stacked stage increments
    const N3 = 3 * n;
    const M: number[][] = Array.from({ length: N3 }, () => new Array(N3).fill(0));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const ha = hs * RA[i][j];
      for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) M[i * n + p][j * n + q] = (i === j && p === q ? 1 : 0) - ha * Jm[p][q];
    }
    let piv: number[];
    try {
      piv = luFactor(M);
    } catch {
      if (mesh) throw new Error('Radau: singular iteration matrix');
      h = Math.abs(hs) * 0.5;
      run.rejected++;
      continue;
    }
    // starting values from the previous collocation polynomial
    const z: number[][] = [0, 1, 2].map((i) => {
      if (!prev || first) return new Array(n).fill(0);
      try {
        const u = prev.at(t + RC[i] * hs);
        return u.map((v, p) => v - y[p]);
      } catch {
        return new Array(n).fill(0);
      }
    });
    // simplified Newton iterations
    let converged = false;
    let theta = 0, dynold = 0, newt = 0;
    faccon = Math.pow(Math.max(faccon, EPS), 0.8);
    // a replayed step cannot be shortened: give Newton more room instead
    const maxNewt = patient ? 20 : 7;
    for (newt = 1; newt <= maxNewt; newt++) {
      const F = [0, 1, 2].map((i) => run.f(t + RC[i] * hs, y.map((v, p) => v + z[i][p])));
      if (!F.every(finite)) break;
      const rhs = new Array(N3);
      for (let i = 0; i < 3; i++) for (let p = 0; p < n; p++) {
        let acc = 0;
        for (let j = 0; j < 3; j++) acc += RA[i][j] * F[j][p];
        rhs[i * n + p] = -z[i][p] + hs * acc;
      }
      const dz = luSolve(M, piv!, rhs);
      let dyno = 0;
      for (let i = 0; i < 3; i++) for (let p = 0; p < n; p++) dyno += (dz[i * n + p] / sc[p]) ** 2;
      dyno = Math.sqrt(dyno / N3);
      if (newt > 1) {
        theta = dyno / dynold;
        if (theta >= 0.99) break;
        faccon = theta / (1 - theta);
        // predicted not to converge within the iteration limit
        if ((Math.pow(theta, maxNewt - newt) / (1 - theta)) * dyno > fnewt) break;
      }
      for (let i = 0; i < 3; i++) for (let p = 0; p < n; p++) z[i][p] += dz[i * n + p];
      dynold = Math.max(dyno, EPS);
      if (faccon * dyno <= fnewt) { converged = true; break; }
    }
    if (!converged) {
      if (mesh) {
        // the same step again, with a fresh Jacobian, then with more iterations
        if (!jacFresh) jac();
        else if (!patient) patient = true;
        else throw new Error('Radau: Newton iteration did not converge on the replayed mesh');
        continue;
      }
      run.rejected++;
      h = Math.abs(hs) * 0.5;
      if (!jacFresh) jac();
      continue;
    }
    const yn = y.map((v, p) => v + z[2][p]);
    // error estimate with Hairer's stiff filter
    let err: number;
    try {
      const E = Jm.map((row, p) => row.map((v, q) => (p === q ? 1 : 0) - hs * G0 * v));
      const Epiv = luFactor(E);
      const ez = y.map((_, p) => RE[0] * z[0][p] + RE[1] * z[1][p] + RE[2] * z[2][p]);
      let ev = luSolve(E, Epiv, ez.map((v, p) => v + G0 * hs * fy[p]));
      const scn = scale.weights(y, yn);
      err = rms(ev, scn);
      if (err >= 1 && (first || reject)) {
        const f2 = run.f(t, y.map((v, p) => v + ev[p]));
        ev = luSolve(E, Epiv, ez.map((v, p) => v + G0 * hs * f2[p]));
        err = rms(ev, scn);
      }
    } catch {
      err = Infinity; // singular filter matrix: try a different step
    }
    if (!Number.isFinite(err)) err = 1e10;
    const fac = Math.min(0.9, (0.9 * (2 * 7 + 1)) / (2 * 7 + newt));
    if (mesh || err <= 1) {
      const tn = mesh ? mesh[mi++] : Math.abs(run.t1 - t - hs) <= EPS * Math.abs(run.t1) ? run.t1 : t + hs;
      const seg = radauSegment(t, tn - t, y.slice(), z.map((r) => r.slice()));
      run.push(tn, yn, seg, 'radau');
      recent.add(tn - t);
      taken++;
      patient = false;
      prev = seg;
      t = tn;
      y = yn;
      fy = run.f(t, y);
      scale.update(y);
      const q = err === 0 ? 8 : Math.min(8, Math.max(0.2, fac * Math.pow(err, -0.25)));
      // no growth right after a rejection
      h = Math.abs(hs) * (reject ? Math.min(1, q) : q);
      first = false;
      reject = false;
      // keep the Jacobian while Newton converges fast
      if (theta > 0.001 || newt > 2) J = null;
      jacFresh = false;
      if (o.maxSteps && taken >= o.maxSteps && run.dir * (run.t1 - t) > 0) return { t, y, stop: 'trial', h: recent.mean() };
    } else {
      run.rejected++;
      reject = true;
      h = Math.abs(hs) * Math.max(0.2, fac * Math.pow(err, -0.25));
      if (!jacFresh) J = null;
    }
  }
  return { t, y, stop: 'end', h: recent.mean() };
}

// ---------------------------------------------------------------- classic RK4

function hermiteSegment(t: number, h: number, y0: number[], f0: number[], y1: number[], f1: number[]): Segment {
  const a = Math.min(t, t + h), b = Math.max(t, t + h);
  return {
    a, b,
    at(tq: number) {
      const s = (tq - t) / h, s2 = s * s, s3 = s2 * s;
      const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
      return y0.map((v, i) => h00 * v + h10 * h * f0[i] + h01 * y1[i] + h11 * h * f1[i]);
    },
  };
}

function rk4(run: Run, t: number, y: number[], mesh?: number[]): { t: number; y: number[] } {
  run.methods.push('Runge–Kutta 4 (fixed step)');
  const steps = mesh ? mesh.length - 1 : Math.max(1, Math.round(run.opts.steps ?? 1000));
  const h = (run.t1 - run.t0) / steps;
  let k1 = run.f(t, y);
  for (let s = 0; s < steps; s++) {
    const tn = mesh ? mesh[s + 1] : s === steps - 1 ? run.t1 : run.t0 + (s + 1) * h;
    const hs = tn - t;
    const k2 = run.f(t + hs / 2, y.map((v, i) => v + (hs / 2) * k1[i]));
    const k3 = run.f(t + hs / 2, y.map((v, i) => v + (hs / 2) * k2[i]));
    const k4 = run.f(t + hs, y.map((v, i) => v + hs * k3[i]));
    const yn = y.map((v, i) => v + (hs / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
    if (!finite(yn)) throw new Error(`ODE solver: the solution is not finite after t = ${t.toPrecision(6)}`);
    const fn = run.f(tn, yn);
    run.push(tn, yn, hermiteSegment(t, hs, y, k1, yn, fn), 'rk4');
    t = tn;
    y = yn;
    k1 = fn;
  }
  return { t, y };
}

// ---------------------------------------------------------------- Bulirsch–Stoer

const BS_SEQ = [2, 4, 6, 8, 10, 12, 14, 16];

/** Gragg's modified midpoint rule over H with n substeps, with the final smoothing step. */
function midpoint(run: Run, t: number, y: number[], f0: number[], H: number, n: number): number[] {
  const h = H / n;
  let zPrev = y.slice();
  let z = y.map((v, i) => v + h * f0[i]);
  for (let m = 1; m < n; m++) {
    const fz = run.f(t + m * h, z);
    const zn = zPrev.map((v, i) => v + 2 * h * fz[i]);
    zPrev = z;
    z = zn;
  }
  const fz = run.f(t + H, z);
  return z.map((v, i) => 0.5 * (v + zPrev[i] + h * fz[i]));
}

function bulirschStoer(run: Run, t: number, y: number[]): { t: number; y: number[] } {
  run.methods.push('Bulirsch–Stoer');
  const n = y.length;
  const rtol = run.opts.rtol ?? 1e-9;
  const atol = atolArray(run.opts, n);
  const scale = new Scale(run.peak, rtol, atol);
  const stops = (run.opts.stops ?? []).filter((s) => run.dir * (s - t) > 0 && run.dir * (run.t1 - s) >= 0).sort((a, b) => run.dir * (a - b));
  let si = 0;
  let f0 = run.f(t, y);
  let H = initialStep(run, t, y, f0, 4, rtol, atol) * 4;
  while (run.dir * (run.t1 - t) > 0) {
    let Hs = run.dir * Math.min(Math.abs(H), run.hmax());
    while (si < stops.length && run.dir * (stops[si] - t) <= 0) si++;
    const target = si < stops.length ? stops[si] : run.t1;
    if (run.dir * (t + 1.01 * Hs - target) >= 0) Hs = target - t;
    if (run.tooSmall(t, Hs)) run.failSmall(t);
    const T: number[][][] = [];
    let accepted: number[] | null = null;
    let used = 0, errUsed = 0;
    for (let j = 0; j < BS_SEQ.length; j++) {
      const row = [midpoint(run, t, y, f0, Hs, BS_SEQ[j])];
      // Aitken–Neville extrapolation in h²
      for (let k = 1; k <= j; k++) {
        const r = (BS_SEQ[j] / BS_SEQ[j - k]) ** 2 - 1;
        row.push(row[k - 1].map((v, i) => v + (v - T[j - 1][k - 1][i]) / r));
      }
      T.push(row);
      if (j >= 2) {
        const sc = scale.weights(y, row[j]);
        const err = rms(row[j].map((v, i) => v - row[j - 1][i]), sc);
        if (err <= 1 && finite(row[j])) {
          accepted = row[j];
          used = j;
          errUsed = err;
          break;
        }
      }
    }
    if (!accepted) {
      run.rejected++;
      H = Math.abs(Hs) * 0.25;
      continue;
    }
    const tn = Math.abs(target - t - Hs) <= EPS * Math.abs(target) ? target : t + Hs;
    const fn = run.f(tn, accepted);
    run.push(tn, accepted, hermiteSegment(t, tn - t, y, f0, accepted, fn), 'bs');
    // converging early means the step can grow
    const order = 2 * used + 1;
    const fac = errUsed === 0 ? 4 : Math.min(4, Math.max(0.25, 0.94 * Math.pow(0.65 / errUsed, 1 / order)));
    H = Math.abs(Hs) * (used <= 3 ? Math.max(fac, 1.5) : fac);
    t = tn;
    y = accepted;
    f0 = fn;
    scale.update(y);
  }
  return { t, y };
}

// ---------------------------------------------------------------- driver

/** Integrate y′ = f(t, y) from t0 (where y = y0) to t1. */
export function solveIvp(f: Rhs, t0: number, y0: number[], t1: number, opts: OdeOptions = {}): OdeSolution {
  if (!finite(y0)) throw new Error('ODE solver: the initial values must be finite numbers');
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) throw new Error('ODE solver: the interval must be finite');
  const run = new Run(f, t0, y0, t1, opts);
  if (t0 === t1) return run.solution();
  const method = opts.method ?? 'auto';
  if (opts.mesh) replay(run, opts.mesh, opts.meshKinds, method === 'radau' || method === 'rk4' ? method : 'dopri');
  else if (method === 'rk4') rk4(run, t0, y0.slice());
  else if (method === 'bs') bulirschStoer(run, t0, y0.slice());
  else if (method === 'radau') radau(run, t0, y0.slice());
  else if (method === 'dopri') dopri(run, t0, y0.slice());
  else autoSwitch(run, t0, y0.slice());
  return run.solution();
}

/**
 * Dormand–Prince until the problem shows itself stiff, then Radau to the end. Hairer's
 * test only sees steps held at the explicit method's stability boundary; at tight
 * tolerances a stiff problem keeps h|λ| near 1 instead (order reduction), so after
 * a few hundred steps (then rarely) a short run of Radau is tried, and kept if it
 * strides much further than Dormand–Prince did.
 */
function autoSwitch(run: Run, t: number, y: number[]) {
  let wait = 300;
  let h0 = 0;
  for (;;) {
    const d = dopri(run, t, y, { detectStiff: true, trialAfter: wait, h0 });
    if (d.stop === 'end') return;
    let at: Leg = d;
    if (d.stop === 'trial') {
      const r = radau(run, d.t, d.y, { maxSteps: 10, h0: d.h });
      if (r.stop === 'end') return;
      at = r;
      // an implicit step costs about two explicit ones
      if (r.h < 3 * d.h) {
        wait *= 8;
        h0 = d.h;
        ({ t, y } = r);
        continue;
      }
    }
    run.stiffAt = at.t;
    radau(run, at.t, at.y, { h0: at === d ? 0 : at.h });
    return;
  }
}

/**
 * Replay a mesh without error control, each stretch with the method that made it
 * (Bulirsch–Stoer steps, whose order varies, with Dormand–Prince).
 */
function replay(run: Run, mesh: number[], kinds: StepKind[] | undefined, fallback: StepKind) {
  let t = run.t0;
  let y = run.ys[0].slice();
  const kindOf = (i: number): StepKind => {
    const k = kinds?.[i] ?? fallback;
    return k === 'bs' ? 'dopri' : k;
  };
  for (let i = 0; i < mesh.length - 1;) {
    const kind = kindOf(i);
    let j = i + 1;
    while (j < mesh.length - 1 && kindOf(j) === kind) j++;
    const sub = mesh.slice(i, j + 1);
    if (kind === 'rk4') ({ t, y } = rk4(run, t, y, sub));
    else ({ t, y } = kind === 'radau' ? radau(run, t, y, { mesh: sub }) : dopri(run, t, y, { mesh: sub }));
    i = j;
  }
}
