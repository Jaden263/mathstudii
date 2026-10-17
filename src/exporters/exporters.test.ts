import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser, type Element as XElement } from '@xmldom/xmldom';
import { exportWorksheet, type Format } from './index';
import { importMathcad } from '../importers/mathcad';
import { importSmath } from '../importers/smath';
import { compareSaved } from '../importers/saved';
import { evaluateWithScope } from '../engine/evaluator';
import { loadCas } from '../engine/symbolic';
import { toSINumber, isUnit, isMatrix } from '../engine/math';
import { beamExample, odeExample, pdeExample, steelCheckExample, solvingExample } from '../model/examples';
import { createRegion, emptyWorksheet, type Region, type Worksheet } from '../model/types';

/** A worksheet with what a calculation usually has: units, functions, matrices, ranges, programs, solve blocks. */
function sample(origin: 0 | 1 = 0, format: Format = 'mcdx'): Worksheet {
  const ws = emptyWorksheet();
  ws.title = 'Beam check';
  ws.settings.origin = origin;
  const i0 = origin;
  const items: [Region['kind'], Partial<Region>][] = [
    ['text', { markdown: '# Beam check\nA **simply supported** beam with a *uniform* load (EN 1991).', width: 400 }],
    ['math', { source: 'L := 6 m' }],
    ['math', { source: 'q := 12 kN/m' }],
    ['math', { source: 'M := q*L^2/8 = kN*m' }],
    ['math', { source: 'g_c ≡ 9.81 m/s^2' }],
    ['math', { source: 'm_s := 250 kg' }],
    ['math', { source: 'W := m_s*g_c = kN' }],
    ['math', { source: 'f(x) := x^2 + 1' }],
    ['math', { source: 'f(3) =' }],
    ['math', { source: 'A := [1, 2; 3, 4]' }],
    ['math', { source: `a_d := A[${i0}, ${i0}]*A[${i0 + 1}, ${i0 + 1}] - A[${i0}, ${i0 + 1}]*A[${i0 + 1}, ${i0}] =` }],
    ['math', { source: `i := ${i0} .. ${i0 + 3}` }],
    ['math', { source: 'v[i] := (i + 1)^2' }],
    ['math', { source: `v[${i0 + 3}] =` }],
    ['math', { source: 'S := sum(v) =' }],
    ['math', { source: 'S_i := sum(v[i], i) =' }],
    ['math', { source: 'fact(n) :=\n  r ← 1\n  for k ∈ 1 .. n\n    r ← r*k\n  return r' }],
    ['math', { source: 'F_5 := fact(5) =' }],
    ['math', { source: 'sgn(x) :=\n  if x < 0\n    -1\n  else if x = 0\n    0\n  else\n    1' }],
    ['math', { source: 'z := sgn(-4) + 10*sgn(0) + 100*sgn(3) =' }],
    ['math', { source: 'I := integral(x^2, x, 0, 3) =' }],
    ['math', { source: 'c := cos(60 deg) =' }],
    ['math', { source: 'σ := M/(250 cm^3) = MPa' }],
    ['math', { source: 'σ < 355 MPa' }],
    ['math', { source: 'h := if(L > 5 m, 2, 3) =' }],
    ['math', { source: 'ε := 0.0021 = %' }],
    ['math', { source: 'F_w := m_s*g = kN' }],
    ['solve', { guesses: 'x := 1\ny := 1', constraints: 'x^2 + y^2 = 25\ny = x + 1', solver: 'sol := find(x, y)' }],
    ['math', { source: `x_1 := sol[${i0}] =` }],
    ['solve', { guesses: 'd := 10 mm', constraints: '20 kN/(π*d^2/4) = 100 MPa', solver: 'd_req := find(d) = mm' }],
    // SMath has no odesolve (a test of its own below)
    ...(format === 'sm' ? [] : [
      ['solve', { guesses: '', constraints: "u''(t) + 4*u(t) = 0\nu(0) = 1\nu'(0) = 0", solver: 'u := odesolve(t, 3)' }],
      ['math', { source: 'u_1 := u(1) =' }],
    ] as typeof items),
    ['table', { name: 'T', units: ['kN', 'kN'], cells: [['1', '10'], ['2', '20'], ['3', '30']] }],
    ['math', { source: `T_32 := T[${i0 + 2}, ${i0 + 1}] =` }],
  ];
  let y = 40;
  ws.regions = items.map(([kind, init]) => {
    const r = createRegion(kind, 40, y, init);
    y += kind === 'solve' ? 140 : kind === 'table' ? 100 : (r.kind === 'math' ? r.source.split('\n').length : 2) * 28 + 12;
    return r;
  });
  return ws;
}

