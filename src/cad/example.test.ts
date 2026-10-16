import { describe, it, expect, beforeAll } from 'vitest';
import { initKernel } from './solid';
import { evaluateWorksheet, type CadResult, type MathResult } from '../engine/evaluator';
import { cadExample } from '../model/examples';
import { designOf } from './design';
import { designKey, designNumbers } from './keys';
import type { CadRegion, Worksheet } from '../model/types';

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
    // built by the B-rep kernel (loaded in test-setup): exact, not just within the mesh's faceting
    expect(res.design!.brep).toBe(true);
    expect(Math.abs(res.design!.components.cf!.V / Vf - 1)).toBeLessThan(1e-9);
    expect(res.design!.placements.os.by).toBe('joint');
    const shaftLine = out.results.get(ws.regions.find((r) => r.kind === 'math' && r.source.startsWith('asm.Spin'))!.id) as MathResult;
    expect(shaftLine.tex).toContain('15');
  });

  it('each part carries the key of the design and numbers it was built from', () => {
    const ws = cadExample();
    const keys = (w: Worksheet) => {
      const out = evaluateWorksheet(w);
      return w.regions.filter((r): r is CadRegion => r.kind === 'cad').map((r) => {
        // as the UI holds it: a structured clone of the worker's result
        const dr = structuredClone((out.results.get(r.id) as CadResult).design!);
        // the UI files display data under this key and checks its requests against it
        expect(designKey(designOf(r), designNumbers(dr))).toBe(dr.display);
        return dr.display;
      });
    };
    const k = keys(ws);
    expect(new Set(k).size).toBe(k.length);
    // a math-only change keeps every key; the bolt count changes the assembly's alone
    const edit = (src: string, to: string): Worksheet => ({ ...ws, regions: ws.regions.map((r) => (r.kind === 'math' && r.source.startsWith(src) ? { ...r, source: to } : r)) });
    expect(keys(edit('ω', 'ω := 2*π*1500/(60 s)'))).toEqual(k);
    const nb = keys(edit('n_b', 'n_b := 8'));
    expect(nb.filter((x, i) => x !== k[i])).toHaveLength(1);
  });
});
