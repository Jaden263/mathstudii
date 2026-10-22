import { describe, it, expect, beforeAll } from 'vitest';
import { zipSync, strToU8, gzipSync } from 'fflate';
import { toBase64 } from './common';
import { compoundFile } from './cfbFixture';
import { writeXlsx } from '../sheet/xlsx';
import { importMathcad, primeValue } from './mathcad';
import { evaluateWorksheet, evaluateWithScope, type MathResult, type SolveResult } from '../engine/evaluator';
import { compareSaved } from './saved';
import { loadCas } from '../engine/symbolic';
import { PAGE_HEIGHT, PAGE_MARGIN, type AreaRegion, type Region, type Worksheet } from '../model/types';
import { expandArea } from '../model/areas';

// ---------------------------------------------------------------- Mathcad Prime fixture

const id = (n: string, labels = 'VARIABLE') => `<ml:id labels="${labels}" xml:space="preserve">${n}</ml:id>`;
const real = (v: number | string) => `<ml:real>${v}</ml:real>`;
const ap = (head: string, ...args: string[]) => `<ml:apply>${head}${args.join('')}</ml:apply>`;
const unit = (v: number, u: string) => ap('<ml:scale/>', real(v), id(u, 'UNIT'));
let top = 0;
const math = (inner: string, left = 40) => `<region region-id="${++top}" left="${left}" top="${top * 40}"><math>${inner}</math></region>`;
const define = (lhs: string, rhs: string) => `<ml:define>${lhs}${rhs}</ml:define>`;
const evalOf = (e: string, u = '') => `<ml:eval>${e}${u ? `<ml:unitOverride>${u}</ml:unitOverride>` : ''}</ml:eval>`;
const lambda = (v: string, body: string) => `<ml:lambda><ml:boundVars>${id(v)}</ml:boundVars>${body}</ml:lambda>`;
const program = (...lines: string[]) => `<ml:program>${lines.join('')}</ml:program>`;