/** A value as SI numbers (a function by its value at 1). */
function si(v: unknown): unknown {
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (isUnit(v)) return toSINumber(v);
  if (isMatrix(v)) return (v.toArray() as unknown[]).flat(2).map(si);
  if (typeof v === 'function') {
    try {
      return si((v as (x: number) => unknown)(1));
    } catch {
      return undefined; // a function of several arguments
    }
  }
  return undefined;
}

function close(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => close(x, b[i]));
  return a === b;
}

const importBack = (bytes: Uint8Array, format: Format) => (format === 'sm' ? importSmath(bytes, 'back.sm') : importMathcad(bytes, `back.${format}`));

/** Export, read back with our importers, evaluate both: the variables that differ, the regions that fail. */
function roundTrip(ws: Worksheet, format: Format, pictures?: Parameters<typeof exportWorksheet>[2]) {
  const before = evaluateWithScope(ws);
  const out = exportWorksheet(ws, format, pictures);
  const back = importBack(out.bytes, format);
  const after = evaluateWithScope(back.ws);
  const differ: string[] = [];
  for (const [name, v] of before.variables) {
    const a = si(v);
    if (a === undefined) continue;
    if (!close(a, si(after.variables.get(name)))) differ.push(name);
  }
  const errors = back.ws.regions.flatMap((r) => {
    const res = after.results.get(r.id) as { error?: string; solver?: { error?: string } } | undefined;
    const e = res?.error ?? res?.solver?.error;
    return e ? [`${(r as { source?: string }).source ?? r.kind}: ${e}`] : [];
  });
  return { ...out, back, before, after, differ, errors };
}

