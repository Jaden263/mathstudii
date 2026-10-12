import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { importSmath } from './smath';
import { evaluateWorksheet, type MathResult } from '../engine/evaluator';
import { loadCas } from '../engine/symbolic';
import type { Region, Worksheet } from '../model/types';

// ---------------------------------------------------------------- fixture builder
// Formulas are written the way SMath stores them: postfix tokens.

const v = (name: string) => `<e type="operand">${name}</e>`;
const u = (name: string) => `<e type="operand" style="unit">${name}</e>`;
const s = (text: string) => `<e type="operand" style="string">${text}</e>`;
const op = (o: string, args = 2) => `<e type="operator" args="${args}">${o}</e>`;
const fn = (name: string, args: number) => `<e type="function" preserve="true" args="${args}">${name}</e>`;
const br = '<e type="bracket">(</e>';
const def = (lhs: string, rhs: string) => lhs + rhs + op(':');

let id = 0;
let top = 0;
const region = (body: string, left = 9, h = 30) => {
  top += h;
  return `<region id="${++id}" left="${left}" top="${top}" width="120" height="24" color="#000000" bgColor="#ffffff" fontSize="10">${body}</region>`;
};
const math = (input: string, opts: { result?: 'numeric' | 'symbolic'; unit?: string; desc?: string } = {}) =>
  region(`<math>${opts.desc ? `<description active="true" position="Right" lang="eng"><p>${opts.desc}</p></description>` : ''}<input>${input}</input>${opts.unit ? `<contract>${opts.unit}</contract>` : ''}${opts.result ? `<result action="${opts.result}">${v('0')}</result>` : ''}</math>`);
