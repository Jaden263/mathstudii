// Pure numerical algorithms on plain JS numbers. Units are stripped/re-attached
// by the callers (see splitUnit in math.ts), which keeps these routines simple
// and fast.
import * as S from './special';

export type Fn1 = (x: number) => number;

// ---------------------------------------------------------------- integration

// 7-point Gauss / 15-point Kronrod nodes and weights on [-1, 1].
const XK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851,
  0.864864423359769072789712788640926, 0.741531185599394439863864773280788,
  0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0.0,
];
const WK = [
  0.022935322010529224963732008058970, 0.063092092629978553290700663189204,
  0.104790010322250183839876322541518, 0.140653259715525918745189590510238,
  0.169004726639267902826583426598550, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
];
const WG = [0.129484966168869693270611432679082, 0.279705391489276667901467771423780,
  0.381830050505118944950369775488975, 0.417959183673469387755102040816327];

function gk15(f: Fn1, a: number, b: number): { value: number; error: number } {
  const c = 0.5 * (a + b);
  const h = 0.5 * (b - a);
  const fc = f(c);
  let resK = fc * WK[7];
  let resG = fc * WG[3];
  for (let j = 0; j < 7; j++) {
    const dx = h * XK[j];
    const f1 = f(c - dx);
    const f2 = f(c + dx);
    resK += WK[j] * (f1 + f2);
    if (j % 2 === 1) resG += WG[(j - 1) / 2] * (f1 + f2);
  }
  return { value: resK * h, error: Math.abs((resK - resG) * h) };
}

/** Adaptive Gauss–Kronrod quadrature; infinite limits are mapped to finite ones. */
export function integrate(f: Fn1, a: number, b: number, tol = 1e-10, maxSegments = 2000): number {
  if (a === b) return 0;
  if (a > b) return -integrate(f, b, a, tol, maxSegments);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    // x = t / (1 - t^2), t in (-1, 1)
    const g: Fn1 = (t) => {
      const d = 1 - t * t;
      const x = t / d;
      return f(x) * (1 + t * t) / (d * d);
    };
    const ta = Number.isFinite(a) ? (a === 0 ? 0 : (Math.sqrt(1 + 4 * a * a) - 1) / (2 * a)) : -1;
    const tb = Number.isFinite(b) ? (b === 0 ? 0 : (Math.sqrt(1 + 4 * b * b) - 1) / (2 * b)) : 1;
    return integrate(g, ta, tb, tol, maxSegments);
  }
  type Seg = { a: number; b: number; value: number; error: number };
  const first = gk15(f, a, b);
  const segs: Seg[] = [{ a, b, ...first }];
  let total = first.value;
  let err = first.error;
  while (err > Math.max(tol, tol * Math.abs(total)) && segs.length < maxSegments) {
    // split the segment with the largest error
    let worst = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].error > segs[worst].error) worst = i;
    const s = segs[worst];
    const m = 0.5 * (s.a + s.b);
    if (m <= s.a || m >= s.b) break;
    const l = gk15(f, s.a, m);
    const r = gk15(f, m, s.b);
    segs.splice(worst, 1, { a: s.a, b: m, ...l }, { a: m, b: s.b, ...r });
    total += l.value + r.value - s.value;
    err += l.error + r.error - s.error;
  }
  if (!Number.isFinite(total)) throw new Error('Integral does not converge');
  return total;
}

// ---------------------------------------------------------------- derivatives

/** Numerical derivative of order 1..5 using Richardson-extrapolated central differences. */
export function derivative(f: Fn1, x: number, order = 1): number {
  if (order === 0) return f(x);
  if (order === 1) {
    let h = 1e-2 * Math.max(1, Math.abs(x));
    const n = 8;
    const table: number[][] = [];
    let best = NaN;
    let bestErr = Infinity;
    for (let i = 0; i < n; i++) {
      table[i] = [(f(x + h) - f(x - h)) / (2 * h)];
      let fac = 4;
      for (let j = 1; j <= i; j++) {
        table[i][j] = table[i][j - 1] + (table[i][j - 1] - table[i - 1][j - 1]) / (fac - 1);
        fac *= 4;
        const e = Math.max(Math.abs(table[i][j] - table[i][j - 1]), Math.abs(table[i][j] - table[i - 1][j - 1]));
        if (e <= bestErr) {
          bestErr = e;
          best = table[i][j];
        }
      }
      if (i > 0 && Math.abs(table[i][i] - table[i - 1][i - 1]) >= 2 * bestErr) break;
      h /= 2;
    }
    return Number.isNaN(best) ? table[0][0] : best;
  }
  return derivative((t) => derivative(f, t, order - 1), x, 1);
}

