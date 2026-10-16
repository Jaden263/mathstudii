// Special functions on plain numbers: gamma family, Bessel (real order), Airy,
// exponential and trigonometric integrals, Fresnel, elliptic (Carlson), Lambert W,
// zeta and the classical orthogonal polynomials. Algorithms follow DLMF and
// Numerical Recipes 3rd ed. (Steed/Temme for Bessel, Lentz continued fractions,
// Carlson duplication); accuracy is close to double precision except near zeros.

const EPS = Number.EPSILON;
const FPMIN = 2.2250738585072014e-308 / EPS;
const EULER = 0.5772156649015329;
const SQRT_PI = Math.sqrt(Math.PI);
const LN_SQRT_2PI = 0.9189385332046728;

function fail(msg: string): never {
  throw new Error(msg);
}

/** sin(πx) and cos(πx), exact at integers and half-integers. */
export function sinPi(x: number): number {
  const r = x - 2 * Math.round(x / 2); // [-1, 1]
  if (r === 0 || Math.abs(r) === 1) return 0;
  if (r === 0.5) return 1;
  if (r === -0.5) return -1;
  return Math.sin(Math.PI * r);
}

export function cosPi(x: number): number {
  return sinPi(x + 0.5);
}

const isInt = (x: number) => Number.isInteger(x);

// ---------------------------------------------------------------- gamma family

// Taylor coefficients of 1/Γ(z) = Σ c_k z^k, k = 1..26 (DLMF 5.7.1, A&S 6.1.34).
const RGAMMA = [
  1, 0.5772156649015329, -0.6558780715202539, -0.04200263503409524, 0.16653861138229149,
  -0.04219773455554434, -0.009621971527876974, 0.007218943246663099, -0.0011651675918590651,
  -0.00021524167411495098, 0.00012805028238811619, -2.013485478078824e-5, -1.2504934821426707e-6,
  1.133027231981696e-6, -2.056338416977607e-7, 6.116095104481416e-9, 5.002007644469223e-9,
  -1.1812745704870201e-9, 1.0434267116911005e-10, 7.782263439905071e-12, -3.6968056186422057e-12,
  5.100370287454476e-13, -2.0583260535665068e-14, -5.348122539423018e-15, 1.2267786282382608e-15,
  -1.1812593016974588e-16,
];

/** 1/Γ(1 + x) for |x| ≤ 1/2 from the Taylor series of 1/Γ. */
function rgamma1p(x: number): number {
  return 1 + rgamma1pm1(x);
}

/** 1/Γ(1 + x) − 1 without cancellation near x = 0. */
function rgamma1pm1(x: number): number {
  let s = 0;
  for (let k = RGAMMA.length - 1; k >= 1; k--) s = s * x + RGAMMA[k];
  return s * x;
}

// Stirling series coefficients B_2k / (2k (2k-1)) for ln Γ (DLMF 5.11.1).
const STIRLING = [1 / 12, -1 / 360, 1 / 1260, -1 / 1680, 1 / 1188, -691 / 360360, 1 / 156, -3617 / 122400];

/** ln Γ(x) − [(x − ½) ln x − x + ½ ln 2π], x ≥ 10. */
function stirlingCorrection(x: number): number {
  const r = 1 / (x * x);
  let s = 0;
  for (let k = STIRLING.length - 1; k >= 0; k--) s = s * r + STIRLING[k];
  return s / x;
}

/** Γ(x) for real x (poles at 0, −1, −2 … are errors). */
export function gamma(x: number): number {
  if (x <= 0 && isInt(x)) fail(`Γ(${x}) is infinite (pole)`);
  if (x < 0.5) return Math.PI / (sinPi(x) * gamma(1 - x));
  if (x > 171.7) return Infinity;
  if (x >= 10) {
    // Stirling, with x^(x−½) e^−x split so that it does not overflow early
    const t = Math.pow(x, 0.5 * (x - 0.5));
    return t * (t * Math.exp(-x)) * Math.sqrt(2 * Math.PI) * Math.exp(stirlingCorrection(x));
  }
  // shift into [0.5, 1.5] and use 1/Γ(1 + t)
  let p = 1;
  let y = x;
  while (y > 1.5) { y -= 1; p *= y; }
  return p / rgamma1p(y - 1);
}

/** ln |Γ(x)|. */
export function lgamma(x: number): number {
  if (x <= 0 && isInt(x)) return Infinity;
  if (x < 0.5) return Math.log(Math.PI / Math.abs(sinPi(x))) - lgamma(1 - x);
  // log1p keeps full relative accuracy near the roots at 1 and 2
  if (x < 1.5) return -Math.log1p(rgamma1pm1(x - 1));
  if (x < 2.5) return Math.log1p(x - 2) - Math.log1p(rgamma1pm1(x - 2));
  if (x < 10) return Math.log(gamma(x));
  return (x - 0.5) * Math.log(x) - x + LN_SQRT_2PI + stirlingCorrection(x);
}

/** Beta function B(a, b) = Γ(a) Γ(b) / Γ(a + b). */
export function beta(a: number, b: number): number {
  if (a > 0 && b > 0 && a + b < 170) return (gamma(a) * gamma(b)) / gamma(a + b);
  if (a > 0 && b > 0) return Math.exp(lgamma(a) + lgamma(b) - lgamma(a + b));
  // negative arguments: sign from the gamma values; Γ(a + b) at a pole makes B vanish
  if (a + b <= 0 && isInt(a + b) && !(a <= 0 && isInt(a)) && !(b <= 0 && isInt(b))) return 0;
  return (gamma(a) * gamma(b)) / gamma(a + b);
}

/** ln(1 + t) − t without cancellation for small t. */
function log1pmx(t: number): number {
  if (Math.abs(t) > 0.25) return Math.log1p(t) - t;
  // −t²/2 + t³/3 − …
  let term = t, s = 0;
  for (let k = 2; k < 200; k++) {
    term *= -t;
    const d = term / k;
    s += d;
    if (Math.abs(d) < EPS * Math.abs(s)) break;
  }
  return s;
}

/** x^a e^−x, with e^−x on its own when that cannot overflow (keeps erfc(26) = e^−676 … exact). */
function powExp(a: number, x: number, lnScale = 0): number {
  const l = a * Math.log(x) - lnScale;
  return Math.abs(l) < 700 && x < 700 ? Math.exp(l) * Math.exp(-x) : Math.exp(l - x);
}

/** x^a e^−x / Γ(a), the prefactor of the incomplete gamma functions. */
function gammaPrefix(a: number, x: number): number {
  if (a < 10) return powExp(a, x, lgamma(a));
  // a ln(x/a) + a − x = a·(ln(1+t) − t): the two large terms cancel near x = a
  const t = (x - a) / a;
  const main = Math.abs(t) < 0.25 ? a * log1pmx(t) : a * Math.log(x / a) + (a - x);
  return Math.exp(main + 0.5 * Math.log(a) - LN_SQRT_2PI - stirlingCorrection(a));
}

/** Legendre's continued fraction h with Γ(a, x) = x^a e^−x h, any real a, x > 0 (DLMF 8.9.2). */
function upperGammaCF(a: number, x: number): number {
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 100000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) return h;
  }
  fail('incomplete gamma: continued fraction did not converge');
}

