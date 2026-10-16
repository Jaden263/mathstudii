import { describe, expect, it } from 'vitest';
import { math } from '../engine/math';
import { evaluateWorksheet, type MathResult } from '../engine/evaluator';
import { createRegion, emptyWorksheet, type Region, type SpreadsheetRegion } from '../model/types';
import { solveSpreadsheet } from './component';
import { newSpreadsheet, type SpreadsheetData } from './model';

const fmt = { precision: 4, expThreshold: 6, metric: true };
const ev = (src: string) => math.evaluate(src);
const sheet = (cells: Record<string, string>, extra: Partial<SpreadsheetData> = {}): SpreadsheetData => ({ ...newSpreadsheet(), sheets: [{ name: 'Sheet1', cells }], ...extra });
const cell = (res: ReturnType<typeof solveSpreadsheet>['result'], ref: string) => res.cells[0][ref]?.t;

describe('inputs: worksheet values into cells', () => {
  it('converts to the unit asked for', () => {
    const { result } = solveSpreadsheet(sheet({ B1: '=A1*2' }, { inputs: [{ expr: '10 kN', ref: 'A1', unit: 'N' }] }), ev, fmt);
    expect(cell(result, 'A1')).toBe('10000');
    expect(cell(result, 'B1')).toBe('20000');
    expect(result.cells[0].A1.in).toBe(1);
    expect(result.written).toEqual([[0, 'A1', 10000]]);
  });
  it('writes quantities without a unit in SI base units, and says so', () => {
    const { result } = solveSpreadsheet(sheet({}, { inputs: [{ expr: '250 mm', ref: 'A1' }, { expr: '2 kN/m^2', ref: 'A2' }] }), ev, fmt);
    expect(cell(result, 'A1')).toBe('0.25');
    expect(cell(result, 'A2')).toBe('2000');
    expect(result.inputs[0].si).toBe('m');
    expect(result.inputs[1].si).toBe('kg / m s^2');
  });
  it('refuses mismatched units and plain numbers given a unit', () => {
    const { result } = solveSpreadsheet(sheet({}, { inputs: [{ expr: '3 m', ref: 'A1', unit: 'kN' }, { expr: '5', ref: 'A2', unit: 'mm' }, { expr: '1', ref: 'Q', unit: '' }] }), ev, fmt);
    expect(result.inputs[0].error).toMatch(/cannot be written in kN/);
    expect(result.inputs[1].error).toMatch(/has no unit/);
    expect(result.inputs[2].error).toMatch(/not a cell, range or name/);
  });
  it('writes vectors down from a cell, into a matching range, or across a row', () => {
    const { result } = solveSpreadsheet(sheet({ D1: '=SUM(A1:A3)', D2: '=SUM(B5:D5)' }, {
      inputs: [{ expr: '[1; 2; 3] m', ref: 'A1', unit: 'mm' }, { expr: '[4, 5, 6]', ref: 'B5:D5' }, { expr: '[7; 8]', ref: 'F1:F3' }],
    }), ev, fmt);
    expect(cell(result, 'D1')).toBe('6000');
    expect(cell(result, 'D2')).toBe('15');
    expect(result.inputs[2].error).toBe('The value is 2 × 1, the range 3 × 1');
  });
  it('writes a matrix as a block and text as text', () => {
    const { result } = solveSpreadsheet(sheet({ D1: '=MDETERM(A1:B2)', D2: '=LEN(A4)' }, { inputs: [{ expr: '[4, 7; 2, 6]', ref: 'A1' }, { expr: '"HEB 200"', ref: 'A4' }] }), ev, fmt);
    expect(Number(cell(result, 'D1'))).toBeCloseTo(10, 12);
    expect(cell(result, 'D2')).toBe('7');
  });
});

describe('outputs: cells into worksheet variables', () => {
  it('gives numbers their unit, ranges become vectors or matrices', () => {
    const { result, defined } = solveSpreadsheet(sheet({ A1: '45', A2: '1', A3: '2', A4: '3', B1: '4', C1: '5', A6: 'IPE 300' }, {
      outputs: [{ name: 'M', ref: 'A1', unit: 'kN·m' }, { name: 'v', ref: 'A2:A4', unit: 'mm' }, { name: 'r', ref: 'A1:C1' }, { name: 'p', ref: 'A6' }],
    }), ev, fmt);
    const vals = Object.fromEntries(defined);
    expect((vals.M as math.Unit).toNumber('N m')).toBe(45000);
    expect((vals.v as math.Matrix).size()).toEqual([3]);
    expect(((vals.v as math.Matrix).get([2]) as math.Unit).toNumber('m')).toBeCloseTo(0.003, 15);
    expect((vals.r as math.Matrix).size()).toEqual([1, 3]);
    expect(vals.p).toBe('IPE 300');
    expect(result.outputs[0].tex).toContain('45');
    expect(result.cells[0].A1.out).toBe(1);
  });
  it('an error, an empty cell or a bad name is an error of that output', () => {
    const { result, defined } = solveSpreadsheet(sheet({ A1: '=1/0', B1: '=C1', C1: '=B1' }, {
      outputs: [{ name: 'x', ref: 'A1' }, { name: 'y', ref: 'D9' }, { name: '2x', ref: 'A1' }, { name: 'z', ref: 'B1' }],
    }), ev, fmt);
    expect(result.outputs.map((o) => o.error)).toEqual(['A1 is #DIV/0!', 'D9 is empty', '"2x" is not a valid variable name', 'B1 is in a circular reference']);
    expect(defined).toEqual([]);
    expect(result.error).toBe('Circular reference: B1 → C1 → B1');
  });
});