function primeWorksheet(): string {
  top = 0;
  const regions = [
    `<region region-id="t1" left="40" top="0"><text item-idref="R1"/></region>`,
    math(define(id('L'), unit(6, 'm'))),
    math(define(`<ml:id labels="VARIABLE" xml:space="preserve">f<Subscript xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">ck</Subscript></ml:id>`, unit(30, 'MPa'))),
    math(evalOf(ap('<ml:pow/>', id('L'), real(2)), ap('<ml:pow/>', id('cm', 'UNIT'), real(2)))),
    math(define(`<ml:function>${id('f', 'FUNCTION')}<ml:boundVars>${id('x')}</ml:boundVars></ml:function>`, ap('<ml:plus/>', ap('<ml:pow/>', id('x'), real(2)), real(1)))),
    math(evalOf(ap(id('f', 'FUNCTION'), real(3)))),
    // column-major: [[1, 2], [3, 4]] is stored 1, 3, 2, 4
    math(define(id('M'), `<ml:matrix rows="2" cols="2">${real(1)}${real(3)}${real(2)}${real(4)}</ml:matrix>`)),
    math(evalOf(ap('<ml:indexer/>', id('M'), `<ml:sequence>${real(1)}${real(0)}</ml:sequence>`))),
    math(define(id('i'), `<ml:range>${real(0)}${real(3)}</ml:range>`)),
    math(define(ap('<ml:indexer/>', id('v'), id('i')), ap('<ml:pow/>', id('i'), real(2)))),
    math(evalOf(ap('<ml:indexer/>', id('v'), real(3)))),
    math(define(`<ml:function>${id('fact', 'FUNCTION')}<ml:boundVars>${id('n')}</ml:boundVars></ml:function>`, program(
      `<ml:localDefine>${id('r')}${real(1)}</ml:localDefine>`,
      `<ml:for>${id('k')}<ml:range>${real(1)}${id('n')}</ml:range>${program(`<ml:localDefine>${id('r')}${ap('<ml:mult/>', id('r'), id('k'))}</ml:localDefine>`)}</ml:for>`,
      `<ml:return>${id('r')}</ml:return>`,
    ))),
    math(evalOf(ap(id('fact', 'FUNCTION'), real(5)))),
    math(define(`<ml:function>${id('sgn', 'FUNCTION')}<ml:boundVars>${id('x')}</ml:boundVars></ml:function>`, program(
      `<ml:if><ml:test>${ap('<ml:lessThan/>', id('x'), real(0))}</ml:test><ml:then>${program(ap('<ml:neg/>', real(1)))}</ml:then><ml:else>${program(real(1))}</ml:else></ml:if>`,
    ))),
    math(evalOf(ap(id('sgn', 'FUNCTION'), ap('<ml:neg/>', real(4))))),
    math(evalOf(ap('<ml:integral/>', lambda('x', ap('<ml:pow/>', id('x'), real(2))), `<ml:lowerBound>${real(0)}</ml:lowerBound>`, `<ml:upperBound>${real(3)}</ml:upperBound>`))),
    math(evalOf(ap('<ml:summation/>', lambda('k', id('k')), `<ml:lowerBound>${real(1)}</ml:lowerBound>`, `<ml:upperBound>${real(10)}</ml:upperBound>`))),
    math(evalOf(ap('<ml:div/>', ap('<ml:plus/>', real(1), real(2)), ap('<ml:minus/>', real(5), ap('<ml:minus/>', real(2), real(1)))))),
    math(evalOf(ap(id('atan2', 'FUNCTION'), `<ml:sequence>${real(0)}${real(1)}</ml:sequence>`), id('deg', 'UNIT'))),
    `<region region-id="sb" left="40" top="${++top * 40}"><solveblock><regions>
      <region solve-block-category="guess-value"><math>${define(id('x'), real(1))}</math></region>
      <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap('<ml:pow/>', id('x'), real(2)), real(2))}</math></region>
      <region solve-block-category="solver"><math>${define(id('x_s'), evalOf(ap(id('find', 'FUNCTION'), id('x'))))}</math></region>
    </regions></solveblock></region>`,
    math(`<ml:symEval>${ap('<ml:minus/>', ap('<ml:pow/>', id('y'), real(2)), real(1))}<ml:command><ml:sequence>${id('factor', 'KEYWORD')}</ml:sequence></ml:command><ml:symResult>${real(0)}</ml:symResult></ml:symEval>`),
    `<region region-id="a1" left="20" top="${++top * 40}"><Area><regions>${math(define(id('inArea'), real(7)), 10)}</regions></Area></region>`,
    `<region region-id="pic" left="300" top="40"><picture><png item-idref="R2"/></picture></region>`,
    math(`<ml:elementOf/>`),
    `<region region-id="plot" left="40" top="${++top * 40}"><plot><xyPlot><axes>
      <xAxis><plotEquations><plotEquation><math>${id('t')}</math><math><ml:placeholder/></math></plotEquation></plotEquations>
        <xyDomain><startValue>${real(0)}</startValue><endValue>${real(10)}</endValue></xyDomain></xAxis>
      <yAxis><plotEquations><plotEquation><math>${ap(id('sin', 'FUNCTION'), id('t'))}</math><math><ml:placeholder/></math></plotEquation></plotEquations></yAxis>
    </axes></xyPlot></plot></region>`,
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50" xmlns:u="http://schemas.mathsoft.com/units10">
  <regions>${regions.join('\n')}</regions>
</worksheet>`;
}

function primePackage(): Uint8Array {
  const xaml = zipSync({
    'Xaml/Document.xaml': strToU8(`<FlowDocument xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation">
      <Paragraph FontSize="24"><Run>Beam design</Run></Paragraph>
      <Paragraph><Run>Load from </Run><Bold><Run>EN 1991</Run></Bold><Run>.</Run></Paragraph></FlowDocument>`),
  });
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="R1" Type="x" Target="/mathcad/xaml/FlowDocument0.XamlPackage"/>
    <Relationship Id="R2" Type="x" Target="/mathcad/media/image1.png"/></Relationships>`;
  return zipSync({
    'mathcad/worksheet.xml': strToU8(primeWorksheet()),
    'mathcad/_rels/worksheet.xml.rels': strToU8(rels),
    'mathcad/xaml/FlowDocument0.XamlPackage': xaml,
    'mathcad/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  });
}

function results(ws: Worksheet) {
  const out = evaluateWorksheet(ws);
  const math = ws.regions.filter((r): r is Extract<Region, { kind: 'math' }> => r.kind === 'math');
  const by = (src: string) => {
    const r = math.find((m) => m.source === src);
    if (!r) throw new Error(`no region "${src}" in ${JSON.stringify(math.map((m) => m.source))}`);
    return out.results.get(r.id) as MathResult;
  };
  return { out, by };
}

describe('Mathcad Prime import', () => {
  beforeAll(async () => {
    await loadCas();
  });

  it('converts math to mathstudii syntax', () => {
    const { ws, warnings, format } = importMathcad(primePackage(), 'beam.mcdx');
    expect(format).toMatch(/Prime/);
    expect(ws.title).toBe('beam');
    const sources = ws.regions.filter((r) => r.kind === 'math').map((r) => (r as { source: string }).source);
    expect(sources).toEqual(expect.arrayContaining([
      'L := 6 m', 'f_ck := 30 MPa', 'L^2 = cm^2', 'f(x) := x^2 + 1', 'f(3) =', 'M := [1, 2; 3, 4]', 'M[1, 0] =',
      'i := 0 .. 3', 'v[i] := i^2', 'v[3] =', 'fact(5) =', 'integral(x^2, x, 0, 3) =', 'sum(k, k, 1, 10) =',
      '(1 + 2)/(5 - (2 - 1)) =', 'atan2(1, 0) = deg', 'y^2 - 1 → factor', 'inArea := 7',
    ]));
    expect(sources).toContain('fact(n) :=\n  r ← 1\n  for k ∈ 1 .. n\n    r ← r*k\n  return r');
    expect(sources).toContain('sgn(x) :=\n  if x < 0\n    -1\n  else\n    1');
    expect(warnings.join("\n")).toMatch(/“elementOf” element/);
  });

  it('produces a worksheet that calculates the same results', () => {
    const { ws } = importMathcad(primePackage(), 'beam.mcdx');
    const { by, out } = results(ws);
    expect(by('L^2 = cm^2').tex).toContain('360\\,000\\ \\mathrm{cm}^{2}');
    expect(by('f(3) =').tex).toMatch(/= 10$/);
    expect(by('M[1, 0] =').tex).toMatch(/= 3$/);
    expect(by('v[3] =').tex).toMatch(/= 9$/);
    expect(by('fact(5) =').tex).toMatch(/= 120$/);
    expect(by('sgn(-4) =').tex).toMatch(/= -1$/);
    expect(by('integral(x^2, x, 0, 3) =').tex).toMatch(/= 9$/);
    expect(by('sum(k, k, 1, 10) =').tex).toMatch(/= 55$/);
    expect(by('(1 + 2)/(5 - (2 - 1)) =').tex).toMatch(/= 0.75$/);
    expect(by('atan2(1, 0) = deg').tex).toContain('90');
    expect(by('y^2 - 1 → factor').error).toBeUndefined();
    const solve = ws.regions.find((r) => r.kind === 'solve')!;
    expect(solve).toMatchObject({ guesses: 'x := 1', constraints: 'x^2 = 2', solver: 'x_s := find(x) =' });
    expect((out.results.get(solve.id) as SolveResult).solver.tex).toContain('1.4142');
  });

  it('imports text, images, areas and plots', () => {
    const { ws } = importMathcad(primePackage(), 'beam.mcdx');
    const text = ws.regions.find((r) => r.kind === 'text' && r.markdown.includes('Beam'));
    expect(text && text.kind === 'text' && text.markdown).toBe('# Beam design\n\nLoad from **EN 1991**.');
    const img = ws.regions.find((r) => r.kind === 'image');
    expect(img && img.kind === 'image' && img.src).toMatch(/^data:image\/png;base64,iVBORw/);
    const area = ws.regions.find((r) => r.kind === 'math' && r.source === 'inArea := 7')!;
    expect(area.x).toBe(30); // area-relative position added to the area's own
    const plot = ws.regions.find((r) => r.kind === 'plot');
    expect(plot).toMatchObject({ xExpr: 't', xmin: '0', xmax: '10', traces: [{ y: 'sin(t)', style: 'line' }] });
  });

  it('rejects files that are not Mathcad worksheets', () => {
    expect(() => importMathcad(strToU8('hello'), 'x.xmcd')).toThrow(/Not a Mathcad/);
    expect(() => importMathcad(zipSync({ 'a.txt': strToU8('x') }), 'x.mcdx')).toThrow(/not a Mathcad Prime/);
  });
});

// ---------------------------------------------------------------- Mathcad 15 fixture

const id15 = (n: string, sub?: string) => `<ml:id xml:space="preserve"${sub ? ` subscript="${sub}"` : ''}>${n}</ml:id>`;

function xmcd(): string {
  top = 0;
  const m = (inner: string) => `<region region-id="${++top}" left="24" top="${top * 36}"><math optimize="false" disable-calc="false">${inner}</math></region>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30">
  <regions>
    <region region-id="t" left="24" top="0" width="300"><text><p style="Heading 1">Shaft check</p><p style="Normal">Torque <b>check</b> to code</p></text></region>
    ${m(define(id15('T', 't'), ap('<ml:mult/>', real(500), ap('<ml:mult/>', id15('N'), id15('m')))))}
    ${m(evalOf(id15('T', 't')))}
    ${m(define(id15('x'), real(1)))}
    ${m(id15('Given'))}
    ${m(ap('<ml:equal/>', ap('<ml:pow/>', id15('x'), real(2)), real(9)))}
    ${m(evalOf(ap(id15('Find'), id15('x'))))}
    ${m(define(`<ml:function>${id15('s')}<ml:boundVars>${id15('z')}</ml:boundVars></ml:function>`, program(
      `<ml:ifThen>${ap('<ml:lessThan/>', id15('z'), real(0))}${ap('<ml:neg/>', real(1))}</ml:ifThen>`,
      `<ml:otherwise>${real(1)}</ml:otherwise>`,
    )))}
    ${m(evalOf(ap(id15('s'), ap('<ml:neg/>', real(2)))))}
    ${m(evalOf(ap('<ml:integral auto-algorithm="true"/>', lambda('u', id15('u')), `<ml:bounds>${real(0)}${real(2)}</ml:bounds>`)))}
    <region region-id="p" left="300" top="0"><picture><png pixel-width="1" pixel-height="1">iVBORw0KGgo=</png></picture></region>
  </regions>
</worksheet>`;
}

describe('Mathcad 15 import', () => {
  it('converts regions, Given/Find blocks and ifThen/otherwise programs', () => {
    const { ws, warnings, format } = importMathcad(strToU8(xmcd()), 'shaft.xmcd');
    expect(format).toMatch(/11–15/);
    expect(warnings).toEqual([]);
    const sources = ws.regions.filter((r) => r.kind === 'math').map((r) => (r as { source: string }).source);
    expect(sources).toEqual(expect.arrayContaining(['T_t := 500*(N*m)', 'T_t =', 'x := 1', 's(z) :=\n  if z < 0\n    -1\n  else\n    1', 's(-2) =', 'integral(u, u, 0, 2) =']));
    const solve = ws.regions.find((r) => r.kind === 'solve');
    expect(solve).toMatchObject({ constraints: 'x^2 = 9', solver: 'find(x) =' });
    const text = ws.regions.find((r) => r.kind === 'text');
    expect(text && text.kind === 'text' && text.markdown).toBe('# Shaft check\n\nTorque **check** to code');
    expect(ws.regions.some((r) => r.kind === 'image')).toBe(true);
  });

  it('calculates after import', () => {
    const { ws } = importMathcad(strToU8(xmcd()), 'shaft.xmcd');
    const { by, out } = results(ws);
    expect(by('T_t =').tex).toContain('500\\ \\mathrm{N}\\cdot \\mathrm{m}');
    expect(by('s(-2) =').tex).toMatch(/= -1$/);
    expect(by('integral(u, u, 0, 2) =').tex).toMatch(/= 2$/);
    const solve = ws.regions.find((r) => r.kind === 'solve')!;
    expect((out.results.get(solve.id) as SolveResult).solver.tex).toMatch(/= 3$/);
  });
});

describe('Mathcad import: what writing files for Mathcad showed', () => {
  const prime = (...maths: string[]) => {
    top = 0;
    const ws = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>${maths.join('')}</regions></worksheet>`;
    return importMathcad(zipSync({ 'mathcad/worksheet.xml': strToU8(ws) }), 'x.mcdx').ws;
  };
  it("prime notation in odesolve: y′′(t) and y′(0) are derivatives, f′c is a name", () => {
    const ws = prime(
      math(define(id('fʹc'), unit(30, 'MPa'))),
      `<region region-id="sb" left="40" top="200"><solveblock><regions>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap('<ml:plus/>', ap(id('y′′'), id('t')), ap(id('y'), id('t'))), real(0))}</math></region>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap(id('y'), real(0)), real(1))}</math></region>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap(id('y′'), real(0)), real(0))}</math></region>
        <region solve-block-category="solver"><math>${define(id('y'), ap(id('odesolve', 'FUNCTION'), `<ml:sequence>${id('t')}${real(3)}</ml:sequence>`))}</math></region>
      </regions></solveblock></region>`,
      math(evalOf(ap(id('y'), real(1)))),
    );
    const solve = ws.regions.find((r) => r.kind === 'solve') as Extract<Region, { kind: 'solve' }>;
    expect(solve.constraints.split('\n')).toEqual(["y''(t) + y(t) = 0", 'y(0) = 1', "y'(0) = 0"]);
    const out = evaluateWorksheet(ws);
    const y1 = ws.regions.find((r) => r.kind === 'math' && r.source === 'y(1) =')!;
    expect((out.results.get(y1.id) as MathResult).tex).toMatch(/= 0\.5403/); // cos 1
  });
  it('a display unit stays a unit when a variable has its name', () => {
    const ws = prime(math(define(id('m'), real(3))), math(define(id('q'), evalOf(unit(12, 'N'), ap('<ml:div/>', id('N', 'UNIT'), id('m', 'UNIT'))))));
    expect(ws.regions.map((r) => (r as { source: string }).source)).toContain('q := 12 N = N/m');
  });
});

// ---------------------------------------------------------------- constructs met in public worksheets

/** A Prime worksheet of the given regions (built with math(), solve blocks …). */
function primeOf(...regions: string[]) {
  top = 0;
  const ws = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>${regions.join('')}</regions></worksheet>`;
  return importMathcad(zipSync({ 'mathcad/worksheet.xml': strToU8(ws) }), 'x.mcdx');
}
const sources = (ws: Worksheet) => ws.regions.map((r) => (r.kind === 'math' ? r.source : r.kind === 'solve' ? `${r.guesses} | ${r.constraints} | ${r.solver}` : r.kind));
const fd = (name: string) => ap('<ml:functionDerivative/>', id(name));