/** Regularised incomplete gamma P(a, x) and Q(a, x) = 1 − P, each accurate where it is small. */
export function gammaPQ(a: number, x: number): { p: number; q: number } {
  if (!(a > 0)) fail('incomplete gamma: a must be positive');
  if (x < 0) fail('incomplete gamma: x must be ≥ 0');
  if (x === 0) return { p: 0, q: 1 };
  if (x === Infinity) return { p: 1, q: 0 };
  const pre = gammaPrefix(a, x);
  if (x < a + 1) {
    // series (DLMF 8.11.4 with 8.7.1)
    let term = 1 / a, sum = term;
    for (let n = 1; n < 100000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    const p = sum * pre;
    return { p, q: 1 - p };
  }
  const q = pre * upperGammaCF(a, x);
  return { p: 1 - q, q };
}

/** Upper incomplete gamma Γ(a, x) = ∫ₓ^∞ t^(a−1) e^−t dt (Mathcad gamma(a, x)), any real a, x > 0. */
export function gammaUpper(a: number, x: number): number {
  if (x < 0) fail('Γ(a, x) needs x ≥ 0');
  if (x === 0) {
    if (a <= 0) fail('Γ(a, 0) is infinite for a ≤ 0');
    return gamma(a);
  }
  // the continued fraction needs no Γ(a) and works for negative a too
  if (x >= Math.max(1.5, a + 1)) return powExp(a, x) * upperGammaCF(a, x);
  if (a > 0) {
    const pq = gammaPQ(a, x);
    return a < 170 ? pq.q * gamma(a) : Math.exp(Math.log(pq.q) + lgamma(a));
  }
  // a ≤ 0, small x: recur down from a + n ∈ (0, 1], or from Γ(0, x) = E1(x) (DLMF 8.8.2)
  let s: number, g: number;
  if (isInt(a)) { s = 0; g = expintE1(x); }
  else { s = a - Math.floor(a); g = gammaUpper(s, x); }
  const lx = Math.log(x);
  while (s > a + 0.5) {
    s -= 1;
    g = (g - Math.exp(s * lx - x)) / s;
  }
  return g;
}

/** Lower incomplete gamma γ(a, x) = ∫₀ˣ t^(a−1) e^−t dt, a > 0. */
export function gammaLower(a: number, x: number): number {
  if (!(a > 0)) fail('γ(a, x) needs a > 0');
  const pq = gammaPQ(a, x);
  return a < 170 ? pq.p * gamma(a) : Math.exp(Math.log(pq.p) + lgamma(a));
}

/** Regularised incomplete beta I_x(a, b) (DLMF 8.17.22 continued fraction). */
export function betaInc(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0)) fail('incomplete beta: a and b must be positive');
  if (x < 0 || x > 1) fail('incomplete beta: x must lie in [0, 1]');
  if (x === 0) return 0;
  if (x === 1) return 1;
  const lnBeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const cf = (x: number, a: number, b: number) => {
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 100000; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  };
  const front = (x: number, a: number, b: number) => Math.exp(a * Math.log(x) + b * Math.log1p(-x) - lnBeta);
  return x < (a + 1) / (a + b + 2)
    ? (front(x, a, b) * cf(x, a, b)) / a
    : 1 - (front(x, a, b) * cf(1 - x, b, a)) / b;
}

/** Digamma ψ(x) = Γ′(x)/Γ(x). */
export function digamma(x: number): number {
  if (x <= 0 && isInt(x)) fail(`ψ(${x}) is infinite (pole)`);
  if (x < 0) return digamma(1 - x) - Math.PI * cosPi(x) / sinPi(x);
  let s = 0;
  while (x < 10) { s -= 1 / x; x += 1; }
  // asymptotic series (DLMF 5.15.8)
  const r = 1 / (x * x);
  const B = [1 / 12, -1 / 120, 1 / 252, -1 / 240, 1 / 132, -691 / 32760, 1 / 12];
  let t = 0;
  for (let k = B.length - 1; k >= 0; k--) t = t * r + B[k];
  return s + Math.log(x) - 0.5 / x - t * r;
}

// Bernoulli numbers B_2 … B_20 for Euler–Maclaurin summation.
const BERNOULLI = [1 / 6, -1 / 30, 1 / 42, -1 / 30, 5 / 66, -691 / 2730, 7 / 6, -3617 / 510, 43867 / 798, -174611 / 330];

/** Riemann zeta ζ(s) for real s: Euler–Maclaurin for s ≥ 0, the functional equation below. */
export function zeta(s: number): number {
  if (s === 1) return Infinity;
  if (s < 0) {
    // ζ(s) = 2^s π^(s−1) sin(πs/2) Γ(1−s) ζ(1−s)  (DLMF 25.4.1)
    const sn = sinPi(s / 2);
    if (sn === 0) return 0;
    const lg = s * Math.LN2 + (s - 1) * Math.log(Math.PI) + lgamma(1 - s);
    return sn * Math.exp(lg) * zeta(1 - s);
  }
  if (s > 60) return 1 + Math.pow(2, -s) + Math.pow(3, -s);
  const N = 12;
  let sum = 0;
  for (let k = 1; k < N; k++) sum += Math.pow(k, -s);
  const Ns = Math.pow(N, -s);
  sum += Ns * (0.5 + N / (s - 1));
  // Σ B_2j/(2j)! · s(s+1)…(s+2j−2) · N^(−s−2j+1)
  let poch = s; // s(s+1)…(s+2j−2)
  let fact = 2; // (2j)!
  let pw = Ns / N; // N^(−s−2j+1) for j = 1
  for (let j = 1; j <= BERNOULLI.length; j++) {
    const term = (BERNOULLI[j - 1] / fact) * poch * pw;
    sum += term;
    if (Math.abs(term) < EPS * Math.abs(sum)) break;
    poch *= (s + 2 * j - 1) * (s + 2 * j);
    fact *= (2 * j + 1) * (2 * j + 2);
    pw /= N * N;
  }
  return sum;
}

// ---------------------------------------------------------------- error function

/** erf(x) for real x (series near 0, incomplete gamma elsewhere). */
export function erf(x: number): number {
  const ax = Math.abs(x);
  if (ax < 0.5) {
    // 2/√π Σ (−1)^n x^(2n+1) / (n! (2n+1))
    let term = x, sum = x;
    const x2 = x * x;
    for (let n = 1; n < 60; n++) {
      term *= -x2 / n;
      const d = term / (2 * n + 1);
      sum += d;
      if (Math.abs(d) < EPS * Math.abs(sum)) break;
    }
    return (2 / SQRT_PI) * sum;
  }
  const p = gammaPQ(0.5, x * x).p;
  return x < 0 ? -p : p;
}

/** e^(−x²) without the rounding of x² (x split into a 26-bit head and a tail). */
function expMinusSquare(x: number): number {
  const hi = Math.round(x * 4096) / 4096;
  const lo = x - hi;
  return Math.exp(-hi * hi) * Math.exp(-lo * (2 * hi + lo));
}

/** erfc(x) = 1 − erf(x), accurate for large x. */
export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x * x < 1.5) return 1 - erf(x);
  // Q(½, x²) = x e^(−x²)/√π · h
  return (x / SQRT_PI) * expMinusSquare(x) * upperGammaCF(0.5, x * x);
}

