// Data files a worksheet reads (Mathcad's READPRN, READCSV, READFILE, READEXCEL and its File Read
// component): the worksheet keeps each file it reads (settings.dataFiles, by file name) and these
// functions read from there, so the calculation needs no disk and moves with the document.
import { math } from './math';
import { readXlsx } from '../sheet/xlsx';
import { parseRange } from '../sheet/refs';
import { dataFileKey } from '../model/dataFiles';

export { dataFileKey, dataFilesIn } from '../model/dataFiles';

/** The data files of the worksheet being calculated: set by the evaluator before each run. */
export const dataFileCtx: { files: Record<string, string> } = { files: {} };

/** A file's contents (its text, or a data: URL for a spreadsheet), or an error saying how to attach it. */
function contents(path: unknown, fn: string): string {
  if (typeof path !== 'string') throw new Error(`${fn}: the file name must be a string`);
  const key = dataFileKey(path);
  const hit = Object.keys(dataFileCtx.files).find((k) => dataFileKey(k) === key);
  if (hit === undefined) throw new Error(`The data file “${path.split(/[\\/]/).pop()}” is not attached to this worksheet: attach it in File ▸ Data files…`);
  return dataFileCtx.files[hit];
}

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eEdD][-+]?\d+)?$/;
/** A cell: a number when it reads as one (1.5, -2e3, Fortran's 1.5D3), else its text. */
function cell(s: string): number | string {
  const t = s.trim();
  if (NUM.test(t)) return Number(t.replace(/[dD]/, 'e'));
  if (/^[-+]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/i.test(t)) return NaN;
  return t;
}

const lines = (text: string) => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '');

function matrixOf(rows: (number | string)[][], fn: string, pad: boolean): unknown {
  if (!rows.length) throw new Error(`${fn}: the file has no data`);
  const width = Math.max(...rows.map((r) => r.length));
  if (!pad && rows.some((r) => r.length !== width)) {
    const bad = rows.findIndex((r) => r.length !== width);
    throw new Error(`${fn}: every line needs the same number of values (line ${bad + 1} has ${rows[bad].length}, others ${width})`);
  }
  return math.matrix(rows.map((r) => (r.length < width ? [...r, ...Array<number>(width - r.length).fill(NaN)] : r)) as never);
}

/** Values on a line separated by spaces, tabs or commas (READPRN's structured data). */
const split = (l: string) => l.trim().split(/[\s,]+/).filter(Boolean);

/** READPRN(file): a structured data file, one row a line; every line has the same number of values. */
function READPRN(file: unknown): unknown {
  return matrixOf(lines(contents(file, 'READPRN')).map((l) => split(l).map(cell)), 'READPRN', false);
}

/** Comma-separated values; quotes keep commas in a value. Short rows are filled with NaN. */
function csvRows(text: string, delim: string): (number | string)[][] {
  return lines(text).map((l) => {
    const out: string[] = [];
    let cur = '', quoted = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (quoted) {
        if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"' && !cur.trim()) { quoted = true; cur = ''; }
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(cell);
  });
}

/** READCSV(file): a comma-separated file as a matrix (numbers and text). */
function READCSV(file: unknown): unknown {
  return matrixOf(csvRows(contents(file, 'READCSV'), ','), 'READCSV', true);
}

/** READEXCEL(file, [range]): the first sheet (or the range, "Sheet1!A1:C10") of an .xlsx file. */
function READEXCEL(file: unknown, range?: unknown): unknown {
  const src = contents(file, 'READEXCEL');
  const m = /^data:[^;,]*;base64,(.*)$/.exec(src);
  if (!m) throw new Error('READEXCEL: the attached file is not an Excel workbook (.xlsx)');
  const book = readXlsx(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  const want = typeof range === 'string' ? parseRange(range) : null;
  if (range !== undefined && !want) throw new Error('READEXCEL: the range must be like "A1:C10" or "Sheet1!A1:C10"');
  const sheet = want?.sheet ? book.sheets.find((s) => s.name.toLowerCase() === want.sheet!.toLowerCase()) : book.sheets.find((s) => !s.hidden) ?? book.sheets[0];
  if (!sheet) throw new Error(`READEXCEL: no sheet “${want?.sheet ?? ''}” in the workbook`);
  const cells = sheet.cells;
  if (!cells.length) throw new Error('READEXCEL: the sheet is empty');
  const r1 = want ? want.r1 : Math.min(...cells.map((c) => c.r)), c1 = want ? want.c1 : Math.min(...cells.map((c) => c.c));
  const r2 = want ? Math.min(want.r2, Math.max(...cells.map((c) => c.r))) : Math.max(...cells.map((c) => c.r));
  const c2 = want ? Math.min(want.c2, Math.max(...cells.map((c) => c.c))) : Math.max(...cells.map((c) => c.c));
  const grid: (number | string)[][] = Array.from({ length: r2 - r1 + 1 }, () => Array<number | string>(c2 - c1 + 1).fill(NaN));
  for (const c of cells) {
    if (c.r < r1 || c.r > r2 || c.c < c1 || c.c > c2) continue;
    const v = c.v;
    grid[c.r - r1][c.c - c1] = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? v : NaN;
  }
  return matrixOf(grid, 'READEXCEL', true);
}

/** READFILE(file, type): "delimited" (spaces, tabs, commas or semicolons), "csv" or "Excel". */
function READFILE(file: unknown, type: unknown = 'delimited'): unknown {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (t === 'excel') return READEXCEL(file);
  const text = contents(file, 'READFILE');
  if (t === 'csv') return matrixOf(csvRows(text, ','), 'READFILE', true);
  if (t !== 'delimited') throw new Error(`READFILE: the file type “${String(type)}” is not supported here (delimited, csv or Excel)`);
  const first = lines(text).slice(0, 20).join('\n');
  const delim = first.includes('\t') ? '\t' : first.includes(';') ? ';' : first.includes(',') ? ',' : '';
  return matrixOf(delim ? csvRows(text, delim) : lines(text).map((l) => split(l).map(cell)), 'READFILE', true);
}

math.import({ READPRN, READCSV, READFILE, READEXCEL }, { override: false });
