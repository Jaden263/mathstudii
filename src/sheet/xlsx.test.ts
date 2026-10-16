import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { calculate, type WorkbookModel } from './engine';
import { bookToModel, compareCached, modelToWriteBook, readXlsx, sheetNames, writeXlsx, type XlsxBook } from './xlsx';
import { dateSerial, isoDate, serialParts } from './dates';
import { formatValue } from './numfmt';
import { parseCell } from './refs';
import { ERR, XlError } from './values';

const fixture = (name: string) => readXlsx(new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
const cell = (book: XlsxBook, sheet: number, ref: string) => {
  const p = parseCell(ref)!;
  return book.sheets[sheet].cells.find((c) => c.r === p.r && c.c === p.c);
};
/** Read a file, calculate it here, and compare with the values the program saved. */
function recalculated(name: string) {
  const book = fixture(name);
  const wb = calculate(bookToModel(book));
  return { book, wb, ...compareCached(book, wb) };
}

describe('date serials', () => {
  it('45000 is 15 March 2023; the 1904 system is 1462 days behind', () => {
    expect(isoDate(45000)).toBe('2023-03-15');
    expect(dateSerial(2023, 3, 15)).toBe(45000);
    expect(dateSerial(2023, 3, 15, true)).toBe(45000 - 1462);
    expect(isoDate(45000 - 1462, true)).toBe('2023-03-15');
    expect(isoDate(1)).toBe('1900-01-01');
    expect(isoDate(60)).toBe('1900-02-29'); // Excel's phantom leap day
    expect(isoDate(61)).toBe('1900-03-01');
    expect(serialParts(45000.75).hh).toBe(18);
    expect(isoDate(2958465)).toBe('9999-12-31'); // the last day Excel knows
  });
});

describe('writing and reading back', () => {
  const model: WorkbookModel = {
    sheets: [
      {
        name: 'Beam',
        cells: {
          A1: 'x [m]', B1: 'M [kN·m]', C1: 'ok', D1: 'note',
          A2: '0', A3: '1.5', A4: '3', A5: '0.1', A6: '1e-7', A7: '-123456.789', A8: '1e+21',
          B2: '=$F$1*A2*($F$2-A2)/2', B3: '=$F$1*A3*($F$2-A3)/2', B4: '=$F$1*A4*($F$2-A4)/2',
          C2: '=B2<=Data!$A$1', C3: 'TRUE', C4: 'FALSE', C5: '#N/A', C6: '=1/0',
          D2: 'A & B < C > D', D3: '  leading and trailing  ', D4: 'two\nlines', D5: 'σ ≤ f_y · 1.0', D6: '_x0041_ stays', D7: "'0123", D8: '=REPT("ab",2)&"="',
          F1: '10', F2: '6', F3: '=MAX(B2:B4)', F4: '=XLOOKUP(3,A2:A4,B2:B4)', F5: '=STDEV.S(A2:A4)', F6: '=SUM(span)', F7: '=k*2',
          H1: '=MMULT(H5:I6,H5:I6)', H5: '1', I5: '2', H6: '3', I6: '4',
        },
        styles: { A1: { b: true }, B1: { b: true }, B2: { fmt: '0.00' }, B3: { fmt: '#,##0.000' }, A6: { fmt: '0.00E+00' }, C1: { b: true, fmt: '0%' } },
        widths: { 0: 64, 1: 120, 3: 200 },
        merges: ['D10:E11'],
      },
      { name: 'Data', cells: { A1: '1000', B1: '=Beam!F3/2', A2: '=DATE(2023,3,15)' }, styles: { A2: { fmt: 'yyyy-mm-dd' } } },
    ],
    names: [{ name: 'span', ref: 'Beam!$F$2' }, { name: 'k', ref: '5', sheet: 0 }],
    date1904: false,
  };
  const wb = calculate(model);
  const bytes = writeXlsx(modelToWriteBook(model, wb, 'Round trip'));
  const back = readXlsx(bytes);
  const again = bookToModel(back);

  it('gives back the same cell contents, styles, widths, merges and names', () => {
    expect(back.sheets.map((s) => s.name)).toEqual(['Beam', 'Data']);
    for (let s = 0; s < 2; s++) {
      const sheet = model.sheets[s];
      for (const [ref, src] of Object.entries(sheet.cells)) {
        // a formula's array result is read back as the formula in its first cell
        expect([ref, again.sheets[s].cells[ref]]).toEqual([ref, src]);
      }
    }
    expect(again.sheets[0].styles).toEqual(model.sheets[0].styles);
    expect(again.sheets[1].styles).toEqual(model.sheets[1].styles);
    expect(again.sheets[0].widths).toEqual({ 0: 64, 1: 120, 3: 200 });
    expect(again.sheets[0].merges).toEqual(['D10:E11']);
    expect(back.names).toEqual(model.names);
  });
  it('stores results with the formulas, so the same values come back and calculate again', () => {
    const wb2 = calculate(again);
    expect(compareCached(back, wb2).mismatches).toEqual([]);
    expect(cell(back, 0, 'B3')!.v).toBe(10 * 1.5 * 4.5 / 2);
    expect(cell(back, 0, 'C2')!.v).toBe(true);
    expect(cell(back, 0, 'C6')!.v).toBe(ERR.div0);
    expect(cell(back, 0, 'F4')!.v).toBe(45);
    expect(cell(back, 0, 'F6')!.v).toBe(6);
    expect(cell(back, 0, 'F7')!.v).toBe(10);
    expect(cell(back, 0, 'D8')!.v).toBe('abab=');
    expect(cell(back, 1, 'B1')!.v).toBe(22.5);
    // the MMULT result spills: an array formula over H1:I2 with the values cached
    expect(cell(back, 0, 'H1')!.array).toEqual({ r1: 0, c1: 7, r2: 1, c2: 8 });
    expect([cell(back, 0, 'I1')!.v, cell(back, 0, 'H2')!.v, cell(back, 0, 'I2')!.v]).toEqual([10, 15, 22]);
    expect([wb2.value(0, 0, 8), wb2.value(0, 1, 7)]).toEqual([10, 15]);
  });
  it('keeps numbers exactly and text as it was', () => {
    expect([0.1, 1e-7, -123456.789, 1e21].map((_, i) => cell(back, 0, `A${i + 5}`)!.v)).toEqual([0.1, 1e-7, -123456.789, 1e21]);
    expect(cell(back, 0, 'D2')!.v).toBe('A & B < C > D');
    expect(cell(back, 0, 'D3')!.v).toBe('  leading and trailing  ');
    expect(cell(back, 0, 'D4')!.v).toBe('two\nlines');
    expect(cell(back, 0, 'D5')!.v).toBe('σ ≤ f_y · 1.0');
    expect(cell(back, 0, 'D6')!.v).toBe('_x0041_ stays');
    expect(cell(back, 0, 'D7')!.v).toBe('0123');
    expect(cell(back, 0, 'C5')!.v).toBe(ERR.na);
    expect(cell(back, 1, 'A2')!.v).toBe(45000);
    expect(formatValue(45000, cell(back, 1, 'A2')!.fmt)).toBe('2023-03-15');
  });
  it('writes the parts ECMA-376 asks for, each in its content types and relationships', () => {
    const files = unzipSync(bytes);
    const names = Object.keys(files).sort();
    expect(names).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']);
    const ct = strFromU8(files['[Content_Types].xml']);
    for (const part of names.filter((n) => !n.endsWith('.rels') && n !== '[Content_Types].xml')) expect(ct).toContain(`PartName="/${part}"`);
    const rels = strFromU8(files['xl/_rels/workbook.xml.rels']);
    for (const t of ['worksheets/sheet1.xml', 'worksheets/sheet2.xml', 'styles.xml', 'sharedStrings.xml']) expect(rels).toContain(`Target="${t}"`);
    const wbXml = strFromU8(files['xl/workbook.xml']);
    expect(wbXml).toMatch(/<sheet name="Beam" sheetId="1" r:id="rId1"\/><sheet name="Data" sheetId="2" r:id="rId2"\/>/);
    expect(wbXml).toContain('<definedName name="k" localSheetId="0">5</definedName>');
    // worksheet children in the order of CT_Worksheet
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    const order = ['<dimension', '<sheetViews', '<sheetFormatPr', '<cols', '<sheetData', '<mergeCells', '<pageMargins'].map((t) => sheet.indexOf(t));
    expect(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1]))).toBe(true);
    // newer functions carry their prefix in the file
    expect(sheet).toContain('<f>_xlfn.XLOOKUP(3,A2:A4,B2:B4)</f>');
    expect(sheet).toContain('<f>_xlfn.STDEV.S(A2:A4)</f>');
    expect(sheet).toContain('<f t="array" ref="H1:I2">MMULT(H5:I6,H5:I6)</f>');
    const styles = strFromU8(files['xl/styles.xml']);
    const xfCount = Number(/<cellXfs count="(\d+)"/.exec(styles)![1]);
    expect((styles.match(/<xf /g) ?? []).length).toBe(xfCount + 1); // + the one cell style
    const sst = strFromU8(files['xl/sharedStrings.xml']);
    expect(Number(/uniqueCount="(\d+)"/.exec(sst)![1])).toBe((sst.match(/<si>/g) ?? []).length);
    expect(sst).toContain('<t xml:space="preserve">  leading and trailing  </t>');
    expect(sst).toContain('_x005F_x0041_ stays');
  });
  it('makes sheet names Excel accepts', () => {
    expect(sheetNames(['Results', 'results', 'a/b:c', '', 'x'.repeat(40)])).toEqual(['Results', 'results (2)', 'a_b_c', 'Sheet4', 'x'.repeat(31)]);
  });
  it('a 1904 workbook keeps its dates', () => {
    const m: WorkbookModel = { sheets: [{ name: 'S', cells: { A1: '=DATE(2023,3,15)' }, styles: { A1: { fmt: 'yyyy-mm-dd' } } }], date1904: true };
    const b = readXlsx(writeXlsx(modelToWriteBook(m, calculate(m))));
    expect(b.date1904).toBe(true);
    expect(cell(b, 0, 'A1')!.v).toBe(45000 - 1462);
  });
  it('refuses files that are not zip packages with a clear message', () => {
    expect(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]))).toThrow(/not an \.xlsx file/);
  });
});

