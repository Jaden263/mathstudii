import { describe, it, expect } from 'vitest';
import { constraintFromSelection, dimensionFromSelection, hitTest, localValues, solveLocal, type Geo } from './edit';
import type { CadSketch } from './model';

function geo(): Geo {
  const sk: CadSketch = {
    points: [
      { id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 2 }, { id: 'c', x: 98, y: 50 }, { id: 'k', x: 50, y: 25 }, { id: 'q', x: 120, y: 80 },
    ],
    entities: [
      { id: 'l1', type: 'line', p1: 'a', p2: 'b' }, { id: 'l2', type: 'line', p1: 'b', p2: 'c' },
      { id: 'o1', type: 'circle', c: 'k', r: 10 }, { id: 'o2', type: 'circle', c: 'q', r: 5 },
    ],
    constraints: [],
  };
  return { sk, P: new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }])), R: new Map([['o1', 10], ['o2', 5]]) };
}

describe('CAD editing', () => {
  it('builds constraints from what is selected, or says what is missing', () => {
    const g = geo();
    expect(constraintFromSelection('horizontal', g, ['l1'])).toMatchObject([{ type: 'horizontal', refs: ['l1'] }]);
    expect(constraintFromSelection('perpendicular', g, ['l1', 'l2'])).toMatchObject([{ type: 'perpendicular', refs: ['l1', 'l2'] }]);
    expect(constraintFromSelection('coincident', g, ['q', 'l1'])).toMatchObject([{ type: 'pointOnLine', refs: ['q', 'l1'] }]);
    expect(constraintFromSelection('equal', g, ['o1', 'o2'])).toMatchObject([{ type: 'equal', refs: ['o1', 'o2'] }]);
    expect(constraintFromSelection('tangent', g, ['o1', 'o2'])).toMatchObject([{ type: 'tangent', mode: 'ext' }]);
    expect(constraintFromSelection('fix', g, ['l1'])).toMatchObject([{ type: 'fix', refs: ['a'], at: { x: 0, y: 0 } }, { type: 'fix', refs: ['b'] }]);
    expect(constraintFromSelection('parallel', g, ['l1'])).toBe('Select two lines');
  });

  it('creates dimensions valued at the current geometry', () => {
    const g = geo();
    expect(dimensionFromSelection(g, ['l1'])).toMatchObject({ type: 'length', value: String(+Math.hypot(100, 2).toPrecision(6)), name: 'd1' });
    expect(dimensionFromSelection(g, ['o1'])).toMatchObject({ type: 'diameter', value: '20' });
    expect(dimensionFromSelection(g, ['b', 'a'], 'horizontal')).toMatchObject({ type: 'distanceX', refs: ['a', 'b'], value: '100' });
    expect(dimensionFromSelection(g, ['l1', 'l2'])).toMatchObject({ type: 'angle' });
    expect(typeof dimensionFromSelection(g, ['o1', 'o2'])).toBe('string');
  });

  it('solves locally with plain values and keeps worksheet-driven ones', () => {
    const g = geo();
    g.sk.constraints.push(
      { id: 'h', type: 'horizontal', refs: ['l1'] },
      { id: 'd1', type: 'length', refs: ['l1'], value: '80 mm' },
      { id: 'd2', type: 'diameter', refs: ['o1'], value: 'D_hole' },
    );
    const vals = localValues(g.sk, 'mm', { d2: 30 });
    expect(vals.get('d1')).toBeCloseTo(80, 12);
    expect(vals.get('d2')).toBe(30);
    const next = solveLocal(g.sk, 'mm', { d2: 30 });
    const a = next.points.find((p) => p.id === 'a')!, b = next.points.find((p) => p.id === 'b')!;
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(80, 6);
    expect(b.y - a.y).toBeCloseTo(0, 6);
    expect((next.entities.find((e) => e.id === 'o1') as { r: number }).r).toBeCloseTo(15, 6);
  });

  it('hits points before curves', () => {
    const g = geo();
    expect(hitTest(g, { x: 1, y: 0.5 }, 3)).toEqual({ kind: 'point', id: 'a' });
    expect(hitTest(g, { x: 50, y: 2 }, 3)).toEqual({ kind: 'entity', id: 'l1' });
    expect(hitTest(g, { x: 60, y: 25.5 }, 3)).toEqual({ kind: 'entity', id: 'o1' });
    expect(hitTest(g, { x: 300, y: 300 }, 3)).toBeNull();
  });
});
