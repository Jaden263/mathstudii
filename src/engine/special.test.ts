import { describe, it, expect } from 'vitest';
import * as S from './special';

/** Relative error (absolute when the reference is 0). */
const rel = (a: number, b: number) => (b === 0 ? Math.abs(a) : Math.abs((a - b) / b));
const close = (a: number, b: number, tol = 1e-13) => expect(rel(a, b), `${a} vs ${b}`).toBeLessThan(tol);

const EULER = 0.5772156649015329;

describe('gamma family', () => {
  it('gamma and log-gamma', () => {
    close(S.gamma(0.5), Math.sqrt(Math.PI), 1e-15); // Γ(½) = √π
    close(S.gamma(10), 362880, 1e-15); // 9!
    close(S.gamma(-1.5), (4 / 3) * Math.sqrt(Math.PI), 1e-14); // Γ(−3/2) = 4√π/3
    close(S.lgamma(0.5), 0.5 * Math.log(Math.PI), 1e-15);
    // near the roots at 1 and 2: ln Γ(1 + ε) = −γε + ζ(2)ε²/2 − … (DLMF 5.7.3)
    const e = 1 + 1e-8 - 1; // the ε that 1 + ε really holds
    close(S.lgamma(1 + e), -EULER * e + (Math.PI ** 2 / 12) * e * e, 1e-12);
    close(S.lgamma(2 + e), (1 - EULER) * e, 1e-7);
    close(S.lgamma(100), 359.13420536957540, 1e-15); // ln 99!
  });
  it('beta', () => {
    close(S.beta(2, 3), 1 / 12, 1e-15); // Γ(2)Γ(3)/Γ(5)
    close(S.beta(0.5, 0.5), Math.PI, 1e-15);
    close(S.beta(200, 300), Math.exp(S.lgamma(200) + S.lgamma(300) - S.lgamma(500)), 1e-12);
  });
  it('incomplete gamma against closed forms', () => {
    for (const x of [0.1, 1, 3.7, 12, 40]) {
      close(S.gammaUpper(1, x), Math.exp(-x), 1e-14); // Γ(1, x) = e^−x
      close(S.gammaUpper(2, x), (x + 1) * Math.exp(-x), 1e-14); // Γ(2, x) = (1 + x) e^−x
      close(S.gammaUpper(0, x), S.expintE1(x), 1e-14); // Γ(0, x) = E₁(x)
      close(S.gammaPQ(3, x).q, Math.exp(-x) * (1 + x + (x * x) / 2), 1e-13); // Q(3, x)
      close(S.gammaPQ(0.5, x * x).q, S.erfc(x), 1e-13); // Q(½, x²) = erfc x
    }
    // small x: P(a, x) = x^a/Γ(a+1) (1 − a x/(a+1) + …)
    close(S.gammaPQ(3, 1e-4).p, (1e-12 / 6) * (1 - 0.75e-4 + 0.6 * 0.5e-8), 1e-13);
    // tail of Q accurate where 1 − P would be 0
    close(S.gammaPQ(1, 100).q, Math.exp(-100), 1e-13);
    // a < 0 by recurrence: Γ(−1, x) = E₂(x)/x (DLMF 8.4.13 with 8.19.1)
    close(S.gammaUpper(-1, 2), S.expintEn(2, 2) / 2, 1e-13);
    close(S.gammaLower(2.5, 1.7) + S.gammaUpper(2.5, 1.7), S.gamma(2.5), 1e-14);
  });
  it('incomplete beta', () => {
    for (const x of [0.01, 0.3, 0.5, 0.92]) {
      close(S.betaInc(x, 2, 3), 6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4, 1e-13); // I_x(2,3) = Σ C(4,j) x^j (1−x)^(4−j)
      close(S.betaInc(x, 1, 4.5), 1 - (1 - x) ** 4.5, 1e-13); // I_x(1, b) = 1 − (1−x)^b
      close(S.betaInc(x, 3.2, 1.7) + S.betaInc(1 - x, 1.7, 3.2), 1, 1e-14); // symmetry
    }
  });
  it('digamma and zeta', () => {
    close(S.digamma(1), -EULER, 1e-15); // ψ(1) = −γ
    close(S.digamma(0.5), -EULER - 2 * Math.LN2, 1e-15); // ψ(½) = −γ − 2 ln 2
    close(S.digamma(11), 1 + 1 / 2 + 1 / 3 + 1 / 4 + 1 / 5 + 1 / 6 + 1 / 7 + 1 / 8 + 1 / 9 + 1 / 10 - EULER, 1e-15); // H₁₀ − γ
    close(S.digamma(-0.5), 0.03648997397857652, 1e-13); // ψ(1 − x) − π cot πx at x = −½
    close(S.zeta(2), Math.PI ** 2 / 6, 1e-15);
    close(S.zeta(4), Math.PI ** 4 / 90, 1e-15);
    close(S.zeta(3), 1.2020569031595943, 1e-15); // Apéry's constant
    close(S.zeta(0.5), -1.4603545088095868, 1e-14);
    close(S.zeta(0), -0.5, 1e-15);
    close(S.zeta(-1), -1 / 12, 1e-14); // ζ(−1) = −B₂/2
    close(S.zeta(-7), 1 / 240, 1e-13); // ζ(−7) = −B₈/8
    expect(S.zeta(-4)).toBe(0); // trivial zero
  });
});

