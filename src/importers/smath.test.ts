import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { importSmath } from './smath';
import { compareSaved } from './saved';
import { evaluateWorksheet, evaluateWithScope, type MathResult } from '../engine/evaluator';
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
    const textRegions = ws.regions.filter((r) => r.kind === 'text');
    const texts = textRegions.map((r) => (r as { markdown: string }).markdown);
    // SMath shows *notes* with its asterisks; the bold paragraph makes the region bold
    expect(texts[0]).toBe('Beam on two supports: &#36; cost and \\*notes\\*');
    expect(textRegions[0].style).toEqual({ bold: true });
    expect(texts).toContain('Beam length');
    expect(textRegions.find((r) => (r as { markdown: string }).markdown === 'Beam length')?.style).toEqual({ italic: true });
    expect(texts).toContain('Hidden part');
    // the collapsed area hides it
    const area = ws.regions.find((r) => r.kind === 'area');
    expect(area && area.kind === 'area' && area.collapsed && area.hidden).toEqual([textRegions.find((r) => (r as { markdown: string }).markdown === 'Hidden part')!.id]);
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

describe('SMath import: what writing files for SMath showed', () => {
  // each a formula as SMath writes it, read in a one-region worksheet
  const one = (...regions: string[]) => {
    id = 0;
    top = 0;
    return importSmath(strToU8(`<?xml version="1.0" encoding="utf-8"?><?application progid="SMath Studio Desktop" version="0.99.7030.1435"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions type="content">${regions.map((r) => math(r)).join('')}</regions></worksheet>`), 'x.sm').ws;
  };
  it('2·(300 kN) is a product, not the number "2 300"', () => {
    const ws = one(def(v('F'), v('2') + v('300') + u('kN') + op('*') + op('*')));
    expect(sources(ws)).toEqual(['F := 2*(300 kN)']);
  });
  it('a negative exponent in a display unit (m^-1), standard gravity gₑ', () => {
    id = 0;
    top = 0;
    const ws = importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${
      region(`<math><input>${def(v('k'), v('2') + u('m') + op('/'))}</input><contract>${u('m') + v('1') + op('-', 1) + op('^')}</contract><result action="numeric">${v('2')}</result></math>`)
    }${region(`<math><input>${def(v('w'), v('1000') + u('kg') + u('g.e') + op('*') + op('*'))}</input><contract>${u('kN')}</contract><result action="numeric">${v('9.8066')}</result></math>`)}</regions></worksheet>`), 'x.sm').ws;
    expect(sources(ws)).toEqual(['k := 2/m = m^-1', 'w := 1000 kg*g = kN']);
    expect(value(ws, 'k := 2/m = m^-1')).toMatch(/= 2\\/);
    expect(value(ws, 'w := 1000 kg*g = kN')).toMatch(/= 9\.80\d*\\ \\mathrm\{kN\}/);
  });
  it('a display unit stays a unit when a variable has its name (m := … , = kN/m)', () => {
    id = 0;
    top = 0;
    const ws = importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${
      region(`<math><input>${def(v('m'), v('3'))}</input></math>`)
    }${region(`<math><input>${def(v('q'), v('12') + u('kN') + u('m') + op('/') + op('*'))}</input><contract>${u('kN') + u('m') + op('/')}</contract><result action="numeric">${v('12')}</result></math>`)}</regions></worksheet>`), 'x.sm').ws;
    expect(sources(ws)).toContain('q := 12 kN/unit(1, "m") = kN/m');
    expect(value(ws, 'q := 12 kN/unit(1, "m") = kN/m')).toMatch(/= 12\\/);
  });
});