describe('Mathcad import: constructs met in public worksheets', () => {
  beforeAll(async () => {
    await loadCas();
  });

  it('prime notation h′(0) written with <functionDerivative/>, and odesolve(h(t), b)', () => {
    const { ws, warnings } = primeOf(
      `<region region-id="sb" left="40" top="40"><solveblock><regions>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap('<ml:derivative/>', lambda('t', ap(id('h'), id('t'))), `<ml:degree>${real(2)}</ml:degree>`), ap('<ml:neg/>', real(9.81)))}</math></region>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap(id('h'), real(0)), real(0))}</math></region>
        <region solve-block-category="constraint"><math>${ap('<ml:equal/>', ap(fd('h'), real(0)), real(10))}</math></region>
        <region solve-block-category="solver"><math>${define(id('h'), ap(id('odesolve', 'KEYWORD'), `<ml:sequence>${ap(id('h'), id('t'))}${real(3)}</ml:sequence>`))}</math></region>
      </regions></solveblock></region>`,
      math(evalOf(ap(fd('h'), real(1)))),
    );
    expect(warnings).toEqual([]);
    expect(sources(ws)).toEqual([" | diff(h(t), t, 2) = -9.81\nh(0) = 0\nh'(0) = 10 | h := odesolve(h(t), 3)", "h'(1) ="]);
    const { by } = results(ws);
    expect(by("h'(1) =").tex).toMatch(/= 0\.19$/); // 10 − 9.81
  });

  it('|v| of a vector is its length, of a square matrix its determinant', () => {
    const vec3 = `<ml:matrix rows="3" cols="1">${real(-36.13)}${real(5.98)}${real(-30.44)}</ml:matrix>`;
    const { ws } = primeOf(math(evalOf(ap('<ml:absval/>', vec3))), math(evalOf(ap('<ml:absval/>', `<ml:matrix rows="2" cols="2">${real(1)}${real(3)}${real(2)}${real(4)}</ml:matrix>`))));
    expect(sources(ws)).toEqual(['mag([-36.13; 5.98; -30.44]) =', 'mag([1, 2; 3, 4]) =']);
    const { by } = results(ws);
    // Lab01.xmcd saved 47.620698 for this vector
    expect(by('mag([-36.13; 5.98; -30.44]) =').tex).toMatch(/= 47\.6207$/);
    expect(by('mag([1, 2; 3, 4]) =').tex).toMatch(/= -2$/);
  });
});

