// The spreadsheet component of a worksheet (Mathcad's Excel component): a workbook of cells
// and formulas, worksheet expressions written into cells (inputs, in a chosen unit), and
// cells or ranges read back out as worksheet variables (outputs, with a unit).
import type { WorkbookModel } from './engine';
import { renameSheets } from './formula';

/** A worksheet expression written into a cell or range before the sheet calculates. */
export interface SheetInput {
  expr: string;
  /** "B2" (a value, or a vector / matrix from there), "B2:B10", "Sheet2!A1", a defined name. */
  ref: string;
  /** Unit the numbers are written in ("kN"); empty: plain numbers, quantities in SI base units. */
  unit?: string;
}

/** A cell or range read out as a worksheet variable. */
export interface SheetOutput {
  name: string;
  ref: string;
  /** Unit of the numbers in the cells ("kN·m" → M := 45 kN·m); empty: plain numbers. */
  unit?: string;
}

/** An .xlsx file the component reads from. */
export interface SheetLink {
  /** File name, as shown. */
  file: string;
  /** Path in the desktop app. */
  path?: string;
  /** Key of the browser's file handle in this browser's storage (Chromium). */
  handle?: string;
  /** Last modification time read (ms). */
  modified?: number;
  /** Read the file again when it changes. */
  watch?: boolean;
}

/** How a file's formulas compared with the values the spreadsheet program saved. */
export interface SheetReport {
  file: string;
  /** When it was read (ms). */
  at: number;
  formulas: number;
  /** Formulas the file holds a saved result for (files written by programs often have none). */
  compared?: number;
  /** Cells whose recalculated value differs ("C5: Excel 12.5, here 12.4"), the first few. */
  mismatches: string[];
  mismatchCount: number;
  /** Functions this engine does not have. */
  unsupported: string[];
}

export interface SpreadsheetData extends WorkbookModel {
  /** Size of the grid on the page, px. */
  width: number;
  height: number;
  /** Sheet shown. */
  active?: number;
  inputs: SheetInput[];
  outputs: SheetOutput[];
  link?: SheetLink;
  report?: SheetReport;
  /** Rows and columns of the grid (it grows to hold what is used). */
  rows?: number;
  cols?: number;
}

export function newSpreadsheet(): SpreadsheetData {
  return { width: 480, height: 230, sheets: [{ name: 'Sheet1', cells: {} }], inputs: [], outputs: [], rows: 20, cols: 8 };
}

export const ROW_H = 20;
export const COL_W = 72;
export const HEAD_W = 36;

/**
 * A sheet renamed as Excel renames one: formulas, defined names and the inputs and outputs
 * that point at it follow ("=Beam!D1" becomes "=Calc!D1").
 */
export function withSheetRenamed(data: Pick<SpreadsheetData, 'sheets' | 'names' | 'inputs' | 'outputs'>, index: number, name: string): Pick<SpreadsheetData, 'sheets' | 'names' | 'inputs' | 'outputs'> {
  const map = new Map([[data.sheets[index].name.toUpperCase(), name]]);
  const formula = (src: string) => (src.startsWith('=') ? renameSheets(src, map) : src);
  const ref = (r: string) => (r.includes('!') ? renameSheets(`=${r}`, map).slice(1) : r);
  return {
    sheets: data.sheets.map((s, k) => ({ ...s, ...(k === index ? { name } : {}), cells: Object.fromEntries(Object.entries(s.cells).map(([c, src]) => [c, formula(src)])) })),
    ...(data.names ? { names: data.names.map((n) => ({ ...n, ref: ref(n.ref) })) } : {}),
    inputs: data.inputs.map((b) => ({ ...b, ref: ref(b.ref) })),
    outputs: data.outputs.map((b) => ({ ...b, ref: ref(b.ref) })),
  };
}
