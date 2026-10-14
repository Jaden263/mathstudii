import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type CadRegion, type Region } from '../model/types';
import type { CadSketch } from './model';

/** 4 lines around a rough rectangle with a hole; dimensions come from the worksheet. */
function plateSketch(): CadSketch {
  return {
    points: [
      { id: 'p1', x: 0, y: 0 }, { id: 'p2', x: 80, y: 0 }, { id: 'p3', x: 80, y: 40 }, { id: 'p4', x: 0, y: 40 }, { id: 'c', x: 40, y: 20 },
    ],
    entities: [
      { id: 'b', type: 'line', p1: 'p1', p2: 'p2' }, { id: 'r', type: 'line', p1: 'p2', p2: 'p3' },
      { id: 't', type: 'line', p1: 'p3', p2: 'p4' }, { id: 'l', type: 'line', p1: 'p4', p2: 'p1' },
      { id: 'h', type: 'circle', c: 'c', r: 8 },
    ],
    constraints: [
      { id: 'k1', type: 'horizontal', refs: ['b'] }, { id: 'k2', type: 'vertical', refs: ['r'] },
      { id: 'k3', type: 'horizontal', refs: ['t'] }, { id: 'k4', type: 'vertical', refs: ['l'] },
      { id: 'k5', type: 'fix', refs: ['p1'], at: { x: 0, y: 0 } },
      { id: 'd1', type: 'length', refs: ['b'], value: 'B', name: 'd1' },
      { id: 'd2', type: 'length', refs: ['l'], value: '50 mm', name: 'H' },
      { id: 'd3', type: 'diameter', refs: ['h'], value: 'D', name: 'D' },
      { id: 'd4', type: 'distanceX', refs: ['p1', 'c'], value: 'B/2' },
      { id: 'd5', type: 'distanceY', refs: ['p1', 'c'], value: '25' },
      { id: 'ref', type: 'distance', refs: ['p1', 'p3'], driving: false, name: 'diag' },
    ],
  };
}

function worksheet(extra: Partial<CadRegion> = {}): { ws: ReturnType<typeof emptyWorksheet>; cad: CadRegion; maths: Region[] } {
  const ws = emptyWorksheet();
  const pre = ['B := 0.12 m', 'D := 20 mm', 'T := 10 mm'].map((s, i) => createRegion('math', 20, 20 + 30 * i, { source: s }));
  const cad = createRegion('cad', 20, 120, { name: 'plate', sketch: plateSketch(), feature: { type: 'extrude', depth: 'T' }, ...extra }) as CadRegion;
  const maths = ['plate.A = mm^2', 'plate.V = cm^3', 'plate.m = kg', 'plate.d1 = mm', 'plate.D = mm', 'plate.diag = mm', 'plate.dof =', 'plate.Ix = cm^4']
    .map((s, i) => createRegion('math', 20, 500 + 30 * i, { source: s }));
  ws.regions = [...pre, cad, ...maths];
  return { ws, cad, maths };
}

const tex = (out: ReturnType<typeof evaluateWorksheet>, r: Region) => {
  const res = out.results.get(r.id) as MathResult;
  expect(res.error, (r as { source: string }).source).toBeUndefined();
  return res.tex;
};

describe('CAD region in a worksheet', () => {
  it('takes dimensions from worksheet variables and exports the part', () => {
    const { ws, cad, maths } = worksheet();
    const out = evaluateWorksheet(ws);
    const res = out.results.get(cad.id) as CadResult;
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(res.dof).toBe(0);
    expect(res.points.p3).toEqual([expect.closeTo(120, 8), expect.closeTo(50, 8)]);
    const A = 120 * 50 - Math.PI * 100;
    expect(res.section!.A).toBeCloseTo(A, 8);
    expect(res.mass!.V).toBeCloseTo(A * 10, 6);
    expect(res.mass!.m).toBeCloseTo(A * 10 * 7850e-9, 9);
    expect(tex(out, maths[0])).toContain('5685.84');
    expect(tex(out, maths[1])).toContain('56.8584');
    expect(tex(out, maths[2])).toContain('0.4463');
    expect(tex(out, maths[3])).toContain('120');
    expect(tex(out, maths[4])).toContain('20');
    expect(tex(out, maths[5])).toContain('130'); // √(120² + 50²)
    expect(tex(out, maths[6])).toMatch(/= 0/);
  });

  it('reports bad dimension expressions and feature problems without failing the worksheet', () => {
    const { ws, cad } = worksheet({ feature: { type: 'revolve', axis: 'y', angle: '360' } });
    (cad.sketch.constraints.find((c) => c.id === 'd3')!).value = 'D_missing';
    // plate starting at x = 0 touches the y axis: still one side, so it revolves
    const out = evaluateWorksheet(ws);
    const res = out.results.get(cad.id) as CadResult;
    expect(res.dimErrors.d3).toMatch(/D_missing/);
    expect(res.dof).toBe(1); // the hole diameter is free now
    expect(res.featureError).toBeUndefined();
    expect(res.mass!.V).toBeGreaterThan(0);
    cad.feature = { type: 'revolve', axis: 'x', angle: 'D' };
    const bad = evaluateWorksheet(ws).results.get(cad.id) as CadResult;
    expect(bad.featureError).toMatch(/angle/);
  });
});