describe('Mathcad import: areas', () => {
  const xmcdOf = (regions: string) => importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>${regions}</regions></worksheet>`), 'a.xmcd');
  const m15 = (rid: string, left: number, top: number, inner: string) => `<region region-id="${rid}" left="${left}" top="${top}" width="60" height="15"><math>${inner}</math></region>`;
  it('Mathcad 15: an open area holds its regions on the page, a collapsed one relative to itself', () => {
    const { ws } = xmcdOf([
      `<region region-id="a1" left="0" top="39" width="500" height="120"><area is-collapsed="false" name="Inputs" show-name="true">${m15('1', 42, 60, define(id15('a'), real(2)))}</area></region>`,
      // collapsed: its regions at 20 pt below its own top, and what follows saved where it is with it collapsed
      `<region region-id="a2" left="0" top="300" width="500" height="200"><area is-collapsed="true" name="Hidden">${m15('2', 42, 20, define(id15('b'), ap('<ml:mult/>', id15('a'), real(3))))}</area></region>`,
      m15('3', 42, 330, evalOf(id15('b'))),
    ].join(''));
    const PX = 96 / 72;
    const [open, shut] = ws.regions.filter((r): r is AreaRegion => r.kind === 'area');
    expect(open).toMatchObject({ title: 'Inputs', y: Math.round(39 * PX) });
    expect(open.collapsed).toBeUndefined();
    const a = ws.regions.find((r) => r.kind === 'math' && r.source === 'a := 2')!;
    expect(Math.abs(a.y - 60 * PX)).toBeLessThan(13); // on the page, inside the open band
    expect(a.y > open.y && a.y < open.y + open.height).toBe(true);
    const b = ws.regions.find((r) => r.kind === 'math' && r.source === 'b := a*3')!;
    expect(shut).toMatchObject({ title: 'Hidden', collapsed: true, hidden: [b.id] });
    // hidden at its place in the open band; what follows stays where Mathcad shows it
    expect(b.y).toBeGreaterThan(shut.y);
    const show = ws.regions.find((r) => r.kind === 'math' && r.source === 'b =')!;
    expect(Math.abs(show.y - 330 * PX)).toBeLessThan(13);
    expect((results(ws).by('b =')).tex).toMatch(/= 6$/);
    // open, the area holds b and pushes the result below its end line
    const opened = expandArea(ws, shut.id);
    const below = opened.regions.find((r) => r.id === show.id)!;
    expect(below.y).toBeGreaterThan(shut.y + shut.height - 1);
  });
  it('a page break starts a new page: what follows moves to the top of the next page', () => {
    const { ws } = xmcdOf([
      m15('1', 42, 40, define(id15('a'), real(2))),
      '<region region-id="p" left="0" top="200" width="400" height="2"><pageBreak/></region>',
      m15('2', 42, 220, define(id15('b'), real(3))),
      m15('3', 42, 300, evalOf(id15('b'))),
    ].join(''));
    const at = (src: string) => ws.regions.find((r) => r.kind === 'math' && r.source === src)!.y;
    expect(at('a := 2')).toBeLessThan(PAGE_HEIGHT);
    // the break falls at the top of the next page; what follows keeps its distance from it
    expect(Math.abs(at('b := 3') - (PAGE_HEIGHT + PAGE_MARGIN + 20 * (96 / 72)))).toBeLessThan(1);
    // what follows keeps its distance
    expect(Math.abs(at('b =') - at('b := 3') - (300 - 220) * (96 / 72))).toBeLessThan(1);
  });
  it('a page break below a collapsed area: the area’s hidden regions move with its bar', () => {
    const { ws } = xmcdOf([
      `<region region-id="a" left="0" top="20" width="500" height="100"><area is-collapsed="true" name="A">${m15('1', 42, 20, define(id15('a'), real(2)))}</area></region>`,
      '<region region-id="p" left="0" top="60" width="400" height="2"><pageBreak/></region>',
      m15('2', 42, 80, evalOf(id15('a'))),
    ].join(''));
    const bar = ws.regions.find((r): r is AreaRegion => r.kind === 'area')!;
    const a = ws.regions.find((r) => r.kind === 'math' && r.source === 'a := 2')!;
    const show = ws.regions.find((r) => r.kind === 'math' && r.source === 'a =')!;
    expect(bar.y).toBeLessThan(PAGE_HEIGHT);
    expect(a.y).toBeLessThan(PAGE_HEIGHT);
    expect(show.y).toBeGreaterThan(PAGE_HEIGHT);
    expect(ws.regions.some((r) => r.kind === 'text' && r.markdown === '')).toBe(false);
    expect(results(ws).by('a =').tex).toMatch(/= 2$/);
  });
  it('Prime: regions relative to the area; IsCollapsed and IsLocked', () => {
    const { ws } = primeOf(
      `<region region-id="a" left="0" top="100"><Area IsCollapsed="true" IsLocked="true"><regions>${math(define(id('k'), real(4)), 20)}</regions></Area></region>`,
      `<region region-id="n" left="40" top="190"><math>${evalOf(id('k'))}</math></region>`,
    );
    const bar = ws.regions.find((r): r is AreaRegion => r.kind === 'area')!;
    const k = ws.regions.find((r) => r.kind === 'math' && r.source === 'k := 4')!;
    expect(bar).toMatchObject({ collapsed: true, hidden: [k.id], locked: true });
    expect(k.locked).toBe(true);
    expect(ws.regions.find((r) => r.kind === 'math' && r.source === 'k =')!.y).toBe(190);
    expect(results(ws).by('k =').tex).toMatch(/= 4$/);
  });
});

describe('Mathcad import: programs as operands, references, Mathcad 15 names', () => {
  beforeAll(async () => {
    await loadCas();
  });
  const fnDef = (name: string, params: string[], body: string, idf = id) => define(`<ml:function>${idf(name)}<ml:boundVars>${params.map((p) => idf(p)).join('')}</ml:boundVars></ml:function>`, body);
  it('a program as a local definition’s value, a try/on error value, x := ⟨program⟩ = and a program inside an expression', () => {
    const { ws, warnings } = primeOf(
      // in(i, v) := | r ← ⟨try v[i] on error NaN⟩, r   (Beamcheck.xmcd's shape)
      math(fnDef('get', ['i', 'v'], program(`<ml:localDefine>${id('r')}<ml:tryCatch>${ap('<ml:indexer/>', id('v'), id('i'))}${id('NaN')}</ml:tryCatch></ml:localDefine>`, id('r')))),
      math(evalOf(ap(id('get', 'FUNCTION'), `<ml:sequence>${real(5)}<ml:matrix rows="2" cols="1">${real(1)}${real(2)}</ml:matrix></ml:sequence>`))),
      // L := ⟨a ← 2 m, a + 50 cm⟩ = mm
      math(define(id('L'), evalOf(program(`<ml:localDefine>${id('a')}${unit(2, 'm')}</ml:localDefine>`, ap('<ml:plus/>', id('a'), unit(50, 'cm'))), id('mm', 'UNIT')))),
      // y := 1 + ⟨b ← 3, b²⟩
      math(define(id('y'), ap('<ml:plus/>', real(1), program(`<ml:localDefine>${id('b')}${real(3)}</ml:localDefine>`, ap('<ml:pow/>', id('b'), real(2)))))),
      math(evalOf(id('y'))),
    );
    expect(warnings).toEqual([]);
    expect(sources(ws)).toEqual([
      'get(i, v) :=\n  r ←\n    try\n      v[i]\n    on error\n      NaN\n  r',
      'get(5, [1; 2]) =',
      'L := = mm\n  a ← 2 m\n  a + 50 cm',
      'y :=\n  p_1 ←\n    b ← 3\n    b^2\n  1 + p_1',
      'y =',
    ]);
    const { by, out } = results(ws);
    expect(by('get(5, [1; 2]) =').tex).toMatch(/= \\mathrm\{NaN\}$/);
    expect((out.results.get(ws.regions[2].id) as MathResult).tex).toMatch(/= 2500\\ \\mathrm\{mm\}$/);
    expect(by('y =').tex).toMatch(/= 10$/);
  });

  it('a Prime reference whose worksheet the package caches: its definitions in a locked, collapsed area', () => {
    top = 0;
    const main = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
      <region region-id="1" top="40" left="0"><reference href="D:\\calc\\Concrete.mcdx" item-idref="R9"/></region>
      <region region-id="2" top="70" left="40"><math>${evalOf(ap('<ml:mult/>', real(2), id('f_ck')))}</math></region></regions></worksheet>`;
    const cachedWs = `<cachedWorksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
      <region region-id="5" top="20" left="20"><math>${define(id('f_ck'), unit(30, 'MPa'))}</math></region>
      <region region-id="6" top="60" left="20"><text item-idref="R1"/></region></regions></cachedWorksheet>`;
    const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="R9" Type="include" Target="/mathcad/include/include1.xml"/></Relationships>`;
    const { ws, warnings } = importMathcad(zipSync({
      'mathcad/worksheet.xml': strToU8(main), 'mathcad/_rels/worksheet.xml.rels': strToU8(rels), 'mathcad/include/include1.xml': strToU8(cachedWs),
    }), 'x.mcdx');
    expect(warnings.join('\n')).toMatch(/references Concrete\.mcdx: its definitions come from the copy Prime saved/);
    const bar = ws.regions.find((r): r is AreaRegion => r.kind === 'area')!;
    const fck = ws.regions.find((r) => r.kind === 'math' && r.source === 'f_ck := 30 MPa')!;
    expect(bar).toMatchObject({ title: 'Reference: Concrete.mcdx', collapsed: true, locked: true, hidden: [fck.id] });
    // only what calculates is taken from the referenced worksheet
    expect(ws.regions.filter((r) => r.kind === 'text')).toEqual([]);
    expect(results(ws).by('2*f_ck =').tex).toContain('60');
  });

  it('a reference the file does not cache: listed to pick; once picked, its definitions in a locked, collapsed area', () => {
    top = 0;
    const main = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
      <region region-id="1" top="40" left="0"><reference used-cache="false" href=".\\..\\Inputs.mcdx"/></region>
      <region region-id="2" top="70" left="40"><math>${evalOf(ap('<ml:mult/>', real(2), id('Q')))}</math></region></regions></worksheet>`;
    const inputs = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
      <region region-id="5" top="20" left="20"><math>${define(id('Q'), unit(3, 'm'))}</math></region>
      <region region-id="6" top="60" left="20"><reference href="Inputs.mcdx"/></region></regions></worksheet>`;
    const file = zipSync({ 'mathcad/worksheet.xml': strToU8(main) });
    const without = importMathcad(file, 'x.mcdx');
    expect(without.references).toEqual(['Inputs.mcdx']);
    expect(without.warnings.join('\n')).toMatch(/A reference to Inputs\.mcdx .*Pick Inputs\.mcdx in this report/);
    const withRef = importMathcad(file, 'x.mcdx', { references: { 'Inputs.mcdx': zipSync({ 'mathcad/worksheet.xml': strToU8(inputs) }) } });
    expect(withRef.references).toBeUndefined();
    expect(withRef.warnings.join('\n')).toMatch(/references Inputs\.mcdx: its definitions come from the copy you picked/);
    const bar = withRef.ws.regions.find((r): r is AreaRegion => r.kind === 'area')!;
    expect(bar).toMatchObject({ title: 'Reference: Inputs.mcdx', collapsed: true, locked: true });
    expect(results(withRef.ws).by('2*Q =').tex).toMatch(/= 6\\ \\mathrm\{m\}$/);
  });

  it('Mathcad 15: a name is a unit until the worksheet defines it, and a name in a style of its own is another name', () => {
    const font = (n: string) => `<ml:id xml:space="preserve" font="17">${n}</ml:id>`;
    const { ws } = importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>
  <region region-id="1" left="24" top="30"><math>${evalOf(ap('<ml:mult/>', real(6), id15('in')), id15('mm'))}</math></region>
  <region region-id="2" left="24" top="60"><math>${fnDef('in', ['i', 'v'], ap('<ml:indexer/>', id15('v'), id15('i')), (n) => (n === 'in' ? font(n) : id15(n)))}</math></region>
  <region region-id="3" left="24" top="90"><math>${evalOf(ap('<ml:mult/>', real(2), id15('in')), id15('mm'))}</math></region>
  <region region-id="4" left="24" top="120"><math>${evalOf(ap(font('in'), `<ml:sequence>${real(1)}<ml:matrix rows="2" cols="1">${real(10)}${real(20)}</ml:matrix></ml:sequence>`))}</math></region>
  <region region-id="5" left="24" top="150"><math>${define(id15('N'), real(5))}</math></region>
  <region region-id="6" left="24" top="180"><math>${evalOf(ap('<ml:mult/>', real(2), id15('N')))}</math></region>
</regions></worksheet>`), 'n.xmcd');
    // the unit inch before and after a function in() in another style; N a variable once defined
    expect(sources(ws)).toEqual(['6*inch = mm', 'in_(i, v) := v[i]', '2*inch = mm', 'in_(1, [10; 20]) =', 'N := 5', '2*N =']);
    const { by } = results(ws);
    expect(by('6*inch = mm').tex).toMatch(/152\.4/);
    expect(by('in_(1, [10; 20]) =').tex).toMatch(/= 20$/);
    expect(by('2*N =').tex).toMatch(/= 10$/);
  });
});