/** Inverse error function: erf(erfinv(y)) = y, −1 < y < 1. */
export function erfinv(y: number): number {
  if (y <= -1 || y >= 1) {
    if (y === 1) return Infinity;
    if (y === -1) return -Infinity;
    fail('erfinv(y) needs −1 < y < 1');
  }
  if (y < 0) return -erfinv(-y);
  if (y > 0.5) return erfcinv(1 - y); // 1 − y is exact here
  let x = Math.abs(y) < 1e-3 ? (SQRT_PI / 2) * y * (1 + (Math.PI / 12) * y * y) : normInvApprox((1 + y) / 2) / Math.SQRT2;
  for (let i = 0; i < 4; i++) {
    const f = erf(x) - y;
    const d = f / ((2 / SQRT_PI) * Math.exp(-x * x));
    x -= d / (1 + x * d); // Halley
    if (Math.abs(d) <= EPS * Math.abs(x)) break;
  }
  return x;
}

/** Inverse complementary error function: erfc(erfcinv(z)) = z, 0 < z < 2. */
export function erfcinv(z: number): number {
  if (z <= 0 || z >= 2) {
    if (z === 0) return Infinity;
    if (z === 2) return -Infinity;
    fail('erfcinv(z) needs 0 < z < 2');
  }
  if (z > 1) return -erfcinv(2 - z);
  if (z > 0.5) return erfinv(1 - z);
  let x = -normInvApprox(z / 2) / Math.SQRT2;
  for (let i = 0; i < 6; i++) {
    const f = erfc(x) - z;
    const d = f / (-(2 / SQRT_PI) * Math.exp(-x * x));
    x -= d / (1 + x * d);
    if (Math.abs(d) <= EPS * Math.abs(x)) break;
  }
  return x;
}

/** Acklam's rational approximation of the standard normal quantile (rel. error ≈ 1e-9). */
function normInvApprox(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Standard normal quantile Φ⁻¹(p), refined to full precision. */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Φ⁻¹(p) = −√2 erfcinv(2p)
  return -Math.SQRT2 * erfcinv(2 * p);
}

// ---------------------------------------------------------------- Bessel functions

/** 1/Γ(1−μ), 1/Γ(1+μ) and Temme's Γ₁, Γ₂ for |μ| ≤ 1/2. */
function temme(mu: number) {
  const gampl = rgamma1p(mu);
  const gammi = rgamma1p(-mu);
  // Γ₁ = (1/Γ(1−μ) − 1/Γ(1+μ)) / 2μ = −(c₂ + c₄μ² + …),  Γ₂ = c₁ + c₃μ² + …
  let g1 = 0, g2 = 0;
  const m2 = mu * mu;
  for (let k = RGAMMA.length - 1; k >= 0; k--) {
    if (k % 2 === 1) g1 = g1 * m2 + RGAMMA[k];
    else g2 = g2 * m2 + RGAMMA[k];
  }
  return { gam1: -g1, gam2: g2, gampl, gammi };
}

const BIG = 1e250;

/** J_ν, Y_ν and their derivatives for ν ≥ 0, x > 0 (Steed's method with Temme's series, NR §6.6). */
function besseljy(nu: number, x: number): { j: number; y: number; jp: number; yp: number } {
  if (x >= 25) {
    const r = besselAsymptotic(nu, x);
    if (r) return r;
  }
  const MAXIT = 2e6;
  const XMIN = 2;
  const nl = x < XMIN ? Math.floor(nu + 0.5) : Math.max(0, Math.floor(nu - x + 1.5));
  const xmu = nu - nl, xmu2 = xmu * xmu;
  const xi = 1 / x, xi2 = 2 * xi, w = xi2 / Math.PI;
  // CF1 for J'_ν/J_ν
  let isign = 1;
  let h = nu * xi;
  if (h < FPMIN) h = FPMIN;
  let b = xi2 * nu, d = 0, c = h;
  let i = 0;
  for (; i < MAXIT; i++) {
    b += xi2;
    d = b - d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b - 1 / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = c * d;
    h = del * h;
    if (d < 0) isign = -isign;
    if (Math.abs(del - 1) <= EPS) break;
  }
  if (i >= MAXIT) fail('Bessel J/Y: x too large');
  let rjl = isign * FPMIN, rjpl = h * rjl;
  let rjl1 = rjl, rjp1 = rjpl;
  let fact = nu * xi;
  for (let l = nl - 1; l >= 0; l--) {
    const rjtemp = fact * rjl + rjpl;
    fact -= xi;
    rjpl = fact * rjtemp - rjl;
    rjl = rjtemp;
    if (Math.abs(rjl) > BIG) { rjl /= BIG; rjpl /= BIG; rjl1 /= BIG; rjp1 /= BIG; }
  }
  if (rjl === 0) rjl = EPS;
  const f = rjpl / rjl;
  let rjmu: number, rymu: number, rymup: number, ry1: number;
  if (x < XMIN) {
    const x2 = 0.5 * x, pimu = Math.PI * xmu;
    const fct = Math.abs(pimu) < EPS ? 1 : pimu / Math.sin(pimu);
    let dd = -Math.log(x2);
    let e = xmu * dd;
    const fact2 = Math.abs(e) < EPS ? 1 : Math.sinh(e) / e;
    const { gam1, gam2, gampl, gammi } = temme(xmu);
    let ff = (2 / Math.PI) * fct * (gam1 * Math.cosh(e) + gam2 * fact2 * dd);
    e = Math.exp(e);
    let p = e / (gampl * Math.PI);
    let q = 1 / (e * Math.PI * gammi);
    const pimu2 = 0.5 * pimu;
    const fact3 = Math.abs(pimu2) < EPS ? 1 : Math.sin(pimu2) / pimu2;
    const r = Math.PI * pimu2 * fact3 * fact3;
    let cc = 1;
    dd = -x2 * x2;
    let sum = ff + r * q, sum1 = p;
    for (i = 1; i <= MAXIT; i++) {
      ff = (i * ff + p + q) / (i * i - xmu2);
      cc *= dd / i;
      p /= i - xmu;
      q /= i + xmu;
      const del = cc * (ff + r * q);
      sum += del;
      const del1 = cc * p - i * del;
      sum1 += del1;
      if (Math.abs(del) < (1 + Math.abs(sum)) * EPS) break;
    }
    rymu = -sum;
    ry1 = -sum1 * xi2;
    rymup = xmu * xi * rymu - ry1;
    rjmu = w / (rymup - f * rymu);
  } else {
    // CF2 (Steed) for p + iq
    let a = 0.25 - xmu2, p = -0.5 * xi, q = 1;
    const br = 2 * x;
    let bi = 2;
    let fct = (a * xi) / (p * p + q * q);
    let cr = br + q * fct, ci = bi + p * fct;
    let den = br * br + bi * bi;
    let dr = br / den, di = -bi / den;
    let dlr = cr * dr - ci * di, dli = cr * di + ci * dr;
    let temp = p * dlr - q * dli;
    q = p * dli + q * dlr;
    p = temp;
    for (i = 1; i < MAXIT; i++) {
      a += 2 * i;
      bi += 2;
      dr = a * dr + br;
      di = a * di + bi;
      if (Math.abs(dr) + Math.abs(di) < FPMIN) dr = FPMIN;
      fct = a / (cr * cr + ci * ci);
      cr = br + cr * fct;
      ci = bi - ci * fct;
      if (Math.abs(cr) + Math.abs(ci) < FPMIN) cr = FPMIN;
      den = dr * dr + di * di;
      dr /= den;
      di /= -den;
      dlr = cr * dr - ci * di;
      dli = cr * di + ci * dr;
      temp = p * dlr - q * dli;
      q = p * dli + q * dlr;
      p = temp;
      if (Math.abs(dlr - 1) + Math.abs(dli) <= EPS) break;
    }
    if (i >= MAXIT) fail('Bessel J/Y: CF2 did not converge');
    const gam = (p - f) / q;
    rjmu = Math.sqrt(w / ((p - f) * gam + q));
    if (rjl < 0) rjmu = -rjmu;
    rymu = rjmu * gam;
    rymup = rymu * (p + q / gam);
    ry1 = xmu * xi * rymu - rymup;
  }
  const scale = rjmu / rjl;
  const j = rjl1 * scale, jp = rjp1 * scale;
  for (i = 1; i <= nl; i++) {
    const rytemp = (xmu + i) * xi2 * ry1 - rymu;
    rymu = ry1;
    ry1 = rytemp;
  }
  return { j, y: rymu, jp, yp: nu * xi * rymu - ry1 };
}

