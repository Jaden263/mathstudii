// Worksheet functions on top of special.ts: Bessel and Airy functions, the gamma
// family, integrals, elliptic integrals, Lambert W, orthogonal polynomials and the
// distributions Mathcad has that the core library lacks. Mathcad names where Mathcad
// has them (Jn, Leg, Her, Tcheb, ibeta …); arguments are dimensionless except angles.
import { math, isUnit, splitUnit } from './math';
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
};
SPECIAL.Jacobi = SPECIAL.Jac;
SPECIAL.Ibeta = SPECIAL.ibeta;

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
