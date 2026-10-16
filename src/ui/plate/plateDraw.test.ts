import { describe, it, expect } from 'vitest';
import { bandPaths, colorOf, displayUnit, makeScale, niceStep } from './plateDraw';

describe('plate contours', () => {
  it('a field of both signs: symmetric bands about a grey middle band', () => {
    const sc = makeScale(-12, 47.9, false);
    expect(sc.diverging).toBe(true);
    // step 5 (47.9 / 5 → 9.6 → 5): edges −12.5 … −2.5, 2.5 … 47.5 … to cover 47.9: 52.5
    expect(sc.levels[0]).toBeLessThanOrEqual(-12);
    expect(sc.levels.at(-1)).toBeGreaterThanOrEqual(47.9);
    expect(sc.levels).toContain(-2.5);
    expect(sc.levels).toContain(2.5);
    expect(sc.colors.length).toBe(sc.levels.length - 1);
    expect(colorOf(sc, 0)).toBe('#f0efec');
    // the two arms are mirror steps: −5 and +5 sit at the same lightness step
    const iNeg = sc.levels.findIndex((l) => l >= -5) - 1, iPos = sc.levels.findIndex((l) => l >= 5) - 1;
    expect(sc.colors[iNeg].startsWith('#')).toBe(true);
    expect(sc.colors[iNeg]).not.toBe(sc.colors[iPos]);
  });

  it('a field of one sign: one hue from zero, darker for more (and the other way on a dark page)', () => {
    const light = makeScale(0, 8.3, false), dark = makeScale(0, 8.3, true);
    expect(light.diverging).toBe(false);
    expect(light.levels[0]).toBe(0);
    expect(light.levels.at(-1)).toBeGreaterThanOrEqual(8.3);
    expect(light.colors[0]).toBe('#b7d3f6');
    expect(dark.colors[0]).not.toBe(light.colors[0]);
    expect(niceStep(0.83)).toBe(1);
    expect(niceStep(0.21)).toBe(0.2);
  });

  it('bands cover every element exactly once', () => {
    // one unit square, field = x: bands at 0.25 must split the area 0.25 per band of width 0.25
    const mesh = { x: [0, 1, 1, 0], y: [0, 0, 1, 1], quads: [0, 1, 2, 3] };
    const sc = { levels: [0, 0.25, 0.5, 0.75, 1], colors: ['a', 'b', 'c', 'd'], diverging: false };
    const paths = bandPaths(mesh, [0, 1, 1, 0], false, 1, sc, (x, y) => [x * 100, y * 100]);
    const area = (d: string) => d.split('Z').filter(Boolean).reduce((s, part) => {
      const p = part.replace('M', '').split('L').map((q) => q.trim().split(' ').map(Number));
      let a = 0;
      for (let i = 0; i < p.length; i++) a += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
      return s + Math.abs(a) / 2;
    }, 0);
    for (const d of paths) expect(area(d)).toBeCloseTo(2500, 6);
  });

  it('display units', () => {
    expect(displayUnit({ forceUnit: 'kN', lengthUnit: 'm' }, 'moment')).toEqual({ k: 1e-3, unit: 'kN·m/m' });
    expect(displayUnit({ forceUnit: 'kN', lengthUnit: 'm' }, 'shear')).toEqual({ k: 1e-3, unit: 'kN/m' });
    expect(displayUnit({ forceUnit: 'kN', lengthUnit: 'mm' }, 'shear').k).toBeCloseTo(1e-6, 15);
  });
});