describe('SMath import: numbers, constants, units and text as SMath writes them', () => {
  const sheet = (...regions: string[]) => {
    id = 0;
    top = 0;
    return `<?xml version="1.0" encoding="utf-8"?><?application progid="SMath Studio Desktop" version="1.0.8348"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions type="content">${regions.join('')}</regions></worksheet>`;
  };
  const load = (...regions: string[]) => importSmath(strToU8(sheet(...regions)), 'x.sm');
  const result = (input: string, saved: string, unit = '') =>
    region(`<math><input>${input}</input>${unit ? `<contract>${unit}</contract>` : ''}<result action="numeric">${saved}</result></math>`);

  it('reads "2." as the number 2', () => {
    const { ws } = load(math(def(v('V'), v('10'))), result(v('V') + v('2.') + op('*'), v('20')));
    expect(sources(ws)).toContain('V*2 =');
    expect(value(ws, 'V*2 =')).toMatch(/= 20/);
  });

  it('takes SMath constants written as units: Boltzmann k, elementary charge e, light speed c', () => {
    // V_T := k·T/e with T = 300 K is 25.852 mV
    const { ws } = load(math(def(v('T'), v('300') + u('K') + op('*'))), result(def(v('V.T'), u('k') + v('T') + op('*') + u('e') + op('/')), v('25.852'), u('mV')),
      result(v('0.6') + u('c') + op('*'), v('179875474.8') + u('m') + u('s') + op('/') + op('*')));
    expect(sources(ws)).toContain('V_T := boltzmann*T/elementaryCharge = mV');
    expect(value(ws, 'V_T := boltzmann*T/elementaryCharge = mV')).toMatch(/25\.85\d*\\ \\mathrm\{mV\}/);
    expect(value(ws, '0.6 speedOfLight =')).toMatch(/1\.7988/);
  });

  it('defines a unit of the worksheet as a variable of its name (k.1 := 17.5 N/mm, kcf := kip/ft³)', () => {
    const { ws } = load(
      math(def(u('k.1'), v('17.5') + u('N') + u('mm') + op('/') + op('*'))),
      math(def(v('F'), v('35') + u('N') + op('*'))),
      result(def(v('d'), v('2') + v('F') + op('*') + v('4') + u('k.1') + op('*') + op('/')), v('1'), u('mm')),
    );
    expect(sources(ws)).toEqual(['k_1 := 17.5 N/mm', 'F := 35 N', 'd := 2*F/(4 k_1) = mm']);
    expect(value(ws, 'd := 2*F/(4 k_1) = mm')).toMatch(/= 1\\ \\mathrm\{mm\}/);
  });

  it('reads results SMath shows in gray (J/kg), katal and tonne-force', () => {
    const { ws, saved, warnings } = load(result(def(v('h'), v('2594387') + u('J') + u('kg') + op('/') + op('*')), v('2594387') + u('Gy') + op('*')),
      result(def(v('P'), v('9806.65') + u('N') + op('*')), v('1'), u('tonnef')),
      result(def(v('n'), v('2') + u('mol') + u('s') + op('/') + op('*')), v('2') + u('kat') + op('*')));
    expect(saved!.map((s) => s.expr)).toEqual(['2594387 (J/kg)', '(1)*((1000 kgf))', '2 (mol/s)']);
    expect(sources(load(math(def(v('σ'), v('36') + u('ksi') + op('*')))).ws)).toEqual(['σ := 36 ksi']);
    // tonne-force is no unit here: shown in kgf, and the report says so
    expect(sources(ws)[1]).toBe('P := 9806.65 N = kgf');
    expect(warnings.some((w) => /tonnef.*kgf/.test(w))).toBe(true);
    const out = evaluateWorksheet(ws);
    for (const r of ws.regions) expect((out.results.get(r.id) as MathResult).error).toBeUndefined();
  });

  it('reads SMath 1.x text: paragraphs, line breaks, bold and italic spans, colours, sizes and math placed in the text', () => {
    const textRegion = `<region id="9" left="18" top="10" width="300" height="40" color="#0000ff" bgColor="#ffff80" fontSize="10"><text lang="eng" fontFamily="Arial" fontSize="10"><content>`
      + `<p style="font-size: 20px;">Thickness \\[REGION[1d44faa63ab44d5597c0a27d0d17358f]]\\ of the plate</p>`
      + `<p style="font-size: 20px;"><span style="font-weight: bold;">Note</span> 2*a_b<br />second line</p></content><regions>`
      + `<region id="1d44faa63ab44d5597c0a27d0d17358f" left="80" top="0" width="52" height="24" color="#000000" fontSize="10"><math><input>${def(v('t'), v('10') + u('mm') + op('*'))}</input></math></region></regions></text></region>`;
    const { ws } = load(textRegion, math(v('t') + v('2') + op('^'), { result: 'numeric', unit: u('mm') + v('2') + op('^') }));
    const text = ws.regions.find((r) => r.kind === 'text') as Region & { markdown: string };
    expect(text.markdown).toBe('Thickness \u2003\u2003\u2003\u2003 of the plate  \n**Note** 2\\*a\\_b  \nsecond line');
    // blue on yellow, 20 px = 15 pt against SMath's 10 pt
    expect(text.style).toEqual({ color: '#0000ff', background: '#ffff80', fontScale: 1.5 });
    // the math in the text defines t, at its place on the page
    const t = find(ws, 't := 10 mm');
    expect(t && t.x > text.x && t.y === text.y).toBe(true);
    expect(value(ws, 't^2 = mm^2')).toMatch(/= 100\\ \\mathrm\{mm\}\^\{2\}/);
  });

  it('keeps math regions\u2019 colours and sizes', () => {
    id = 0;
    top = 0;
    const { ws } = importSmath(strToU8(sheet(`<region id="1" left="9" top="9" width="80" height="24" color="#ff0000" bgColor="#dddddd" fontSize="12"><math><input>${def(v('a'), v('1'))}</input></math></region>`)), 'x.sm');
    expect(ws.regions[0].style).toEqual({ color: '#ff0000', background: '#dddddd', fontScale: 1.2 });
  });

  it('makes SMath areas areas, collapsed as they were saved', () => {
    const area = (collapsed: boolean, y: number, inner: string) => `<region id="${++id}" top="${y}" color="#000000" bgColor="#ffff80"><area collapsed="${collapsed}"><title lang="eng"><p>Inputs</p></title></area>${inner}</region>`;
    const inner = `<region id="${++id}" left="9" top="130" width="80" height="24"><math><input>${def(v('a'), v('2'))}</input></math></region>`;
    for (const collapsed of [false, true]) {
      id = 0;
      const { ws } = importSmath(strToU8(sheet(area(collapsed, 100, inner), `<region id="${++id}" left="9" top="200" width="80" height="24"><math><input>${v('a')}</input><result action="numeric">${v('2')}</result></math></region>`)), 'x.sm');
      const a = ws.regions.find((r) => r.kind === 'area')!;
      expect(a.kind === 'area' && a.title).toBe('Inputs');
      expect(a.kind === 'area' && !!a.collapsed).toBe(collapsed);
      // collapsed, what is below moves up; the value is the same
      const shown = find(ws, 'a =');
      expect(shown.y < 200).toBe(collapsed);
      expect(value(ws, 'a =')).toMatch(/= 2/);
    }
  });

  it('imports the Image plugin\u2019s picture, the picture of a Maxima plot, Writer text and a slider\u2019s value', () => {
    const { ws, warnings } = load(
      region(`<image><imagefile filename="4ckidis5.png" lenght="718" width="108" height="149">${PNG}</imagefile><input>${v('#')}</input></image>`),
      region(`<maximaplugin><ImageFile FileName="0jjv30dg.png" DataLenght="36139">${PNG}</ImageFile></maximaplugin>`),
      region(`<writer lang="eng"><![CDATA[<span style="font-family: 'Arial'; font-size: 10pt; font-weight: bold;"><div>Current mirror – NPN</div></span>]]></writer>`),
      region(`<slider orientation="Vertical" maxValue="100" minValue="0" value="97"><input>${v('v1')}</input></slider>`),
      math(v('v1'), { result: 'numeric' }),
    );
    expect(ws.regions.filter((r) => r.kind === 'image')).toHaveLength(2);
    const text = ws.regions.find((r) => r.kind === 'text') as Region & { markdown: string };
    expect(text.markdown).toBe('Current mirror – NPN');
    expect(text.style).toEqual({ bold: true });
    expect(value(ws, 'v1 =')).toMatch(/= 97/);
    expect(warnings.some((w) => /slider.*v1 := 97/.test(w))).toBe(true);
    expect(warnings.some((w) => /Maxima plot.*picture/.test(w))).toBe(true);
  });
});