// ---------------------------------------------------------------- root finding

/** Brent's method on a bracketing interval. */
export function brent(f: Fn1, a: number, b: number, tol = 1e-14, maxIter = 200): number {
  let fa = f(a);
  let fb = f(b);
  if (fa === 0) return a;
  if (fb === 0) return b;
  if (fa * fb > 0) throw new Error('root: f(a) and f(b) must have opposite signs');
  let c = a, fc = fa, d = b - a, e = d;
  for (let i = 0; i < maxIter; i++) {
    if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d; }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa; }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tol;
    const xm = 0.5 * (c - b);
    if (Math.abs(xm) <= tol1 || fb === 0) return b;
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      let p: number, q: number;
      const s = fb / fa;
      if (a === c) { p = 2 * xm * s; q = 1 - s; }
      else {
        const qq = fa / fc, r = fb / fc;
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1));
        q = (qq - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q; }
      else { d = xm; e = d; }
    } else { d = xm; e = d; }
    a = b; fa = fb;
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1);
    fb = f(b);
  }
  return b;
}

/** Root from a single guess: secant/Newton steps, falling back to bracket search + Brent. */
export function rootFromGuess(f: Fn1, x0: number, tol = 1e-12): number {
  let x = x0;
  let fx = f(x);
  if (fx === 0) return x;
  const scale = Math.max(1, Math.abs(x0));
  for (let i = 0; i < 60; i++) {
    const h = 1e-7 * Math.max(1, Math.abs(x));
    const df = (f(x + h) - f(x - h)) / (2 * h);
    if (!Number.isFinite(df) || df === 0) break;
    let step = fx / df;
    let xn = x - step;
    let fn = f(xn);
    // damping
    let k = 0;
    while ((!Number.isFinite(fn) || Math.abs(fn) > Math.abs(fx)) && k < 30) {
      step /= 2;
      xn = x - step;
      fn = f(xn);
      k++;
    }
    x = xn;
    fx = fn;
    if (Math.abs(step) <= tol * Math.max(1, Math.abs(x)) || fx === 0) return x;
  }
  if (Math.abs(fx) < 1e-10 * scale) return x;
  // expanding bracket search around the guess
  const f0 = f(x0);
  let d = 0.01 * scale;
  for (let i = 0; i < 80; i++) {
    const a = x0 - d, b = x0 + d;
    const fa = f(a), fb = f(b);
    if (Number.isFinite(fa) && Number.isFinite(f0) && fa * f0 <= 0) return brent(f, a, x0);
    if (Number.isFinite(fb) && Number.isFinite(f0) && fb * f0 <= 0) return brent(f, x0, b);
    d *= 1.6;
  }
  throw new Error('root: no root found near the guess value');
}

// ---------------------------------------------------------------- optimisation

export interface LMResult { x: number[]; residual: number; converged: boolean; iterations: number }

/** Levenberg–Marquardt least squares on residual vector r(x). */
export function levenbergMarquardt(
  r: (x: number[]) => number[],
  x0: number[],
  opts: { tol?: number; maxIter?: number } = {},
): LMResult {
  const tol = opts.tol ?? 1e-12;
  const maxIter = opts.maxIter ?? 500;
  const n = x0.length;
  let x = x0.slice();
  let res = r(x);
  let cost = sumSq(res);
  let lambda = 1e-3;
  let it = 0;
  for (; it < maxIter; it++) {
    if (cost === 0) break;
    const m = res.length;
    // Jacobian by forward differences
    const J: number[][] = Array.from({ length: m }, () => new Array(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-8 * Math.max(1, Math.abs(x[j]));
      const xp = x.slice();
      xp[j] += h;
      const rp = r(xp);
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - res[i]) / h;
    }
    const JtJ: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const Jtr = new Array(n).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < n; a++) {
        Jtr[a] += J[i][a] * res[i];
        for (let b = 0; b < n; b++) JtJ[a][b] += J[i][a] * J[i][b];
      }
    }
    let improved = false;
    for (let k = 0; k < 30; k++) {
      const A = JtJ.map((row, i) => row.map((v, j) => (i === j ? v + lambda * Math.max(v, 1e-12) : v)));
      let step: number[];
      try {
        step = solveLinear(A, Jtr.map((v) => -v));
      } catch {
        lambda *= 10;
        continue;
      }
      const xn = x.map((v, i) => v + step[i]);
      const rn = r(xn);
      const cn = sumSq(rn);
      if (Number.isFinite(cn) && cn < cost) {
        const rel = Math.sqrt(sumSq(step)) / Math.max(1e-300, Math.sqrt(sumSq(x)) + 1e-12);
        x = xn;
        res = rn;
        const dc = cost - cn;
        cost = cn;
        lambda = Math.max(lambda / 3, 1e-15);
        improved = true;
        if (rel < 1e-15 || dc < 1e-30) it = maxIter;
        break;
      }
      lambda *= 4;
    }
    if (!improved || Math.sqrt(cost) < tol) break;
  }
  return { x, residual: Math.sqrt(cost), converged: Math.sqrt(cost) < Math.sqrt(tol), iterations: it };
}