describe('in a worksheet', () => {
  /**
   * A simply supported beam tabulated in the spreadsheet: L, q and E·I from the worksheet,
   * M(x) = q x (L − x) / 2 and w(x) = q x (L³ − 2 L x² + x³) / (24 E I) at x = 0, L/6 … L.
   * At midspan M = q L² / 8 = 54 kN·m and w = 5 q L⁴ / (384 E I) = 11.54 mm (IPE 300, I = 8356 cm⁴).
   */
  function beamSheet(): SpreadsheetRegion {
    const cells: Record<string, string> = { A4: 'x [m]', B4: 'M [kN·m]', C4: 'w [m]', D1: '=MAX(B5:B11)', D2: '=MAX(C5:C11)*1000', D3: '=INDEX(A5:A11,MATCH(D1,B5:B11,0))' };
    for (let i = 0; i < 7; i++) {
      const r = 5 + i;
      cells[`A${r}`] = i === 0 ? '0' : `=A${r - 1}+$B$1/6`;
      cells[`B${r}`] = `=$B$2*A${r}*($B$1-A${r})/2`;
      cells[`C${r}`] = `=$B$2*A${r}*($B$1^3-2*$B$1*A${r}^2+A${r}^3)/(24*$B$3)`;
    }
    return createRegion('spreadsheet', 20, 200, {
      sheets: [{ name: 'Beam', cells }],
      inputs: [{ expr: 'L', ref: 'B1', unit: 'm' }, { expr: 'q', ref: 'B2', unit: 'kN/m' }, { expr: 'E * I', ref: 'B3', unit: 'kN*m^2' }],
      outputs: [{ name: 'M_max', ref: 'D1', unit: 'kN*m' }, { name: 'w_max', ref: 'D2', unit: 'mm' }, { name: 'x_M', ref: 'D3', unit: 'm' }, { name: 'M_x', ref: 'B5:B11', unit: 'kN*m' }],
    }) as SpreadsheetRegion;
  }
  const math_ = (y: number, source: string): Region => createRegion('math', 20, y, { source });
  it('takes worksheet inputs and gives outputs used further down', () => {
    const ws = emptyWorksheet();
    ws.regions = [
      math_(20, 'L := 6 m'), math_(40, 'q := 12 kN/m'), math_(60, 'E := 210 GPa'), math_(80, 'I := 8356 cm^4'),
      beamSheet(),
      math_(600, 'M_max = kN*m'), math_(620, 'w_max = mm'), math_(640, 'x_M ='), math_(660, 'M_max ≤ 60 kN*m'), math_(680, 'max(M_x) - M_max ='),
      math_(700, 'w_ref := 5 * q * L^4 / (384 * E * I)'), math_(720, 'w_max / w_ref ='),
    ];
    const out = evaluateWorksheet(ws);
    const tex = (i: number) => (out.results.get(ws.regions[i].id) as MathResult).tex;
    const sheetRes = out.results.get(ws.regions[4].id);
    expect(sheetRes?.kind === 'spreadsheet' && sheetRes.error).toBeFalsy();
    expect(tex(5)).toContain('54');
    expect(tex(6)).toContain('11.54');
    expect(tex(7)).toContain('3');
    expect((out.results.get(ws.regions[8].id) as MathResult).check?.ok).toBe(true);
    expect(tex(9)).toMatch(/= 0/);
    expect(tex(11)).toMatch(/= 1(?![.\d])/);
    expect(out.errorCount).toBe(0);
  });
  it('an output before its spreadsheet is not defined yet (reading order)', () => {
    const ws = emptyWorksheet();
    ws.regions = [math_(20, 'L := 6 m'), math_(40, 'q := 12 kN/m'), math_(60, 'E := 210 GPa'), math_(80, 'I := 8356 cm^4'), math_(100, 'M_max ='), beamSheet()];
    const out = evaluateWorksheet(ws);
    expect((out.results.get(ws.regions[4].id) as MathResult).error).toMatch(/not defined/);
  });
});
