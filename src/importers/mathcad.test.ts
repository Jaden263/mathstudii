import { describe, it, expect, beforeAll } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { importMathcad } from './mathcad';
import { evaluateWorksheet, type MathResult, type SolveResult } from '../engine/evaluator';
import { loadCas } from '../engine/symbolic';
import type { Region, Worksheet } from '../model/types';

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
