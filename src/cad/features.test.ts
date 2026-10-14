import { describe, it, expect } from 'vitest';
import { extrudeProps, revolveProps } from './features';
import type { ProfileRegion, Seg } from './profile';

const poly = (...p: [number, number][]): ProfileRegion => ({
  outer: { segs: p.map(([x, y], i): Seg => ({ kind: 'line', a: { x, y }, b: { x: p[(i + 1) % p.length][0], y: p[(i + 1) % p.length][1] } })), entities: [] },
  holes: [],
});
const disc = (cx: number, cy: number, r: number): ProfileRegion => ({ outer: { segs: [{ kind: 'arc', c: { x: cx, y: cy }, r, a0: 0, a1: 2 * Math.PI }], entities: [] }, holes: [] });

describe('feature mass properties', () => {
  it('extrudes a rectangle into a box', () => {
    const m = extrudeProps([poly([0, 0], [100, 0], [100, 50], [0, 50])], 20)!;
    const V = 100 * 50 * 20;
    expect(m.V).toBeCloseTo(V, 8);
    expect([m.xg, m.yg, m.zg]).toEqual([50, 25, 10].map((v) => expect.closeTo(v, 9)));
    expect(m.Ixx).toBeCloseTo((V * (50 ** 2 + 20 ** 2)) / 12, 4);
    expect(m.Iyy).toBeCloseTo((V * (100 ** 2 + 20 ** 2)) / 12, 4);
    expect(m.Izz).toBeCloseTo((V * (100 ** 2 + 50 ** 2)) / 12, 4);
  });

  it('revolves a rectangle into a tube (closed form)', () => {
    // r from 10 to 20, height 30, about the y axis
    const m = revolveProps([poly([10, 0], [20, 0], [20, 30], [10, 30])], { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } }, 2 * Math.PI)!;
    const V = Math.PI * (20 ** 2 - 10 ** 2) * 30;
    expect(m.V).toBeCloseTo(V, 6);
    expect(m.xg).toBeCloseTo(0, 9);
    expect(m.yg).toBeCloseTo(15, 9);
    expect(m.zg).toBeCloseTo(0, 9);
    // tube about its own axis: V (r1² + r2²)/2; about a transverse centroidal axis: V (3(r1² + r2²) + h²)/12
    expect(m.Iyy).toBeCloseTo((V * (10 ** 2 + 20 ** 2)) / 2, 3);
    expect(m.Ixx).toBeCloseTo((V * (3 * (10 ** 2 + 20 ** 2) + 30 ** 2)) / 12, 3);
    expect(m.Izz).toBeCloseTo(m.Ixx, 3);
  });

  it('revolves a disc into a torus and handles a half turn', () => {
    const R = 40, r = 10;
    const full = revolveProps([disc(R, 0, r)], { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } }, 2 * Math.PI)!;
    expect(full.V).toBeCloseTo(2 * Math.PI ** 2 * R * r * r, 6);
    // torus about its symmetry axis: V (R² + 3r²/4)
    expect(full.Iyy).toBeCloseTo(full.V * (R * R + (3 * r * r) / 4), 2);
    const half = revolveProps([disc(R, 0, r)], { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } }, Math.PI)!;
    expect(half.V).toBeCloseTo(full.V / 2, 6);
    // half torus: centroid off the axis on the side the profile turns towards
    expect(Math.hypot(half.xg, half.zg)).toBeCloseTo((2 * (R * R + (r * r) / 4)) / (Math.PI * R), 6);
  });

  it('refuses a profile that crosses the axis', () => {
    expect(() => revolveProps([poly([-5, 0], [20, 0], [20, 30], [-5, 30])], { p: { x: 0, y: 0 }, d: { x: 0, y: 1 } }, 2 * Math.PI)).toThrow(/crosses/);
  });
});
