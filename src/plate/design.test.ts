import { describe, it, expect } from 'vitest';
import { minimumSteel, principal, rebarProps, steelArea, surfaceStress, woodArmer } from './design';

describe('Wood–Armer moments', () => {
  it('hand cases (Wood 1968 rules)', () => {
    // m_x = 20, m_y = 10, m_xy = 5: bottom m* = m + |m_xy| = 25, 15; top m − |m_xy| > 0 both, so none
    expect(woodArmer(20, 10, 5)).toEqual({ xb: 25, yb: 15, xt: 0, yt: 0 });
    // m_x = 10, m_y = −8, m_xy = 6: bottom m*_y = −2 < 0 → 0 and m*_x = 10 + 6²/8 = 14.5;
    // top m*_x = 4 > 0 → 0 and m*_y = −8 − 6²/10 = −11.6
    const b = woodArmer(10, -8, 6);
    expect(b.xb).toBeCloseTo(14.5, 12);
    expect(b.yb).toBe(0);
    expect(b.xt).toBe(0);
    expect(b.yt).toBeCloseTo(-11.6, 12);
    // hogging both ways: no bottom steel, top −30 − 8 = −38 and −10 − 8 = −18
    expect(woodArmer(-30, -10, 8)).toEqual({ xb: 0, yb: 0, xt: -38, yt: -18 });
    // pure twist m_xy = 7: ±7 both ways at both faces
    expect(woodArmer(0, 0, 7)).toEqual({ xb: 7, yb: 7, xt: -7, yt: -7 });
  });

  it('covers the normal moment in every direction, and touches it (Johansen)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 200 - 100;
    for (let k = 0; k < 400; k++) {
      const mx = rnd(), my = rnd(), mxy = rnd() / 2;
      const w = woodArmer(mx, my, mxy);
      let slackB = Infinity, slackT = Infinity;
      for (let i = 0; i <= 720; i++) {
        const th = (i * Math.PI) / 720, c = Math.cos(th), s = Math.sin(th);
        const mn = mx * c * c + my * s * s + 2 * mxy * s * c;
        const capB = w.xb * c * c + w.yb * s * s, capT = w.xt * c * c + w.yt * s * s;
        expect(capB).toBeGreaterThanOrEqual(mn - 1e-9);
        expect(capT).toBeLessThanOrEqual(mn + 1e-9);
        slackB = Math.min(slackB, capB - mn);
        slackT = Math.min(slackT, mn - capT);
      }
      // the least such moments: the resistance meets m_n in some direction (unless none is needed)
      if (w.xb + w.yb > 0) expect(slackB).toBeLessThan(1e-2);
      if (w.xt + w.yt < 0) expect(slackT).toBeLessThan(1e-2);
    }
  });

  it('principal moments', () => {
    // m_x = 20, m_y = 10, m_xy = 5: 15 ± √(25 + 25), θ = ½ atan(10/10) = 22.5°
    const [m1, m2, th] = principal(20, 10, 5);
    expect(m1).toBeCloseTo(15 + Math.sqrt(50), 12);
    expect(m2).toBeCloseTo(15 - Math.sqrt(50), 12);
    expect((th * 180) / Math.PI).toBeCloseTo(22.5, 12);
  });
});

describe('EN 1992-1-1 slab reinforcement', () => {
  // C30/37, B500B, t = 250 mm, c = 30 mm, Ø12: d_x = 250 − 30 − 6 = 214 mm (outer), d_y = 202 mm
  const p = rebarProps({ concrete: 'C30/37', steel: 'B500B', t: 0.25, cover: 0.03, bar: 0.012 });

  it('depths and strengths', () => {
    expect(p.dx).toBeCloseTo(0.214, 12);
    expect(p.dy).toBeCloseTo(0.202, 12);
    expect(p.fcd / 1e6).toBeCloseTo(20, 9);
    expect(p.fyd / 1e6).toBeCloseTo(434.783, 3);
    // μ_lim at x/d = 0.45: 0.8 · 0.45 (1 − 0.4 · 0.45) = 0.2952
    expect(p.muLim).toBeCloseTo(0.2952, 4);
  });

  it('a_s = m / (0.9 d f_yd) for an ordinary moment', () => {
    // 50 kN·m/m: z = 0.9 · 214 = 192.6 mm, a_s = 50e3 / (0.1926 · 434.78e6) = 5.971 cm²/m (μ = 0.0546)
    const r = steelArea(50e3, p.dx, p);
    expect(r.as * 1e4).toBeCloseTo(5.971, 3);
    expect(r.mu).toBeCloseTo(50e3 / (0.214 ** 2 * 20e6), 9);
    expect(r.over).toBe(false);
  });

  it('a deeper compression zone shortens the lever arm', () => {
    // 250 kN·m/m: μ = 0.2729 > 0.18, z = d (1 + √(1 − 2μ))/2 = 0.8369 d = 179.1 mm, a_s = 32.10 cm²/m
    const r = steelArea(250e3, p.dx, p);
    const z = (0.214 * (1 + Math.sqrt(1 - 2 * r.mu))) / 2;
    expect(z / 0.214).toBeCloseTo(0.8369, 4);
    expect(r.as * 1e4).toBeCloseTo(250e3 / (z * p.fyd) * 1e4, 9);
    expect(r.as * 1e4).toBeCloseTo(32.1, 1);
    expect(r.over).toBe(false);
    // 300 kN·m/m is beyond μ_lim (0.3275 > 0.2952)
    expect(steelArea(300e3, p.dx, p).over).toBe(true);
  });

  it('a_s,min = 0.26 f_ctm / f_yk b d ≥ 0.0013 b d', () => {
    // f_ctm = 0.3 · 30^(2/3) = 2.8965 MPa: 0.26 · 2.8965 / 500 = 0.001506 > 0.0013 → 3.223 cm²/m at d = 214 mm
    expect(minimumSteel(p.dx, p) * 1e4).toBeCloseTo(3.223, 3);
    // C12/15: f_ctm = 1.5741 MPa, 0.26 · 1.5741/500 = 0.000819 < 0.0013 → 0.0013 d
    const low = rebarProps({ concrete: 'C12/15', steel: 'B500B', t: 0.25, cover: 0.03, bar: 0.012 });
    expect(minimumSteel(0.214, low)).toBeCloseTo(0.0013 * 0.214, 12);
  });

  it('the y bars outside instead', () => {
    const q = rebarProps({ concrete: 'C30/37', steel: 'B500B', t: 0.25, cover: 0.03, bar: 0.012, outer: 'y' });
    expect([q.dx, q.dy]).toEqual([0.202, 0.214].map((v) => expect.closeTo(v, 12)));
  });
});

describe('steel plates', () => {
  it('von Mises stress at the surface, σ = 6 m / t²', () => {
    // t = 20 mm, m_x = 10 kN·m/m alone: σ = 6 · 10e3 / 0.02² = 150 MPa; pure twist 5 kN·m/m: √3 · 75 MPa
    expect(surfaceStress(10e3, 0, 0, 0.02) / 1e6).toBeCloseTo(150, 9);
    expect(surfaceStress(0, 0, 5e3, 0.02) / 1e6).toBeCloseTo(Math.sqrt(3) * 75, 9);
    // equal biaxial bending: σ_v = σ
    expect(surfaceStress(10e3, 10e3, 0, 0.02) / 1e6).toBeCloseTo(150, 9);
  });
});