describe('Mathcad 15 import: percent, saved values, value lists', () => {
  const xmcdOf = (regions: string) => importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>${regions}</regions></worksheet>`), 'p.xmcd');
  const m15 = (rid: number, inner: string) => `<region region-id="${rid}" left="24" top="${rid * 30}"><math>${inner}</math></region>`;
  const result = (inner: string) => `<result xmlns="http://schemas.mathsoft.com/math30">${inner}</result>`;
  it('40·%·I is 40 % of I', () => {
    const { ws } = xmcdOf(m15(1, define(id15('I'), real(20))) + m15(2, define(id15('ΔI'), evalOf(ap('<ml:mult/>', ap('<ml:mult/>', real(40), id15('%')), id15('I'))))));
    expect(sources(ws)).toEqual(['I := 20', 'ΔI := 40 %*I =']);
    expect(results(ws).by('ΔI := 40 %*I =').tex).toMatch(/= 8$/);
  });
  it('reads saved results in Mathcad’s unit names (megapascal, kips_per_sq_inch) and complex numbers with one part', () => {
    const united = (v: number, unitName: string) => `<unitedValue>${real(v)}<unitMonomial><unitReference unit="${unitName}"/></unitMonomial></unitedValue>`;
    const evalSaved = (e: string, saved: string) => `<ml:eval>${e}${result(saved)}</ml:eval>`;
    const res = xmcdOf([
      m15(1, evalSaved(ap('<ml:mult/>', real(30), id15('MPa')), united(30, 'megapascal'))),
      m15(2, evalSaved(ap('<ml:mult/>', real(2), id15('ksi')), united(2, 'kips_per_sq_inch'))),
      m15(3, evalSaved(ap('<ml:mult/>', real(3), id15('i')), '<complex><imag>3</imag></complex>')),
    ].join(''));
    expect(res.saved!.map((s) => s.expr)).toEqual(['(30)*MPa', '(2)*ksi', '(0 + 3i)']);
    const cmp = compareSaved(res.saved!, res.ws.regions, evaluateWithScope(res.ws).shown);
    expect(cmp).toMatchObject({ checked: 3, agree: 3 });
  });
  it('x[i] := 0.2, 1, 2 (a list of values) is the vector of them', () => {
    const { ws } = xmcdOf(m15(1, define(ap('<ml:indexer/>', id15('D'), id15('z')), `<ml:sequence>${real(0.2)}${real(1)}${real(2)}</ml:sequence>`)) + m15(2, evalOf(ap('<ml:indexer/>', id15('D'), real(2)))));
    expect(sources(ws)).toEqual(['D := [0.2; 1; 2]', 'D[2] =']);
    expect(results(ws).by('D[2] =').tex).toMatch(/= 2$/);
  });
});

describe('Mathcad import: how numbers are shown', () => {
  it('the worksheet’s precision and exponential threshold, and a region’s own result format', () => {
    top = 0;
    const presentation = `<presentation xmlns:ws="http://schemas.mathsoft.com/worksheet50" xmlns="http://schemas.ptc.com/mathcad/settings/presentation10"><mathRendering><ws:results><general precision="2" exponential-threshold="3" xmlns="http://schemas.mathsoft.com/worksheet50"/></ws:results></mathRendering></presentation>`;
    const fmt = '<resultFormat><engineering precision="3" show-trailing-zeros="false"/></resultFormat>';
    const ws = `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"><regions>
      <region region-id="1" top="40" left="40"><math>${evalOf(real(1234.5678))}</math></region>
      <region region-id="2" top="80" left="40"><math>${evalOf(real(0.000160218))}${fmt}</math></region></regions></worksheet>`;
    const res = importMathcad(zipSync({ 'mathcad/worksheet.xml': strToU8(ws), 'mathcad/settings/presentation.xml': strToU8(presentation) }), 'f.mcdx');
    expect(res.ws.settings).toMatchObject({ precision: 2, expThreshold: 3 });
    expect((res.ws.regions[1] as Extract<Region, { kind: 'math' }>).format).toEqual({ precision: 3, style: 'engineering' });
    const { by } = results(res.ws);
    expect(by('1234.5678 =').tex).toMatch(/= 1.23 \\cdot 10\^\{3\}$/);
    expect(by('0.000160218 =').tex).toMatch(/= 160.218 \\cdot 10\^\{-6\}$/);
  });
});

describe('Mathcad import: input controls', () => {
  it('a combo box keeps its choices: the region shows them, the definition has the picked one', () => {
    const combo = `<ml:ComboBoxControl rows="3" cols="2" SelectedRow="1" ComboBoxPrefix=""><ml:ComboBoxRowNames><ml:rowName>C12</ml:rowName><ml:rowName>C16</ml:rowName><ml:rowName>C20</ml:rowName></ml:ComboBoxRowNames><ml:ComboBoxScaleFactors>${id('MPa', 'UNIT')}<ml:placeholder /></ml:ComboBoxScaleFactors><ml:ComboBoxValues>${[12, 1.1, 16, 1.3, 20, 1.5].map(real).join('')}</ml:ComboBoxValues></ml:ComboBoxControl>`;
    const res = primeOf(math(define(`<ml:matrix rows="2" cols="1">${id('f_ck')}${id('k')}</ml:matrix>`, combo)), math(evalOf(id('k'))));
    const r = res.ws.regions[0] as Extract<Region, { kind: 'math' }>;
    expect(r.source).toBe('[f_ck; k] := [16 MPa; 1.3]');
    expect(r.choices).toEqual({ labels: ['C12', 'C16', 'C20'], values: ['[12 MPa; 1.1]', '[16 MPa; 1.3]', '[20 MPa; 1.5]'], selected: 1 });
    expect(res.warnings.join('\n')).not.toMatch(/input control/);
    expect(results(res.ws).by('k =').tex).toMatch(/= 1.3$/);
  });
  it('a list box run by a script: the value it gave when saved', () => {
    const rl = btoa('(op_matrix:0x00000003 (unboxed 2) (unboxed 1) (list (number 3:0x00000004) (number 0.13:0x00000005)))');
    const lb = `<ml:ListBoxScriptableControl Count="3" SelectedIndex="0" EngineType="JScript" RL="${rl}"><ml:vals><ml:val>Class S</ml:val><ml:val>Class N</ml:val><ml:val>Class R</ml:val></ml:vals></ml:ListBoxScriptableControl>`;
    const res = primeOf(math(define(id('α'), lb)));
    expect(sources(res.ws)).toEqual(['α := [3; 0.13]']);
    expect(res.warnings.join('\n')).toMatch(/list box for α runs a script \(JScript\), which does not run here: it is imported as the value it gave for “Class S”, \[3; 0\.13\]; the other 2 choices are not offered/);
    expect(primeValue('(op_matrix:0x1 (unboxed 2) (unboxed 2) (list (number 1:0x2) (number 3:0x3) (number 2:0x4) (number 4:0x5)))')).toBe('[1, 2; 3, 4]');
    expect(primeValue('(string "Class S")')).toBe('"Class S"');
    expect(primeValue('(unknown 1)')).toBeNull();
  });
});

describe('Mathcad 15 import: data files', () => {
  /** A component's saved state as Mathcad keeps it: UTF-16 names in an OLE stream, gzipped and base64'd. */
  const state = (...names: string[]) => {
    const parts: number[] = [1, 2, 3];
    for (const n of names) {
      parts.push(0, n.length + 1, 0xff);
      for (const ch of n) parts.push(ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8);
      parts.push(0, 0);
    }
    return toBase64(gzipSync(Uint8Array.from(parts)));
  };
  const sheet = (component: string, item: string) => importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>
<region region-id="1" left="24" top="20" width="100" height="40">${component}</region>
<region region-id="2" left="24" top="90"><math><ml:eval>${id15('Pattern')}</ml:eval></math></region>
</regions><binaryContent><item item-id="7" content-encoding="gzip">${item}</item></binaryContent></worksheet>`), 'd.xmcd');
  it('a File Read component reads its file with READCSV or READPRN, from the data files the worksheet keeps', () => {
    const res = sheet(`<component clsid-buddy="01350083-1122-11DB-9380-000D56C6051A" item-idref="7"><inputs/><outputs>${id15('Pattern')}</outputs></component>`, state('Pattern', 'Root Entry', 'Contents', '..\\data\\beam.csv', 'Pattern'));
    expect(sources(res.ws)).toEqual(['Pattern := READCSV("..\\\\data\\\\beam.csv")', 'Pattern =']);
    expect(res.warnings.join('\n')).toMatch(/File Read component for Pattern at \d+ px became Pattern := READCSV\("beam.csv"\): attach beam.csv in File ▸ Data files…/);
    const ws = { ...res.ws, settings: { ...res.ws.settings, dataFiles: { 'beam.csv': '4,5\n6,7\n' } } };
    expect(results(ws).by('Pattern =').tex).toMatch(/4[\s\S]*5[\s\S]*6[\s\S]*7/);
  });
});