/** Nelder–Mead simplex minimisation. */
export function nelderMead(f: (x: number[]) => number, x0: number[], maxIter = 5000, tol = 1e-12): number[] {
  const n = x0.length;
  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] = p[i] !== 0 ? p[i] * 1.05 : 0.00025;
    if (p[i] === x0[i]) p[i] += 0.05;
    simplex.push(p);
  }
  let values = simplex.map(f);
  for (let it = 0; it < maxIter; it++) {
    const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    simplex = order.map((i) => simplex[i]);
    values = order.map((i) => values[i]);
    if (Math.abs(values[n] - values[0]) <= tol * (Math.abs(values[0]) + Math.abs(values[n]) + 1e-300)) {
      let spread = 0;
      for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) spread = Math.max(spread, Math.abs(simplex[i][j] - simplex[0][j]));
      if (spread < 1e-10 * (1 + Math.max(...simplex[0].map(Math.abs)))) break;
    }
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const along = (t: number) => centroid.map((c, j) => c + t * (simplex[n][j] - c));
    const xr = along(-1);
    const fr = f(xr);
    if (fr < values[0]) {
      const xe = along(-2);
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; values[n] = fe; } else { simplex[n] = xr; values[n] = fr; }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr; values[n] = fr;
    } else {
      const xc = fr < values[n] ? along(-0.5) : along(0.5);
      const fc = f(xc);
      if (fc < Math.min(fr, values[n])) { simplex[n] = xc; values[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j]));
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return simplex[best];
}

// ---------------------------------------------------------------- linear algebra

export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) throw new Error('Singular matrix');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f !== 0) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function matrixRank(A: number[][], tol = 1e-10): number {
  const M = A.map((r) => r.slice());
  const rows = M.length;
  const cols = rows ? M[0].length : 0;
  let rank = 0;
  const scale = Math.max(1e-300, ...M.flat().map(Math.abs));
  for (let c = 0; c < cols && rank < rows; c++) {
    let p = rank;
    for (let r = rank + 1; r < rows; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) <= tol * scale) continue;
    [M[rank], M[p]] = [M[p], M[rank]];
    for (let r = rank + 1; r < rows; r++) {
      const f = M[r][c] / M[rank][c];
      for (let k = c; k < cols; k++) M[r][k] -= f * M[rank][k];
    }
    rank++;
  }
  return rank;
}

function sumSq(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return s;
}

// ---------------------------------------------------------------- polynomials

export interface C { re: number; im: number }

