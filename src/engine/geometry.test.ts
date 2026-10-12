import { describe, it, expect } from 'vitest';
import { templatePrimitives, placePrimitives, sectionProperties, type Primitive } from './geometry';

const close = (a: number, b: number, rel = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(b)));

describe('section properties', () => {
  it('rectangle', () => {
    const p = sectionProperties(templatePrimitives('rect', { b: 200, h: 400 }))!;
    close(p.A, 80000);
    close(p.Ix, (200 * 400 ** 3) / 12);
    close(p.Iy, (400 * 200 ** 3) / 12);
    close(p.Wx, (200 * 400 ** 2) / 6);
    close(p.Ixy, 0);
    close(p.xc, 0);
    close(p.yc, 0);
  });

  it('circle and tube', () => {
    const c = sectionProperties(templatePrimitives('circle', { d: 200 }))!;
    close(c.A, Math.PI * 100 ** 2);
    close(c.Ix, (Math.PI * 200 ** 4) / 64);
    close(c.J, (Math.PI * 200 ** 4) / 32);
    const t = sectionProperties(templatePrimitives('tube', { d: 168.3, t: 8 }))!;
    close(t.A, (Math.PI / 4) * (168.3 ** 2 - 152.3 ** 2));
    close(t.Ix, (Math.PI / 64) * (168.3 ** 4 - 152.3 ** 4));
  });

  it('I beam (IPE 300 without root radii)', () => {
    const p = sectionProperties(templatePrimitives('I', { h: 300, b: 150, tw: 7.1, tf: 10.7 }))!;
    close(p.A, 2 * 150 * 10.7 + (300 - 2 * 10.7) * 7.1);
    close(p.Ix, (150 * 300 ** 3 - (150 - 7.1) * (300 - 2 * 10.7) ** 3) / 12);
    close(p.Iy, (2 * 10.7 * 150 ** 3 + (300 - 2 * 10.7) * 7.1 ** 3) / 12);
  });

  it('T section centroid', () => {
    const h = 200, b = 200, tw = 10, tf = 15;
    const p = sectionProperties(templatePrimitives('T', { h, b, tw, tf }))!;
    const Af = b * tf, Aw = tw * (h - tf);
    const yf = h / 2 - tf / 2, yw = -h / 2 + (h - tf) / 2;
    close(p.A, Af + Aw);
    close(p.yc, (Af * yf + Aw * yw) / (Af + Aw));
    const yc = p.yc;
    close(p.Ix, (b * tf ** 3) / 12 + Af * (yf - yc) ** 2 + (tw * (h - tf) ** 3) / 12 + Aw * (yw - yc) ** 2);
  });

  it('equal angle has principal axes at ±45°', () => {
    const p = sectionProperties(templatePrimitives('L', { h: 100, b: 100, t: 10 }))!;
    expect(Math.abs(Math.abs(p.theta) - 45)).toBeLessThan(1e-9);
    expect(p.I1).toBeGreaterThan(p.Ix);
    expect(p.I2).toBeLessThan(p.Iy);
    close(p.I1 + p.I2, p.Ix + p.Iy);
  });

  it('rotation swaps Ix and Iy; translation moves the centroid', () => {
    const base = templatePrimitives('rect', { b: 100, h: 300 });
    const p = sectionProperties(placePrimitives(base, { x: 50, y: -20 }, 90))!;
    close(p.Ix, (100 * 300 ** 3) / 12 * ((100 * 100) / (300 * 300)));
    close(p.Iy, (100 * 300 ** 3) / 12);
    close(p.xc, 50);
    close(p.yc, -20);
  });

  it('holes subtract, regardless of outline orientation', () => {
    const cw: Primitive = { kind: 'poly', sign: 1, pts: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }] };
    const hole: Primitive = { kind: 'circle', sign: -1, c: { x: 5, y: 5 }, r: 2 };
    const p = sectionProperties([cw, hole])!;
    close(p.A, 100 - Math.PI * 4);
    close(p.xc, 5);
    close(p.Ix, 10 ** 4 / 12 - (Math.PI * 2 ** 4) / 4);
  });

  it('rejects impossible dimensions', () => {
    expect(() => templatePrimitives('tube', { d: 10, t: 6 })).toThrow(/wall/);
    expect(() => templatePrimitives('rect', { b: -1, h: 2 })).toThrow(/positive/);
  });
});
