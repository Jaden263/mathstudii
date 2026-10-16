import { describe, it, expect, beforeAll } from 'vitest';
import katex from 'katex';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { emptyWorksheet, createRegion, type Worksheet } from '../model/types';
import { loadCas } from './symbolic';
import { exactNumber, unitNamesIn } from './symbolicUnits';
import { parseExpr } from './compile';

function run(lines: string[], settings: Partial<Worksheet['settings']> = {}): MathResult {
  const ws = emptyWorksheet();
  ws.settings = { ...ws.settings, ...settings };
  ws.regions = lines.map((l, i) => createRegion('math', 40, 40 + i * 40, { source: l }));
  const out = evaluateWorksheet(ws);
  const last = out.results.get(ws.regions[ws.regions.length - 1].id) as MathResult;
  if (!last.error) expect(() => katex.renderToString(last.tex, { throwOnError: true }), last.tex).not.toThrow();
  return last;
}

/** The TeX right of the arrow. */
function result(lines: string[]): string {
  const r = run(lines);
  if (r.error) throw new Error(r.error);
  const x = r.tex.indexOf('\\xrightarrow{');
  if (x < 0) return r.tex.slice(r.tex.indexOf('\\rightarrow') + '\\rightarrow'.length).trim();
  // skip the keyword's braces
  let depth = 0, i = x + '\\xrightarrow'.length;
  do {
    if (r.tex[i] === '{') depth++;
    else if (r.tex[i] === '}') depth--;
    i++;
  } while (depth > 0);
  return r.tex.slice(i).trim();
}

describe('units in symbolic results', () => {
  beforeAll(async () => {
    await loadCas();
  });

  it('adds like units, converting to one (shown as "=" shows it)', () => {
    expect(result(['2 m + 3 m →'])).toBe('5\\ \\mathrm{m}');
    // 1 m + 10 × 0.01 m (SI: 1 cm = 10⁻² m) = 1.1 m; the metric display keeps the number ≥ 1
    expect(result(['1 m + 10 cm →'])).toBe('1.1\\ \\mathrm{m}');
    expect(result(['1 m / 3 →'])).toBe('333.3333\\ \\mathrm{mm}');
  });

  it('carries units of defined variables', () => {
    // F·L = 10 kN × 2 m = 20 kN·m, a moment
    expect(result(['F := 10 kN', 'L := 2 m', 'F * L →'])).toBe('20\\ \\mathrm{kN}\\cdot \\mathrm{m}');
    // q L²/8 = 3 kN/m × 36 m² / 8 = 13.5 kN·m
    expect(result(['3 kN/m * (6 m)^2 / 8 →'])).toBe('13.5\\ \\mathrm{kN}\\cdot \\mathrm{m}');
    // σ A = 10 N/mm² × 200 mm² = 2000 N
    expect(result(['10 MPa * 200 mm^2 →'])).toBe('2\\ \\mathrm{kN}');
    expect(result(['9.81 m/s^2 * 2 s →'])).toBe('19.62\\ \\frac{\\mathrm{m}}{\\mathrm{s}}');
  });

  it('takes roots and powers of units', () => {
    expect(result(['sqrt(4 m^2) →'])).toBe('2\\ \\mathrm{m}');
    expect(result(['(2 m)^2 →'])).toBe('4\\ \\mathrm{m}^{2}');
    expect(result(['x^2 = 4 m^2 → solve, x'])).toBe('\\left[-2\\ \\mathrm{m},\\ 2\\ \\mathrm{m}\\right]');
    // 2/(4) with the metres cancelled is a plain number
    expect(result(['2 m / (4 m) →'])).toBe('\\frac{1}{2}');
  });

  it('keeps symbols next to units, in the unit that leaves them simplest', () => {
    expect(result(['x*m/s →'])).toBe('x\\,\\frac{\\mathrm{m}}{\\mathrm{s}}');
    expect(result(['x*kN + 2 kN →'])).toBe('\\left(x+2\\right)\\,\\mathrm{kN}');
    expect(result(['F := 10 kN', 'F * x →'])).toBe('10 \\cdot x\\,\\mathrm{kN}');
    expect(result(['x mm →'])).toBe('x\\,\\mathrm{mm}');
    // a line load: 1000 x N/m = x kN/m
    expect(result(['x*kN/m →'])).toBe('x\\,\\frac{\\mathrm{kN}}{\\mathrm{m}}');
    // terms of different units stay apart: x is no length unless it is one
    expect(result(['x + 2 m →'])).toBe('2\\ \\mathrm{m} + x');
  });

  it('refuses to add or take functions of mismatched units', () => {
    expect(run(['2 m + 3 s →']).error).toBe('Cannot add a length and a time');
    expect(run(['F := 10 kN', 'F + 2 m →']).error).toBe('Cannot add a force and a length');
    expect(run(['sin(2 m) →']).error).toBe('sin needs a number, not a length');
    expect(run(['x^2 = 4 m → solve, x']).error).toBeUndefined();
  });

  it('leaves single letters as variables unless they are written as a quantity', () => {
    // litre, ampere, farad, seconds … would all be wrong here
    expect(result(['q*L^2/8 →'])).toBe('\\frac{q \\cdot L^{2}}{8}');
    expect(result(['F/A →'])).toBe('\\frac{F}{A}');
    // s is the Laplace variable here, not seconds: (s + 2)(s + 1)
    expect(result(['s^2 + 3 s + 2 → factor'])).toBe('\\left(s+2\\right) \\cdot \\left(s+1\\right)');
    expect(result(['(a + b)^4 → expand'])).toContain('b^{3}');
    expect(result(['1/2 m v^2 →'])).toBe('\\frac{m \\cdot v^{2}}{2}');
    expect(result(['N/2 →'])).toBe('\\frac{N}{2}');
    expect(result(['2 N →'])).toBe('2\\ \\mathrm{N}');
  });

  it('shows units upright and variables in italics in the input', () => {
    expect(run(['2 m + 3 m →']).tex).toMatch(/^2\\,\\mathrm\{m\}\+3\\,\\mathrm\{m\}/);
    expect(run(['q*L^2/8 →']).tex).not.toContain('\\mathrm{L}');
  });
});