/** All roots of the polynomial with ascending real coefficients (Durand–Kerner + Newton polish). */
export function polyRoots(coeffs: number[]): C[] {
  const a = coeffs.slice();
  while (a.length && a[a.length - 1] === 0) a.pop();
  let zeroRoots = 0;
  while (a.length > 1 && a[0] === 0) { a.shift(); zeroRoots++; }
  const n = a.length - 1;
  const out: C[] = Array.from({ length: zeroRoots }, () => ({ re: 0, im: 0 }));
  if (n < 1) {
    if (out.length) return out;
    throw new Error('polyroots: polynomial must have degree >= 1');
  }
  const lead = a[n];
  const c = a.map((v) => v / lead); // monic
  const evalP = (z: C): C => {
    let re = 1, im = 0;
    for (let k = n - 1; k >= 0; k--) {
      const r2 = re * z.re - im * z.im + c[k];
      im = re * z.im + im * z.re;
      re = r2;
    }
    return { re, im };
  };
  const radius = 1 + Math.max(...c.slice(0, n).map(Math.abs));
  let z: C[] = Array.from({ length: n }, (_, k) => {
    const ang = (2 * Math.PI * k) / n + 0.4;
    return { re: radius * 0.5 * Math.cos(ang), im: radius * 0.5 * Math.sin(ang) };
  });
  for (let it = 0; it < 2000; it++) {
    let delta = 0;
    const next = z.map((zi, i) => {
      const p = evalP(zi);
      let dre = 1, dim = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const xr = zi.re - z[j].re, xi = zi.im - z[j].im;
        const r2 = dre * xr - dim * xi;
        dim = dre * xi + dim * xr;
        dre = r2;
      }
      const den = dre * dre + dim * dim || 1e-300;
      const qre = (p.re * dre + p.im * dim) / den;
      const qim = (p.im * dre - p.re * dim) / den;
      delta = Math.max(delta, Math.hypot(qre, qim));
      return { re: zi.re - qre, im: zi.im - qim };
    });
    z = next;
    if (delta < 1e-15 * radius) break;
  }
  for (const r of z) {
    if (Math.abs(r.im) < 1e-10 * Math.max(1, Math.abs(r.re))) r.im = 0;
    out.push(r);
  }
  return out.sort((p, q) => p.re - q.re || p.im - q.im);
}

// ---------------------------------------------------------------- FFT

/** In-place complex DFT for any length (radix-2 when possible, else Bluestein). */
export function dft(re: number[], im: number[], inverse = false): { re: number[]; im: number[] } {
  const n = re.length;
  if (n === 0) return { re: [], im: [] };
  if ((n & (n - 1)) === 0) return radix2(re.slice(), im.slice(), inverse);
  // Bluestein's algorithm
  const sign = inverse ? 1 : -1;
  let m = 1;
  while (m < 2 * n - 1) m <<= 1;
  const wr = new Array(n), wi = new Array(n);
  for (let k = 0; k < n; k++) {
    const ang = (sign * Math.PI * ((k * k) % (2 * n))) / n;
    wr[k] = Math.cos(ang);
    wi[k] = Math.sin(ang);
  }
  const ar = new Array(m).fill(0), ai = new Array(m).fill(0);
  const br = new Array(m).fill(0), bi = new Array(m).fill(0);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k] * wr[k] - im[k] * wi[k];
    ai[k] = re[k] * wi[k] + im[k] * wr[k];
  }
  br[0] = wr[0]; bi[0] = -wi[0];
  for (let k = 1; k < n; k++) {
    br[k] = br[m - k] = wr[k];
    bi[k] = bi[m - k] = -wi[k];
  }
  const A = radix2(ar, ai, false);
  const B = radix2(br, bi, false);
  const pr = A.re.map((v, k) => v * B.re[k] - A.im[k] * B.im[k]);
  const pi = A.re.map((v, k) => v * B.im[k] + A.im[k] * B.re[k]);
  const P = radix2(pr, pi, true);
  const outR = new Array(n), outI = new Array(n);
  for (let k = 0; k < n; k++) {
    const xr = P.re[k] / m, xi = P.im[k] / m;
    outR[k] = xr * wr[k] - xi * wi[k];
    outI[k] = xr * wi[k] + xi * wr[k];
  }
  return { re: outR, im: outI };
}

function radix2(re: number[], im: number[], inverse: boolean): { re: number[]; im: number[] } {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  return { re, im };
}

// ---------------------------------------------------------------- interpolation

/**
 * Cubic spline second derivatives M_i, with Mathcad's end conditions: "natural" (lspline,
 * M = 0 at the ends: the curve runs out straight), "parabolic" (pspline, M_0 = M_1: a parabola
 * at the ends) or "cubic" (cspline, M linear over the first and last two intervals: a cubic).
 */
