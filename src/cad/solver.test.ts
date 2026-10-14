import { describe, it, expect } from 'vitest';
import { solveSketch, measure } from './solver';
import { findProfiles, profileProperties } from './profile';
import type { CadConstraint, CadSketch } from './model';

/** A rough rectangle p1..p4 with lines b (bottom), r, t, l. */
function rect(): CadSketch {
  return {
    points: [
      { id: 'p1', x: 0, y: 0 }, { id: 'p2', x: 90, y: 3 }, { id: 'p3', x: 95, y: 45 }, { id: 'p4', x: -4, y: 52 },
    ],
    entities: [
      { id: 'b', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'r', type: 'line', p1: 'p2', p2: 'p3' },
      { id: 't', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l', type: 'line', p1: 'p4', p2: 'p1' },
    ],
    constraints: [
      { id: 'c1', type: 'horizontal', refs: ['b'] }, { id: 'c2', type: 'vertical', refs: ['r'] },
      { id: 'c3', type: 'horizontal', refs: ['t'] }, { id: 'c4', type: 'vertical', refs: ['l'] },
      { id: 'c5', type: 'fix', refs: ['p1'], at: { x: 0, y: 0 } },
    ],
  };
}

const dims = (...pairs: [string, number][]) => new Map(pairs);

describe('constraint solver', () => {
  it('solves a fully constrained rectangle and reports zero freedom', () => {
    const sk = rect();
    sk.constraints.push({ id: 'd1', type: 'length', refs: ['b'], value: '100' }, { id: 'd2', type: 'length', refs: ['l'], value: '50' });
    const res = solveSketch(sk, { values: dims(['d1', 100], ['d2', 50]) });
    expect(res.ok).toBe(true);
    expect(res.dof).toBe(0);
    expect(res.points.get('p3')!.x).toBeCloseTo(100, 9);
    expect(res.points.get('p3')!.y).toBeCloseTo(50, 9);
    expect([...res.determined].sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('counts the freedom that is left and which points can still move', () => {
    const sk = rect();
    sk.constraints.push({ id: 'd1', type: 'length', refs: ['b'], value: '100' });
    const res = solveSketch(sk, { values: dims(['d1', 100]) });
    expect(res.ok).toBe(true);
    expect(res.dof).toBe(1); // the height
    expect(res.determined.has('p2')).toBe(true);
    expect(res.determined.has('p3')).toBe(false);
  });

  it('separates conflicting from redundant constraints', () => {
    const conflict = rect();
    conflict.constraints.push(
      { id: 'd1', type: 'length', refs: ['b'], value: '100' }, { id: 'd2', type: 'length', refs: ['l'], value: '50' },
      { id: 'd3', type: 'length', refs: ['t'], value: '80' },
    );
    const a = solveSketch(conflict, { values: dims(['d1', 100], ['d2', 50], ['d3', 80]) });
    expect(a.ok).toBe(false);
    expect(a.conflicting).toContain('d3');

    const redundant = rect();
    redundant.constraints.push({ id: 'par', type: 'parallel', refs: ['b', 't'] });
    const b = solveSketch(redundant);
    expect(b.ok).toBe(true);
    expect(b.redundant).toEqual(['par']);
  });

  it('makes a line tangent to a circle', () => {
    const sk: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: -50, y: 30 }, { id: 'b', x: 50, y: 25 }],
      entities: [{ id: 'k', type: 'circle', c: 'c', r: 10 }, { id: 'ln', type: 'line', p1: 'a', p2: 'b' }],
      constraints: [
        { id: 'f', type: 'fix', refs: ['c'], at: { x: 0, y: 0 } },
        { id: 'h', type: 'horizontal', refs: ['ln'] },
        { id: 'tg', type: 'tangent', refs: ['ln', 'k'] },
        { id: 'r', type: 'radius', refs: ['k'], value: '20' },
      ],
    };
    const res = solveSketch(sk, { values: dims(['r', 20]) });
    expect(res.ok).toBe(true);
    expect(res.radii.get('k')).toBeCloseTo(20, 9);
    expect(res.points.get('a')!.y).toBeCloseTo(20, 8);
    expect(res.points.get('b')!.y).toBeCloseTo(20, 8);
  });

  it('holds angles and measures them between undirected lines', () => {
    const sk: CadSketch = {
      points: [{ id: 'o', x: 0, y: 0 }, { id: 'a', x: 100, y: 5 }, { id: 'b', x: 60, y: 60 }],
      entities: [{ id: 'l1', type: 'line', p1: 'o', p2: 'a' }, { id: 'l2', type: 'line', p1: 'o', p2: 'b' }],
      constraints: [
        { id: 'f', type: 'fix', refs: ['o'], at: { x: 0, y: 0 } },
        { id: 'h', type: 'horizontal', refs: ['l1'] },
        { id: 'ang', type: 'angle', refs: ['l1', 'l2'], value: '30' },
      ],
    };
    const res = solveSketch(sk, { values: dims(['ang', Math.PI / 6]) });
    expect(res.ok).toBe(true);
    const b = res.points.get('b')!;
    expect(Math.atan2(b.y, b.x)).toBeCloseTo(Math.PI / 6, 9);
    expect(measure(sk, sk.constraints[2] as CadConstraint, res.points)).toBeCloseTo(Math.PI / 6, 9);
  });

  it('drags free geometry exactly and constrained geometry as close as it can go', () => {
    const sk = rect();
    sk.constraints.push({ id: 'd1', type: 'length', refs: ['b'], value: '100' });
    // the top edge can move up and down only
    const res = solveSketch(sk, { values: dims(['d1', 100]), drag: new Map([['p3', { x: 120, y: 70 }]]) });
    expect(res.ok).toBe(true);
    expect(res.points.get('p3')!.x).toBeCloseTo(100, 7);
    expect(res.points.get('p3')!.y).toBeCloseTo(70, 4);
    expect(res.points.get('p4')!.y).toBeCloseTo(70, 4);
  });

  it('keeps arc ends on their circle and handles symmetry and midpoints', () => {
    const sk: CadSketch = {
      points: [{ id: 'c', x: 0, y: 0 }, { id: 'a', x: 30, y: 2 }, { id: 'b', x: -28, y: 5 }, { id: 'm', x: 3, y: -40 }, { id: 'n', x: 0, y: 40 }],
      entities: [{ id: 'arc', type: 'arc', c: 'c', p1: 'a', p2: 'b' }, { id: 'ax', type: 'line', p1: 'm', p2: 'n', construction: true }],
      constraints: [
        { id: 'f', type: 'fix', refs: ['c'], at: { x: 0, y: 0 } },
        { id: 'v', type: 'vertical', refs: ['ax'] },
        { id: 'mid', type: 'midpoint', refs: ['c', 'ax'] },
        { id: 'sym', type: 'symmetric', refs: ['a', 'b', 'ax'] },
        { id: 'r', type: 'radius', refs: ['arc'], value: '25' },
      ],
    };
    const res = solveSketch(sk, { values: dims(['r', 25]) });
    expect(res.ok).toBe(true);
    const a = res.points.get('a')!, b = res.points.get('b')!;
    expect(Math.hypot(a.x, a.y)).toBeCloseTo(25, 8);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(25, 8);
    expect(a.x).toBeCloseTo(-b.x, 8);
    expect(a.y).toBeCloseTo(b.y, 8);
    expect(res.points.get('m')!.x).toBeCloseTo(0, 8);
  });
});

describe('profiles', () => {
  it('finds a plate with a hole and integrates it exactly', () => {
    const sk: CadSketch = {
      points: [
        { id: 'p1', x: 0, y: 0 }, { id: 'p2', x: 100, y: 0 }, { id: 'p3', x: 100, y: 50 }, { id: 'p4', x: 0, y: 50 }, { id: 'c', x: 30, y: 25 },
      ],
      entities: [
        { id: 'b', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'r', type: 'line', p1: 'p2', p2: 'p3' },
        { id: 't', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l', type: 'line', p1: 'p4', p2: 'p1' },
        { id: 'h', type: 'circle', c: 'c', r: 10 },
      ],
      constraints: [],
    };
    const { regions, issues } = findProfiles(sk);
    expect(issues).toEqual([]);
    expect(regions.length).toBe(1);
    expect(regions[0].holes.length).toBe(1);
    const p = profileProperties(regions)!;
    const A = 5000 - Math.PI * 100;
    expect(p.A).toBeCloseTo(A, 9);
    expect(p.xc).toBeCloseTo((5000 * 50 - Math.PI * 100 * 30) / A, 9);
    expect(p.yc).toBeCloseTo(25, 9);
    expect(p.Ix).toBeCloseTo((100 * 50 ** 3) / 12 - (Math.PI * 10 ** 4) / 4, 6);
  });

  it('integrates arcs exactly (slot) and reports open outlines', () => {
    // slot: two lines and two half circles, width 20, straight length 60
    const sk: CadSketch = {
      points: [
        { id: 'a', x: 0, y: -10 }, { id: 'b', x: 60, y: -10 }, { id: 'c', x: 60, y: 10 }, { id: 'd', x: 0, y: 10 },
        { id: 'k1', x: 60, y: 0 }, { id: 'k2', x: 0, y: 0 }, { id: 'o1', x: 200, y: 0 }, { id: 'o2', x: 250, y: 0 },
      ],
      entities: [
        { id: 'l1', type: 'line', p1: 'a', p2: 'b' }, { id: 'arc1', type: 'arc', c: 'k1', p1: 'b', p2: 'c' },
        { id: 'l2', type: 'line', p1: 'c', p2: 'd' }, { id: 'arc2', type: 'arc', c: 'k2', p1: 'd', p2: 'a' },
        { id: 'stray', type: 'line', p1: 'o1', p2: 'o2' },
      ],
      constraints: [],
    };
    const { regions, issues } = findProfiles(sk);
    expect(regions.length).toBe(1);
    expect(issues).toEqual(['1 outline is not closed']);
    const p = profileProperties(regions)!;
    expect(p.A).toBeCloseTo(60 * 20 + Math.PI * 100, 10);
    expect(p.xc).toBeCloseTo(30, 10);
    // Iy about the centroid: rectangle + two half discs shifted by ±30 (+ their own centroid offset)
    const r = 10, half = (Math.PI * r * r) / 2, e = (4 * r) / (3 * Math.PI);
    const IyHalf = (Math.PI * r ** 4) / 8 - half * e * e + half * (30 + e) ** 2;
    expect(p.Iy).toBeCloseTo((20 * 60 ** 3) / 12 + 2 * IyHalf, 6);
  });
});