const xml = (s: string) => new DOMParser().parseFromString(s, 'text/xml');
const byTag = (doc: ReturnType<typeof xml>, tag: string) => Array.from(doc.getElementsByTagNameNS('*', tag)) as XElement[];
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../importers/fixtures/${name}`, import.meta.url)));

describe('export to Mathcad Prime, Mathcad 15 and SMath, read back with our importers', () => {
  beforeAll(() => loadCas());

  for (const format of ['mcdx', 'xmcd', 'sm'] as Format[]) {
    for (const origin of [0, 1] as const) {
      it(`${format}, first index ${origin}: every value is the same`, () => {
        const r = roundTrip(sample(origin, format), format);
        expect(r.errors).toEqual([]);
        expect(r.differ).toEqual([]);
        // the comparison has something to compare: every defined name came back
        for (const name of ['M', 'W', 'a_d', 'S', 'S_i', 'F_5', 'z', 'I', 'σ', 'h', 'ε', 'F_w', 'x_1', 'd_req', 'T_32', ...(format === 'sm' ? [] : ['sol', 'u_1'])]) {
          expect(r.after.variables.has(name), name).toBe(true);
        }
      });
    }
  }

  it('the values that came back are the right ones (hand calculations)', () => {
    for (const format of ['mcdx', 'xmcd', 'sm'] as Format[]) {
      const { after } = roundTrip(sample(0, format), format);
      const v = (n: string) => si(after.variables.get(n)) as number;
      expect(v('M')).toBeCloseTo((12e3 * 36) / 8, 6); // q L²/8 = 54 kN·m
      expect(v('a_d')).toBe(-2); // det [1 2; 3 4]
      expect(v('S')).toBe(1 + 4 + 9 + 16);
      expect(v('F_5')).toBe(120);
      expect(v('z')).toBe(-1 + 0 + 100);
      expect(v('I')).toBeCloseTo(9, 9); // ∫₀³ x² dx
      expect(v('c')).toBeCloseTo(0.5, 12);
      expect(v('d_req')).toBeCloseTo(Math.sqrt((4 * 20e3) / (Math.PI * 100e6)), 9); // 15.96 mm
      expect(v('x_1')).toBeCloseTo(3, 6); // x² + (x + 1)² = 25 from x = 1
      expect(v('F_w')).toBeCloseTo(250 * 9.80665, 9); // g, Mathcad's and SMath's standard gravity
      // u'' + 4u = 0, u(0) = 1, u'(0) = 0: u = cos 2t, read back from Mathcad's prime notation
      if (format !== 'sm') expect(v('u_1')).toBeCloseTo(Math.cos(2), 5);
    }
  });

  it('the examples come back with the same values: solve blocks, odesolve, Pdesolve, beams, sections', () => {
    for (const make of [solvingExample, odeExample, pdeExample, beamExample, steelCheckExample]) {
      for (const format of ['mcdx', 'xmcd'] as Format[]) {
        const r = roundTrip(make(), format);
        expect(r.differ, `${make.name} → ${format}`).toEqual([]);
        expect(r.errors, `${make.name} → ${format}`).toEqual([]);
        // what the evaluations show (T(50 mm, 1 hr) = °C …) is the same too
        const shown = (m: Map<string, unknown>) => [...m.values()].map(si).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
        if (make === pdeExample) {
          const a = shown(r.before.shown), b = shown(r.after.shown);
          expect(b.length).toBe(a.length);
          a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
          // T(50 mm, 1 hr) against the half-space solution T_s + (T_0 − T_s) erf(x / 2√(αt));
          // erf by Abramowitz & Stegun 7.1.26 (error below 1.5·10⁻⁷)
          const erf = (z: number) => {
            const t = 1 / (1 + 0.3275911 * z);
            return 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
          };
          const halfSpace = 373.15 - 80 * erf(0.05 / (2 * Math.sqrt(7e-7 * 3600)));
          expect(b.some((v) => Math.abs(v - halfSpace) < 1e-3)).toBe(true);
        }
      }
    }
  });

  it('real files survive the trip: imported, exported, imported again', () => {
    // fixtures with permissive licences (importers/fixtures/README.md)
    const files = ['calculix-beam.sm', 'calculix-streifen.sm', 'mononobe-okabe.sm', 'cs-amp-hand-calculations.xmcd', 'g431-can-timing.xmcd',
      'mcad2py-trig.mcdx', 'mcad2py-hyperbolic.mcdx', 'mcad2py-range_sum.mcdx', 'mcad2py-solve_as_function.mcdx', 'mcad2py-stack_augment_lookup.mcdx', 'mcad2py-seed.mcdx'];
    let compared = 0;
    for (const f of files) {
      const ws = (/\.sm$/.test(f) ? importSmath(fixture(f), f) : importMathcad(fixture(f), f)).ws;
      for (const format of ['mcdx', 'xmcd', 'sm'] as Format[]) {
        const r = roundTrip(ws, format);
        compared += [...r.before.variables.values()].filter((v) => si(v) !== undefined).length;
        // SMath counts from 1 (match and lookup return other indices), has no column assignments
        // in programs and no solve blocks: those differences are expected and warned about
        const expected: Record<string, string[]> = {
          'mcad2py-stack_augment_lookup.mcdx': ['k', 'ij'], 'mcad2py-seed.mcdx': ['S1', 'same'], 'mcad2py-solve_as_function.mcdx': ['G'],
        };
        expect(r.differ, `${f} → ${format}`).toEqual(format === 'sm' ? expected[f] ?? [] : []);
      }
    }
    expect(compared).toBeGreaterThan(300);
  });

  it('SMath: the results written in the file agree with what is calculated from it', () => {
    // SMath shows a result only where the file has one: ours, in the display unit, read back as "saved"
    const out = exportWorksheet(sample(0, 'sm'), 'sm');
    const back = importSmath(out.bytes, 'back.sm');
    const ev = evaluateWithScope(back.ws);
    const cmp = compareSaved(back.saved ?? [], back.ws.regions, ev.shown);
    expect(cmp.differ).toEqual([]);
    expect(cmp.agree).toBeGreaterThan(12);
  });
});

describe('the files, part by part', () => {
  it('Mathcad Prime: the parts and relationships Prime writes, as in a file Prime 11 saved', () => {
    const ws = sample();
    ws.regions.push(createRegion('image', 40, 3000, { src: `data:image/png;base64,${PNG_1PX}`, width: 50 }));
    const files = unzipSync(exportWorksheet(ws, 'mcdx').bytes);
    const real = unzipSync(fixture('mcad2py-collapsable-area.mcdx'));
    // every part a Prime file has (but its saved results' content), plus text and pictures
    for (const part of Object.keys(real).filter((k) => !/xaml\/|media\//.test(k))) expect(Object.keys(files)).toContain(part);
    expect(Object.keys(files).filter((k) => k.endsWith('.XamlPackage'))).toHaveLength(1);
    expect(Object.keys(files).filter((k) => /^mathcad\/media\/.*\.png$/.test(k))).toHaveLength(1);
    // content types: a default for each extension used, an override for each special part
    const ct = xml(strFromU8(files['[Content_Types].xml']));
    const defaults = byTag(ct, 'Default').map((d) => d.getAttribute('Extension'));
    expect(defaults).toEqual(expect.arrayContaining(['xml', 'rels', 'XamlPackage', 'png']));
    const realCt = xml(strFromU8(real['[Content_Types].xml']).replace(/^﻿/, ''));
    expect(byTag(ct, 'Override').map((o) => o.getAttribute('PartName')).sort()).toEqual(byTag(realCt, 'Override').map((o) => o.getAttribute('PartName')).sort());
    // relationships point at parts that exist
    for (const rels of ['_rels/.rels', 'mathcad/_rels/worksheet.xml.rels']) {
      for (const r of byTag(xml(strFromU8(files[rels])), 'Relationship')) expect(files[r.getAttribute('Target')!.slice(1)], r.getAttribute('Target')!).toBeDefined();
    }
    // the worksheet: math50 in the worksheet50 namespace, one result per math region, unique ids
    const doc = xml(strFromU8(files['mathcad/worksheet.xml']));
    expect(doc.documentElement!.namespaceURI).toBe('http://schemas.mathsoft.com/worksheet50');
    expect(byTag(doc, 'define')[0].namespaceURI).toBe('http://schemas.mathsoft.com/math50');
    const ids = byTag(doc, 'region').map((r) => r.getAttribute('region-id'));
    expect(new Set(ids).size).toBe(ids.length);
    const refs = byTag(doc, 'math').map((m) => m.getAttribute('resultRef'));
    const results = byTag(xml(strFromU8(files['mathcad/result.xml'])), 'resultData').map((r) => r.getAttribute('result-id'));
    for (const ref of refs) expect(results).toContain(ref);
    // a text region's XAML package holds the formatted text
    const xaml = unzipSync(Object.entries(files).find(([k]) => k.endsWith('.XamlPackage'))![1]);
    expect(strFromU8(xaml['Xaml/Document.xaml'])).toContain('<Run FontWeight="Bold">simply supported</Run>');
    // labels: units, constants, solve block keywords
    expect(strFromU8(files['mathcad/worksheet.xml'])).toContain('<ml:id labels="UNIT" xml:space="preserve">kN</ml:id>');
    expect(strFromU8(files['mathcad/worksheet.xml'])).toContain('<ml:id labels="KEYWORD" xml:space="preserve">find</ml:id>');
    expect(strFromU8(files['mathcad/settings/calculation.xml'])).toContain('array-origin="0"');
  });

  it('Mathcad Prime: a name with a subscript, a unit, and t in odesolve (not tonne)', () => {
    const text = strFromU8(unzipSync(exportWorksheet(sample(), 'mcdx').bytes)['mathcad/worksheet.xml']);
    expect(text).toContain('<pw:Subscript>c</pw:Subscript>');
    expect(text).not.toContain('tonne');
    expect(text).toContain('<ml:id labels="VARIABLE" xml:space="preserve">u′′</ml:id>');
  });

  it('Mathcad 15: worksheet30 XML in points, math regions on their baseline, a Given block', () => {
    const ws = sample();
    ws.regions.push(createRegion('image', 40, 3000, { src: `data:image/png;base64,${PNG_1PX}`, width: 50 }));
    const text = strFromU8(exportWorksheet(ws, 'xmcd').bytes);
    const doc = xml(text);
    expect(doc.documentElement!.getAttribute('version')).toBe('3.0.3');
    expect(doc.documentElement!.namespaceURI).toBe('http://schemas.mathsoft.com/worksheet30');
    const L = byTag(doc, 'region').find((r) => r.textContent?.trim() === 'L' || /^L6m$/.test((r.textContent ?? '').replace(/\s/g, '')))!;
    // 40 px = 30 pt; the baseline 12 px below the top
    expect(Number(L.getAttribute('left'))).toBe(30);
    expect(Number(L.getAttribute('align-y')) - Number(L.getAttribute('top'))).toBe(9);
    expect(text).toContain('>Given</ml:id>');
    expect(text).toContain('<ml:Find />');
    expect(text).toContain('<ml:id xml:space="preserve">Odesolve</ml:id>');
    expect(text).toContain('<ml:id xml:space="preserve" subscript="c">g</ml:id>');
    // a picture is a PNG in the binary content
    const item = byTag(doc, 'item')[0];
    expect(item.textContent!.replace(/\s/g, '')).toBe(PNG_1PX);
    expect(byTag(doc, 'png')[0].getAttribute('item-idref')).toBe(item.getAttribute('item-id'));
  });

  it('SMath: postfix tokens, f.ck subscripts, a contract for the display unit, results', () => {
    const text = strFromU8(exportWorksheet(sample(0, 'sm'), 'sm').bytes);
    const doc = xml(text);
    expect(doc.documentElement!.namespaceURI).toBe('http://smath.info/schemas/worksheet/1.0');
    expect(text).toContain('<?application progid="SMath Studio Desktop"');
    // q := 12 kN/m
    expect(text).toContain('<e type="operand">q</e><e type="operand">12</e><e type="operand" style="unit">kN</e><e type="operand" style="unit">m</e><e type="operator" args="2">/</e><e type="operator" args="2">*</e><e type="operator" args="2">:</e>');
    expect(text).toContain('<e type="operand">g.c</e>');
    // standard gravity is the unit gₑ there
    expect(text).toContain('<e type="operand" style="unit">g.e</e>');
    // M = kN·m shows 54 in it
    expect(text).toMatch(/<contract><e type="operand" style="unit">kN<\/e><e type="operand" style="unit">m<\/e><e type="operator" args="2">\*<\/e><\/contract><result action="numeric"><e type="operand">54<\/e><\/result>/);
  });
});

describe('what the other program has no counterpart for', () => {
  beforeAll(() => loadCas());

  it('a beam becomes a labelled note, its picture and the values the worksheet reads', () => {
    const ws = beamExample();
    const beam = ws.regions.find((r) => r.kind === 'beam' && r.name === 'b')!;
    const pictures = new Map([[beam.id, { png: Uint8Array.from(atob(PNG_1PX), (c) => c.charCodeAt(0)), width: 640, height: 320 }]]);
    for (const format of ['mcdx', 'xmcd', 'sm'] as Format[]) {
      const r = roundTrip(ws, format, pictures);
      expect(r.differ).toEqual([]);
      const texts = r.back.ws.regions.filter((x) => x.kind === 'text').map((x) => (x as { markdown: string }).markdown).join('\n');
      expect(texts).toMatch(/\[mathstudii beam “b”\]\** shown as a picture/);
      expect(r.back.ws.regions.filter((x) => x.kind === 'image').length).toBeGreaterThanOrEqual(1);
      // b.M_max, read below the beam, is a value definition there
      const bM = si(r.before.variables.get('b') && (r.before.variables.get('b') as Record<string, unknown>).M_max) as number;
      expect(si(r.after.variables.get('b_M_max'))).toBeCloseTo(bM, 9);
      expect(r.warnings.join('\n')).toMatch(/The beam b at \d+ px became a picture and \d+ value definitions/);
    }
  });

  it('SMath: odesolve and symbolic keywords become notes, with warnings', () => {
    const ws = emptyWorksheet();
    ws.regions = [
      createRegion('solve', 40, 40, { guesses: '', constraints: "u''(t) + 4*u(t) = 0\nu(0) = 1\nu'(0) = 0", solver: 'u := odesolve(t, 3)' }),
      createRegion('math', 40, 240, { source: 'x^2 - 1 → factor' }),
    ];
    const out = exportWorksheet(ws, 'sm');
    const text = strFromU8(out.bytes);
    expect(text).toContain('its solution u is a function, which is not exported');
    expect(text).toContain('⚠ Not exported: `x^2 - 1 → factor`');
    expect(out.warnings.join('\n')).toMatch(/symbolic keyword “factor”, which SMath Studio cannot hold/);
    // Mathcad has both
    const back = importMathcad(exportWorksheet(ws, 'mcdx').bytes, 'x.mcdx');
    expect(back.ws.regions.map((r) => (r as { source?: string }).source)).toContain('x^2 - 1 → factor');
    expect(back.ws.regions.some((r) => r.kind === 'solve' && /odesolve/.test(r.solver))).toBe(true);
  });

  it('Mathcad 15: a table in several units becomes one vector per column', () => {
    const ws = emptyWorksheet();
    ws.regions = [
      createRegion('table', 40, 40, { name: 'T', units: ['m', 'kN'], headers: ['x', 'F'], columnVars: true, cells: [['1', '10'], ['2', '20']] }),
      createRegion('math', 40, 300, { source: 'R := F[1]*x[1] = kN*m' }),
    ];
    const r = roundTrip(ws, 'xmcd');
    expect(si(r.after.variables.get('x'))).toEqual([1, 2]);
    expect(si(r.after.variables.get('F'))).toEqual([10e3, 20e3]);
    expect(si(r.after.variables.get('R'))).toBeCloseTo(40e3, 9);
    expect(r.warnings.join('\n')).toMatch(/columns are in different units/);
    // Prime holds the table as it is
    expect(roundTrip(ws, 'mcdx').differ).toEqual([]);
  });

  it('a definition the format cannot write is written as its value', () => {
    const ws = steelCheckExample();
    const out = exportWorksheet(ws, 'mcdx');
    expect(out.warnings.join('\n')).toMatch(/is a table of values: written as \d+ value definitions/);
  });
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
