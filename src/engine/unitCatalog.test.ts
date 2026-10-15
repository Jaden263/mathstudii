import { describe, expect, it } from 'vitest';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { createRegion, emptyWorksheet } from '../model/types';
import { closestName, compatibleUnits } from './unitCatalog';

function run(srcs: string[], unitSystem: 'si' | 'us' = 'si') {
  const ws = { ...emptyWorksheet(), regions: srcs.map((s, i) => createRegion('math', 0, i * 30, { source: s })) };
  ws.settings.unitSystem = unitSystem;
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => out.results.get(r.id) as MathResult);
}
const shown = (r: MathResult) => r.tex.replace(/^.*= /, '');

describe('automatic metric display units', () => {
  const res = run([
    'q := 10 kN/m', 'L := 6 m', 'b := 300 mm', 'h := 500 mm',
    'q*L^2/8 =', '1 kN/m^2 * 3 m =', '3 kN/dm =', '7850 kg/m^3 * 9.81 m/s^2 =', 'b*h^3/12 =', '5*q*L^4/(384*210 GPa*b*h^3/12) =',
    '25 kNm =', '3 kW * 1 hr =', '(q*L^2/8) / (b*h^2/6) =', 'q*L^2/8 = J',
  ]);
  it('picks practical units per quantity', () => {
    expect(shown(res[4])).toBe('45\\ \\mathrm{kN}\\cdot \\mathrm{m}');
    expect(shown(res[5])).toBe('3\\ \\frac{\\mathrm{kN}}{\\mathrm{m}}');
    expect(shown(res[6])).toBe('30\\ \\frac{\\mathrm{kN}}{\\mathrm{m}}');
    expect(shown(res[7])).toBe('77.0085\\ \\frac{\\mathrm{kN}}{\\mathrm{m}^{3}}');
    expect(shown(res[8])).toBe('312\\,500\\ \\mathrm{cm}^{4}');
    expect(shown(res[9])).toBe('0.2571\\ \\mathrm{mm}');
    expect(shown(res[10])).toBe('25\\ \\mathrm{kN}\\cdot \\mathrm{m}');
    expect(shown(res[11])).toBe('10.8\\ \\mathrm{MJ}');
    expect(shown(res[12])).toBe('3.6\\ \\mathrm{MPa}');
  });
  it('keeps a requested unit and reports dimensions for choosing one', () => {
    expect(shown(res[13])).toBe('45\\,000\\ \\mathrm{J}');
    expect(res[4].dims?.slice(0, 3)).toEqual([1, 2, -2]);
    expect(compatibleUnits(res[4].dims!).map((u) => u.u)).toContain('kN m');
    expect(res[4].text).toMatch(/^45/);
  });
  it('leaves US worksheets alone', () => {
    const us = run(['10 lbf * 2 ft ='], 'us');
    expect(shown(us[0])).not.toContain('kN');
  });
});

describe('typo help', () => {
  it('suggests the closest name', () => {
    expect(closestName('kn', ['kN', 'm', 'kg'])).toBe('kN');
    expect(closestName('rdm', ['dm', 'rpm', 'rad'])).toBe('dm');
    expect(closestName('sqr', ['sqrt', 'qr'])).toBe('sqrt');
    expect(closestName('z', ['m'])).toBeNull();
  });
  it('offers a fix and rejects exotic prefixes', () => {
    const r = run(['3 kn =', '1 kN/rm =']);
    expect(r[0].fix).toEqual({ from: 'kn', to: 'kN' });
    expect(r[1].error).toMatch(/"rm" is not defined/);
  });
});
