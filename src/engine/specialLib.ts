// Worksheet functions on top of special.ts: Bessel and Airy functions, the gamma
// family, integrals, elliptic integrals, Lambert W, orthogonal polynomials and the
// distributions Mathcad has that the core library lacks. Mathcad names where Mathcad
// has them (Jn, Leg, Her, Tcheb, ibeta …); arguments are dimensionless except angles.
import { math, isUnit, isMatrix, splitUnit } from './math';
import { num, int } from './library';
import { SHADOWABLE } from './compile';
import * as S from './special';
import * as N from './numeric';

/** An angle: a plain number in radians or a quantity in rad, deg … */
function angle(v: unknown, what: string): number {
  if (isUnit(v)) {
    const d = (v as unknown as { dimensions: number[] }).dimensions;
    if (d.some((e, i) => e !== 0 && i !== 7)) throw new Error(`${what} must be an angle`);
    return splitUnit(v).value;
  }
  return num(v, what);
}

/** Reject NaN (no real value) with a message instead of showing NaN. */
function real(v: number, fn: string): number {
  if (Number.isNaN(v)) throw new Error(`${fn}: no real value for these arguments`);
  return v;
}

const one = (f: (x: number) => number, fn: string) => (x: unknown) => real(f(num(x, `${fn}: x`)), fn);
const bessel = (f: (nu: number, x: number) => number, fn: string, fixed?: number) =>
  fixed === undefined
    ? (m: unknown, x: unknown) => real(f(num(m, `${fn}: the order`), num(x, `${fn}: x`)), fn)
    : (x: unknown) => real(f(fixed, num(x, `${fn}: x`)), fn);

// ---------------------------------------------------------------- distributions

function pos(v: unknown, what: string): number {
  const x = num(v, what);
  if (!(x > 0)) throw new Error(`${what} must be positive`);
  return x;
}

function prob(p: unknown): number {
  const x = num(p, 'p');
  if (!(x >= 0 && x <= 1)) throw new Error('The probability p must lie in [0, 1]');
  return x;
}

const dF = (x: unknown, d1: unknown, d2: unknown) => {
  const xv = num(x), a = pos(d1, 'd1'), b = pos(d2, 'd2');
  if (xv < 0) return 0;
  if (xv === 0) return a < 2 ? Infinity : a === 2 ? 1 : 0;
  // f(x) = √((a x)^a b^b / (a x + b)^(a+b)) / (x B(a/2, b/2))
  const ln = 0.5 * (a * Math.log(a * xv) + b * Math.log(b) - (a + b) * Math.log(a * xv + b)) - Math.log(xv) - (S.lgamma(a / 2) + S.lgamma(b / 2) - S.lgamma((a + b) / 2));
  return Math.exp(ln);
};

// Weibull with shape s and scale λ (Mathcad: λ = 1)
const dweibull = (x: unknown, s: unknown, l: unknown = 1) => {
  const xv = num(x), k = pos(s, 'shape s'), lam = pos(l, 'scale');
  if (xv < 0) return 0;
  const z = xv / lam;
  return (k / lam) * Math.pow(z, k - 1) * Math.exp(-Math.pow(z, k));
};
const pweibull = (x: unknown, s: unknown, l: unknown = 1) => {
  const xv = num(x), k = pos(s, 'shape s'), lam = pos(l, 'scale');
  return xv <= 0 ? 0 : -Math.expm1(-Math.pow(xv / lam, k));
};
const qweibull = (p: unknown, s: unknown, l: unknown = 1) => pos(l, 'scale') * Math.pow(-Math.log1p(-prob(p)), 1 / pos(s, 'shape s'));