/**
 * Hankel's asymptotic expansion (DLMF 10.17.3), or null when its terms stop
 * shrinking before full precision (x too small for this order).
 */
function besselAsymptotic(nu: number, x: number): { j: number; y: number; jp: number; yp: number } | null {
  const mu = 4 * nu * nu;
  let P = 0, Q = 0, term = 1, last = Infinity, biggest = 0;
  let falling = false, ok = false;
  for (let k = 0; k < 500; k++) {
    if (k > 0) term *= (mu - (2 * k - 1) ** 2) / (k * 8 * x);
    const at = Math.abs(term);
    // terms may grow at first (large ν) but must not grow again once falling
    if (at > last && falling) break;
    if (k > 0 && at < last) falling = true;
    last = at;
    biggest = Math.max(biggest, at);
    if (k % 4 === 0) P += term;
    else if (k % 4 === 1) Q += term;
    else if (k % 4 === 2) P -= term;
    else Q -= term;
    if (at < 0.5 * EPS * Math.max(Math.abs(P), Math.abs(Q))) { ok = true; break; }
  }
  // the cancellation of big terms costs biggest·ε; Steed's method costs about x·ε
  if (!ok || biggest > Math.max(4, x / 25) * Math.max(Math.abs(P), Math.abs(Q))) return null;
  // cos(x − c) from cos x and sin x keeps the phase exact for large x
  const c = (nu / 2 + 0.25) * Math.PI;
  const cx = Math.cos(x), sx = Math.sin(x), cc = Math.cos(c), sc = Math.sin(c);
  const cosChi = cx * cc + sx * sc, sinChi = sx * cc - cx * sc;
  const s = Math.sqrt(2 / (Math.PI * x));
  return { j: s * (P * cosChi - Q * sinChi), y: s * (P * sinChi + Q * cosChi), jp: NaN, yp: NaN };
}

/** I_ν, K_ν for ν ≥ 0, x > 0 (NR §6.6, Temme's series and Steed's CF2). */
function besselik(nu: number, x: number): { i: number; k: number } {
  const MAXIT = 2e6;
  const XMIN = 2;
  const nl = Math.floor(nu + 0.5);
  const xmu = nu - nl, xmu2 = xmu * xmu;
  const xi = 1 / x, xi2 = 2 * xi;
  let h = nu * xi;
  if (h < FPMIN) h = FPMIN;
  let b = xi2 * nu, d = 0, c = h;
  let i = 0;
  for (; i < MAXIT; i++) {
    b += xi2;
    d = 1 / (b + d);
    c = b + 1 / c;
    const del = c * d;
    h = del * h;
    if (Math.abs(del - 1) <= EPS) break;
  }
  if (i >= MAXIT) fail('Bessel I/K: x too large');
  let ril = FPMIN, ripl = h * ril;
  let ril1 = ril;
  let fact = nu * xi;
  for (let l = nl - 1; l >= 0; l--) {
    const ritemp = fact * ril + ripl;
    fact -= xi;
    ripl = fact * ritemp + ril;
    ril = ritemp;
    if (Math.abs(ril) > BIG) { ril /= BIG; ripl /= BIG; ril1 /= BIG; }
  }
  const f = ripl / ril;
  let rkmu: number, rk1: number;
  if (x < XMIN) {
    const x2 = 0.5 * x, pimu = Math.PI * xmu;
    const fct = Math.abs(pimu) < EPS ? 1 : pimu / Math.sin(pimu);
    let dd = -Math.log(x2);
    let e = xmu * dd;
    const fact2 = Math.abs(e) < EPS ? 1 : Math.sinh(e) / e;
    const { gam1, gam2, gampl, gammi } = temme(xmu);
    let ff = fct * (gam1 * Math.cosh(e) + gam2 * fact2 * dd);
    let sum = ff;
    e = Math.exp(e);
    let p = (0.5 * e) / gampl;
    let q = 0.5 / (e * gammi);
    let cc = 1;
    dd = x2 * x2;
    let sum1 = p;
    for (i = 1; i <= MAXIT; i++) {
      ff = (i * ff + p + q) / (i * i - xmu2);
      cc *= dd / i;
      p /= i - xmu;
      q /= i + xmu;
      const del = cc * ff;
      sum += del;
      const del1 = cc * (p - i * ff);
      sum1 += del1;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    rkmu = sum;
    rk1 = sum1 * xi2;
  } else {
    let bb = 2 * (1 + x);
    let dd = 1 / bb;
    let hh = dd, delh = dd;
    let q1 = 0, q2 = 1;
    const a1 = 0.25 - xmu2;
    let q = a1, cc = a1;
    let a = -a1;
    let s = 1 + q * delh;
    for (i = 1; i < MAXIT; i++) {
      a -= 2 * i;
      cc = (-a * cc) / (i + 1);
      const qnew = (q1 - bb * q2) / a;
      q1 = q2;
      q2 = qnew;
      q += cc * qnew;
      bb += 2;
      dd = 1 / (bb + a * dd);
      delh = (bb * dd - 1) * delh;
      hh += delh;
      const dels = q * delh;
      s += dels;
      if (Math.abs(dels / s) <= EPS) break;
    }
    if (i >= MAXIT) fail('Bessel I/K: CF2 did not converge');
    hh = a1 * hh;
    rkmu = (Math.sqrt(Math.PI / (2 * x)) * Math.exp(-x)) / s;
    rk1 = rkmu * (xmu + x + 0.5 - hh) * xi;
  }
  const rkmup = xmu * xi * rkmu - rk1;
  const rimu = xi / (f * rkmu - rkmup);
  const iv = (rimu * ril1) / ril;
  for (i = 1; i <= nl; i++) {
    const rktemp = (xmu + i) * xi2 * rk1 + rkmu;
    rkmu = rk1;
    rk1 = rktemp;
  }
  return { i: iv, k: rkmu };
}

/** Bessel function of the first kind J_ν(x) for real order ν. */
export function besselJ(nu: number, x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) {
    if (!isInt(nu)) fail('Jn(ν, x) is complex for x < 0 and non-integer ν');
    return (nu % 2 === 0 ? 1 : -1) * besselJ(nu, -x);
  }
  if (x === 0) {
    if (nu === 0) return 1;
    if (nu > 0 || isInt(nu)) return 0;
    fail('Jn(ν, 0) is infinite for negative non-integer ν');
  }
  if (nu < 0) {
    if (isInt(nu)) return (nu % 2 === 0 ? 1 : -1) * besseljy(-nu, x).j;
    const r = besseljy(-nu, x);
    return cosPi(-nu) * r.j - sinPi(-nu) * r.y; // DLMF 10.4.7
  }
  return besseljy(nu, x).j;
}

