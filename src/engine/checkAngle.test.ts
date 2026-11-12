import { describe, expect, it } from 'vitest';
import { evaluateWithScope } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';

function run(srcs: string[]) {
  const ws = emptyWorksheet();
  ws.regions = srcs.map((s, k) => { const r = createRegion('math', 20, 40 * k, { source: s } as never); r.id = 'r' + k; return r; });
  const out = evaluateWithScope(ws);
  return ws.regions.map((r) => out.results.get(r.id) as { error?: string; check?: { ok: boolean } } | undefined);
}

describe('checks treat an angle as a plain number', () => {
  it('compares a bearing life from rpm (min/cycle) with hours', () => {
    const res = run(['n := 1500 rpm', 'L := 10^6 / n · 4500', 'L_req := 5000 hr', 'L > L_req', 'L < L_req', 'L = hr']);
    expect(res[3]?.error).toBeUndefined();
    expect(res[3]?.check?.ok).toBe(true);
    expect(res[4]?.check?.ok).toBe(false);
  });
  it('still refuses really different units', () => {
    const res = run(['a := 2 m', 'b := 3 s', 'a > b']);
    expect(res[2]?.error).toMatch(/different units/);
  });
});
