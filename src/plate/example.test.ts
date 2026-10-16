import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type MathResult, type PlateResult } from '../engine/evaluator';
import { plateExample } from '../model/examples';

describe('the flat slab example', () => {
  it('evaluates without errors and its checks hold', () => {
    const ws = plateExample();
    const out = evaluateWorksheet(ws);
    const plate = ws.regions.find((r) => r.kind === 'plate')!;
    const res = out.results.get(plate.id) as PlateResult;
    expect(res.error).toBeUndefined();
    expect(Object.keys(res.errors)).toEqual([]);
    for (const r of ws.regions) {
      const m = out.results.get(r.id) as MathResult | undefined;
      if (r.kind !== 'math' || !m) continue;
      expect(m.error, r.source).toBeUndefined();
      if (m.check) expect(m.check.ok, r.source).toBe(true);
    }
    // the reactions carry the ULS load: 1.35 (7.0 kN/m² · 25.92 m² + 4 kN/m · 6 m) + 1.5 · 3 kN/m² · 25.92 m²
    const sum = ws.regions.find((r) => r.kind === 'math' && r.source.startsWith('p.R_sum'))!;
    expect(Number((out.results.get(sum.id) as MathResult).text!.split(' ')[0])).toBeCloseTo(1.35 * (7 * 25.92 + 24) + 1.5 * 3 * 25.92, 1);
  });
});