/** Bessel function of the second kind Y_ν(x), x > 0. */
export function besselY(nu: number, x: number): number {
  if (x <= 0) fail('Yn(ν, x) needs x > 0');
  if (x === Infinity) return 0;
  if (nu < 0) {
    if (isInt(nu)) return (nu % 2 === 0 ? 1 : -1) * besseljy(-nu, x).y;
    const r = besseljy(-nu, x);
    return sinPi(-nu) * r.j + cosPi(-nu) * r.y; // DLMF 10.4.8
  }
  return besseljy(nu, x).y;
}

/** Modified Bessel function of the first kind I_ν(x). */
export function besselI(nu: number, x: number): number {
  if (x === Infinity) return Infinity;
  if (x < 0) {
    if (!isInt(nu)) fail('In(ν, x) is complex for x < 0 and non-integer ν');
    return (nu % 2 === 0 ? 1 : -1) * besselI(nu, -x);
  }
  if (x === 0) {
    if (nu === 0) return 1;
    if (nu > 0 || isInt(nu)) return 0;
    fail('In(ν, 0) is infinite for negative non-integer ν');
  }
  if (nu < 0) {
    if (isInt(nu)) return besselI(-nu, x);
    return besselI(-nu, x) + (2 / Math.PI) * sinPi(-nu) * besselK(-nu, x); // DLMF 10.27.2
  }
  // the Wronskian in besselik loses digits for small x; the power series has none to lose
  if (x <= 2) return besselISeries(nu, x);
  return besselik(nu, x).i;
}

/** I_ν(x) = (x/2)^ν Σ (x²/4)^k / (k! Γ(ν+k+1)), ν ≥ 0 (DLMF 10.25.2). */
function besselISeries(nu: number, x: number): number {
  const front = nu < 170 ? Math.pow(x / 2, nu) / gamma(nu + 1) : Math.exp(nu * Math.log(x / 2) - lgamma(nu + 1));
  if (front === 0) return 0;
  const q = (x * x) / 4;
  let term = 1, sum = 1;
  for (let k = 1; k < 500; k++) {
    term *= q / (k * (nu + k));
    sum += term;
    if (term < EPS * sum) break;
  }
  return front * sum;
}

/** Modified Bessel function of the second kind K_ν(x), x > 0. */
export function besselK(nu: number, x: number): number {
  if (x <= 0) fail('Kn(ν, x) needs x > 0');
  if (x === Infinity) return 0;
  return besselik(Math.abs(nu), x).k;
}

/** Spherical Bessel j_n(x) = √(π/2x) J_{n+½}(x). */
export function sphericalJ(n: number, x: number): number {
  if (!isInt(n)) fail('js(n, x): n must be an integer');
  if (x === 0) {
    if (n === 0) return 1;
    if (n > 0) return 0;
    fail('js(n, 0) is infinite for n < 0');
  }
  if (x < 0) return (n % 2 === 0 ? 1 : -1) * sphericalJ(n, -x);
  return Math.sqrt(Math.PI / (2 * x)) * besselJ(n + 0.5, x);
}

/** Spherical Bessel y_n(x) = √(π/2x) Y_{n+½}(x). */
export function sphericalY(n: number, x: number): number {
  if (!isInt(n)) fail('ys(n, x): n must be an integer');
  if (x === 0) fail('ys(n, 0) is infinite');
  if (x < 0) return (n % 2 === 0 ? -1 : 1) * sphericalY(n, -x);
  return Math.sqrt(Math.PI / (2 * x)) * besselY(n + 0.5, x);
}

/** Airy functions Ai, Bi and their derivatives (DLMF 9.6 via Bessel functions of order 1/3, 2/3). */
export function airy(x: number): { ai: number; bi: number; aip: number; bip: number } {
  const R3 = 1 / Math.sqrt(3);
  if (x === 0) {
    const ai = 0.3550280538878172, aip = -0.2588194037928068;
    return { ai, bi: ai / R3, aip, bip: -aip / R3 };
  }
  const ax = Math.abs(x), rx = Math.sqrt(ax);
  const z = (2 / 3) * ax * rx;
  if (x > 0) {
    if (z > 700) return { ai: 0, bi: Infinity, aip: -0, bip: Infinity };
    const a = besselik(1 / 3, z), b = besselik(2 / 3, z);
    return {
      ai: (rx * R3 * a.k) / Math.PI,
      bi: rx * (a.k / Math.PI + 2 * R3 * a.i),
      aip: (-x * R3 * b.k) / Math.PI,
      bip: x * (b.k / Math.PI + 2 * R3 * b.i),
    };
  }
  const a = besseljy(1 / 3, z), b = besseljy(2 / 3, z);
  return {
    ai: 0.5 * rx * (a.j - R3 * a.y),
    bi: -0.5 * rx * (a.y + R3 * a.j),
    aip: 0.5 * ax * (R3 * b.y + b.j),
    bip: 0.5 * ax * (R3 * b.j - b.y),
  };
}

// ---------------------------------------------------------------- exponential & trigonometric integrals

/** Exponential integral E_n(x) = ∫₁^∞ e^(−xt)/tⁿ dt, integer n ≥ 0, x ≥ 0 (NR §6.3). */
export function expintEn(n: number, x: number): number {
  if (!isInt(n) || n < 0) fail('En(n, x): n must be an integer ≥ 0');
  if (x < 0) fail('En(n, x) needs x ≥ 0');
  if (x === 0) {
    if (n <= 1) return Infinity;
    return 1 / (n - 1);
  }
  if (x === Infinity) return 0;
  if (n === 0) return Math.exp(-x) / x;
  const nm1 = n - 1;
  if (x > 1) {
    let b = x + n, c = 1 / FPMIN, d = 1 / b, h = d;
    for (let i = 1; i <= 100000; i++) {
      const a = -i * (nm1 + i);
      b += 2;
      d = 1 / (a * d + b);
      c = b + a / c;
      const del = c * d;
      h *= del;
      if (Math.abs(del - 1) <= EPS) return h * Math.exp(-x);
    }
    fail('En: continued fraction did not converge');
  }
  let ans = nm1 !== 0 ? 1 / nm1 : -Math.log(x) - EULER;
  let fact = 1;
  for (let i = 1; i <= 1000; i++) {
    fact *= -x / i;
    let del: number;
    if (i !== nm1) del = -fact / (i - nm1);
    else {
      let psi = -EULER;
      for (let ii = 1; ii <= nm1; ii++) psi += 1 / ii;
      del = fact * (-Math.log(x) + psi);
    }
    ans += del;
    if (Math.abs(del) < Math.abs(ans) * EPS) return ans;
  }
  fail('En: series did not converge');
}

/** E₁(x) = ∫ₓ^∞ e^−t/t dt, x > 0. */
export function expintE1(x: number): number {
  if (x <= 0) fail(x === 0 ? 'E1(0) is infinite' : 'E1(x) is complex for x < 0 (use −Ei(−x))');
  return expintEn(1, x);
}