export function splineSecondDerivs(xs: number[], ys: number[], end: 'natural' | 'parabolic' | 'cubic' = 'natural'): number[] {
  const n = xs.length;
  const M = new Array(n).fill(0);
  if (n < 3) return M;
  if (end === 'cubic' && n < 4) end = 'parabolic';
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  // h_{i-1} M_{i-1} + 2 (h_{i-1} + h_i) M_i + h_i M_{i+1} = 6 (Δy_i/h_i − Δy_{i-1}/h_{i-1}), i = 1 … n−2
  const m = n - 2;
  const lo = new Array(m).fill(0), di = new Array(m).fill(0), up = new Array(m).fill(0), r = new Array(m).fill(0);
  for (let k = 0; k < m; k++) {
    const i = k + 1;
    lo[k] = h[i - 1];
    di[k] = 2 * (h[i - 1] + h[i]);
    up[k] = h[i];
    r[k] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]);
  }
  // the end conditions eliminate M_0 and M_{n−1} from the first and last equations
  if (end === 'parabolic') {
    di[0] += h[0];
    di[m - 1] += h[n - 2];
  } else if (end === 'cubic') {
    // M_0 = ((h0 + h1) M_1 − h0 M_2)/h1
    di[0] += (h[0] * (h[0] + h[1])) / h[1];
    up[0] -= (h[0] * h[0]) / h[1];
    const a = h[n - 2], b = h[n - 3];
    di[m - 1] += (a * (a + b)) / b;
    lo[m - 1] -= (a * a) / b;
  }
  // Thomas algorithm
  for (let k = 1; k < m; k++) {
    const w = lo[k] / di[k - 1];
    di[k] -= w * up[k - 1];
    r[k] -= w * r[k - 1];
  }
  M[m] = r[m - 1] / di[m - 1];
  for (let k = m - 2; k >= 0; k--) M[k + 1] = (r[k] - up[k] * M[k + 2]) / di[k];
  if (end === 'parabolic') {
    M[0] = M[1];
    M[n - 1] = M[n - 2];
  } else if (end === 'cubic') {
    M[0] = ((h[0] + h[1]) * M[1] - h[0] * M[2]) / h[1];
    M[n - 1] = ((h[n - 2] + h[n - 3]) * M[n - 2] - h[n - 2] * M[n - 3]) / h[n - 3];
  }
  return M;
}

export function splineEval(xs: number[], ys: number[], y2: number[], x: number): number {
  const n = xs.length;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const k = (hi + lo) >> 1;
    if (xs[k] > x) hi = k; else lo = k;
  }
  const h = xs[hi] - xs[lo];
  const a = (xs[hi] - x) / h, b = (x - xs[lo]) / h;
  return a * ys[lo] + b * ys[hi] + ((a * a * a - a) * y2[lo] + (b * b * b - b) * y2[hi]) * (h * h) / 6;
}

export function linterp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n < 2) throw new Error('linterp needs at least two points');
  let i = 0;
  if (x <= xs[0]) i = 0;
  else if (x >= xs[n - 1]) i = n - 2;
  else while (i < n - 2 && xs[i + 1] < x) i++;
  const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
  return ys[i] + t * (ys[i + 1] - ys[i]);
}

/** Least-squares polynomial fit, ascending coefficients. */
export function polyfit(xs: number[], ys: number[], degree: number): number[] {
  const n = degree + 1;
  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let k = 0; k < xs.length; k++) {
    const pw = [1];
    for (let j = 1; j < 2 * n; j++) pw[j] = pw[j - 1] * xs[k];
    for (let i = 0; i < n; i++) {
      b[i] += pw[i] * ys[k];
      for (let j = 0; j < n; j++) A[i][j] += pw[i + j];
    }
  }
  return solveLinear(A, b);
}

// ---------------------------------------------------------------- special functions
// (implemented in special.ts; these names are kept for the distribution functions)

export const gammaln = S.lgamma;

/** Regularised lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  return x <= 0 ? 0 : S.gammaPQ(a, x).p;
}

/** Regularised upper incomplete gamma Q(a, x) = 1 − P(a, x), accurate where it is small. */
export function gammaQ(a: number, x: number): number {
  return x <= 0 ? 1 : S.gammaPQ(a, x).q;
}

/** Regularised incomplete beta I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : S.betaInc(x, a, b);
}

export const erf = S.erf;
export const erfc = S.erfc;
export const normInv = S.normInv;

/** Invert a monotone increasing CDF on (lo, hi) by bisection + Brent. */
export function invertCdf(cdf: Fn1, p: number, lo: number, hi: number): number {
  while (cdf(lo) > p) lo = lo < 0 ? lo * 2 : lo - 1;
  while (cdf(hi) < p) hi = hi > 0 ? hi * 2 : hi + 1;
  // to full relative precision: quantiles in a tail are tiny (qchisq(1e−12, 1) = 1.6e−24)
  return brent((x) => cdf(x) - p, lo, hi, 1e-300);
}