// lognormal with log-mean μ and log-deviation σ
const dlnorm = (x: unknown, mu: unknown = 0, sg: unknown = 1) => {
  const xv = num(x), m = num(mu), s = pos(sg, 'σ');
  if (xv <= 0) return 0;
  const z = (Math.log(xv) - m) / s;
  return Math.exp(-0.5 * z * z) / (xv * s * Math.sqrt(2 * Math.PI));
};
const plnorm = (x: unknown, mu: unknown = 0, sg: unknown = 1) => {
  const xv = num(x), m = num(mu), s = pos(sg, 'σ');
  return xv <= 0 ? 0 : 0.5 * S.erfc(-(Math.log(xv) - m) / (s * Math.SQRT2));
};
const qlnorm = (p: unknown, mu: unknown = 0, sg: unknown = 1) => Math.exp(num(mu) + pos(sg, 'σ') * S.normInv(prob(p)));

// gamma with shape s and scale θ (Mathcad: θ = 1)
const dgamma = (x: unknown, s: unknown, th: unknown = 1) => {
  const xv = num(x), k = pos(s, 'shape s'), t = pos(th, 'scale');
  if (xv < 0) return 0;
  if (xv === 0) return k < 1 ? Infinity : k === 1 ? 1 / t : 0;
  return Math.exp((k - 1) * Math.log(xv / t) - xv / t - S.lgamma(k)) / t;
};
const pgamma = (x: unknown, s: unknown, th: unknown = 1) => {
  const xv = num(x);
  return xv <= 0 ? 0 : S.gammaPQ(pos(s, 'shape s'), xv / pos(th, 'scale')).p;
};
const qgamma = (p: unknown, s: unknown, th: unknown = 1) => {
  const pv = prob(p), k = pos(s, 'shape s'), t = pos(th, 'scale');
  if (pv === 0) return 0;
  if (pv === 1) return Infinity;
  return t * N.invertCdf((x) => (x <= 0 ? 0 : S.gammaPQ(k, x).p), pv, 0, Math.max(1, 2 * k));
};

const dbeta = (x: unknown, a: unknown, b: unknown) => {
  const xv = num(x), p = pos(a, 's1'), q = pos(b, 's2');
  if (xv < 0 || xv > 1) return 0;
  if (xv === 0 || xv === 1) {
    const e = xv === 0 ? p : q;
    return e < 1 ? Infinity : e === 1 ? 1 / S.beta(p, q) : 0;
  }
  return Math.exp((p - 1) * Math.log(xv) + (q - 1) * Math.log1p(-xv)) / S.beta(p, q);
};
const pbeta = (x: unknown, a: unknown, b: unknown) => {
  const xv = num(x);
  return xv <= 0 ? 0 : xv >= 1 ? 1 : S.betaInc(xv, pos(a, 's1'), pos(b, 's2'));
};
const qbeta = (p: unknown, a: unknown, b: unknown) => {
  const pv = prob(p), s1 = pos(a, 's1'), s2 = pos(b, 's2');
  if (pv === 0 || pv === 1) return pv;
  return N.brent((x) => S.betaInc(x, s1, s2) - pv, 0, 1, 1e-15);
};

// ---------------------------------------------------------------- more of Mathcad's distributions

function count(v: unknown, what: string): number {
  const k = int(v, what);
  if (k < 0) throw new Error(`${what} must be a whole number ≥ 0`);
  return k;
}

function chance(v: unknown, what: string): number {
  const p = num(v, what);
  if (!(p >= 0 && p <= 1)) throw new Error(`${what} must lie in [0, 1]`);
  return p;
}

/** ln C(n, k) for real n ≥ k ≥ 0. */
const lnChoose = (n: number, k: number) => S.lgamma(n + 1) - S.lgamma(k + 1) - S.lgamma(n - k + 1);

/**
 * The smallest whole k ≥ lo with cdf(k) ≥ p, by doubling then bisection. p is eased by
 * 64 ulp (as R does) so that a p computed from the cdf itself gives back its own k.
 */