/** Exponential integral Ei(x) = −PV∫₋ₓ^∞ e^−t/t dt, x ≠ 0. */
export function expintEi(x: number): number {
  if (x === 0) fail('Ei(0) is infinite');
  if (x < 0) return -expintE1(-x);
  if (x === Infinity) return Infinity;
  if (x < FPMIN) return Math.log(x) + EULER;
  if (x <= 40) {
    let sum = 0, fact = 1;
    for (let k = 1; k <= 1000; k++) {
      fact *= x / k;
      const term = fact / k;
      sum += term;
      if (term < EPS * sum) break;
    }
    return sum + Math.log(x) + EULER;
  }
  // asymptotic series, truncated at the smallest term
  let sum = 0, term = 1;
  for (let k = 1; k <= 1000; k++) {
    const prev = term;
    term *= k / x;
    if (term < EPS) break;
    if (term < prev) sum += term;
    else { sum -= prev; break; }
  }
  return (Math.exp(x) * (1 + sum)) / x;
}

/** Sine and cosine integrals Si(x) = ∫₀ˣ sin t/t dt, Ci(x) = γ + ln x + ∫₀ˣ (cos t − 1)/t dt (NR §6.9). */
export function sici(x: number): { si: number; ci: number } {
  const t = Math.abs(x);
  if (t === 0) return { si: 0, ci: -Infinity };
  if (t === Infinity) return { si: Math.sign(x) * Math.PI / 2, ci: x > 0 ? 0 : NaN };
  let si: number, ci: number;
  if (t > 2) {
    // complex continued fraction for E1(it)
    let br = 1, bi = t;
    let cr = 1 / FPMIN, cim = 0;
    let den = br * br + bi * bi;
    let dr = br / den, di = -bi / den;
    let hr = dr, hi = di;
    let i = 1;
    for (; i < 100000; i++) {
      const a = -i * i;
      br += 2;
      // d = 1/(a d + b)
      let xr = a * dr + br, xi = a * di + bi;
      den = xr * xr + xi * xi;
      dr = xr / den; di = -xi / den;
      // c = b + a/c
      den = cr * cr + cim * cim;
      xr = br + (a * cr) / den; xi = bi - (a * cim) / den;
      cr = xr; cim = xi;
      // del = c d; h *= del
      const delr = cr * dr - cim * di, deli = cr * di + cim * dr;
      const nhr = hr * delr - hi * deli, nhi = hr * deli + hi * delr;
      hr = nhr; hi = nhi;
      if (Math.abs(delr - 1) + Math.abs(deli) <= EPS) break;
    }
    if (i >= 100000) fail('Si/Ci: continued fraction did not converge');
    // h = (cos t − i sin t) h;  cs = −conj(h) + iπ/2
    const co = Math.cos(t), sn = Math.sin(t);
    const r = co * hr + sn * hi, im = co * hi - sn * hr;
    ci = -r;
    si = Math.PI / 2 + im;
  } else {
    let sum = 0, sums = 0, sumc = 0, sign = 1, fact = 1, odd = true;
    for (let k = 1; k <= 1000; k++) {
      fact *= t / k;
      const term = fact / k;
      sum += sign * term;
      const err = term / Math.abs(sum);
      if (odd) { sign = -sign; sums = sum; sum = sumc; }
      else { sumc = sum; sum = sums; }
      if (err < EPS) break;
      odd = !odd;
    }
    si = sums;
    ci = sumc + Math.log(t) + EULER;
  }
  return { si: x < 0 ? -si : si, ci: x < 0 ? NaN : ci };
}

/** Fresnel integrals S(x) = ∫₀ˣ sin(πt²/2) dt, C(x) = ∫₀ˣ cos(πt²/2) dt (NR §6.9). */
export function fresnel(x: number): { s: number; c: number } {
  const ax = Math.abs(x);
  let s: number, c: number;
  if (ax === Infinity) { s = 0.5; c = 0.5; }
  else if (ax < Math.sqrt(FPMIN)) { s = 0; c = ax; }
  else if (ax <= 1.5) {
    let sum = 0, sums = 0, sumc = ax, sign = 1, term = ax, n = 3, odd = true;
    const fact = (Math.PI / 2) * ax * ax;
    for (let k = 1; k <= 1000; k++) {
      term *= fact / k;
      sum += (sign * term) / n;
      const test = Math.abs(sum) * EPS;
      if (odd) { sign = -sign; sums = sum; sum = sumc; }
      else { sumc = sum; sum = sums; }
      if (term < test) break;
      odd = !odd;
      n += 2;
    }
    s = sums; c = sumc;
  } else {
    // continued fraction for erfc of complex argument
    const pix2 = Math.PI * ax * ax;
    let br = 1, bi = -pix2;
    let cr = 1 / FPMIN, ci = 0;
    let den = br * br + bi * bi;
    let dr = br / den, di = -bi / den;
    let hr = dr, hi = di;
    let n = -1;
    for (let k = 2; k <= 100000; k++) {
      n += 2;
      const a = -n * (n + 1);
      br += 4;
      let xr = a * dr + br, xi = a * di + bi;
      den = xr * xr + xi * xi;
      dr = xr / den; di = -xi / den;
      den = cr * cr + ci * ci;
      xr = br + (a * cr) / den; xi = bi - (a * ci) / den;
      cr = xr; ci = xi;
      const delr = cr * dr - ci * di, deli = cr * di + ci * dr;
      const nhr = hr * delr - hi * deli, nhi = hr * deli + hi * delr;
      hr = nhr; hi = nhi;
      if (Math.abs(delr - 1) + Math.abs(deli) <= EPS) break;
    }
    // h *= (ax − i ax);  cs = (½ + i½)(1 − e^(iπx²/2) h)
    const h2r = hr * ax + hi * ax, h2i = hi * ax - hr * ax;
    const er = Math.cos(0.5 * pix2), ei = Math.sin(0.5 * pix2);
    const pr = 1 - (er * h2r - ei * h2i), pi = -(er * h2i + ei * h2r);
    c = 0.5 * pr - 0.5 * pi;
    s = 0.5 * pi + 0.5 * pr;
  }
  return x < 0 ? { s: -s, c: -c } : { s, c };
}

/** sin(x)/x with the limit 1 at 0. */
export function sinc(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x === 0 ? 1 : Math.sin(x) / x;
}

// ---------------------------------------------------------------- Lambert W

/** Lambert W function: W e^W = x, branch 0 (x ≥ −1/e) or −1 (−1/e ≤ x < 0). */
export function lambertW(x: number, k = 0): number {
  if (k !== 0 && k !== -1) fail('LambertW(x, k): only the real branches k = 0 and k = −1 exist');
  const branchPoint = -Math.exp(-1);
  if (x < branchPoint) {
    // allow rounding of −1/e itself
    if (x > branchPoint * (1 + 4 * EPS)) x = branchPoint;
    else fail('LambertW(x) is complex for x < −1/e');
  }
  if (k === -1 && x >= 0) {
    if (x === 0) return -Infinity;
    fail('LambertW(x, −1) is real only for −1/e ≤ x < 0');
  }
  if (x === 0) return 0;
  if (x === Infinity) return Infinity;
  const q = 2 * (Math.E * x + 1);
  let w: number;
  if (q < 0.3) {
    // series about the branch point (DLMF 4.13.6)
    const p = (k === 0 ? 1 : -1) * Math.sqrt(Math.max(0, q));
    w = -1 + p - p * p / 3 + (11 / 72) * p * p * p;
    if (q < 1e-8) return w;
  } else if (k === 0) {
    if (x < 3) {
      const l = Math.log1p(x);
      w = l * (1 - Math.log1p(l) / (2 + l));
    } else {
      const l1 = Math.log(x), l2 = Math.log(l1);
      w = l1 - l2 + l2 / l1;
    }
  } else {
    const l1 = Math.log(-x), l2 = Math.log(-l1);
    w = l1 - l2 + l2 / l1;
  }
  for (let i = 0; i < 60; i++) {
    const ew = Math.exp(w);
    const f = w * ew - x;
    const wp1 = w + 1;
    if (wp1 === 0) break;
    const dw = f / (ew * wp1 - ((w + 2) * f) / (2 * wp1));
    w -= dw;
    if (Math.abs(dw) <= 4 * EPS * Math.max(1, Math.abs(w))) break;
  }
  return w;
}

