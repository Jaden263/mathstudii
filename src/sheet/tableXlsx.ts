// Table regions to and from Excel sheets. A header row "F [kN]" carries each column's name
// and unit both ways; dates become ISO text, text that is not a plain label is quoted so
// the table reads it as text.
import type { TableRegion } from '../model/types';
import { splitHeader, type TableData } from '../model/tableData';
import { isoDate } from './dates';
import { isDateFormat } from './numfmt';
import { cellName, type Area } from './refs';
import { XlError, type Scalar } from './values';
import { bookToModel, writeXlsx, type WriteCell, type WriteSheet, type XlsxBook, type XlsxSheet } from './xlsx';
import { calculate } from './engine';

/** A table region as a sheet: bold header row, then the values (in the column units). */
export function tableSheet(t: Pick<TableRegion, 'name' | 'headers' | 'units' | 'cells'>, values?: (number | string)[][]): WriteSheet {
  const width = Math.max(1, t.units.length, t.headers?.length ?? 0, ...t.cells.map((r) => r.length));
  const cells = new Map<string, WriteCell>();
  for (let j = 0; j < width; j++) {
    const h = t.headers?.[j]?.trim() || `col${j}`;
    const u = t.units[j]?.trim();
    cells.set(cellName(0, j), { v: u ? `${h} [${u}]` : h, bold: true });
  }
  const rows = values ?? t.cells.filter((r) => r.some((c) => c.trim())).map((r) => r.map((c) => {
    const s = c.trim();
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : s;
  }));
  rows.forEach((row, i) => {
    for (let j = 0; j < width; j++) {
      const v = row[j];
      if (v === undefined || v === '') continue;
      // text the table wrote with quotes ("HEB 200") goes without them
      cells.set(cellName(i + 1, j), { v: typeof v === 'string' ? v.replace(/^"(.*)"$/s, '$1') : v });
    }
  });
  return { name: t.name || 'Table', cells, freezeRows: 1, widths: Object.fromEntries(Array.from({ length: width }, (_, j) => [j, 96])) };
}

export function tableToXlsx(t: Pick<TableRegion, 'name' | 'headers' | 'units' | 'cells'>, values?: (number | string)[][]): Uint8Array {
  return writeXlsx({ sheets: [tableSheet(t, values)], title: t.name });
}

/** The area holding something on a sheet. */
export function usedArea(sheet: XlsxSheet): Area | null {
  let a: Area | null = null;
  for (const c of sheet.cells) {
    if (c.v === null && !c.f) continue;
    if (!a) a = { r1: c.r, c1: c.c, r2: c.r, c2: c.c };
    else {
      a.r1 = Math.min(a.r1, c.r); a.c1 = Math.min(a.c1, c.c);
      a.r2 = Math.max(a.r2, c.r); a.c2 = Math.max(a.c2, c.c);
    }
  }
  return a;
}

/** A cell's value as a table cell holds it. */
function tableCell(v: Scalar, fmt: string | undefined, date1904: boolean): string {
  if (v === null) return '';
  if (typeof v === 'number') return fmt && isDateFormat(fmt) ? `"${isoDate(v, date1904)}"` : String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof XlError) return 'NaN';
  const s = v.trim();
  // labels such as "G" or "HEB 200" stay as they are; anything the table would calculate is quoted
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) || (/[A-Za-z]/.test(s) && !/[*/^()+=",]/.test(s))) return s;
  return `"${s.replace(/"/g, "'")}"`;
}

/**
 * An area of a sheet as table data. With `header`, its first row gives the column names
 * and units ("F [kN]"). Formula cells give their saved results.
 */
export function sheetToTable(sheet: XlsxSheet, area: Area, header: boolean, date1904 = false): TableData {
  const at = new Map(sheet.cells.map((c) => [`${c.r},${c.c}`, c]));
  const width = area.c2 - area.c1 + 1;
  const headers: string[] = [], units: string[] = [];
  let r0 = area.r1;
  if (header) {
    for (let j = 0; j < width; j++) {
      const c = at.get(`${area.r1},${area.c1 + j}`);
      const text = c?.v === null || c?.v === undefined ? '' : c.v instanceof XlError ? c.v.code : String(c.v);
      const { name, unit } = splitHeader(text);
      headers.push(name);
      units.push(unit);
    }
    r0++;
  } else for (let j = 0; j < width; j++) { headers.push(''); units.push(''); }
  const cells: string[][] = [];
  for (let r = r0; r <= area.r2; r++) {
    const row: string[] = [];
    for (let j = 0; j < width; j++) {
      const c = at.get(`${r},${area.c1 + j}`);
      row.push(c ? tableCell(c.v, c.fmt, date1904) : '');
    }
    cells.push(row);
  }
  // trailing empty rows say nothing
  while (cells.length > 1 && cells[cells.length - 1].every((c) => !c)) cells.pop();
  return { headers, units, cells: cells.length ? cells : [Array(width).fill('')] };
}

/** Does the first row of an area look like a header (text over numbers)? */
export function looksLikeHeader(sheet: XlsxSheet, area: Area): boolean {
  const at = new Map(sheet.cells.map((c) => [`${c.r},${c.c}`, c.v]));
  const first = Array.from({ length: area.c2 - area.c1 + 1 }, (_, j) => at.get(`${area.r1},${area.c1 + j}`));
  const second = Array.from({ length: area.c2 - area.c1 + 1 }, (_, j) => at.get(`${area.r1 + 1},${area.c1 + j}`));
  return first.some((v) => typeof v === 'string') && second.some((v) => typeof v === 'number') && first.every((v) => typeof v !== 'number');
}

/**
 * Formula cells saved without results (files written by programs rather than by Excel or
 * LibreOffice) get the values this engine calculates.
 */
export function withResults(book: XlsxBook): XlsxBook {
  if (!book.sheets.some((s) => s.cells.some((c) => c.f && c.v === null))) return book;
  const wb = calculate(bookToModel(book));
  return {
    ...book,
    sheets: book.sheets.map((s, si) => ({ ...s, cells: s.cells.map((c) => (c.f && c.v === null ? { ...c, v: wb.value(si, c.r, c.c) } : c)) })),
  };
}
