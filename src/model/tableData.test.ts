import { describe, expect, it } from 'vitest';
import { parseDelimited, toCsv, toTableData } from './tableData';

describe('table data', () => {
  it('reads a pasted Excel range with a header and units', () => {
    const t = toTableData(parseDelimited('x [m]\tM (kN m)\tcase\n0\t0\tG\n1,5\t12,25\tQ\n3\t18\tG\n'));
    expect(t.headers).toEqual(['x', 'M', 'case']);
    expect(t.units).toEqual(['m', 'kN m', '']);
    expect(t.cells).toEqual([['0', '0', 'G'], ['1.5', '12.25', 'Q'], ['3', '18', 'G']]);
  });

  it('reads CSV with quotes, semicolons and thousands', () => {
    expect(parseDelimited('a,"b, c",d\n1,"say ""hi""",3')).toEqual([['a', 'b, c', 'd'], ['1', 'say "hi"', '3']]);
    const t = toTableData(parseDelimited('F;L\n1.234,5;2,0\n'));
    expect(t.cells).toEqual([['1234.5', '2.0']]);
    const u = toTableData(parseDelimited('1,234.5,7\n'));
    expect(u.headers).toEqual(['', '', '']);
  });

  it('writes CSV back', () => {
    expect(toCsv(['x', 'F'], ['m', 'kN'], [['1', '2'], ['3', '4']])).toBe('x [m],F [kN]\n1,2\n3,4\n');
  });
});

import { evaluateWorksheet, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet } from './types';

describe('table regions', () => {
  it('evaluate names, units, text labels and column variables', () => {
    const t = toTableData(parseDelimited('x [m]\tF [kN]\tcase\n0\t1,5\tG\n2\t3\tQ'));
    const ws = { ...emptyWorksheet(), regions: [
      createRegion('table', 0, 0, { name: 'D', ...t, columnVars: true }),
      createRegion('math', 0, 200, { source: 'sum(F) =' }),
      createRegion('math', 0, 230, { source: 'x =' }),
    ] };
    const out = evaluateWorksheet(ws);
    expect(out.results.get(ws.regions[0].id)).toEqual({ kind: 'table' });
    expect((out.results.get(ws.regions[1].id) as MathResult).tex).toContain('4.5\\ \\mathrm{kN}');
    const x = out.results.get(ws.regions[2].id) as MathResult;
    expect(x.grid).toEqual({ unit: 'm', rows: [['0'], ['2']] });
  });
});