describe('Mathcad Prime import: Excel components', () => {
  it('becomes a spreadsheet region with the embedded workbook, its inputs and its outputs', () => {
    const book = writeXlsx({ sheets: [{ name: 'Calc', cells: { A1: { v: 2 }, B1: { v: 6, f: 'A1*3' } } }] });
    const NS = 'xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"';
    const cell = (ref: string) => ap('<ml:indexer/>', id('excel'), `<ml:str>${ref}</ml:str>`);
    const ws = `<?xml version="1.0" encoding="utf-8"?><worksheet ${NS}><regions>
      <region region-id="1" top="40" left="40"><math>${define(id('a'), real(5))}</math></region>
      <region region-id="2" top="100" left="40"><excelComponent><regions>
        <region region-id="3" top="10" left="10"><math>${define(cell('A1'), id('a'))}</math></region>
        <region region-id="4" top="60" left="0"><excelTable item-idref="X1"><OleViewportSize width="400" height="60"/></excelTable></region>
        <region region-id="5" top="130" left="10"><math>${define(id('b'), cell('B1'))}</math></region>
      </regions></excelComponent></region>
      <region region-id="6" top="300" left="40"><math>${evalOf(id('b'))}</math></region></regions></worksheet>`;
    const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="X1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/excel" Target="/mathcad/excel/excel1.ole"/></Relationships>';
    const res = importMathcad(zipSync({
      'mathcad/worksheet.xml': strToU8(ws),
      'mathcad/_rels/worksheet.xml.rels': strToU8(rels),
      'mathcad/excel/excel1.ole': compoundFile('Package', book),
    }), 'x.mcdx');
    const sheet = res.ws.regions.find((r) => r.kind === 'spreadsheet') as Extract<Region, { kind: 'spreadsheet' }>;
    expect(sheet.inputs).toEqual([{ expr: 'a', ref: 'A1' }]);
    expect(sheet.outputs).toEqual([{ name: 'b', ref: 'B1' }]);
    expect(sheet.sheets[0].name).toBe('Calc');
    expect(results(res.ws).by('b =').tex).toMatch(/= 15$/);
  });
});