describe('SMath import: definitions that read names defined further down', () => {
  it('calculates them where they are used, with the values the names have there (SMath keeps them as symbols)', () => {
    id = 0;
    top = 0;
    const show = (input: string, saved: string) => region(`<math><input>${input}</input><result action="numeric">${v(saved)}</result></math>`);
    const xml = `<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${[
      math(def(v('q'), v('2'))),
      // w := q·L/I before L and I are defined; σ := w/k reads w and k
      math(def(v('w'), v('q') + v('L') + op('*') + v('I') + op('/'))),
      math(def(v('σ'), v('w') + v('k') + op('/'))),
      math(def(v('L'), v('3'))),
      math(def(v('I'), v('2'))),
      math(def(v('k'), v('3'))),
      show(v('w'), '3'),
      show(v('σ'), '1'),
      // a second section: other I, the same formulas
      math(def(v('I'), v('6'))),
      show(v('w'), '1'),
      show(v('σ'), '0.3333'),
    ].join('')}</regions></worksheet>`;
    const { ws, saved, warnings } = importSmath(strToU8(xml), 'x.sm');
    expect(sources(ws).slice(1, 3)).toEqual(['w(L, I) := q*L/I', 'σ(L, I, k) := w(L, I)/k']);
    expect(sources(ws).filter((x) => x.endsWith(' ='))).toEqual(['w(L, I) =', 'σ(L, I, k) =', 'w(L, I) =', 'σ(L, I, k) =']);
    expect(warnings.some((w) => /2 definitions read names defined only further down or not at all \(w\(L, I\), σ\(L, I, k\)\)/.test(w))).toBe(true);
    const cmp = compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown);
    expect(cmp).toMatchObject({ checked: 4, agree: 4 });
  });
});