const text = (eng: string, rus = 'Текст', bold = false) =>
  region(`<text lang="rus"><p>${rus}</p></text><text lang="eng"><p${bold ? ' bold="true"' : ''}>${eng}</p></text>`);

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function worksheet(variant: 'old' | 'new' = 'old'): string {
  id = 0;
  top = 0;
  const regions = [
    text('Beam on two supports: $ cost and *notes*', 'Балка', true),
    // L := 3 m ; L.A := 60 cm  (dot = literal subscript)
    math(def(v('L'), v('3') + u('m') + op('*')), { desc: 'Beam length' }),
    math(def(v('L.A'), v('60') + u('cm') + op('*'))),
    // F := [10 kN, 8 kN; 50 cm, 1.1 m] stored row by row, then rows, cols
    math(def(v('F'), v('10') + u('kN') + op('*') + v('8') + u('kN') + op('*') + v('50') + u('cm') + op('*') + v('1.1') + u('m') + op('*') + v('2') + v('2') + fn('mat', 6))),
    // q := 4 kN/m
    math(def(v('q'), v('4') + u('kN') + u('m') + op('/') + op('*'))),
    // R := sum(el(F, 1, k), k, 1, cols(F))  shown in kN
    math(v('F') + v('1') + v('k') + fn('el', 3) + v('k') + v('1') + v('F') + fn('cols', 1) + fn('sum', 4), { result: 'numeric', unit: u('kN') }),
    // M := q·L²/8 shown in kN·m
    math(def(v('M'), v('q') + v('L') + v('2') + op('^') + op('*') + v('8') + op('/'))),
    math(v('M'), { result: 'numeric', unit: u('kN') + u('m') + op('*') }),
    // gravity(m) := m·G  with G defined after the function (SMath binds at call time)
    math(def(v('w') + fn('gravity', 1), v('w') + v('G') + op('*'))),
    math(def(v('G'), v('9.81'))),
    math(v('2') + fn('gravity', 1), { result: 'numeric' }),
    // GCD by a top-level loop: line(while(x≠0 & y≠0, if(x>y, x:=mod(x,y), y:=mod(y,x))), GCD:=x+y, 2, 1)
    math(def(v('x'), v('20405'))),
    math(def(v('y'), v('84645'))),
    math(
      v('x') + v('0') + op('≠') + br + v('y') + v('0') + op('≠') + br + op('&')
      + v('x') + v('y') + op('>')
      + v('x') + v('x') + v('y') + fn('mod', 2) + op(':')
      + v('y') + v('y') + v('x') + fn('mod', 2) + op(':')
      + fn('if', 3) + fn('while', 2)
      + v('GCD') + v('x') + v('y') + op('+') + op(':')
      + v('2') + v('1') + fn('line', 4),
    ),
    math(v('GCD'), { result: 'numeric' }),
    // bisection: while(abs(f) > ε, line(if(…, b:=xn, a:=xn), xn:=(a+b)/2, n:=n+1, 3, 1)) assigns xn and n
    math(def(v('a'), v('0'))),
    math(def(v('b'), v('4'))),
    math(def(v('xn'), v('2'))),
    math(def(v('n'), v('0'))),
    math(
      v('xn') + v('2') + op('^') + v('2') + op('-') + fn('abs', 1) + v('10') + v('9') + op('-', 1) + op('^') + op('>')
      + v('xn') + v('2') + op('^') + v('2') + op('-') + v('0') + op('>')
      + v('b') + v('xn') + op(':') + v('a') + v('xn') + op(':') + fn('if', 3)
      + v('xn') + v('a') + v('b') + op('+') + br + v('2') + op('/') + op(':')
      + v('n') + v('n') + v('1') + op('+') + op(':')
      + v('3') + v('1') + fn('line', 5)
      + fn('while', 2),
    ),
    math(v('xn'), { result: 'numeric' }),
    math(v('n'), { result: 'numeric' }),
    // C-style loop filling a vector: for(i:=1, i≤3, i:=i+1, el(sq, i) := i^2)
    math(v('i') + v('1') + op(':') + v('i') + v('3') + op('≤') + v('i') + v('i') + v('1') + op('+') + op(':')
      + v('sq') + v('i') + fn('el', 2) + v('i') + v('2') + op('^') + op(':') + fn('for', 4)),
    math(v('sq'), { result: 'numeric' }),
    // descending range(start, end, second): for(j, range(3, 1, 2), cd := concat(cd, num2str(j)))
    math(def(v('cd'), s(''))),
    math(v('j') + v('3') + v('1') + v('2') + fn('range', 3) + v('cd') + v('cd') + v('j') + fn('num2str', 1) + fn('concat', 2) + op(':') + fn('for', 3)),
    math(v('cd'), { result: 'numeric' }),
    // a display-only equation and a symbolic evaluation
    math(v('A') + v('x') + op('*') + v('d') + op('≡')),
    math(v('s') + v('3') + op('^') + v('2') + v('s') + op('*') + op('+') + v('s') + fn('diff', 2), { result: 'symbolic' }),
    // a picture and a plot of a function and of a matrix of points
    region(`<picture><raw format="png" encoding="base64">${PNG}</raw></picture>`),
    math(def(v('pts'), v('0') + v('0') + v('1') + v('1') + v('2') + v('2') + fn('mat', 6))),
    region(`<plot type="2d" render="lines"><input>${v('x') + fn('sin', 1) + v('pts') + v('2') + v('1') + fn('sys', 4)}</input></plot>`, 9, 40),
    region('<somePluginRegion />'),
  ];
  // a collapsible area: its title region is nested and uses page coordinates
  const area = `<region id="${++id}" top="${top + 40}" color="#000000" bgColor="#ffffff"><area collapsed="true" /><region id="${++id}" left="9" top="${top + 50}" width="80" height="24"><text lang="eng"><p>Hidden part</p></text></region></region>`;
  const settings = '<settings><calculation><precision>3</precision><exponentialThreshold>5</exponentialThreshold></calculation></settings>';
  const ns = 'xmlns="http://smath.info/schemas/worksheet/1.0"';
  const head = '<?xml version="1.0" encoding="utf-8"?><?application progid="SMath Studio Desktop" version="0.99.7579"?>';
  return variant === 'old'
    ? `${head}<regions ${ns}>${settings}${regions.join('')}${area}</regions>`
    : `\uFEFF${head}<worksheet ${ns}>${settings}<regions type="content">${regions.join('')}${area}</regions></worksheet>`;
}

const sources = (ws: Worksheet) => ws.regions.filter((r) => r.kind === 'math').map((r) => (r as { source: string }).source);
const find = (ws: Worksheet, src: string) => ws.regions.find((r) => r.kind === 'math' && r.source === src) as Region;
const value = (ws: Worksheet, src: string) => {
  const r = find(ws, src);
  expect(r, `no region "${src}" in:\n${sources(ws).join('\n')}`).toBeTruthy();
  const res = evaluateWorksheet(ws).results.get(r.id) as MathResult;
  expect(res.error, `${src}: ${res.error}`).toBeUndefined();
  return res.tex;
};

