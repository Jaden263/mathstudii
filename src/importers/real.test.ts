import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { importMathcad } from './mathcad';
import { importSmath } from './smath';
import { compareSaved } from './saved';
import { evaluateWithScope, type MathResult } from '../engine/evaluator';
import { loadCas } from '../engine/symbolic';
import type { Region, Worksheet } from '../model/types';

// Files saved by Mathcad Prime 11/12, Mathcad 14/15 and SMath Studio (licences and sources in
// fixtures/README.md). Each keeps the results its program calculated; the import is checked by
// recalculating and comparing with them.
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function check(name: string) {
  const bytes = fixture(name);
  const res = /\.sm$/.test(name) ? importSmath(bytes, name) : importMathcad(bytes, name);
  const ev = evaluateWithScope(res.ws);
  return { res, ev, cmp: compareSaved(res.saved ?? [], res.ws.regions, ev.shown) };
}

const math = (ws: Worksheet) => ws.regions.filter((r): r is Extract<Region, { kind: 'math' }> => r.kind === 'math');

describe('real worksheets: recalculated results agree with the saved ones', () => {
  beforeAll(() => loadCas());

  it.each([
    // file, saved results, how many must agree; what each one pins
    ['mcad2py-trig.mcdx', 19, 19], // acot's (0, π) branch, results shown in deg
    ['mcad2py-hyperbolic.mcdx', 13, 13], // sinh of an angle in degrees, inverse functions shown in deg
    ['mcad2py-range_sum.mcdx', 6, 6], // Σ of a vector, Σ over a range variable, Σ with bounds
    ['mcad2py-Constants.mcdx', 19, 17], // labelled constants (e_c, ℏ, μ_0 …), units with a numeric scale
    ['mcad2py-solve_as_function.mcdx', 3, 3], // f(a, b) := find(x)
    ['mcad2py-collapsable-area.mcdx', 1, 1],
    ['mcad2py-seed.mcdx', 53, 52], // Seed and the r… generators draw Mathcad's own numbers
    ['mcad2py-stack_augment_lookup.mcdx', 15, 12], // match, lookup, vlookup, hlookup, vhlookup
    ['g431-can-timing.xmcd', 1, 1], // a Mathcad 14 result saved in kHz
    ['cs-amp-hand-calculations.xmcd', 14, 14], // 7 pF (pF is also a function), Ω, μ prefixes
    ['calculix-beam.sm', 7, 7],
    ['calculix-streifen.sm', 7, 7], // angles in degrees shown as plain numbers, MPa, %
    ['mononobe-okabe.sm', 11, 5],
  ] as const)('%s', (name, saved, agree) => {
    const { res, cmp } = check(name);
    expect(res.saved?.length).toBe(saved);
    expect(cmp.agree, JSON.stringify(cmp.differ, null, 1)).toBeGreaterThanOrEqual(agree);
  }, 60000);

  it('Mathcad Prime: constants by label, inline if, display units with a scale', () => {
    const { res, ev } = check('mcad2py-Constants.mcdx');
    const src = math(res.ws).map((r) => r.source);
    expect(src).toEqual(expect.arrayContaining(['elementaryCharge = pC', 'reducedPlanckConstant = kg*m^2/s', 'avogadro =']));
    expect(res.warnings.join('\n')).toMatch(/shown in the unit alone/);
    const r = math(res.ws).find((m) => m.source === 'elementaryCharge = pC')!;
    expect((ev.results.get(r.id) as MathResult).tex).toContain('1.6022');
  });

  it('Mathcad 15: an align-y ordering, units without labels, regions kept off the page', () => {
    const { res } = check('cs-amp-hand-calculations.xmcd');
    expect(math(res.ws).map((r) => r.source)).toContain('Cap := 7*pF');
    expect(res.format).toMatch(/11–15/);
  });

  it('SMath: angles count as plain numbers in display units', () => {
    const { res, ev } = check('calculix-streifen.sm');
    const sigma = math(res.ws).find((m) => m.source.startsWith('σ := E*ε'))!;
    // 210 GPa · 0.45° … strain from a bend through 0.45°: SMath shows 1.649 GPa (saved)
    expect((ev.results.get(sigma.id) as MathResult).error).toBeUndefined();
  });
});

// ---------------------------------------------------------------- constructs found in real files, built by hand

const ML = 'xmlns:ml="http://schemas.mathsoft.com/math30"';
const id = (n: string, sub?: string) => `<ml:id xml:space="preserve"${sub ? ` subscript="${sub}"` : ''}>${n}</ml:id>`;
const real = (v: number | string) => `<ml:real>${v}</ml:real>`;
const ap = (head: string, ...a: string[]) => `<ml:apply>${head}${a.join('')}</ml:apply>`;
const define = (l: string, r: string) => `<ml:define ${ML}>${l}${r}</ml:define>`;