function discreteQuantile(cdf: (k: number) => number, p: number, lo: number, hi = Infinity): number {
  const target = p * (1 - 64 * Number.EPSILON);
  if (cdf(lo) >= target) return lo;
  let a = lo, b = lo + 1;
  while (b < hi && cdf(b) < target) {
    a = b;
    b = Math.min(hi, lo + 2 * (b - lo));
  }
  while (b - a > 1) {
    const m = Math.floor((a + b) / 2);
    if (cdf(m) >= target) b = m;
    else a = m;
  }
  return b;
}

const binomCdf = (k: number, n: number, p: number) => (k >= n || p === 0 ? 1 : p === 1 ? 0 : S.betaInc(1 - p, n - k, k + 1));
const qbinom = (pv: unknown, n: unknown, q: unknown) => {
  const nn = count(n, 'qbinom: n'), qq = chance(q, 'qbinom: q');
  return discreteQuantile((k) => binomCdf(k, nn, qq), prob(pv), 0, nn);
};
const qpois = (pv: unknown, l: unknown) => {
  const lam = pos(l, 'qpois: λ');
  return discreteQuantile((k) => S.gammaPQ(k + 1, lam).q, prob(pv), 0);
};

// geometric: failures before the first success
const dgeom = (k: unknown, p: unknown) => {
  const kk = count(k, 'dgeom: k'), pp = chance(p, 'dgeom: p');
  return pp * Math.exp(kk * Math.log1p(-pp));
};
const geomCdf = (k: number, p: number) => -Math.expm1((k + 1) * Math.log1p(-p));
const pgeom = (k: unknown, p: unknown) => {
  const kk = Math.floor(num(k, 'pgeom: k'));
  return kk < 0 ? 0 : geomCdf(kk, chance(p, 'pgeom: p'));
};
const qgeom = (pv: unknown, p: unknown) => {
  const pp = chance(p, 'qgeom: p');
  return discreteQuantile((k) => geomCdf(k, pp), prob(pv), 0);
};

// negative binomial: failures before the n-th success
const dnbinom = (k: unknown, n: unknown, p: unknown) => {
  const kk = count(k, 'dnbinom: k'), nn = pos(n, 'dnbinom: n'), pp = chance(p, 'dnbinom: p');
  return Math.exp(S.lgamma(nn + kk) - S.lgamma(nn) - S.lgamma(kk + 1) + nn * Math.log(pp) + kk * Math.log1p(-pp));
};
const nbinomCdf = (k: number, n: number, p: number) => (p === 1 ? 1 : p === 0 ? 0 : S.betaInc(p, n, k + 1));
const pnbinom = (k: unknown, n: unknown, p: unknown) => {
  const kk = Math.floor(num(k, 'pnbinom: k'));
  return kk < 0 ? 0 : nbinomCdf(kk, pos(n, 'pnbinom: n'), chance(p, 'pnbinom: p'));
};
const qnbinom = (pv: unknown, n: unknown, p: unknown) => {
  const nn = pos(n, 'qnbinom: n'), pp = chance(p, 'qnbinom: p');
  return discreteQuantile((k) => nbinomCdf(k, nn, pp), prob(pv), 0);
};