describe('SMath import', () => {
  beforeAll(() => loadCas());

  it('converts definitions, units, matrices and evaluations', () => {
    const { ws, format } = importSmath(strToU8(worksheet()), 'beam.sm');
    expect(format).toBe('SMath Studio (.sm)');
    expect(ws.title).toBe('beam');
    expect(ws.settings.origin).toBe(1);
    expect(ws.settings.precision).toBe(3);
    expect(ws.settings.lateBinding).toBe(true);
    const src = sources(ws);
    expect(src).toContain('L := 3 m');
    expect(src).toContain('L_A := 60 cm');
    expect(src).toContain('F := [10 kN, 8 kN; 50 cm, 1.1 m]');
    expect(src).toContain('q := 4 kN/m');
    expect(value(ws, 'sum(F[1, k], k, 1, cols(F)) = kN')).toMatch(/= 18\\ \\mathrm\{kN\}/);
    expect(value(ws, 'M = kN*m')).toMatch(/4\.5/);
  });

  it('binds functions at call time like SMath', () => {
    const { ws } = importSmath(strToU8(worksheet()), 'a.sm');
    expect(value(ws, 'gravity(2) =')).toMatch(/19\.62/);
  });

  it('turns top-level loops into programs that define the variables read later', () => {
    const { ws } = importSmath(strToU8(worksheet()), 'a.sm');
    const src = sources(ws);
    // one variable read later: a plain program definition
    expect(src.find((x) => x.startsWith('GCD :=\n'))).toContain('return GCD');
    expect(value(ws, 'GCD =')).toMatch(/= 55/);
    // two variables: computed once, then taken out
    expect(src).toContain('xn := loop1.xn');
    expect(src).toContain('n := loop1.n');
    expect(value(ws, 'xn =')).toMatch(/= 1\.414/);
    expect(value(ws, 'n =')).toMatch(/= \d{2}/);
    // counting loop → for … ∈ a .. b, element assignment from an empty vector
    expect(src.find((x) => x.startsWith('sq :='))).toContain('for i ∈ 1 .. 3');
    expect(value(ws, 'sq =')).toMatch(/1 \\\\ 4 \\\\ 9/);
    // range(3, 1, 2) counts down
    expect(src.find((x) => x.startsWith('cd :=\n'))).toContain('for j ∈ 3, 2 .. 1');
    expect(value(ws, 'cd =')).toContain('321');
  });

  it('keeps text, comments, pictures, plots, display formulas and reports plugins', () => {
    const { ws, warnings } = importSmath(strToU8(worksheet()), 'a.sm');
    const texts = ws.regions.filter((r) => r.kind === 'text').map((r) => (r as { markdown: string }).markdown);
    expect(texts[0]).toBe('**Beam on two supports: &#36; cost and *notes***');
    expect(texts).toContain('*Beam length*');
    expect(texts).toContain('Hidden part');
    expect(texts.some((t) => t.startsWith('⚠️') && t.includes('somePluginRegion'))).toBe(true);
    expect(ws.regions.some((r) => r.kind === 'image' && r.src.startsWith('data:image/png;base64,'))).toBe(true);
    const plot = ws.regions.find((r) => r.kind === 'plot');
    expect(plot && plot.kind === 'plot' && plot.traces).toEqual([
      { y: 'sin(x_plot)', style: 'line' },
      { xExpr: 'col(pts, 1)', y: 'col(pts, 2)', style: 'line' },
    ]);
    expect(sources(ws)).toContain('A*x == d');
    expect(sources(ws)).toContain('diff(s^3 + 2*s, s) →');
    expect(warnings.some((w) => /somePluginRegion/.test(w))).toBe(true);
    // every region evaluates except the plugin placeholder
    const out = evaluateWorksheet(ws);
    const errors = ws.regions.filter((r) => r.kind === 'math').map((r) => [r, out.results.get(r.id) as MathResult] as const).filter(([, res]) => res?.error);
    expect(errors.map(([r, res]) => `${(r as { source: string }).source}: ${res.error}`)).toEqual([]);
  });

  it('reads SMath 0.99+ files, gzip and zip compressed .smz', () => {
    const xml = worksheet('new');
    for (const bytes of [strToU8(xml), gzipSync(strToU8(xml)), zipSync({ 'worksheet.sm': strToU8(xml) })]) {
      const { ws } = importSmath(bytes, 'b.smz');
      expect(ws.title).toBe('b');
      expect(sources(ws)).toContain('L := 3 m');
    }
    expect(() => importSmath(strToU8('<html></html>'), 'x.sm')).toThrow(/SMath/);
  });
});