describe('Mathcad import: systems of element definitions', () => {
  it('a column of elements on the left is written as such', () => {
    const el = (n: string, i: string) => ap('<ml:indexer/>', id(n), i);
    const { ws } = primeOf(
      math(define(id('j'), `<ml:range>${real(0)}${real(2)}</ml:range>`)),
      math(define(`<ml:matrix rows="2" cols="1">${el('u', real(0))}${el('v', real(0))}</ml:matrix>`, `<ml:matrix rows="2" cols="1">${real(1)}${real(0)}</ml:matrix>`)),
      math(define(`<ml:matrix rows="2" cols="1">${el('u', ap('<ml:plus/>', id('j'), real(1)))}${el('v', ap('<ml:plus/>', id('j'), real(1)))}</ml:matrix>`, `<ml:matrix rows="2" cols="1">${ap('<ml:plus/>', el('u', id('j')), el('v', id('j')))}${el('u', id('j'))}</ml:matrix>`)),
      math(evalOf(el('u', real(3)))),
    );
    expect(sources(ws).slice(1, 3)).toEqual(['[u[0]; v[0]] := [1; 0]', '[u[j + 1]; v[j + 1]] := [u[j] + v[j]; u[j]]']);
    expect(results(ws).by('u[3] =').tex).toMatch(/= 3$/);
  });
});

describe('Mathcad import: spec tables', () => {
  it('a row a math region, all within the table, above a region below it that uses them', () => {
    const row = (n: string, v: string) => `<math>${define(id(n), v)}</math>`;
    const { ws } = primeOf(
      `<region region-id="t" left="40" top="40" actualHeight="45"><spec-table>${row('a', real(1))}${row('b', real(2))}${row('c', ap('<ml:plus/>', id('a'), id('b')))}</spec-table></region>`,
      `<region region-id="d" left="300" top="70"><math>${evalOf(ap('<ml:mult/>', id('c'), real(2)))}</math></region>`,
    );
    const ys = ws.regions.filter((r) => r.kind === 'math').map((r) => r.y);
    expect(ys[2] - ys[0]).toBeLessThanOrEqual(45);
    expect(ys[2]).toBeLessThan(ys[3]);
    expect(results(ws).by('c*2 =').tex).toMatch(/= 6$/);
  });
});