// ---------------------------------------------------------------- elliptic integrals (Carlson)

/** Carlson R_F(x, y, z). */
export function carlsonRF(x: number, y: number, z: number): number {
  if (Math.min(x, y, z) < 0 || Math.min(x + y, x + z, y + z) === 0) fail('R_F: invalid arguments');
  let xt = x, yt = y, zt = z;
  let ave: number, dx: number, dy: number, dz: number;
  for (;;) {
    const sx = Math.sqrt(xt), sy = Math.sqrt(yt), sz = Math.sqrt(zt);
    const lam = sx * (sy + sz) + sy * sz;
    xt = 0.25 * (xt + lam); yt = 0.25 * (yt + lam); zt = 0.25 * (zt + lam);
    ave = (xt + yt + zt) / 3;
    dx = (ave - xt) / ave; dy = (ave - yt) / ave; dz = (ave - zt) / ave;
    if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= 0.0008) break;
  }
  const e2 = dx * dy - dz * dz, e3 = dx * dy * dz;
  return (1 + (e2 / 24 - 0.1 - (3 / 44) * e3) * e2 + e3 / 14) / Math.sqrt(ave);
}

/** Carlson R_D(x, y, z). */
export function carlsonRD(x: number, y: number, z: number): number {
  if (Math.min(x, y) < 0 || x + y === 0 || z <= 0) fail('R_D: invalid arguments');
  const C1 = 3 / 14, C2 = 1 / 6, C3 = 9 / 22, C4 = 3 / 26, C5 = 0.25 * C3, C6 = 1.5 * C4;
  let xt = x, yt = y, zt = z, sum = 0, fac = 1;
  let ave: number, dx: number, dy: number, dz: number;
  for (;;) {
    const sx = Math.sqrt(xt), sy = Math.sqrt(yt), sz = Math.sqrt(zt);
    const lam = sx * (sy + sz) + sy * sz;
    sum += fac / (sz * (zt + lam));
    fac *= 0.25;
    xt = 0.25 * (xt + lam); yt = 0.25 * (yt + lam); zt = 0.25 * (zt + lam);
    ave = 0.2 * (xt + yt + 3 * zt);
    dx = (ave - xt) / ave; dy = (ave - yt) / ave; dz = (ave - zt) / ave;
    if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= 0.0005) break;
  }
  const ea = dx * dy, eb = dz * dz, ec = ea - eb, ed = ea - 6 * eb, ee = ed + ec + ec;
  return 3 * sum + (fac * (1 + ed * (-C1 + C5 * ed - C6 * dz * ee) + dz * (C2 * ee + dz * (-C3 * ec + dz * C4 * ea)))) / (ave * Math.sqrt(ave));
}

/** Carlson R_C(x, y) (Cauchy principal value for y < 0). */
export function carlsonRC(x: number, y: number): number {
  if (x < 0 || y === 0) fail('R_C: invalid arguments');
  let xt: number, yt: number, w: number;
  if (y > 0) { xt = x; yt = y; w = 1; }
  else { xt = x - y; yt = -y; w = Math.sqrt(x) / Math.sqrt(xt); }
  let ave: number, s: number;
  for (;;) {
    const lam = 2 * Math.sqrt(xt) * Math.sqrt(yt) + yt;
    xt = 0.25 * (xt + lam); yt = 0.25 * (yt + lam);
    ave = (xt + yt + yt) / 3;
    s = (yt - ave) / ave;
    if (Math.abs(s) <= 0.0004) break;
  }
  return (w * (1 + s * s * (0.3 + s * (1 / 7 + s * (0.375 + s * (9 / 22)))))) / Math.sqrt(ave);
}

/** Carlson R_J(x, y, z, p) (Cauchy principal value for p < 0). */
export function carlsonRJ(x: number, y: number, z: number, p: number): number {
  if (Math.min(x, y, z) < 0 || Math.min(x + y, x + z, y + z) === 0 || p === 0) fail('R_J: invalid arguments');
  const C1 = 3 / 14, C2 = 1 / 3, C3 = 3 / 22, C4 = 3 / 26, C5 = 0.75 * C3, C6 = 1.5 * C4, C7 = 0.5 * C2, C8 = C3 + C3;
  let sum = 0, fac = 1;
  let xt: number, yt: number, zt: number, pt: number;
  let a = 0, b = 0, rcx = 0;
  if (p > 0) { xt = x; yt = y; zt = z; pt = p; }
  else {
    xt = Math.min(x, y, z);
    zt = Math.max(x, y, z);
    yt = x + y + z - xt - zt;
    a = 1 / (yt - p);
    b = a * (zt - yt) * (yt - xt);
    pt = yt + b;
    const rho = (xt * zt) / yt, tau = (p * pt) / yt;
    rcx = carlsonRC(rho, tau);
  }
  let ave: number, dx: number, dy: number, dz: number, dp: number;
  for (;;) {
    const sx = Math.sqrt(xt), sy = Math.sqrt(yt), sz = Math.sqrt(zt);
    const lam = sx * (sy + sz) + sy * sz;
    const alpha = (pt * (sx + sy + sz) + sx * sy * sz) ** 2;
    const bet = pt * (pt + lam) ** 2;
    sum += fac * carlsonRC(alpha, bet);
    fac *= 0.25;
    xt = 0.25 * (xt + lam); yt = 0.25 * (yt + lam); zt = 0.25 * (zt + lam); pt = 0.25 * (pt + lam);
    ave = 0.2 * (xt + yt + zt + pt + pt);
    dx = (ave - xt) / ave; dy = (ave - yt) / ave; dz = (ave - zt) / ave; dp = (ave - pt) / ave;
    if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), Math.abs(dp)) <= 0.0005) break;
  }
  const ea = dx * (dy + dz) + dy * dz, eb = dx * dy * dz, ec = dp * dp, ed = ea - 3 * ec, ee = eb + 2 * dp * (ea - ec);
  let ans = 3 * sum + (fac * (1 + ed * (-C1 + C5 * ed - C6 * ee) + eb * (C7 + dp * (-C8 + dp * C4)) + dp * ea * (C2 - dp * C3) - C2 * dp * ec)) / (ave * Math.sqrt(ave));
  if (p <= 0) ans = a * (b * ans + 3 * (rcx - carlsonRF(xt, yt, zt)));
  return ans;
}

function checkModulus(k: number, fn: string) {
  if (!(Math.abs(k) <= 1)) fail(`${fn}: the modulus k must satisfy |k| ≤ 1`);
}

/** 1 − k² (the complementary parameter) without cancellation near |k| = 1. */
const comp = (k: number) => (1 - k) * (1 + k);

