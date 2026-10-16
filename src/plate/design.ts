// Design values from a plate's moments: principal moments, Wood–Armer moments for
// reinforcement along x and y, the reinforcement they need by EN 1992-1-1, and the surface
// stress of a steel plate. Moments in N·m/m, sagging positive (tension at the bottom).
import { concreteGrade, rebarGrade } from '../engine/materials';

/** Principal moments m₁ ≥ m₂ and the angle of m₁ from x (radians). */
export function principal(mx: number, my: number, mxy: number): [number, number, number] {
  const c = (mx + my) / 2, r = Math.hypot((mx - my) / 2, mxy);
  return [c + r, c - r, 0.5 * Math.atan2(2 * mxy, mx - my)];
}

/**
 * Wood–Armer moments (Wood 1968, Armer 1968): the least reinforcement moments along x and
 * y whose resistance m*_x cos²θ + m*_y sin²θ covers the normal moment m_n(θ) in every
 * direction θ (Johansen's criterion), at the bottom (≥ 0, for sagging) and the top (≤ 0).
 */
export function woodArmer(mx: number, my: number, mxy: number): { xb: number; yb: number; xt: number; yt: number } {
  const t = Math.abs(mxy);
  let xb = mx + t, yb = my + t;
  if (xb < 0) {
    xb = 0;
    yb = my + Math.abs((mxy * mxy) / mx);
  } else if (yb < 0) {
    yb = 0;
    xb = mx + Math.abs((mxy * mxy) / my);
  }
  let xt = mx - t, yt = my - t;
  if (xt > 0) {
    xt = 0;
    yt = my - Math.abs((mxy * mxy) / mx);
  } else if (yt > 0) {
    yt = 0;
    xt = mx - Math.abs((mxy * mxy) / my);
  }
  return { xb: Math.max(0, xb), yb: Math.max(0, yb), xt: Math.min(0, xt), yt: Math.min(0, yt) };
}

/** Reinforcement data of a concrete slab, SI (m, Pa). */
export interface RebarDesign {
  /** Concrete class (C30/37) and reinforcement (B500B). */
  concrete: string;
  steel: string;
  /** Slab thickness, cover to the outer bars, bar diameter (m). */
  t: number;
  cover: number;
  bar: number;
  /** Which direction lies in the outer layer (top and bottom); the other is one bar further in. */
  outer?: 'x' | 'y';
  /** Partial factors and α_cc (EN 1992-1-1 2.4.2.4, 3.1.6: recommended 1.5, 1.15, 1.0). */
  gammaC?: number;
  gammaS?: number;
  alphaCC?: number;
}

export interface RebarProps {
  fcd: number;
  fyd: number;
  fctm: number;
  fyk: number;
  /** Effective depths of the x and y bars (m). */
  dx: number;
  dy: number;
  /** Stress block: λ, η (3.1.7(3)) and the limit μ at x/d = 0.45 (≤ C50/60) or 0.35 (5.6.3(2)). */
  lambda: number;
  eta: number;
  muLim: number;
}

export function rebarProps(r: RebarDesign): RebarProps {
  const c = concreteGrade(r.concrete), s = rebarGrade(r.steel);
  const fck = c.f_ck * 1e6;
  const fcd = ((r.alphaCC ?? 1) * fck) / (r.gammaC ?? 1.5), fyd = (s.f_yk * 1e6) / (r.gammaS ?? 1.15);
  const lambda = c.f_ck <= 50 ? 0.8 : 0.8 - (c.f_ck - 50) / 400, eta = c.f_ck <= 50 ? 1 : 1 - (c.f_ck - 50) / 200;
  const xi = c.f_ck <= 50 ? 0.45 : 0.35;
  const outer = r.t - r.cover - r.bar / 2, inner = outer - r.bar;
  if (!(inner > 0)) throw new Error('The slab is too thin for its cover and bars');
  const xOuter = (r.outer ?? 'x') === 'x';
  return {
    fcd, fyd, fctm: c.f_ctm * 1e6, fyk: s.f_yk * 1e6, dx: xOuter ? outer : inner, dy: xOuter ? inner : outer,
    lambda, eta, muLim: lambda * xi * (1 - (lambda * xi) / 2),
  };
}

/**
 * Bending reinforcement per metre for a design moment m ≥ 0 (N·m/m) at depth d:
 * a_s = m / (z f_yd) with the simplified lever arm z = 0.9 d, or the rectangular stress
 * block's z = d (1 + √(1 − 2μ))/2 where the compression zone is deeper (μ = m/(d² η f_cd)
 * > 0.18, where that z drops below 0.9 d). Above μ_lim the section needs compression
 * reinforcement or more depth: `over`.
 */
export function steelArea(m: number, d: number, p: RebarProps): { as: number; mu: number; over: boolean } {
  if (!(m > 0)) return { as: 0, mu: 0, over: false };
  const mu = m / (d * d * p.eta * p.fcd);
  const z = Math.min(0.9 * d, mu < 0.5 ? (d * (1 + Math.sqrt(1 - 2 * mu))) / 2 : d / 2);
  return { as: m / (z * p.fyd), mu, over: mu > p.muLim };
}

/** EN 1992-1-1 9.3.1.1(1) with 9.2.1.1(1): a_s,min = 0.26 f_ctm/f_yk b d ≥ 0.0013 b d, per metre (m²/m). */
export const minimumSteel = (d: number, p: RebarProps) => Math.max((0.26 * p.fctm) / p.fyk, 0.0013) * d;

/** Von Mises stress at the faces of a steel plate: σ = 6 m / t² (Pa). */
export function surfaceStress(mx: number, my: number, mxy: number, t: number): number {
  const k = 6 / (t * t), sx = k * mx, sy = k * my, txy = k * mxy;
  return Math.sqrt(sx * sx + sy * sy - sx * sy + 3 * txy * txy);
}