describe('error function', () => {
  it('erf, erfc and their inverses', () => {
    close(S.erfc(5), 1.5374597944280349e-12, 1e-14); // A&S table 7.1
    close(S.erfc(26), 5.663192408856143e-296, 1e-13); // far tail, where 1 − erf is 0
    close(S.erf(1e-10), (2 / Math.sqrt(Math.PI)) * 1e-10, 1e-15);
    close(S.erfinv(0.5), 0.47693627620446987, 1e-15);
    close(S.normInv(0.975), 1.959963984540054, 1e-15);
    for (const y of [1e-12, 0.1, 0.5, 0.9, 0.999999]) close(S.erf(S.erfinv(y)), y, 1e-14);
    for (const z of [1e-300, 1e-20, 1e-5, 0.3, 1.7]) close(S.erfc(S.erfcinv(z)), z, 1e-13);
  });
});

describe('Bessel and Airy functions', () => {
  it('tabulated values of integer order (A&S 9.1)', () => {
    close(S.besselJ(0, 1), 0.7651976865579666, 1e-15);
    close(S.besselY(0, 1), 0.08825696421567696, 1e-14);
    close(S.besselI(0, 1), 1.2660658777520082, 1e-15);
    close(S.besselK(0, 1), 0.42102443824070833, 1e-15);
    // first zeros j₀,₁ and j₁,₁ (DLMF table 10.21.1)
    expect(Math.abs(S.besselJ(0, 2.4048255576957728))).toBeLessThan(1e-15);
    expect(Math.abs(S.besselJ(1, 3.8317059702075123))).toBeLessThan(1e-15);
  });
  it('half-integer order in closed form (DLMF 10.16.1, 10.39.1)', () => {
    for (const x of [1e-8, 0.3, 1.7, 9.5, 48, 1e5]) {
      const s = Math.sqrt(2 / (Math.PI * x));
      expect(Math.abs(S.besselJ(0.5, x) - s * Math.sin(x))).toBeLessThan(2e-15 * s);
      expect(Math.abs(S.besselY(0.5, x) + s * Math.cos(x))).toBeLessThan(2e-15 * s);
      expect(Math.abs(S.besselJ(-0.5, x) - s * Math.cos(x))).toBeLessThan(2e-15 * s);
      if (x < 700) close(S.besselI(0.5, x), s * Math.sinh(x), 1e-14);
      close(S.besselK(0.5, x), Math.sqrt(Math.PI / (2 * x)) * Math.exp(-x), 1e-14);
    }
  });
  it('real order: Wronskians (DLMF 10.5.5, 10.28.2)', () => {
    for (const [nu, x] of [[2.7, 13.4], [0.3, 0.8], [7.25, 3.1], [15.5, 60]]) {
      const w = S.besselJ(nu + 1, x) * S.besselY(nu, x) - S.besselJ(nu, x) * S.besselY(nu + 1, x);
      close(w, 2 / (Math.PI * x), 1e-12);
      const v = S.besselI(nu, x) * S.besselK(nu + 1, x) + S.besselI(nu + 1, x) * S.besselK(nu, x);
      close(v, 1 / x, 1e-12);
    }
    // J_{−ν} = cos νπ J_ν − sin νπ Y_ν
    close(S.besselJ(-2.3, 4.1), Math.cos(2.3 * Math.PI) * S.besselJ(2.3, 4.1) - Math.sin(2.3 * Math.PI) * S.besselY(2.3, 4.1), 1e-12);
    // integer order: J_{−n} = (−1)^n J_n, J_n(−x) = (−1)^n J_n(x)
    close(S.besselJ(-3, 2.2), -S.besselJ(3, 2.2), 1e-15);
    close(S.besselJ(3, -2.2), -S.besselJ(3, 2.2), 1e-15);
  });
  it('spherical Bessel functions (DLMF 10.49.3)', () => {
    for (const x of [0.01, 1.3, 7, 40]) {
      close(S.sphericalJ(0, x), Math.sin(x) / x, 1e-14);
      close(S.sphericalY(0, x), -Math.cos(x) / x, 1e-14);
      expect(Math.abs(S.sphericalJ(1, x) - (Math.sin(x) / (x * x) - Math.cos(x) / x))).toBeLessThan(1e-15 / Math.min(1, x));
    }
    expect(S.sphericalJ(0, 0)).toBe(1);
  });
  it('Airy functions', () => {
    const a0 = S.airy(0);
    close(a0.ai, 0.35502805388781724, 1e-15); // 1/(3^(2/3) Γ(2/3))
    close(a0.bi, 0.6149266274460007, 1e-15);
    expect(Math.abs(S.airy(-2.338107410459767).ai)).toBeLessThan(1e-15); // first zero a₁ (DLMF 9.9.1)
    for (const x of [-7.5, -1, 0.4, 3, 8]) {
      // Wronskian Ai Bi′ − Ai′ Bi = 1/π (DLMF 9.2.7)
      const a = S.airy(x);
      close(a.ai * a.bip - a.aip * a.bi, 1 / Math.PI, 1e-12);
    }
  });
});