// hypergeometric: m successes in n draws from a successes and b failures
function hyper(m: unknown, a: unknown, b: unknown, n: unknown, fn: string) {
  const aa = count(a, `${fn}: a`), bb = count(b, `${fn}: b`), nn = count(n, `${fn}: n`);
  if (nn > aa + bb) throw new Error(`${fn}: n cannot exceed a + b`);
  const d = (i: number) => (i < Math.max(0, nn - bb) || i > Math.min(nn, aa) ? 0 : Math.exp(lnChoose(aa, i) + lnChoose(bb, nn - i) - lnChoose(aa + bb, nn)));
  const cdf = (k: number) => {
    let s = 0;
    for (let i = Math.max(0, nn - bb); i <= Math.min(k, nn, aa); i++) s += d(i);
    return Math.min(1, s);
  };
  return { m: Math.floor(num(m, `${fn}: m`)), lo: Math.max(0, nn - bb), hi: Math.min(nn, aa), d, cdf };
}
const dhypergeom = (m: unknown, a: unknown, b: unknown, n: unknown) => {
  const h = hyper(m, a, b, n, 'dhypergeom');
  return Number.isInteger(num(m)) ? h.d(h.m) : 0;
};
const phypergeom = (m: unknown, a: unknown, b: unknown, n: unknown) => {
  const h = hyper(m, a, b, n, 'phypergeom');
  return h.m < h.lo ? 0 : h.cdf(h.m);
};
const qhypergeom = (pv: unknown, a: unknown, b: unknown, n: unknown) => {
  const h = hyper(0, a, b, n, 'qhypergeom');
  return discreteQuantile(h.cdf, prob(pv), h.lo, h.hi);
};

// Cauchy and logistic with location l and scale s
const z = (x: unknown, l: unknown, s: unknown, fn: string) => (num(x, `${fn}: x`) - num(l, `${fn}: l`)) / pos(s, `${fn}: s`);
const dcauchy = (x: unknown, l: unknown, s: unknown) => {
  const t = z(x, l, s, 'dcauchy');
  return 1 / (Math.PI * num(s) * (1 + t * t));
};
// below the centre as atan(1/|t|)/π, which keeps the tail's digits
const pcauchy = (x: unknown, l: unknown, s: unknown) => {
  const t = z(x, l, s, 'pcauchy');
  return t < 0 ? Math.atan(-1 / t) / Math.PI : 0.5 + Math.atan(t) / Math.PI;
};
const qcauchy = (p: unknown, l: unknown, s: unknown) => {
  const pv = prob(p);
  if (pv === 0 || pv === 1) return pv === 0 ? -Infinity : Infinity;
  return num(l, 'qcauchy: l') + pos(s, 'qcauchy: s') * Math.tan(Math.PI * (pv - 0.5));
};
const dlogis = (x: unknown, l: unknown, s: unknown) => {
  const t = Math.abs(z(x, l, s, 'dlogis'));
  const e = Math.exp(-t);
  return e / (num(s) * (1 + e) * (1 + e));
};
const plogis = (x: unknown, l: unknown, s: unknown) => 1 / (1 + Math.exp(-z(x, l, s, 'plogis')));
const qlogis = (p: unknown, l: unknown, s: unknown) => {
  const pv = prob(p);
  return num(l, 'qlogis: l') + pos(s, 'qlogis: s') * (Math.log(pv) - Math.log1p(-pv));
};

// ---------------------------------------------------------------- registration

