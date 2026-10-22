import { describe, it, expect } from 'vitest';
import { evaluateWorksheet, type MathResult } from './evaluator';
import { emptyWorksheet, createRegion, type Worksheet } from '../model/types';
import { dataFileKey, dataFilesIn } from './dataFiles';
import { writeXlsx } from '../sheet/xlsx';
import { toBase64 } from '../importers/common';

function results(lines: string[], dataFiles: Record<string, string>) {
  const ws: Worksheet = emptyWorksheet();
  ws.settings = { ...ws.settings, dataFiles };
  ws.regions = lines.map((source, i) => createRegion('math', 40, 40 + i * 40, { source }));
  const out = evaluateWorksheet(ws);
  return ws.regions.map((r) => out.results.get(r.id) as MathResult);
}
const value = (r: MathResult) => {
  if (r.error) throw new Error(r.error);
  return r.tex.slice(r.tex.lastIndexOf(' = ') + 3);
};

describe('data files the worksheet keeps', () => {
  it('READPRN: one row a line, values apart by spaces, tabs or commas; found by file name in any folder', () => {
    const files = { 'beam.prn': '0 1.5\n1\t2.5\n\n2, 3.5D1\n' };
    const [, a, b] = results(['M := READPRN("C:\\\\data\\\\Beam.PRN")', 'M[2,1] =', 'rows(M) ='], files);
    expect(value(a)).toBe('35');
    expect(value(b)).toBe('3');
  });
  it('READPRN wants the same number of values on every line', () => {
    const [m] = results(['M := READPRN("x.txt")'], { 'x.txt': '1 2\n3\n' });
    expect(m.error).toMatch(/every line needs the same number of values \(line 2 has 1, others 2\)/);
  });
  it('READCSV and READFILE: quoted text, short rows filled with NaN; a missing file says how to attach it', () => {
    const files = { 'cars.csv': 'name,mpg\n"Ford, T",21\nVW\n', 'p.txt': '1;2\n3;4\n' };
    const r = results(['C := READCSV("cars.csv")', 'C[1,0] =', 'C[1,1] =', 'P := READFILE("p.txt", "delimited")', 'P[1,1] =', 'Q := READPRN("gone.dat")'], files);
    expect(value(r[1])).toMatch(/Ford, T/);
    expect(value(r[2])).toBe('21');
    expect(value(r[4])).toBe('4');
    expect(r[5].error).toBe('The data file “gone.dat” is not attached to this worksheet: attach it in File ▸ Data files…');
  });
  it('READEXCEL: the first sheet, or a range of it', () => {
    const book = writeXlsx({ sheets: [{ name: 'Data', cells: { A1: { v: 'x' }, A2: { v: 2 }, B2: { v: 5 }, B3: { v: 7 } } }] });
    const files = { 'd.xlsx': `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${toBase64(book)}` };
    const r = results(['X := READEXCEL("d.xlsx", "Data!B2:B3")', 'X =', 'cols(READEXCEL("d.xlsx")) ='], files);
    expect(r[0].error).toBeUndefined();
    expect(value(r[1])).toMatch(/5[\s\S]*7/);
    expect(value(r[2])).toBe('2');
  });
  it('finds the files a worksheet reads', () => {
    expect(dataFilesIn('A := READPRN("..\\\\src\\\\TRP.dat") + READCSV( "b.csv")')).toEqual(['..\\src\\TRP.dat', 'b.csv']);
    expect(dataFileKey('..\\src\\TRP.dat')).toBe('trp.dat');
  });
});
