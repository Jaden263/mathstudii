// Reading an .xlsx into a spreadsheet component: its sheets, names and date system replace
// the component's, its inputs and outputs stay, and every formula is recalculated here and
// compared with the value the spreadsheet program saved.
import { calculate } from './engine';
import type { SheetReport, SpreadsheetData } from './model';
import { displayText, type Scalar } from './values';
import { bookToModel, compareCached, readXlsx } from './xlsx';

const show = (v: Scalar) => (typeof v === 'string' ? `"${v}"` : displayText(v) || 'empty');

/** The changes to a component for a workbook file. */
export function importWorkbook(bytes: Uint8Array, file: string): Partial<SpreadsheetData> {
  const book = readXlsx(bytes);
  if (!book.sheets.length) throw new Error(`${file} has no worksheets`);
  const model = bookToModel(book);
  const wb = calculate(model);
  const cmp = compareCached(book, wb);
  const report: SheetReport = {
    file, at: Date.now(), formulas: cmp.formulas,
    mismatches: cmp.mismatches.slice(0, 8).map((m) => `${m.cell}: ${show(m.excel)} in the file, ${show(m.ours)} here`),
    mismatchCount: cmp.mismatches.length,
    unsupported: cmp.unsupported,
  };
  return { sheets: model.sheets, names: model.names, date1904: model.date1904, report };
}

/** One line about an import: how the recalculation compared. */
export function reportText(r: SheetReport): string {
  const when = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!r.formulas) return `Read ${r.file} at ${when}: values only, no formulas.`;
  const agree = r.formulas - r.mismatchCount;
  const head = `Read ${r.file} at ${when}: ${r.formulas} formula${r.formulas === 1 ? '' : 's'} recalculated here`;
  if (!r.mismatchCount) return `${head}, all agree with the values the file was saved with.`;
  return `${head}; ${agree} agree with the saved values, ${r.mismatchCount} differ${r.unsupported.length ? ` (not available here: ${r.unsupported.join(', ')})` : ''}.`;
}

