import { describe, expect, it } from 'vitest';
import { fmt, units } from './beamDraw';

describe('result units of the drawing', () => {
  it('read as they always did when none are chosen', () => {
    const u = units({ lengthUnit: 'm', forceUnit: 'kN' });
    // the old formulas, digit for digit
    for (const v of [12345.678, -0.0123456, 0.012345, 98765.4321, 1.5e-3]) {
      expect(u.force(v)).toBe(`${fmt(v / 1e3)} kN`);
      expect(u.moment(v)).toBe(`${fmt(v / 1e3)} kN·m`);
      expect(u.line(v)).toBe(`${fmt(v / 1e3)} kN/m`);
      expect(u.defl(v)).toBe(`${fmt(v * 1000)} mm`);
      expect(u.stress(v * 1e6)).toBe(`${fmt((v * 1e6) / 1e6)} MPa`);
    }
    const us = units({ lengthUnit: 'ft', forceUnit: 'kip' });
    expect(us.defl(0.0254)).toBe('1 in');
    expect(us.moment(4448.2216152605 * 0.3048 * 10)).toBe('10 kip·ft');
  });

  it('follow the units chosen for the results', () => {
    const u = units({ lengthUnit: 'mm', forceUnit: 'N', display: { force: 'kN', moment: 'kN·m', line: 'kN/m', defl: 'mm', stress: 'MPa' } });
    expect(u.force(12500)).toBe('12.5 kN');
    expect(u.moment(48690)).toBe('48.69 kN·m');
    expect(u.line(4000)).toBe('4 kN/m');
    expect(u.names).toEqual({ force: 'kN', moment: 'kN·m', line: 'kN/m', defl: 'mm', stress: 'MPa' });
    // and the region's own units without a choice: N, N·mm, N/mm
    const own = units({ lengthUnit: 'mm', forceUnit: 'N' });
    expect(own.moment(48690)).toBe('48690000 N·mm');
    expect(own.line(4000)).toBe('4 N/mm');
  });
});