describe('integrals', () => {
  it('exponential integrals', () => {
    close(S.expintE1(1), 0.21938393439552027, 1e-15); // A&S table 5.1
    close(S.expintEi(1), 1.8951178163559368, 1e-15);
    close(S.expintEi(-2), -S.expintE1(2), 1e-15);
    for (const x of [0.2, 1, 5.5, 30]) close(S.expintEn(2, x), Math.exp(-x) - x * S.expintE1(x), 1e-13); // DLMF 8.19.12
    // Ei(x) ~ e^x/x Σ k!/x^k far out (DLMF 6.12.2)
    let sum = 0, term = 1;
    for (let k = 0; k < 14; k++) { sum += term; term *= (k + 1) / 200; }
    close(S.expintEi(200), (Math.exp(200) / 200) * sum, 1e-13);
  });
  it('sine, cosine and Fresnel integrals', () => {
    close(S.sici(Math.PI).si, 1.8519370519824662, 1e-15); // Wilbraham–Gibbs
    close(S.sici(1).ci, 0.33740392290096813, 1e-14); // A&S table 5.1
    close(S.sici(Infinity).si, Math.PI / 2, 1e-15);
    // Si(x) → π/2 − cos x / x for large x
    expect(Math.abs(S.sici(1e4).si - (Math.PI / 2 - Math.cos(1e4) / 1e4))).toBeLessThan(1e-8);
    close(S.fresnel(1).c, 0.7798934003768228, 1e-15); // A&S table 7.7
    close(S.fresnel(1).s, 0.43825914739035477, 1e-15);
    close(S.fresnel(-3).s, -S.fresnel(3).s, 1e-15);
    expect(S.fresnel(Infinity)).toEqual({ s: 0.5, c: 0.5 });
  });
});