/** Complete elliptic integral of the first kind K(k) (modulus k; parameter m = k²). */
export function ellipK(k: number): number {
  checkModulus(k, 'ellipK');
  if (Math.abs(k) === 1) return Infinity;
  return carlsonRF(0, comp(k), 1);
}

/** Complete elliptic integral of the second kind E(k). */
export function ellipE(k: number): number {
  checkModulus(k, 'ellipE');
  if (Math.abs(k) === 1) return 1;
  const q = comp(k);
  return carlsonRF(0, q, 1) - ((k * k) / 3) * carlsonRD(0, q, 1);
}

/** Complete elliptic integral of the third kind Π(n, k) = ∫₀^(π/2) dθ / ((1 − n sin²θ) √(1 − k² sin²θ)). */
export function ellipPi(n: number, k: number): number {
  checkModulus(k, 'ellipPi');
  if (n === 1 || Math.abs(k) === 1) return Infinity;
  const q = comp(k);
  return carlsonRF(0, q, 1) + (n / 3) * carlsonRJ(0, q, 1, 1 - n);
}

/** Split φ = jπ + r with |r| ≤ π/2 (the incomplete integrals are quasi-periodic). */
function reduceAmplitude(phi: number): { j: number; r: number } {
  const j = Math.round(phi / Math.PI);
  return { j, r: phi - j * Math.PI };
}

/** Incomplete elliptic integral of the first kind F(φ, k) = ∫₀^φ dθ / √(1 − k² sin²θ). */
export function ellipF(phi: number, k: number): number {
  checkModulus(k, 'ellipF');
  const { j, r } = reduceAmplitude(phi);
  const s = Math.sin(r), c = Math.cos(r);
  const part = s * carlsonRF(c * c, comp(k * s), 1);
  return j === 0 ? part : part + 2 * j * ellipK(k);
}

/** Incomplete elliptic integral of the second kind E(φ, k) = ∫₀^φ √(1 − k² sin²θ) dθ. */
export function ellipEinc(phi: number, k: number): number {
  checkModulus(k, 'ellipE');
  const { j, r } = reduceAmplitude(phi);
  const s = Math.sin(r), c = Math.cos(r), q = comp(k * s);
  const part = s * carlsonRF(c * c, q, 1) - ((k * k * s * s * s) / 3) * carlsonRD(c * c, q, 1);
  return j === 0 ? part : part + 2 * j * ellipE(k);
}

/** Incomplete elliptic integral of the third kind Π(n; φ, k). */
export function ellipPiInc(n: number, phi: number, k: number): number {
  checkModulus(k, 'ellipPi');
  const { j, r } = reduceAmplitude(phi);
  const s = Math.sin(r), c = Math.cos(r), q = comp(k * s);
  const part = s * carlsonRF(c * c, q, 1) + ((n * s * s * s) / 3) * carlsonRJ(c * c, q, 1, 1 - n * s * s);
  return j === 0 ? part : part + 2 * j * ellipPi(n, k);
}

// ---------------------------------------------------------------- orthogonal polynomials

function degree(n: number, fn: string): number {
  if (!isInt(n) || n < 0) fail(`${fn}: the degree n must be an integer ≥ 0`);
  return n;
}

/** Legendre polynomial P_n(x) (Bonnet recurrence). */
export function legendre(n: number, x: number): number {
  degree(n, 'Leg');
  if (n === 0) return 1;
  let p0 = 1, p1 = x;
  for (let k = 1; k < n; k++) {
    const p2 = ((2 * k + 1) * x * p1 - k * p0) / (k + 1);
    p0 = p1; p1 = p2;
  }
  return p1;
}

/** Associated Legendre function P_n^m(x), |x| ≤ 1, with the Condon–Shortley phase (−1)^m (DLMF 14.6.1). */
export function assocLegendre(n: number, m: number, x: number): number {
  degree(n, 'Leg');
  if (!isInt(m)) fail('Leg(n, m, x): the order m must be an integer');
  if (Math.abs(x) > 1) fail('Leg(n, m, x) needs |x| ≤ 1');
  if (m < 0) {
    // P_n^(−m) = (−1)^m (n−m)!/(n+m)! P_n^m
    const mm = -m;
    if (mm > n) return 0;
    let ratio = 1;
    for (let k = n - mm + 1; k <= n + mm; k++) ratio /= k;
    return (mm % 2 === 0 ? 1 : -1) * ratio * assocLegendre(n, mm, x);
  }
  if (m > n) return 0;
  // P_m^m = (−1)^m (2m − 1)!! (1 − x²)^(m/2)
  let pmm = 1;
  if (m > 0) {
    const somx2 = Math.sqrt((1 - x) * (1 + x));
    let fact = 1;
    for (let i = 1; i <= m; i++) { pmm *= -fact * somx2; fact += 2; }
  }
  if (n === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (n === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= n; ll++) {
    pll = (x * (2 * ll - 1) * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1; pmmp1 = pll;
  }
  return pll;
}

/** Hermite polynomial H_n(x) (physicists', H₂ = 4x² − 2). */
export function hermite(n: number, x: number): number {
  degree(n, 'Her');
  if (n === 0) return 1;
  let h0 = 1, h1 = 2 * x;
  for (let k = 1; k < n; k++) {
    const h2 = 2 * x * h1 - 2 * k * h0;
    h0 = h1; h1 = h2;
  }
  return h1;
}

/** Generalised Laguerre polynomial L_n^(α)(x) (α = 0: Laguerre L_n). */
export function laguerre(n: number, x: number, alpha = 0): number {
  degree(n, 'Lag');
  if (n === 0) return 1;
  let l0 = 1, l1 = 1 + alpha - x;
  for (let k = 1; k < n; k++) {
    const l2 = ((2 * k + 1 + alpha - x) * l1 - (k + alpha) * l0) / (k + 1);
    l0 = l1; l1 = l2;
  }
  return l1;
}

/** Chebyshev polynomial of the first kind T_n(x). */
export function chebT(n: number, x: number): number {
  degree(n, 'Tcheb');
  if (n === 0) return 1;
  let t0 = 1, t1 = x;
  for (let k = 1; k < n; k++) {
    const t2 = 2 * x * t1 - t0;
    t0 = t1; t1 = t2;
  }
  return t1;
}

/** Chebyshev polynomial of the second kind U_n(x). */
export function chebU(n: number, x: number): number {
  degree(n, 'Ucheb');
  if (n === 0) return 1;
  let u0 = 1, u1 = 2 * x;
  for (let k = 1; k < n; k++) {
    const u2 = 2 * x * u1 - u0;
    u0 = u1; u1 = u2;
  }
  return u1;
}

/** Jacobi polynomial P_n^(a,b)(x) (DLMF 18.9.2). */
export function jacobiP(n: number, a: number, b: number, x: number): number {
  degree(n, 'Jac');
  if (!(a > -1) || !(b > -1)) fail('Jac(n, a, b, x) needs a > −1 and b > −1');
  if (n === 0) return 1;
  let p0 = 1;
  let p1 = (a + 1) + (a + b + 2) * (x - 1) / 2;
  for (let k = 2; k <= n; k++) {
    const s = 2 * k + a + b;
    const c1 = 2 * k * (k + a + b) * (s - 2);
    const c2 = (s - 1) * (s * (s - 2) * x + a * a - b * b);
    const c3 = 2 * (k + a - 1) * (k + b - 1) * s;
    const p2 = (c2 * p1 - c3 * p0) / c1;
    p0 = p1; p1 = p2;
  }
  return p1;
}