const SPECIAL: Record<string, unknown> = {
  // Bessel (real order allowed where the function is real)
  J0: bessel(S.besselJ, 'J0', 0), J1: bessel(S.besselJ, 'J1', 1), Jn: bessel(S.besselJ, 'Jn'),
  Y0: bessel(S.besselY, 'Y0', 0), Y1: bessel(S.besselY, 'Y1', 1), Yn: bessel(S.besselY, 'Yn'),
  I0: bessel(S.besselI, 'I0', 0), I1: bessel(S.besselI, 'I1', 1), In: bessel(S.besselI, 'In'),
  K0: bessel(S.besselK, 'K0', 0), K1: bessel(S.besselK, 'K1', 1), Kn: bessel(S.besselK, 'Kn'),
  js: (n: unknown, x: unknown) => S.sphericalJ(int(n, 'js: n'), num(x, 'js: x')),
  ys: (n: unknown, x: unknown) => S.sphericalY(int(n, 'ys: n'), num(x, 'ys: x')),
  Ai: (x: unknown) => S.airy(num(x, 'Ai: x')).ai,
  Bi: (x: unknown) => S.airy(num(x, 'Bi: x')).bi,
  // gamma family
  beta: (a: unknown, b: unknown) => S.beta(num(a, 'beta: a'), num(b, 'beta: b')),
  gammaP: (a: unknown, x: unknown) => S.gammaPQ(num(a, 'gammaP: a'), num(x, 'gammaP: x')).p,
  gammaQ: (a: unknown, x: unknown) => S.gammaPQ(num(a, 'gammaQ: a'), num(x, 'gammaQ: x')).q,
  gammainc: (a: unknown, x: unknown) => S.gammaLower(num(a, 'gammainc: a'), num(x, 'gammainc: x')),
  ibeta: (z: unknown, a: unknown, b: unknown) => S.betaInc(num(z, 'ibeta: z'), num(a, 'ibeta: a'), num(b, 'ibeta: b')),
  betainc: (z: unknown, a: unknown, b: unknown) => {
    const av = num(a, 'betainc: a'), bv = num(b, 'betainc: b');
    return S.betaInc(num(z, 'betainc: z'), av, bv) * S.beta(av, bv);
  },
  digamma: one(S.digamma, 'digamma'),
  // Mathcad's ψ: Psi(x) digamma, Psi(n, x) the n-th derivative of digamma
  Psi: (a: unknown, x?: unknown) => (x === undefined ? real(S.digamma(num(a, 'Psi: x')), 'Psi') : S.polygamma(int(a, 'Psi: n'), num(x, 'Psi: x'))),
  polygamma: (n: unknown, x: unknown) => S.polygamma(int(n, 'polygamma: n'), num(x, 'polygamma: x')),
  // integrals
  Ei: one(S.expintEi, 'Ei'),
  E1: one(S.expintE1, 'E1'),
  En: (n: unknown, x: unknown) => S.expintEn(int(n, 'En: n'), num(x, 'En: x')),
  Si: (x: unknown) => S.sici(num(x, 'Si: x')).si,
  Ci: (x: unknown) => {
    const v = num(x, 'Ci: x');
    if (v <= 0) throw new Error(v === 0 ? 'Ci(0) is infinite' : 'Ci(x) is complex for x < 0');
    return S.sici(v).ci;
  },
  FresnelS: (x: unknown) => S.fresnel(num(x, 'FresnelS: x')).s,
  FresnelC: (x: unknown) => S.fresnel(num(x, 'FresnelC: x')).c,
  erfc: one(S.erfc, 'erfc'),
  erfinv: one(S.erfinv, 'erfinv'),
  erfcinv: one(S.erfcinv, 'erfcinv'),
  sinc: (x: unknown) => S.sinc(angle(x, 'sinc: x')),
  // elliptic integrals: modulus k (parameter m = k²); amplitude φ in radians or degrees
  ellipK: (k: unknown) => S.ellipK(num(k, 'ellipK: k')),
  ellipE: (a: unknown, k?: unknown) => (k === undefined ? S.ellipE(num(a, 'ellipE: k')) : S.ellipEinc(angle(a, 'ellipE: φ'), num(k, 'ellipE: k'))),
  ellipF: (phi: unknown, k: unknown) => S.ellipF(angle(phi, 'ellipF: φ'), num(k, 'ellipF: k')),
  ellipPi: (n: unknown, a: unknown, k?: unknown) => (k === undefined
    ? S.ellipPi(num(n, 'ellipPi: n'), num(a, 'ellipPi: k'))
    : S.ellipPiInc(num(n, 'ellipPi: n'), angle(a, 'ellipPi: φ'), num(k, 'ellipPi: k'))),
  LambertW: (x: unknown, k: unknown = 0) => S.lambertW(num(x, 'LambertW: x'), int(k, 'LambertW: branch k')),
  // orthogonal polynomials
  Leg: (n: unknown, a: unknown, x?: unknown) => (x === undefined
    ? S.legendre(int(n, 'Leg: n'), num(a, 'Leg: x'))
    : S.assocLegendre(int(n, 'Leg: n'), int(a, 'Leg: m'), num(x, 'Leg: x'))),
  Her: (n: unknown, x: unknown) => S.hermite(int(n, 'Her: n'), num(x, 'Her: x')),
  Lag: (n: unknown, a: unknown, x?: unknown) => (x === undefined
    ? S.laguerre(int(n, 'Lag: n'), num(a, 'Lag: x'))
    : S.laguerre(int(n, 'Lag: n'), num(x, 'Lag: x'), num(a, 'Lag: α'))),
  Tcheb: (n: unknown, x: unknown) => S.chebT(int(n, 'Tcheb: n'), num(x, 'Tcheb: x')),
  Ucheb: (n: unknown, x: unknown) => S.chebU(int(n, 'Ucheb: n'), num(x, 'Ucheb: x')),
  Jac: (n: unknown, a: unknown, b: unknown, x: unknown) => S.jacobiP(int(n, 'Jac: n'), num(a, 'Jac: a'), num(b, 'Jac: b'), num(x, 'Jac: x')),
  // distributions
  dF, dweibull, pweibull, qweibull, dlnorm, plnorm, qlnorm, dgamma, pgamma, qgamma, dbeta, pbeta, qbeta,
  qbinom, qpois, dgeom, pgeom, qgeom, dnbinom, pnbinom, qnbinom, dhypergeom, phypergeom, qhypergeom,
  dcauchy, pcauchy, qcauchy, dlogis, plogis, qlogis,
};
SPECIAL.Jacobi = SPECIAL.Jac;
SPECIAL.Ibeta = SPECIAL.ibeta;