describe('elliptic integrals (modulus k)', () => {
  it('complete integrals', () => {
    close(S.ellipK(0), Math.PI / 2, 1e-15);
    close(S.ellipE(0), Math.PI / 2, 1e-15);
    expect(S.ellipE(1)).toBe(1);
    close(S.ellipK(Math.SQRT1_2), 1.8540746773013719, 1e-15); // Γ(¼)²/(4√π)
    close(S.ellipE(Math.SQRT1_2), 1.3506438810476755, 1e-15);
    // Legendre's relation E K′ + E′ K − K K′ = π/2 (DLMF 19.7.1)
    for (const k of [0.1, 0.5, 0.95]) {
      const kp = Math.sqrt(1 - k * k);
      close(S.ellipE(k) * S.ellipK(kp) + S.ellipE(kp) * S.ellipK(k) - S.ellipK(k) * S.ellipK(kp), Math.PI / 2, 1e-14);
    }
    close(S.ellipPi(0, 0.6), S.ellipK(0.6), 1e-15);
    close(S.ellipPi(0.5, 0), Math.PI / (2 * Math.sqrt(0.5)), 1e-15); // Π(n, 0) = π / (2√(1 − n))
    // near k = 1: K = ln(4/k′) + k′²/4 (ln(4/k′) − 1) + O(k′⁴ ln k′) (DLMF 19.12.1)
    const k = 1 - 2 ** -30, kp = Math.sqrt((1 - k) * (1 + k));
    close(S.ellipK(k), Math.log(4 / kp) + ((kp * kp) / 4) * (Math.log(4 / kp) - 1), 1e-14);
  });
  it('incomplete integrals', () => {
    close(S.ellipF(Math.PI / 2, 0.7), S.ellipK(0.7), 1e-15);
    close(S.ellipF(0.6, 0), 0.6, 1e-15);
    close(S.ellipF(0.6, 1), Math.atanh(Math.sin(0.6)), 1e-14); // F(φ, 1) = artanh(sin φ)
    close(S.ellipEinc(0.6, 1), Math.sin(0.6), 1e-15); // E(φ, 1) = sin φ
    close(S.ellipF(Math.PI + 0.3, 0.5), 2 * S.ellipK(0.5) + S.ellipF(0.3, 0.5), 1e-15); // quasi-periodicity
    close(S.ellipPiInc(0, 1.1, 0.4), S.ellipF(1.1, 0.4), 1e-15);
  });
});

describe('Lambert W', () => {
  it('both real branches', () => {
    close(S.lambertW(1), 0.5671432904097838, 1e-15); // the omega constant
    close(S.lambertW(Math.E), 1, 1e-15);
    close(S.lambertW(-Math.LN2 / 2), -Math.LN2, 1e-15); // −ln2 · e^(−ln2) = −ln2/2
    close(S.lambertW(-Math.LN2 / 2, -1), -2 * Math.LN2, 1e-15);
    close(S.lambertW(-Math.exp(-1)), -1, 1e-7); // branch point: W ≈ −1 + √(2(ex + 1))
    for (const x of [1e-12, 0.3, 50, 1e10]) {
      const w = S.lambertW(x);
      close(w * Math.exp(w), x, 1e-14);
    }
    expect(() => S.lambertW(-0.5)).toThrow(/complex/);
  });
});

describe('orthogonal polynomials', () => {
  it('closed forms and identities', () => {
    for (const x of [-0.8, 0.13, 0.9]) {
      close(S.legendre(2, x), (3 * x * x - 1) / 2, 1e-15);
      close(S.legendre(25, 1), 1, 1e-15);
      close(S.assocLegendre(2, 1, x), -3 * x * Math.sqrt(1 - x * x), 1e-14); // with (−1)^m
      close(S.hermite(3, x), 8 * x ** 3 - 12 * x, 1e-14);
      close(S.laguerre(2, x), (x * x - 4 * x + 2) / 2, 1e-15);
      close(S.laguerre(2, x, 1.5), (x * x - 2 * 3.5 * x + 2.5 * 3.5) / 2, 1e-15);
      const th = Math.acos(x);
      // T₇(cos θ) = cos 7θ, U₆(cos θ) = sin 7θ / sin θ (absolute: the reference itself carries acos rounding)
      expect(Math.abs(S.chebT(7, x) - Math.cos(7 * th))).toBeLessThan(1e-14);
      expect(Math.abs(S.chebU(6, x) - Math.sin(7 * th) / Math.sin(th))).toBeLessThan(1e-13);
      expect(Math.abs(S.jacobiP(5, 0, 0, x) - S.legendre(5, x))).toBeLessThan(1e-15); // P_n^(0,0) = P_n (|P_n| ≤ 1)
      close(S.jacobiP(4, -0.5, -0.5, x), S.chebT(4, x) * (40320 / (256 * 576)), 1e-13); // DLMF 18.7.3
    }
  });
});
