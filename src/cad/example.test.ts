import { describe, it, expect, beforeAll } from 'vitest';
import { initKernel } from './solid';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { cadExample } from '../model/examples';

beforeAll(async () => {
  await initKernel();
});

describe('CAD example worksheet', () => {
  it('evaluates the parts and the assembly without errors', () => {
    const ws = cadExample();
    const out = evaluateWorksheet(ws);
    for (const r of ws.regions) {
      const res = out.results.get(r.id);
      if (r.kind === 'math') expect((res as MathResult).error, r.source).toBeUndefined();
      if (r.kind === 'cad') {
        const c = res as CadResult;
        expect(c.error, r.name).toBeUndefined();
        expect(c.featureError, r.name).toBeUndefined();
        expect(c.mass?.m, r.name).toBeGreaterThan(0);
      }
    }
    const asm = ws.regions.find((r) => r.kind === 'cad' && r.name === 'asm')!;
    const res = out.results.get(asm.id) as CadResult;
    // flange: plate + hub − bore − 6 counterbored holes (d_2 = 50 mm)
    const bore = Math.PI * 25.5 ** 2;
    const hole = Math.PI * 4.5 ** 2 * 12 + Math.PI * (7.5 ** 2 - 4.5 ** 2) * 4;
    const Vf = Math.PI * 100 ** 2 * 12 + Math.PI * 50 ** 2 * 20 - bore * 32 - 6 * hole;
    expect(res.design!.components.cf!.V / Vf).toBeCloseTo(1, 3);
    expect(res.design!.placements.os.by).toBe('joint');
    const shaftLine = out.results.get(ws.regions.find((r) => r.kind === 'math' && r.source.startsWith('asm.Spin'))!.id) as MathResult;
    expect(shaftLine.tex).toContain('15');
  });
});