describe('SMath import: functions and lists', () => {
  const one = (...regions: string[]) => {
    id = 0;
    top = 0;
    return importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${regions.join('')}</regions></worksheet>`), 'x.sm');
  };
  it('a system sys(a, b) as a value is a column vector; its saved result too', () => {
    const { ws, saved } = one(region(`<math><input>${def(v('t') + fn('M', 1), v('t') + v('2') + op('*') + v('t') + v('2') + op('^') + v('2') + v('1') + fn('sys', 4))}</input></math>`),
      region(`<math><input>${v('3') + fn('M', 1)}</input><result action="numeric">${v('6') + v('9') + v('2') + v('1') + fn('sys', 4)}</result></math>`));
    expect(sources(ws)).toEqual(['M(t) := [t*2; t^2]', 'M(3) =']);
    expect(saved![0].expr).toBe('[6; 9]');
    expect(compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown)).toMatchObject({ checked: 1, agree: 1 });
  });

  it('a range as a subscript takes those elements; if without else in a program; nthroot', () => {
    const { ws } = one(
      math(def(v('v'), v('1') + v('2') + v('3') + v('4') + v('4') + v('1') + fn('mat', 6))),
      math(v('v') + v('2') + v('3') + fn('range', 2) + fn('el', 2), { result: 'numeric' }),
      // s := 0; for j ∈ 1..4: if v[j] > 2 then s := s + v[j]
      math(def(v('s'), v('0'))),
      math(v('j') + v('1') + v('4') + fn('range', 2) + v('v') + v('j') + fn('el', 2) + v('2') + op('>') + v('s') + v('s') + v('v') + v('j') + fn('el', 2) + op('+') + op(':') + fn('if', 2) + fn('for', 3)),
      math(v('s'), { result: 'numeric' }),
      math(v('8') + op('-', 1) + v('3') + fn('nthroot', 2), { result: 'numeric' }),
    );
    expect(sources(ws)[1]).toBe('v[range(2, 3)] =');
    expect(value(ws, 'v[range(2, 3)] =')).toMatch(/2 \\\\ 3/);
    expect(sources(ws).find((x) => x.startsWith('s :=\n'))).toContain('    if v[j] > 2\n      s ← s + v[j]');
    expect(value(ws, 's =')).toMatch(/= 7/);
    expect(value(ws, 'nthRoot(-8, 3) =')).toMatch(/= -2/);
  });

  it('a range inside an expression is the vector of its values: (0..3)·2', () => {
    const { ws } = one(math(def(v('φ'), v('0') + v('3') + fn('range', 2) + br + v('2') + op('*'))), math(def(v('i'), v('1') + v('3') + fn('range', 2))), math(v('φ'), { result: 'numeric' }));
    expect(sources(ws)).toEqual(['φ := range(0, 3)*2', 'i := 1 .. 3', 'φ =']);
    expect(value(ws, 'φ =')).toMatch(/0 \\\\ 2 \\\\ 4 \\\\ 6/);
  });

  it('solve(f, x, a, b) gives every root between a and b; roots(f, x, x₀); at(f, x = a)', () => {
    const { ws, saved } = one(
      math(def(v('σ.x'), v('40') + u('MPa') + op('*'))),
      // σ(φ) reads φ, which the worksheet never defines: a symbol, as in SMath
      math(def(v('σ'), v('σ.x') + v('2') + v('φ') + op('*') + fn('cos', 1) + op('*'))),
      region(`<math><input>${def(v('φ.0'), v('σ') + v('0') + op('≡') + v('φ') + v('0') + v('π') + fn('solve', 4))}</input><contract>${u('°')}</contract><result action="numeric">${v('45') + v('135') + v('2') + v('1') + fn('sys', 4)}</result></math>`),
      region(`<math><input>${v('σ') + v('0') + op('≡') + v('φ') + v('1') + fn('roots', 3)}</input><contract>${u('°')}</contract><result action="numeric">${v('45')}</result></math>`),
      region(`<math><input>${v('σ') + v('φ') + v('0') + op('≡') + fn('at', 2)}</input><contract>${u('MPa')}</contract><result action="numeric">${v('40')}</result></math>`),
    );
    expect(sources(ws).slice(1)).toEqual(['σ(φ) := σ_x*cos(2*φ)', 'φ_0 := roots(σ(φ) == 0, φ, 0, π) = deg', 'roots(σ(φ) == 0, φ, 1) = deg', 'subs(σ(φ), φ == 0) = MPa']);
    expect(compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown)).toMatchObject({ checked: 3, agree: 3 });
  });

  it('says which regions need an SMath plugin or the computer SMath ran on', () => {
    const { warnings } = one(
      math(def(v('h'), s('H') + s('T') + v('300') + u('K') + op('*') + s('P') + v('1') + u('atm') + op('*') + s('Water') + fn('CoolProp_Props', 6))),
      math(def(v('t0'), s('') + fn('time', 1))),
      math(v('lastError'), { result: 'numeric' }),
    );
    expect(warnings).toContain('1 region uses functions of the CoolProp plugin (fluid properties), which mathstudii does not have (CoolProp_Props): it and what depends on it is not calculated');
    expect(warnings.some((w) => /1 region uses functions whose value depends on the computer and the moment SMath ran .*\(time\)/.test(w))).toBe(true);
    expect(warnings.some((w) => /lastError/.test(w))).toBe(true);
  });
});

describe('SMath import: what SMath does not calculate, and how it rounds', () => {
  const one = (...regions: string[]) => {
    id = 0;
    top = 0;
    return importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${regions.join('')}</regions></worksheet>`), 'x.sm');
  };
  it('a region with evaluation off stays off, and defines nothing', () => {
    const { ws } = one(math(def(v('a'), v('1'))), region(`<math evaluate="false"><input>${def(v('a'), v('5'))}</input></math>`), math(v('a'), { result: 'numeric' }));
    expect(ws.regions[1].disabled).toBe(true);
    expect(value(ws, 'a =')).toMatch(/= 1/);
  });
  it('after Clear(x) what reads x waits for it again, and x[1] := … starts afresh', () => {
    const { ws, saved } = one(
      math(def(v('x'), v('2'))),
      region(`<math><input>${v('x') + fn('Clear', 1)}</input><result action="numeric">${v('1')}</result></math>`),
      math(def(v('y'), v('x') + v('3') + op('*'))),
      math(def(v('x'), v('4'))),
      region(`<math><input>${v('y')}</input><result action="numeric">${v('12')}</result></math>`),
    );
    expect(sources(ws)).toEqual(['x := 2', 'Clear(x) =', 'y(x) := x*3', 'x := 4', 'y(x) =']);
    expect(compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown)).toMatchObject({ checked: 2, agree: 2 });
  });
  it('in significant-digits mode 11330 is 11333.3 to 4 digits and 1220 is 1225 to 3; in decimal places a whole number is exact', () => {
    const shown = (attrs: string, rhs: string, saved: string) => region(`<math ${attrs}><input>${def(v('A'), rhs)}</input><result action="numeric">${v(saved)}</result></math>`);
    const { ws, saved } = one(
      shown('significantDigitsMode="true" decimalPlaces="4"', v('34000') + v('3') + op('/'), '11330'),
      shown('significantDigitsMode="true" decimalPlaces="3"', v('1225'), '1220'),
      shown('significantDigitsMode="false" decimalPlaces="4"', v('1225'), '1220'),
    );
    const cmp = compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown);
    expect(cmp).toMatchObject({ checked: 3, agree: 2 });
    expect(cmp.differ.map((d) => d.theirs)).toEqual(['1220']);
  });
});