function xmcd(regions: string[]): Uint8Array {
  return strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet version="3.0.3" xmlns="http://schemas.mathsoft.com/worksheet30" xmlns:ml="http://schemas.mathsoft.com/math30" xmlns:p="http://schemas.mathsoft.com/provenance10">
  <settings><calculation><builtInVariables array-origin="0"/></calculation></settings>
  <regions>${regions.join('\n')}</regions>
</worksheet>`);
}
const region = (left: number, top: number, alignY: number, body: string) =>
  `<region left="${left}" top="${top}" width="60" height="20" align-x="${left}" align-y="${alignY}"><math>${body}</math></region>`;

describe('Mathcad 15 constructs', () => {
  it('orders by the math baseline (align-y), as Mathcad calculates', () => {
    // Simpson's rule worksheet: h := (b − a)/N rises above the line of N := 5 to its left
    const ws = importMathcad(xmcd([
      region(10, 10, 20, define(id('a'), real(1))),
      region(60, 10, 20, define(id('b'), real(2))),
      region(10, 48, 58, define(id('N'), real(5))),
      region(80, 40, 58, define(id('h'), ap('<ml:div/>', ap('<ml:minus/>', id('b'), id('a')), id('N')))),
      region(10, 80, 90, `<ml:eval ${ML}>${id('h')}<result xmlns="http://schemas.mathsoft.com/math30"><ml:real>0.2</ml:real></result></ml:eval>`),
    ]), 's.xmcd');
    const ev = evaluateWithScope(ws.ws);
    expect(compareSaved(ws.saved!, ws.ws.regions, ev.shown)).toMatchObject({ checked: 1, agree: 1 });
    expect(ws.ws.regions.find((r) => r.kind === 'math' && r.source === 'h := (b - a)/N')!.y)
      .toBe(ws.ws.regions.find((r) => r.kind === 'math' && r.source === 'N := 5')!.y);
  });

  it('looks through provenance wrappers and sets ORIGIN, reads <ml:Find/>, Ω and a reference', () => {
    const prov = (inner: string) => `<ml:provenance ${ML}><originRef xmlns="http://schemas.mathsoft.com/provenance10" href="a.xmcd"><hash/></originRef><contentHash xmlns="http://schemas.mathsoft.com/provenance10">0</contentHash>${inner}</ml:provenance>`;
    const ws = importMathcad(xmcd([
      region(10, 0, 10, prov(`<ml:define>${id('ORIGIN')}${real(1)}</ml:define>`)),
      region(10, 30, 40, define(id('R'), ap('<ml:mult/>', real(4.7), id('kΩ')))),
      region(10, 60, 70, define(id('x'), real(1))),
      region(10, 90, 100, `${id('Given')}`.replace('<ml:id', `<ml:id ${ML}`)),
      region(10, 120, 130, `<ml:apply ${ML}><ml:equal/>${ap('<ml:pow/>', id('x'), real(2))}${real(2)}</ml:apply>`),
      region(10, 150, 160, define(id('x', 's'), ap('<ml:Find/>', id('x')))),
      `<region left="10" top="190" width="60" height="10"><reference><originRef xmlns="http://schemas.mathsoft.com/provenance10" href="C:\\calc\\units.xmcd"/></reference></region>`,
    ]), 'p.xmcd');
    expect(ws.ws.settings.origin).toBe(1);
    expect(math(ws.ws).map((r) => r.source)).toContain('R := 4.7*kohm');
    expect(ws.ws.regions.find((r) => r.kind === 'solve')).toMatchObject({ constraints: 'x^2 = 2', solver: 'x_s := find(x)' });
    expect(ws.warnings.join('\n')).toMatch(/reference to units\.xmcd/);
  });

  it('a for loop whose body is an ifThen, and Σ of a vector (vectorSum)', () => {
    const ws = importMathcad(xmcd([
      region(10, 0, 10, define(id('v'), `<ml:matrix rows="3" cols="1">${real(1)}${real(-4)}${real(2)}</ml:matrix>`)),
      region(10, 30, 40, define(`<ml:function>${id('mx')}<ml:boundVars>${id('a')}</ml:boundVars></ml:function>`, `<ml:program>
        <ml:localDefine>${id('m')}${real(0)}</ml:localDefine>
        <ml:for>${id('j')}<ml:range>${real(0)}${real(2)}</ml:range><ml:ifThen>${ap('<ml:greaterThan/>', ap('<ml:absval/>', ap('<ml:indexer/>', id('a'), id('j'))), id('m'))}<ml:localDefine>${id('m')}${ap('<ml:absval/>', ap('<ml:indexer/>', id('a'), id('j')))}</ml:localDefine></ml:ifThen></ml:for>
        ${id('m')}</ml:program>`)),
      region(10, 80, 90, `<ml:eval ${ML}>${ap(id('mx'), id('v'))}</ml:eval>`),
      region(10, 110, 120, `<ml:eval ${ML}>${ap('<ml:vectorSum/>', id('v'))}</ml:eval>`),
    ]), 'l.xmcd');
    const ev = evaluateWithScope(ws.ws);
    const value = (src: string) => (ev.results.get(math(ws.ws).find((r) => r.source === src)!.id) as MathResult).tex;
    expect(value('mx(v) =')).toMatch(/= 4$/);
    expect(value('sum(v) =')).toMatch(/= -1$/);
  });
});

describe('Mathcad Prime constructs', () => {
  const W = 'xmlns="http://schemas.mathsoft.com/worksheet50" xmlns:ml="http://schemas.mathsoft.com/math50"';
  const pid = (n: string, labels = 'VARIABLE') => `<ml:id labels="${labels}" xml:space="preserve">${n}</ml:id>`;
  let top = 0;
  const m = (inner: string) => `<region region-id="${++top}" left="20" top="${top * 30}"><math>${inner}</math></region>`;
  const prime = (regions: string[]) => zipSync({ 'mathcad/worksheet.xml': strToU8(`<worksheet ${W}><regions>${regions.join('')}</regions></worksheet>`) });

  it('an input control becomes its selected value; a script control becomes its check', () => {
    top = 0;
    const res = importMathcad(prime([
      m(`<ml:define><ml:matrix rows="2" cols="1">${pid('f_ck')}${pid('f_ctk')}</ml:matrix><ml:ComboBoxControl rows="3" cols="2" SelectedRow="1"><ml:ComboBoxRowNames><ml:rowName>C20</ml:rowName><ml:rowName>C30</ml:rowName><ml:rowName>C40</ml:rowName></ml:ComboBoxRowNames><ml:ComboBoxScaleFactors>${pid('MPa', 'UNIT')}${pid('MPa', 'UNIT')}</ml:ComboBoxScaleFactors><ml:ComboBoxValues>${real(20)}${real(1.5)}${real(30)}${real(2)}${real(40)}${real(2.5)}</ml:ComboBoxValues></ml:ComboBoxControl></ml:define>`),
      m(`<ml:TextBoxScriptableControl><ml:vals><ml:val>OK!</ml:val></ml:vals><ml:PiggybackNode><ml:inputControlInputField><ml:parens><ml:apply><ml:lessThan/>${pid('f_ctk')}${pid('f_ck')}</ml:apply></ml:parens></ml:inputControlInputField></ml:PiggybackNode></ml:TextBoxScriptableControl>`),
      m(`<ml:define>${pid('a')}<ml:apply>${pid('if', 'KEYWORD')}<ml:sequence><ml:apply><ml:greaterThan/>${pid('f_ck')}<ml:apply><ml:scale/>${real(25)}${pid('MPa', 'UNIT')}</ml:apply></ml:apply><ml:str>high</ml:str><ml:str>low</ml:str></ml:sequence></ml:apply></ml:define>`),
    ]), 'c.mcdx');
    const src = math(res.ws).map((r) => r.source);
    expect(src).toEqual(['[f_ck; f_ctk] := [30 MPa; 2 MPa]', 'f_ctk < f_ck', 'a := if(f_ck > 25 MPa, "high", "low")']);
    expect(res.warnings.join('\n')).toMatch(/selected value, “C30”/);
    const ev = evaluateWithScope(res.ws);
    expect((ev.results.get(res.ws.regions[1].id) as MathResult).check?.ok).toBe(true);
  });

  it('a matrix of names takes its values column by column; a unit named like a variable is spelled out', () => {
    top = 0;
    const res = importMathcad(prime([
      m(`<ml:define>${pid('m')}${real(3)}</ml:define>`),
      // [a b; c d] := M is listed a, c, b, d
      m(`<ml:define><ml:matrix rows="2" cols="2">${pid('a')}${pid('c')}${pid('b')}${pid('d')}</ml:matrix><ml:matrix rows="2" cols="2">${real(1)}${real(3)}${real(2)}${real(4)}</ml:matrix></ml:define>`),
      m(`<ml:define>${pid('L')}<ml:apply><ml:scale/>${real(2)}${pid('m', 'UNIT')}</ml:apply></ml:define>`),
    ]), 'd.mcdx');
    expect(math(res.ws).map((r) => r.source)).toEqual(['m := 3', '[a; b; c; d] := [1, 2; 3, 4]', 'L := 2 unit(1, "m")']);
  });
});

describe('SMath constructs', () => {
  it('a region that ignores units calculates with every unit as 1', () => {
    const v = (n: string) => `<e type="operand">${n}</e>`, u = (n: string) => `<e type="operand" style="unit">${n}</e>`;
    const op = (o: string) => `<e type="operator" args="2">${o}</e>`;
    const xml = `<?xml version="1.0"?><regions xmlns="http://smath.info/schemas/worksheet/1.0">
      <region left="0" top="10"><math ignoreUnits="true"><input>${v('a.%')}${v('10')}${u('%')}${op('*')}${op(':')}</input></math></region>
      <region left="0" top="40"><math><input>${v('a.%')}<e type="operand">100</e>${op('/')}</input><result action="numeric">${v('0.1')}</result></math></region></regions>`;
    const res = importSmath(strToU8(xml), 'p.sm');
    expect(math(res.ws)[0].source).toBe('a_ := 10');
    const ev = evaluateWithScope(res.ws);
    expect(compareSaved(res.saved!, res.ws.regions, ev.shown).agree).toBe(1);
  });
});
