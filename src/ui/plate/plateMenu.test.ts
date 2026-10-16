import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type PlateResult } from '../../engine/evaluator';
import { createRegion, emptyWorksheet, type PlateRegion } from '../../model/types';
import { slimPlate } from '../../plate/evaluate';
import { plateResultsTsv } from './plateMenu';

describe('plate results as a table', () => {
  it('lists each support and every field’s extremes in the region’s units', () => {
    const ws = emptyWorksheet();
    const p = createRegion('plate', 0, 0, { name: 'p', mesh: '0.25' }) as PlateRegion;
    ws.regions = [p];
    const res = evaluateWorksheet(ws).results.get(p.id) as PlateResult;
    const tsv = plateResultsTsv(p, slimPlate(res))!;
    const rows = tsv.split(/\r?\n/).map((r) => r.split('\t'));
    expect(rows[0]).toEqual(['Support', 'R [kN]', 'r max [kN/m]', 'r min', 'at start', 'at end']);
    // the four simply supported edges carry the ULS load of the default slab: 1.35 (5 + 1.5) + 1.5 · 3 kN/m² on 24 m²
    const R = rows.slice(1, 5).reduce((s, r) => s + Number(r[1]), 0);
    expect(R).toBeCloseTo((1.35 * 6.5 + 1.5 * 3) * 24, 2);
    expect(rows.some((r) => r[0] === 'mx' && r[3] === 'kN·m/m')).toBe(true);
  });
});
