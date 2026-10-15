import { describe, expect, it } from 'vitest';
import { kernel, Arena, type Frame } from './solid';
import { thinExtrude, shapedExtrude, loftSolid } from './shaping';
import type { ProfileRegion } from './profile';

const XY: Frame = { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
const rect = (w: number, h: number, hole?: number): ProfileRegion => {
  const P = (x: number, y: number) => ({ x, y });
  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ kind: 'line' as const, a, b });
  const pts = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  const outer = { segs: pts.map((p, i) => line(p, pts[(i + 1) % 4])), entities: ['a', 'b', 'c', 'd'] };
  const holes = hole ? [{ segs: [{ kind: 'arc' as const, c: P(w / 2, h / 2), r: hole, a0: 0, a1: 2 * Math.PI }], entities: ['h'] }] : [];
  return { outer, holes } as unknown as ProfileRegion;
};

describe('shaping', () => {
  it('thin extrude: a box with an open top', () => {
    const K = kernel()!;
    const arena = new Arena();
    const m = thinExtrude(K, arena, [rect(100, 60)], XY, 0, 40, { t: 2, side: 'inside', cap: 'start' });
    // walls 2 thick, bottom 2 thick: 100·60·40 − 96·56·38
    expect(m.volume()).toBeCloseTo(100 * 60 * 40 - 96 * 56 * 38, 0);
    arena.free();
  });

  it('chamfered and filleted top edges', () => {
    const K = kernel()!;
    const arena = new Arena();
    const ch = shapedExtrude(K, arena, [rect(100, 60)], XY, 0, 20, undefined, { type: 'chamfer', r: 5 });
    // the chamfered top 5 mm is a prismatoid: h/6 (A1 + 4 Am + A2)
    const top = (5 / 6) * (100 * 60 + 4 * 95 * 55 + 90 * 50);
    expect(ch.volume()).toBeCloseTo(100 * 60 * 15 + top, 0);
    const fi = shapedExtrude(K, arena, [rect(100, 60, 10)], XY, 0, 20, { type: 'fillet', r: 3 }, { type: 'fillet', r: 3 });
    expect(fi.status()).toBe('NoError');
    expect(fi.volume()).toBeLessThan((100 * 60 - Math.PI * 100) * 20);
    expect(fi.volume()).toBeGreaterThan((100 * 60 - Math.PI * 100) * 20 * 0.95);
    expect(() => shapedExtrude(K, arena, [rect(10, 10)], XY, 0, 20, undefined, { type: 'fillet', r: 8 })).toThrow(/too large|fit/);
    arena.free();
  });

  it('lofts a square into a circle', () => {
    const K = kernel()!;
    const arena = new Arena();
    const top: Frame = { o: [0, 0, 50], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
    const circ = { outer: { segs: [{ kind: 'arc', c: { x: 50, y: 30 }, r: 20, a0: 0, a1: 2 * Math.PI }], entities: ['c'] }, holes: [] } as unknown as ProfileRegion;
    const m = loftSolid(K, arena, { region: rect(100, 60), frame: XY }, { region: circ, frame: top });
    expect(m.status()).toBe('NoError');
    const v = m.volume();
    // between the frustum-like bounds of a 6000 mm² and a 1257 mm² end over 50 mm
    expect(v).toBeGreaterThan(50 * 1257);
    expect(v).toBeLessThan(50 * 6000);
    arena.free();
  });
});
