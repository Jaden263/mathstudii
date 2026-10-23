import { describe, it, expect } from 'vitest';
import { missingFunctions, missingFunctionsText } from './report';
import { createRegion, type Region } from '../model/types';

describe('import report: functions the worksheet calls that nothing defines', () => {
  const math = (source: string) => createRegion('math', 0, 0, { source }) as Region;
  it('are the names a region calls that its evaluation did not find, with the add-in they come from', () => {
    const regions = [math('h := PropsSI("H", "T", 300, "P", 101325, "Water") ='), math('ρ := rp_rhotp(f, T, P)'), math('q := ρ*2'), math('w := FooBar(2) + 1')];
    const results = new Map<string, unknown>([
      [regions[0].id, { error: '"PropsSI" is not defined' }],
      [regions[1].id, { error: '"rp_rhotp" is not defined — did you mean "rhotp"?' }],
      // a name used as a value is not a function
      [regions[2].id, { error: '"ρ" is not defined' }],
      [regions[3].id, { error: '"FooBar" is not defined' }],
    ]);
    const list = missingFunctions(regions, results);
    expect(list).toEqual([
      { name: 'FooBar', regions: 1 },
      { name: 'PropsSI', regions: 1, addIn: 'CoolProp' },
      { name: 'rp_rhotp', regions: 1, addIn: 'REFPROP' },
    ]);
    const text = missingFunctionsText(list);
    expect(text).toMatch(/PropsSI \(from the CoolProp add-in/);
    expect(text).toMatch(/FooBar \(not Mathcad built-ins/);
    expect(missingFunctionsText([])).toBe('');
  });
});
