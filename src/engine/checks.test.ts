import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';
import { splitChain } from './syntax';

function run(srcs: string[]) {
  const ws = { ...emptyWorksheet(), regions: srcs.map((s, i) => createRegion('math', 0, i * 30, { source: s })) };
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => out.results.get(r.id) as MathResult);
}

describe('design checks', () => {
  it('splits comparison chains', () => {
    expect(splitChain('a <= b')).toEqual({ terms: ['a', 'b'], ops: ['<='] });
    expect(splitChain('0 < x ≤ 10')).toEqual({ terms: ['0', 'x', '10'], ops: ['<', '≤'] });
    expect(splitChain('if(a < b, 1, 2)')).toBeNull();
    expect(splitChain('a = b')).toBeNull();
  });

  it('shows OK / NOT OK with the utilisation', () => {
    const r = run(['σ := 200 MPa', 'f_y := 355 MPa', 'σ ≤ f_y', 'σ <= f_y =', 'f_y ≥ 400 MPa', '0 < σ ≤ f_y', 'v := [1, 2, 3] kN', 'v ≤ 2.5 kN']);
    expect(r[2].check).toEqual({ ok: true, util: 200 / 355 });
    expect(r[2].tex).toContain('OK');
    expect(r[2].tex).toContain('56\\,\\%');
    expect(r[3].check?.ok).toBe(true);
    expect(r[4].check).toEqual({ ok: false, util: 400 / 355 });
    expect(r[4].tex).toContain('NOT OK');
    expect(r[5].check).toEqual({ ok: true });
    expect(r[7].check).toEqual({ ok: false, util: 1.2 });
  });

  it('rejects mismatched units', () => {
    expect(run(['3 MPa ≤ 2 m'])[0].error).toMatch(/different units/);
  });
});