describe('prime notation in symbolic input', () => {
  beforeAll(async () => {
    await loadCas();
  });
  it('differentiates functions defined above', () => {
    expect(result(['y(t) := t^3', "y'(t) →"])).toBe('3 \\cdot t^{2}');
    expect(result(['y(t) := t^3', "y''(t) →"])).toBe('6 \\cdot t');
    expect(result(['f(x) := sin(x)', "f'(x) →"])).toMatch(/cos/);
  });
  it('explains what it cannot do', () => {
    expect(run(["z'(t) →"]).error).toMatch(/^z′: z is not a function of one variable defined above/);
    expect(run(['y(t) := t^3', "y'(2) →"]).error).toMatch(/needs a variable/);
  });
});

describe('which names are units', () => {
  const none = { isDefined: () => false, value: () => undefined };
  const names = (src: string) => [...unitNamesIn(parseExpr(src), none, new Set())].sort();
  it('reads quantities, multi-letter units and compounds', () => {
    expect(names('2 m + 3 s')).toEqual(['m', 's']);
    expect(names('x*kN/m')).toEqual(['kN', 'm']);
    expect(names('x*m/s')).toEqual(['m', 's']);
    expect(names('9.81 m/s^2')).toEqual(['m', 's']);
    expect(names('2 F L/3')).toEqual([]);
    expect(names('2 m*a')).toEqual([]);
    expect(names('2*m')).toEqual([]);
  });
  it('never takes defined or bound names', () => {
    const defined = { isDefined: (n: string) => n === 'm', value: () => 3 };
    expect([...unitNamesIn(parseExpr('2 m + 1 mm'), defined, new Set())]).toEqual(['mm']);
    expect([...unitNamesIn(parseExpr('2 s'), none, new Set(['s']))]).toEqual([]);
  });
});

describe('exact numbers for the CAS', () => {
  it('writes decimals as exact fractions', () => {
    expect(exactNumber(1000)).toBe('1000');
    expect(exactNumber(0.0254)).toBe('(254/10^4)');
    expect(exactNumber(1609.344)).toBe('(1609344/10^3)');
    expect(exactNumber(1e-9)).toBe('(1/10^9)');
    expect(exactNumber(-4.5e21)).toBe('(-45*10^20)');
  });
});