describe('files saved by Excel and LibreOffice', () => {
  it('error values (Excel): every error type, recalculated alike', () => {
    const { book, mismatches, formulas } = recalculated('calamine-errors.xlsx');
    expect(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((r) => (cell(book, 0, r)!.v as XlError).code)).toEqual(['#DIV/0!', '#NAME?', '#VALUE!', '#NULL!', '#REF!', '#NUM!', '#N/A']);
    expect(formulas).toBe(7);
    expect(mismatches).toEqual([]);
  });
  it('formulas with cached values (Excel)', () => {
    const { book, mismatches } = recalculated('calamine-formula.issue.xlsx');
    expect(cell(book, 0, 'A1')!.f).toBe('=C1+E5');
    expect(cell(book, 0, 'J14')!.v).toBe('US');
    expect(mismatches).toEqual([]);
  });
  it('defined names (Excel)', () => {
    const { book, mismatches, formulas } = recalculated('calamine-issues.xlsx');
    expect(book.names.map((n) => n.name)).toContain('OneRange');
    expect(formulas).toBe(5);
    expect(mismatches).toEqual([]);
    const various = fixture('poi-WithVariousData.xlsx');
    expect(various.names).toEqual(expect.arrayContaining([{ name: 'AllANumbers', ref: 'Sheet1!$A$2:$A$7' }, { name: 'AllBStrings', ref: 'Sheet1!$B$2:$B$7' }]));
    const wb = calculate(bookToModel(various));
    expect(wb.resolve('AllANumbers')).toEqual({ sheet: 0, area: { r1: 1, c1: 0, r2: 6, c2: 0 } });
  });
  it('merged cells (Excel)', () => {
    const book = fixture('calamine-merged_range.xlsx');
    expect(book.sheets[0].merges.length).toBe(9);
    expect(book.sheets[1].merges.length).toBe(6);
    expect(book.sheets[0].merges).toContainEqual({ r1: 0, c1: 2, r2: 1, c2: 3 }); // C1:D2
    expect(cell(book, 0, 'C1')!.v).toBe('C1');
  });
  it('inline and rich shared strings in prefixed XML (Excel)', () => {
    const book = fixture('calamine-richtext-namespaced.xlsx');
    expect(cell(book, 0, 'A1')!.v).toBe('inline string\nLine 2\nLine 3');
    expect(cell(book, 0, 'H1')!.v).toBe('shared string\nLine 2\nLine 3');
  });
  it('dates in the 1900 and 1904 systems (LibreOffice)', () => {
    const d1900 = fixture('calamine-date.xlsx'), d1904 = fixture('calamine-date_1904.xlsx');
    expect(d1900.date1904).toBe(false);
    expect(d1904.date1904).toBe(true);
    const a1 = cell(d1900, 0, 'A1')!, b1 = cell(d1904, 0, 'A1')!;
    expect(a1.v).toBe(dateSerial(2021, 1, 1));
    expect(b1.v).toBe(dateSerial(2021, 1, 1, true));
    expect(formatValue(a1.v, a1.fmt)).toBe('2021-01-01');
    expect(formatValue(b1.v, b1.fmt, true)).toBe('2021-01-01');
    // a duration of 10 days 15:10:10 in [hh]:mm:ss
    const a3 = cell(d1900, 0, 'A3')!;
    expect(a3.v).toBeCloseTo(10 + 54610 / 86400, 12);
    expect(formatValue(a3.v, a3.fmt)).toBe('255:10:10');
  });
  it('shared formulas (Excel) are moved to each cell', () => {
    const { book, mismatches, formulas } = recalculated('poi-shared_formulas.xlsx');
    expect(cell(book, 0, 'A2')!.f).toBe('=B2');
    expect(cell(book, 0, 'A11')!.f).toBe('=B11');
    expect(formulas).toBe(40);
    expect(mismatches).toEqual([]);
  });
  it('references across sheets, Sheet1:Sheet3!A1 (Excel)', () => {
    const { book, mismatches, formulas } = recalculated('poi-55906-MultiSheetRefs.xlsx');
    expect(cell(book, 0, 'A3')!.v).toBe(66);
    expect(cell(book, 0, 'I3')!.v).toBe(27.5);
    expect(formulas).toBe(13);
    expect(mismatches).toEqual([]);
  });
  it('TEXT with 45 date and time formats agrees with Excel for Mac (1904 dates)', () => {
    const { book, mismatches, formulas } = recalculated('poi-DateFormatTests.xlsx');
    expect(book.date1904).toBe(true);
    expect(formulas).toBe(45);
    expect(mismatches).toEqual([]);
  });
  it('WORKDAY (Excel)', () => {
    expect(recalculated('poi-50755_workday_formula_example.xlsx').mismatches).toEqual([]);
  });
  it('about 300 formulas give what LibreOffice calculated, except where LibreOffice is not Excel', () => {
    const { mismatches, formulas, book } = recalculated('libreoffice-crosscheck.xlsx');
    // column B holds each formula as text, as it was written (LibreOffice saves TRUE as TRUE())
    const f = (ref: string) => cell(book, 1, ref.replace(/^F!/, '').replace(/^A/, 'B'))!.v as string;
    const differ = new Map(mismatches.map((m) => [f(m.cell), m]));
    // LibreOffice counts TRUE as 1 in ranges and in text; Excel does not (SUM of 1, "2", TRUE,
    // 5, "x", 7.5, FALSE, 9, -3 is 19.5 in Excel); Excel 365 spills ranges instead of
    // intersecting them; Excel has no real odd roots; Excel adds 1900 to years below 1900 and
    // keeps 29 February 1900 (serial 60); Excel shows rounded small negatives as -0.00
    const excel: Record<string, unknown> = {
      '="a"&1.5&TRUE': 'a1.5TRUE', '=Data!A1:A3*2': ERR.spill, '=SUM(Data!C1:C10)': 19.5, '=SUM(1,"2",TRUE)': 4,
      '=AVERAGE(Data!C1:C10)': 3.9, '=COUNT(Data!C1:C10)': 5, '=POWER(-8,1/3)': ERR.num, '=INDEX(Data!G1:I3,2,0)': ERR.spill,
      '=DATE(100,1,1)': 36526, '=DAY(Data!D6)': 29, '=TEXT(-0.004,"0.00")': '-0.00', '=TYPE(Data!A1:A2)': 64,
    };
    // LibreOffice 24.2 does not have these yet (#NAME? there); they are tested against Microsoft's examples instead
    const missing = (s: string) => /XLOOKUP|SEQUENCE/.test(s);
    for (const [formula, m] of differ) {
      if (missing(formula)) continue;
      expect([formula, m.ours]).toEqual([formula, excel[formula]]);
    }
    expect(formulas).toBeGreaterThan(300);
    expect(mismatches.length).toBeLessThanOrEqual(Object.keys(excel).length + 7);
  });
});