describe('Mathcad 15 import: custom operators, names in several styles, program statements in parentheses', () => {
  const xmcdOf = (regions: string) => importMathcad(strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30"><regions>${regions}</regions></worksheet>`), 'o.xmcd');
  const m15 = (rid: number, inner: string) => `<region region-id="${rid}" left="24" top="${rid * 30}"><math>${inner}</math></region>`;
  const fn15 = (name: string, params: string[], body: string, idf = id15) => define(`<ml:function>${idf(name)}<ml:boundVars>${params.map((p) => id15(p)).join('')}</ml:boundVars></ml:function>`, body);
  const infix = (op: string, a: string, b: string) => `<ml:apply fixity="infix">${id15(op)}${a}${b}</ml:apply>`;
  it('operators named || and |+ (functions written between their operands) stay apart', () => {
    const { ws } = xmcdOf([
      m15(1, fn15('||', ['A', 'B'], ap('<ml:div/>', ap('<ml:mult/>', id15('A'), id15('B')), ap('<ml:plus/>', id15('A'), id15('B'))))),
      m15(2, fn15('|+', ['A', 'B'], ap('<ml:plus/>', id15('A'), ap('<ml:mult/>', real(10), id15('B'))))),
      m15(3, evalOf(infix('||', real(2), real(2)))),
      m15(4, evalOf(infix('|+', real(2), real(2)))),
    ].join(''));
    expect(sources(ws)).toEqual(['op_bar_bar(A, B) := A*B/(A + B)', 'op_bar_plus(A, B) := A + 10*B', 'op_bar_bar(2, 2) =', 'op_bar_plus(2, 2) =']);
    const { by } = results(ws);
    expect(by('op_bar_bar(2, 2) =').tex).toMatch(/= 1$/);
    expect(by('op_bar_plus(2, 2) =').tex).toMatch(/= 22$/);
  });
  it('a name in two styles of its own besides the plain one is three names', () => {
    const styled = (n: string, font: string) => `<ml:id xml:space="preserve" font="${font}">${n}</ml:id>`;
    const { ws } = xmcdOf([
      m15(1, define(id15('F'), real(1))),
      m15(2, define(styled('F', '4'), real(2))),
      m15(3, define(styled('F', '7'), real(3))),
      m15(4, evalOf(ap('<ml:plus/>', ap('<ml:plus/>', id15('F'), ap('<ml:mult/>', real(10), styled('F', '4'))), ap('<ml:mult/>', real(100), styled('F', '7'))))),
    ].join(''));
    expect(sources(ws).slice(0, 3)).toEqual(['F := 1', 'F_ := 2', 'F_2 := 3']);
    expect(results(ws).by('F + 10*F_ + 100*F_2 =').tex).toMatch(/= 321$/);
  });
  it('a name in the Constants style (font 1) is the plain name; trace(S, …) is a message; the worksheet calculates as Mathcad 15', () => {
    const constant = (n: string) => `<ml:id xml:space="preserve" font="1">${n}</ml:id>`;
    const { ws } = xmcdOf([
      m15(1, fn15('twice', ['x'], program(
        `<ml:localDefine><ml:function>${constant('f')}<ml:boundVars>${id15('y')}</ml:boundVars></ml:function>${ap('<ml:mult/>', real(2), id15('y'))}</ml:localDefine>`,
        ap(id15('trace'), `<ml:sequence><ml:str>x = {0}</ml:str>${id15('x')}</ml:sequence>`),
        ap(id15('f'), id15('x')),
      ))),
      m15(2, evalOf(ap(id15('twice'), ap('<ml:mult/>', constant('π'), real(1))))),
    ].join(''));
    expect(sources(ws)[0]).toBe('twice(x) :=\n  f(y) ← 2*y\n  traceText("x = {0}", x)\n  f(x)');
    expect(ws.settings.mathcad15).toBe(true);
    expect(results(ws).by('twice(π*1) =').tex).toMatch(/= 6\.2832$/);
  });
  it('(M)[i] ← v: an element of M whose name is drawn in parentheses', () => {
    const { ws } = xmcdOf(m15(1, define(id15('M'), program(
      `<ml:localDefine>${ap('<ml:indexer/>', `<ml:parens>${id15('v')}</ml:parens>`, real(1))}${real(7)}</ml:localDefine>`,
      id15('v'),
    ))) + m15(2, evalOf(ap('<ml:indexer/>', id15('M'), real(1)))));
    expect(sources(ws)[0]).toBe('M :=\n  v[1] ← 7\n  v');
    expect(results(ws).by('M[1] =').tex).toMatch(/= 7$/);
  });
  it('(break) and (return x): a program statement in parentheses is that statement', () => {
    const { ws } = xmcdOf([
      m15(1, fn15('first', ['v'], program(
        `<ml:for>${id15('k')}<ml:range>${real(0)}${real(9)}</ml:range>${program(`<ml:ifThen>${ap('<ml:greaterThan/>', ap('<ml:indexer/>', id15('v'), id15('k')), real(2))}<ml:parens><ml:return>${id15('k')}</ml:return></ml:parens></ml:ifThen>`)}</ml:for>`,
        ap('<ml:neg/>', real(1)),
      ))),
      m15(2, evalOf(ap(id15('first'), `<ml:matrix rows="4" cols="1">${real(1)}${real(2)}${real(5)}${real(7)}</ml:matrix>`))),
    ].join(''));
    expect(sources(ws)[0]).toBe('first(v) :=\n  for k ∈ 0 .. 9\n    if v[k] > 2\n      return k\n  -1');
    expect(results(ws).by('first([1; 2; 5; 7]) =').tex).toMatch(/= 2$/);
  });
});

describe('saved results: nested arrays', () => {
  it('compare element by element, an array among the elements by its own elements', () => {
    const { ws, saved } = primeOf(math(define(id('N'), `<ml:matrix rows="2" cols="1">${real(1)}<ml:matrix rows="2" cols="1">${real(2)}${real(3)}</ml:matrix></ml:matrix>`)), math(evalOf(id('N'))));
    const shown = evaluateWithScope(ws).shown;
    const reg = ws.regions.find((r) => r.kind === 'math' && r.source === 'N =')!;
    expect(compareSaved([{ regionId: reg.id, expr: '[1; [2; 3]]' }, ...(saved ?? [])], ws.regions, shown)).toMatchObject({ checked: 1, agree: 1 });
    expect(compareSaved([{ regionId: reg.id, expr: '[1; [2; 4]]' }], ws.regions, shown)).toMatchObject({ checked: 1, agree: 0 });
  });
});