/**
 * Element by element over vectors and matrices, as the built-in sin or erf do: J0(v),
 * pnorm(v, 0, 1); several array arguments pair up element by element.
 */
function elementwise(f: (...a: unknown[]) => unknown) {
  const go = (args: unknown[]): unknown => {
    const k = args.findIndex(Array.isArray);
    if (k < 0) return f(...args);
    const n = (args[k] as unknown[]).length;
    if (args.some((a) => Array.isArray(a) && a.length !== n)) throw new Error('The vector arguments have different sizes');
    return Array.from({ length: n }, (_, i) => go(args.map((a) => (Array.isArray(a) ? a[i] : a))));
  };
  return (...args: unknown[]) => {
    if (!args.some((a) => isMatrix(a) || Array.isArray(a))) return f(...args);
    return math.matrix(go(args.map((a) => (isMatrix(a) ? a.toArray() : a))) as never);
  };
}
for (const k of Object.keys(SPECIAL)) SPECIAL[k] = elementwise(SPECIAL[k] as (...a: unknown[]) => unknown);

const clashes = Object.keys(SPECIAL).filter((k) => k in math);
if (clashes.length) throw new Error(`Special function names clash: ${clashes.join(', ')}`);
// ys and dF are also (obscure) units; functions win, as in the core library
math.import(SPECIAL, { override: true });
// a worksheet variable with one of these names (Ai, Si, beta …) still multiplies: Ai (x + 1)
for (const k of Object.keys(SPECIAL)) SHADOWABLE.add(k);

// Mathcad's gamma(a, x) is the upper incomplete gamma function
math.import({ gamma: math.typed('gamma', { 'number, number': (a: number, x: number) => S.gammaUpper(a, x) }) });

// mathjs' real lgamma and zeta lose digits (lgamma(0.5) to 1e-12, zeta(−7.5) entirely)
const replaceNumber = (name: 'lgamma' | 'zeta', f: (x: number) => number) => {
  const old = (math as unknown as Record<string, { signatures: Record<string, unknown> }>)[name];
  math.import({ [name]: math.typed(name, { ...old.signatures, number: f } as never) }, { override: true });
};
replaceNumber('lgamma', S.lgamma);
replaceNumber('zeta', S.zeta);
