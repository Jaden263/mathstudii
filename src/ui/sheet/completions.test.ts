import { describe, expect, it } from 'vitest';
import { worksheetCompletions } from '../autocomplete';
import { createRegion } from '../../model/types';

describe('spreadsheet outputs in autocomplete', () => {
  it('offers the variables a spreadsheet defines, and the math around it still', () => {
    const names = worksheetCompletions([
      createRegion('math', 0, 0, { source: 'L := 6 m' }),
      createRegion('spreadsheet', 0, 40, { outputs: [{ name: 'M_max', ref: 'D1', unit: 'kN*m' }, { name: '', ref: 'D2' }] }),
      createRegion('table', 0, 300, { name: 'loads' }),
    ]).map((c) => [c.name, c.detail]);
    expect(names).toEqual(expect.arrayContaining([['M_max', 'spreadsheet D1'], ['loads', 'table']]));
    expect(names.map((n) => n[0])).toContain('L');
  });
});
