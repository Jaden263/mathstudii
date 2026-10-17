import { describe, expect, it } from 'vitest';
import { createRegion, emptyWorksheet, type Region } from '../model/types';
import { exportWorksheetXlsx } from './exportWorker';
import { prettyUnit } from './exportWorksheet';
import { calculate } from './engine';
import { bookToModel, compareCached, readXlsx, type XlsxBook } from './xlsx';
import { parseCell } from './refs';

const at = (book: XlsxBook, sheet: string, ref: string) => {
  const s = book.sheets.find((x) => x.name === sheet)!;
  const p = parseCell(ref)!;
  return s.cells.find((c) => c.r === p.r && c.c === p.c)?.v ?? null;
};
/** Rows of the Results sheet as [name, value, unit, expression, where]. */
const rows = (book: XlsxBook) => {
  const s = book.sheets.find((x) => x.name === 'Results')!;
  const n = Math.max(...s.cells.map((c) => c.r));
  return Array.from({ length: n }, (_, i) => ['A', 'B', 'C', 'D', 'E'].map((col) => at(book, 'Results', `${col}${i + 2}`)));
};

describe('worksheet to .xlsx', () => {
  const m = (y: number, source: string): Region => createRegion('math', 20, y, { source });
  const ws = emptyWorksheet();
  ws.title = 'Export';
  ws.regions = [
    m(10, 'L := 6 m'), m(30, 'q := 12 kN/m'), m(50, 'M := q * L^2 / 8 = kN*m'), m(70, 'σ := 10 N/mm^2'), m(80, 'σ = MPa'),
    m(90, 'n := 3'), m(110, 'label := "HEB 200"'), m(130, 'x := [0; 1.5; 3] m'), m(150, 'K := [2, -1; -1, 2] kN/m'),
    m(170, 'f(t) := t^2'), m(190, 's := section("IPE 300")'),
    createRegion('table', 20, 210, { name: 'loads', headers: ['case', 'F'], units: ['', 'kN'], cells: [['G', '10'], ['Q', 'n * 5']] }),
    createRegion('spreadsheet', 20, 400, {
      sheets: [{ name: 'Calc', cells: { A1: '=B1*2', C1: 'note' } }],
      inputs: [{ expr: 'M', ref: 'B1', unit: 'kN*m' }],
      outputs: [{ name: 'M2', ref: 'A1', unit: 'kN*m' }],
    }),
  ];
  const book = readXlsx(exportWorksheetXlsx(ws));

  it('lists every variable with value, unit and expression, in the units the worksheet shows', () => {
    const r = rows(book);
    const by = new Map(r.map((x) => [x[0], x]));
    expect(by.get('L')).toEqual(['L', 6, 'm', '6 m', null]);
    expect(by.get('M')).toEqual(['M', 54, 'kN·m', 'q * L^2 / 8', null]);
    expect(by.get('σ')).toEqual(['σ', 10, 'MPa', '10 N/mm^2', null]);
    expect(by.get('n')).toEqual(['n', 3, null, '3', null]);
    expect(by.get('label')).toEqual(['label', 'HEB 200', null, '"HEB 200"', null]);
    expect(by.get('s.h')?.slice(1, 3)).toEqual([300, 'mm']);
    expect(by.get('M2')?.slice(1, 4)).toEqual([108, 'kN·m', 'spreadsheet A1']);
    expect(by.has('f')).toBe(false); // functions are not values
    expect(r.findIndex((x) => x[0] === 'L')).toBeLessThan(r.findIndex((x) => x[0] === 'M')); // reading order
  });
  it('writes units as engineers do', () => {
    expect(['kN m', 'kN / m', 'kg / m s^2', 'm^4', ''].map(prettyUnit)).toEqual(['kN·m', 'kN/m', 'kg/(m·s^2)', 'm^4', '']);
    // an output's own unit, as typed, is listed the same way
    expect(rows(book).find((x) => x[0] === 'M2')?.[2]).toBe('kN·m');
  });
  it('puts vectors in columns, matrices and tables on sheets of their own', () => {
    const r = new Map(rows(book).map((x) => [x[0], x]));
    expect(r.get('x')?.[4]).toBe('Vectors, column A');
    expect(at(book, 'Vectors', 'A1')).toBe('x [m]');
    expect([at(book, 'Vectors', 'A2'), at(book, 'Vectors', 'A3'), at(book, 'Vectors', 'A4')]).toEqual([0, 1.5, 3]);
    expect(r.get('K')?.slice(1, 5)).toEqual(['2 × 2', 'kN/m', '[2, -1; -1, 2] kN/m', 'sheet K']);
    expect(at(book, 'K', 'A1')).toBe('K [kN/m]');
    expect(at(book, 'K', 'B2')).toBe(-1);
    expect(r.get('loads')?.slice(2, 5)).toEqual([null, 'table', 'sheet loads']);
    expect([at(book, 'loads', 'A1'), at(book, 'loads', 'B1'), at(book, 'loads', 'B3')]).toEqual(['case', 'F [kN]', 15]);
  });
  it('spreadsheet components keep their formulas, calculated with the inputs they had', () => {
    expect(at(book, 'Calc', 'B1')).toBe(54);
    expect(at(book, 'Calc', 'A1')).toBe(108);
    const calc = book.sheets.find((s) => s.name === 'Calc')!;
    expect(calc.cells.find((c) => c.r === 0 && c.c === 0)?.f).toBe('=B1*2');
    expect(compareCached(book, calculate(bookToModel(book))).mismatches).toEqual([]);
  });
});