describe('SMath import: the X-Y Plot plugin', () => {
  it('draws its functions over the saved x-axis, with the saved limits, colours, styles and labels', () => {
    id = 0;
    top = 0;
    const xy = `<xyplot width="343" height="211" points="100" name="XYPlot"><xaxes xmin="2.235174E-08" xmax="6.28" xtick="2" /><yaxes ymin="-2" ymax="2" ytick="1" />`
      + `<title2d title="" /><xylabel xlabel="wt" ylabel="Vin" /><traces>`
      + `<trace seriesname="a" plotmethod="Lines" linecolor="Blue" symboltype="None" /><trace seriesname="b" plotmethod="Points" linecolor="Red" symboltype="Circle" /><trace seriesname="c" plotmethod="Lines" linecolor="Black" symboltype="None" />`
      + `</traces><input>${v('ωt') + fn('sin', 1) + v('pts') + v('0') + v('3') + v('1') + fn('sys', 5)}</input></xyplot>`;
    const { ws } = importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${
      math(def(v('pts'), v('0') + v('0') + v('1') + v('1') + v('2') + v('2') + fn('mat', 6)))}${region(xy, 9, 40)}</regions></worksheet>`), 'x.sm');
    const p = ws.regions.find((r) => r.kind === 'plot')!;
    expect(p.kind === 'plot' && p).toMatchObject({
      xExpr: 'ωt', xmin: '0', xmax: '6.28', ymin: '-2', ymax: '2', title: 'Vin over wt', width: 343, height: 211,
      traces: [
        { y: 'sin(ωt)', style: 'line', color: 'blue' },
        { xExpr: 'col(pts, 1)', y: 'col(pts, 2)', style: 'points', color: 'red' },
        { y: '0', style: 'line' },
      ],
    });
    const res = evaluateWorksheet(ws).results.get(p.id) as { error?: string; series: { xs: number[] }[] };
    expect(res.error).toBeUndefined();
    expect(res.series[0].xs[res.series[0].xs.length - 1]).toBeCloseTo(6.28, 6);
  });
});

describe('SMath import: programs that show their value', () => {
  it('x := if … shows the value SMath showed, as x := =', () => {
    id = 0;
    top = 0;
    const prog = v('a') + v('2') + op('>') + v('y') + v('1') + op(':') + v('y') + v('2') + op(':') + fn('if', 3);
    const { ws, saved } = importSmath(strToU8(`<?xml version="1.0"?><?application progid="SMath Studio Desktop"?><worksheet xmlns="http://smath.info/schemas/worksheet/1.0"><regions>${
      math(def(v('a'), v('3')))}${region(`<math><input>${prog}</input><result action="numeric">${v('1')}</result></math>`)}${region(`<math><input>${def(v('z'), prog)}</input><result action="numeric">${v('1')}</result></math>`)}${
      region(`<math><input>${v('y')}</input><result action="numeric">${v('1')}</result></math>`)}</regions></worksheet>`), 'x.sm');
    expect(sources(ws)[1].split('\n')[0]).toBe('y := =');
    expect(sources(ws)[2].split('\n')[0]).toBe('z := =');
    expect(compareSaved(saved!, ws.regions, evaluateWithScope(ws).shown)).toMatchObject({ checked: 3, agree: 3 });
  });
});
