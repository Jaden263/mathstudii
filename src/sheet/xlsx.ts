// Office Open XML workbooks (.xlsx, ECMA-376 / ISO 29500) without a spreadsheet library:
// a zip (fflate) of XML parts (@xmldom/xmldom). Reading follows the relationships from
// _rels/.rels to the workbook, its sheets, shared strings and styles; it takes numbers,
// text (shared, inline, rich), logicals, errors, dates (1900 and 1904 systems), formulas
// with their cached values (shared and array formulas too), merged cells, column widths
// and defined names. Writing makes the minimal package Excel and LibreOffice open:
// [Content_Types].xml, the relationships, workbook.xml, styles.xml, sharedStrings.xml and
// one sheetN.xml per sheet.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { DOMParser, type Element as XElement } from '@xmldom/xmldom';
import { dateSerial } from './dates';
import type { DefinedName, SheetModel, WorkbookModel, Workbook } from './engine';
import { fromFileFormula, toFileFormula, translateFormula } from './formula';
import { BUILTIN_FORMATS, isDateFormat } from './numfmt';
import { areaName, cellName, colName, parseCell, parseRange, type Area } from './refs';
import { compare, errorOf, inputOf, XlError, type Scalar } from './values';

export interface XlsxCell {
  r: number;
  c: number;
  /** The value, or the cached result of a formula. */
  v: Scalar;
  /** Formula as typed ("=A1*2"), without file prefixes. */
  f?: string;
  /** The formula is an array formula over this area (its other cells hold only cached values). */
  array?: Area;
  fmt?: string;
  bold?: boolean;
}

export interface XlsxSheet {
  name: string;
  cells: XlsxCell[];
  merges: Area[];
  /** Column widths in px by column index. */
  widths: Record<number, number>;
  hidden?: boolean;
}

export interface XlsxBook {
  sheets: XlsxSheet[];
  names: DefinedName[];
  date1904: boolean;
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

// ---------------------------------------------------------------- reading

type El = XElement;
const local = (e: El) => e.localName || e.nodeName.replace(/^.*:/, '');
const kids = (e: El | null | undefined, name?: string): El[] => {
  const out: El[] = [];
  if (!e) return out;
  for (let n = e.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!name || local(n as El) === name)) out.push(n as El);
  return out;
};
const kid = (e: El | null | undefined, name: string) => kids(e, name)[0] ?? null;
const text = (e: El | null) => (e ? e.textContent ?? '' : '');
/** An attribute by local name (prefixes differ between writers: r:id, x:r …). */
function attr(e: El, name: string): string | null {
  if (e.hasAttribute(name)) return e.getAttribute(name);
  for (let i = 0; i < e.attributes.length; i++) {
    const a = e.attributes[i];
    if ((a.localName || a.name.replace(/^.*:/, '')) === name) return a.value;
  }
  return null;
}

/** OOXML strings escape characters XML cannot hold as _xHHHH_. */
const unescapeX = (s: string) => s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

function parseXml(bytes: Uint8Array | undefined, what: string): El {
  if (!bytes) throw new Error(`The file has no ${what}`);
  const doc = new DOMParser({ onError: () => {} }).parseFromString(strFromU8(bytes), 'text/xml');
  const root = doc.documentElement as unknown as El | null;
  if (!root) throw new Error(`${what} is not readable XML`);
  return root;
}

/** Resolve a relationship target against the part that owns it. */
function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function relsOf(files: Record<string, Uint8Array>, part: string): { id: string; type: string; target: string }[] {
  const dir = part.split('/').slice(0, -1).join('/');
  const relPath = `${dir ? dir + '/' : ''}_rels/${part.split('/').pop()}.rels`;
  const bytes = files[relPath];
  if (!bytes) return [];
  return kids(parseXml(bytes, relPath), 'Relationship').map((r) => ({
    id: attr(r, 'Id') ?? '', type: attr(r, 'Type') ?? '', target: resolvePart(part, attr(r, 'Target') ?? ''),
  }));
}

/** Text of a shared or inline string item: plain <t>, or the runs of rich text (phonetic hints left out). */
function stringItem(si: El): string {
  const t = kid(si, 't');
  if (t && !kids(si, 'r').length) return unescapeX(text(t));
  return kids(si, 'r').map((r) => unescapeX(text(kid(r, 't')))).join('');
}

interface Styles {
  fmt: (string | undefined)[];
  bold: boolean[];
}

function readStyles(root: El | null): Styles {
  if (!root) return { fmt: [], bold: [] };
  const custom = new Map<number, string>();
  for (const nf of kids(kid(root, 'numFmts'), 'numFmt')) custom.set(Number(attr(nf, 'numFmtId')), attr(nf, 'formatCode') ?? '');
  const fonts = kids(kid(root, 'fonts'), 'font').map((f) => {
    const b = kid(f, 'b');
    return !!b && !/^(0|false)$/.test(attr(b, 'val') ?? '');
  });
  const fmt: (string | undefined)[] = [], bold: boolean[] = [];
  for (const xf of kids(kid(root, 'cellXfs'), 'xf')) {
    const id = Number(attr(xf, 'numFmtId') ?? 0);
    const code = custom.get(id) ?? BUILTIN_FORMATS[id];
    fmt.push(code && code !== 'General' ? code : undefined);
    bold.push(fonts[Number(attr(xf, 'fontId') ?? 0)] ?? false);
  }
  return { fmt, bold };
}

/** px of a column from its stored width (characters of the default font's digit, 7 px for Calibri 11). */
const widthPx = (w: number) => Math.trunc(((256 * w + 18) / 256) * 7);

/** Read an .xlsx (or .xlsm) file. */
export function readXlsx(bytes: Uint8Array): XlsxBook {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('This is not an .xlsx file (it is not a zip package): an old .xls file, or a workbook protected with a password. Save it from Excel as an unprotected .xlsx first.');
  }
  const top = relsOf(files, '');
  const wbPath = top.find((r) => /\/officeDocument$/.test(r.type))?.target ?? 'xl/workbook.xml';
  const wbRoot = parseXml(files[wbPath], 'workbook');
  const wbRels = relsOf(files, wbPath);
  const relTarget = (type: string) => wbRels.find((r) => r.type.endsWith(`/${type}`))?.target;
  const ssPath = relTarget('sharedStrings');
  const shared = ssPath && files[ssPath] ? kids(parseXml(files[ssPath], 'shared strings'), 'si').map(stringItem) : [];
  const stPath = relTarget('styles');
  const styles = readStyles(stPath && files[stPath] ? parseXml(files[stPath], 'styles') : null);
  const pr = kid(wbRoot, 'workbookPr');
  const date1904 = !!pr && /^(1|true)$/.test(attr(pr, 'date1904') ?? '');

  const sheets: XlsxSheet[] = [];
  for (const s of kids(kid(wbRoot, 'sheets'), 'sheet')) {
    const rel = wbRels.find((r) => r.id === attr(s, 'id'));
    if (!rel || !/\/worksheet$/.test(rel.type) || !files[rel.target]) continue; // chart sheets and the like
    const sheet = readSheet(parseXml(files[rel.target], `sheet ${attr(s, 'name')}`), shared, styles, date1904);
    sheet.name = attr(s, 'name') ?? `Sheet${sheets.length + 1}`;
    if (/hidden/i.test(attr(s, 'state') ?? '')) sheet.hidden = true;
    sheets.push(sheet);
  }
  const names: DefinedName[] = [];
  for (const d of kids(kid(wbRoot, 'definedNames'), 'definedName')) {
    const name = attr(d, 'name') ?? '';
    // print areas, filter ranges and other built-in names are not for formulas
    if (!name || name.startsWith('_xlnm.')) continue;
    const ls = attr(d, 'localSheetId');
    names.push({ name, ref: fromFileFormula(text(d)).slice(1), ...(ls !== null ? { sheet: Number(ls) } : {}) });
  }
  return { sheets, names, date1904 };
}

function readSheet(root: El, shared: string[], styles: Styles, date1904: boolean): XlsxSheet {
  const cells: XlsxCell[] = [];
  const masters = new Map<string, { f: string; r: number; c: number }>();
  let rowIdx = -1;
  for (const row of kids(kid(root, 'sheetData'), 'row')) {
    const rAttr = attr(row, 'r');
    rowIdx = rAttr ? Number(rAttr) - 1 : rowIdx + 1;
    let colIdx = -1;
    for (const c of kids(row, 'c')) {
      const ref = attr(c, 'r');
      const p = ref ? parseCell(ref) : null;
      const r = p ? p.r : rowIdx;
      colIdx = p ? p.c : colIdx + 1;
      const t = attr(c, 't') ?? 'n';
      const vEl = kid(c, 'v');
      const raw = vEl ? text(vEl) : null;
      let v: Scalar = null;
      if (t === 's') v = raw === null ? null : (shared[Number(raw)] ?? '');
      else if (t === 'inlineStr') v = stringItem(kid(c, 'is') ?? c);
      else if (t === 'str') v = raw === null ? '' : unescapeX(raw);
      else if (t === 'b') v = raw === null ? null : raw.trim() === '1' || /^true$/i.test(raw.trim());
      else if (t === 'e') v = raw === null ? null : (errorOf(raw.trim()) ?? raw.trim());
      else if (t === 'd') v = raw === null ? null : isoSerial(raw, date1904);
      else if (raw !== null && raw.trim() !== '') v = Number(raw);
      const s = Number(attr(c, 's') ?? 0);
      const cell: XlsxCell = { r, c: colIdx, v };
      if (styles.fmt[s]) cell.fmt = styles.fmt[s];
      if (styles.bold[s]) cell.bold = true;
      const fEl = kid(c, 'f');
      if (fEl) {
        const ft = attr(fEl, 't');
        const body = text(fEl);
        if (ft === 'shared') {
          const si = attr(fEl, 'si') ?? '';
          if (body) masters.set(si, { f: body, r, c: colIdx });
          const m = masters.get(si);
          if (m) cell.f = fromFileFormula(translateFormula(m.f, r - m.r, colIdx - m.c));
        } else if (ft !== 'dataTable' && body) {
          cell.f = fromFileFormula(body);
          if (ft === 'array') {
            const a = parseRange(attr(fEl, 'ref') ?? '');
            if (a && (a.r1 !== a.r2 || a.c1 !== a.c2)) cell.array = { r1: a.r1, c1: a.c1, r2: a.r2, c2: a.c2 };
          }
        }
      }
      if (cell.v !== null || cell.f || cell.fmt || cell.bold) cells.push(cell);
    }
  }
  const merges: Area[] = [];
  for (const m of kids(kid(root, 'mergeCells'), 'mergeCell')) {
    const a = parseRange(attr(m, 'ref') ?? '');
    if (a) merges.push({ r1: a.r1, c1: a.c1, r2: a.r2, c2: a.c2 });
  }
  const widths: Record<number, number> = {};
  for (const col of kids(kid(root, 'cols'), 'col')) {
    const w = Number(attr(col, 'width'));
    if (!Number.isFinite(w) || w <= 0) continue;
    const lo = Number(attr(col, 'min')) - 1, hi = Math.min(Number(attr(col, 'max')) - 1, lo + 255);
    for (let i = lo; i <= hi; i++) widths[i] = widthPx(w);
  }
  return { name: '', cells, merges, widths };
}

/** A t="d" cell holds an ISO 8601 date-time. */
function isoSerial(s: string, date1904: boolean): Scalar {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(s.trim());
  if (!m) return s;
  return dateSerial(+m[1], +m[2], +m[3], date1904) + ((+(m[4] ?? 0)) * 3600 + (+(m[5] ?? 0)) * 60 + +(m[6] ?? 0)) / 86400;
}

/** The workbook a component calculates: formulas as typed, values as their inputs. */
export function bookToModel(book: XlsxBook): WorkbookModel {
  const sheets: SheetModel[] = book.sheets.map((s) => {
    const cells: Record<string, string> = {};
    const styles: SheetModel['styles'] = {};
    // the other cells of an array formula are what it spills
    const covered = new Set<string>();
    for (const c of s.cells) if (c.f && c.array) for (let r = c.array.r1; r <= c.array.r2; r++) for (let k = c.array.c1; k <= c.array.c2; k++) if (r !== c.r || k !== c.c) covered.add(cellName(r, k));
    for (const c of s.cells) {
      const ref = cellName(c.r, c.c);
      if (c.fmt || c.bold) styles[ref] = { ...(c.fmt ? { fmt: c.fmt } : {}), ...(c.bold ? { b: true } : {}) };
      if (covered.has(ref)) continue;
      const src = c.f ?? inputOf(c.v);
      if (src) cells[ref] = src;
    }
    const widths = Object.fromEntries(Object.entries(s.widths).map(([k, v]) => [k, v]));
    return {
      name: s.name, cells,
      ...(Object.keys(styles).length ? { styles } : {}),
      ...(Object.keys(widths).length ? { widths } : {}),
      ...(s.merges.length ? { merges: s.merges.map(areaName) } : {}),
    };
  });
  return { sheets, ...(book.names.length ? { names: book.names } : {}), ...(book.date1904 ? { date1904: true } : {}) };
}

export interface Mismatch {
  cell: string;
  excel: Scalar;
  ours: Scalar;
}

/**
 * Formulas recalculated here against the values the file was saved with. Numbers agree to
 * 1e-9 relative (Excel keeps 15 digits); formulas the engine cannot do are listed apart.
 */
export function compareCached(book: XlsxBook, wb: Workbook): { formulas: number; mismatches: Mismatch[]; unsupported: string[] } {
  let formulas = 0;
  const mismatches: Mismatch[] = [];
  const unsupported = new Set(wb.unknownFunctions);
  book.sheets.forEach((s, si) => {
    for (const c of s.cells) {
      if (!c.f) continue;
      formulas++;
      // a file saved without results (written by a program, not Excel) has nothing to compare
      if (c.v === null) continue;
      const ours = wb.value(si, c.r, c.c);
      if (!sameValue(c.v, ours)) mismatches.push({ cell: wb.label(si, c.r, c.c), excel: c.v, ours });
    }
  });
  return { formulas, mismatches, unsupported: [...unsupported].sort() };
}

function sameValue(a: Scalar, b: Scalar): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
  if (a instanceof XlError || b instanceof XlError) return a === b;
  // a formula giving "" is cached as an empty string; ours may be blank
  if ((a === '' && b === null) || (a === null && b === '')) return true;
  return typeof a === typeof b && compare(a, b) === 0 && (typeof a !== 'string' || a === b);
}

// ---------------------------------------------------------------- writing

export interface WriteCell {
  v: Scalar;
  /** Formula, with or without "=". */
  f?: string;
  /** The formula spills over this area (written as an array formula). */
  array?: Area;
  fmt?: string;
  bold?: boolean;
}

export interface WriteSheet {
  name: string;
  /** Cells by "A1" reference. */
  cells: Map<string, WriteCell> | Record<string, WriteCell>;
  /** Column widths in px by column index. */
  widths?: Record<number, number>;
  merges?: Area[];
  /** Rows kept on screen when scrolling (a header row). */
  freezeRows?: number;
}

export interface WriteBook {
  sheets: WriteSheet[];
  names?: DefinedName[];
  date1904?: boolean;
  title?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text for an XML element: control characters as _xHHHH_ (and a literal _xHHHH_ protected). */
const escText = (s: string) => esc(s.replace(/_x[0-9A-Fa-f]{4}_/g, (m) => `_x005F_${m.slice(1)}`).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`));
const tEl = (s: string) => (/^\s|\s$/.test(s) ? `<t xml:space="preserve">${escText(s)}</t>` : `<t>${escText(s)}</t>`);
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Excel's rules for sheet names: 31 characters, none of []:*?/\, unique ignoring case. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n, i) => {
    let base = n.replace(/[[\]:*?/\\]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`;
    if (/^history$/i.test(base)) base = `${base}_`;
    let name = base, k = 2;
    while (used.has(name.toUpperCase())) {
      const suffix = ` (${k++})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toUpperCase());
    return name;
  });
}

/** px → stored column width (characters of a 7 px digit, as Excel writes them). */
const widthChars = (px: number) => Math.trunc((px / 7) * 256) / 256;

/** Number formats that have built-in ids. */
const BUILTIN_IDS = new Map(Object.entries(BUILTIN_FORMATS).filter(([id]) => Number(id) < 14 || Number(id) > 22).map(([id, code]) => [code, Number(id)]));

const numText = (x: number) => (Number.isFinite(x) ? String(x).replace('e+', 'E+').replace('e-', 'E-') : '');

/** Write an .xlsx file. */
export function writeXlsx(book: WriteBook): Uint8Array {
  const names = sheetNames(book.sheets.map((s) => s.name));
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sst = (s: string) => {
    let i = stringIndex.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      stringIndex.set(s, i);
    }
    return i;
  };
  // styles: index 0 is the default; one xf per (format, bold) pair used
  const customFmts = new Map<string, number>();
  const xfs: { fmtId: number; bold: boolean }[] = [{ fmtId: 0, bold: false }];
  const xfIndex = new Map<string, number>([['0|0', 0]]);
  const styleOf = (fmt: string | undefined, bold: boolean | undefined) => {
    let fmtId = 0;
    if (fmt && fmt !== 'General') {
      fmtId = BUILTIN_IDS.get(fmt) ?? customFmts.get(fmt) ?? 0;
      if (!fmtId) {
        fmtId = 164 + customFmts.size;
        customFmts.set(fmt, fmtId);
      }
    }
    const k = `${fmtId}|${bold ? 1 : 0}`;
    let i = xfIndex.get(k);
    if (i === undefined) {
      i = xfs.length;
      xfs.push({ fmtId, bold: !!bold });
      xfIndex.set(k, i);
    }
    return i;
  };

  const sheetXml = book.sheets.map((s, si) => {
    const entries = (s.cells instanceof Map ? [...s.cells.entries()] : Object.entries(s.cells))
      .map(([ref, cell]) => ({ p: parseCell(ref)!, cell }))
      .filter((e) => e.p)
      .sort((a, b) => a.p.r - b.p.r || a.p.c - b.p.c);
    const rows: string[] = [];
    let curRow = -1, line = '';
    let maxR = 0, maxC = 0;
    for (const { p, cell } of entries) {
      if (p.r !== curRow) {
        if (curRow >= 0) rows.push(`<row r="${curRow + 1}">${line}</row>`);
        curRow = p.r;
        line = '';
      }
      maxR = Math.max(maxR, p.r);
      maxC = Math.max(maxC, p.c);
      const st = styleOf(cell.fmt, cell.bold);
      const sAttr = st ? ` s="${st}"` : '';
      const r = cellName(p.r, p.c);
      const v = cell.v;
      if (cell.f) {
        const f = toFileFormula(cell.f);
        const fEl = cell.array ? `<f t="array" ref="${areaName(cell.array)}">${esc(f)}</f>` : `<f>${esc(f)}</f>`;
        // the cached result, so viewers that do not calculate still show it
        if (typeof v === 'number' && Number.isFinite(v)) line += `<c r="${r}"${sAttr}>${fEl}<v>${numText(v)}</v></c>`;
        else if (typeof v === 'string') line += `<c r="${r}"${sAttr} t="str">${fEl}<v>${escText(v)}</v></c>`;
        else if (typeof v === 'boolean') line += `<c r="${r}"${sAttr} t="b">${fEl}<v>${v ? 1 : 0}</v></c>`;
        else if (v instanceof XlError && v.code !== '#CIRC!') line += `<c r="${r}"${sAttr} t="e">${fEl}<v>${v.code}</v></c>`;
        else line += `<c r="${r}"${sAttr}>${fEl}</c>`;
      } else if (typeof v === 'number') {
        line += Number.isFinite(v) ? `<c r="${r}"${sAttr}><v>${numText(v)}</v></c>` : `<c r="${r}"${sAttr} t="e"><v>#NUM!</v></c>`;
      } else if (typeof v === 'string') line += `<c r="${r}"${sAttr} t="s"><v>${sst(v)}</v></c>`;
      else if (typeof v === 'boolean') line += `<c r="${r}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
      else if (v instanceof XlError && v.code !== '#CIRC!') line += `<c r="${r}"${sAttr} t="e"><v>${v.code}</v></c>`;
      else if (st) line += `<c r="${r}"${sAttr}/>`;
    }
    if (curRow >= 0) rows.push(`<row r="${curRow + 1}">${line}</row>`);
    const widths = Object.entries(s.widths ?? {}).map(([k, px]) => [Number(k), px] as const).sort((a, b) => a[0] - b[0]);
    const cols = widths.length ? `<cols>${widths.map(([c, px]) => `<col min="${c + 1}" max="${c + 1}" width="${widthChars(px)}" customWidth="1"/>`).join('')}</cols>` : '';
    const pane = s.freezeRows ? `<pane ySplit="${s.freezeRows}" topLeftCell="A${s.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${s.freezeRows + 1}" sqref="A${s.freezeRows + 1}"/>` : '';
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${areaName(m)}"/>`).join('')}</mergeCells>` : '';
    return XML_HEAD
      + `<worksheet xmlns="${MAIN}" xmlns:r="${REL}">`
      + `<dimension ref="${entries.length ? `A1:${colName(maxC)}${maxR + 1}` : 'A1'}"/>`
      + `<sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + cols
      + `<sheetData>${rows.join('')}</sheetData>`
      + merges
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + '</worksheet>';
  });

  const n = book.sheets.length;
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(XML_HEAD
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheetXml.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>');
  files['_rels/.rels'] = strToU8(XML_HEAD
    + `<Relationships xmlns="${PKG_REL}">`
    + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>`
    + `<Relationship Id="rId2" Type="${PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>`
    + `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>`
    + '</Relationships>');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files['docProps/core.xml'] = strToU8(XML_HEAD
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + (book.title ? `<dc:title>${esc(book.title)}</dc:title>` : '')
    + '<dc:creator>mathstudii</dc:creator>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
    + '</cp:coreProperties>');
  files['docProps/app.xml'] = strToU8(XML_HEAD
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>mathstudii</Application></Properties>');
  const definedNames = (book.names ?? []).filter((d) => d.name && d.ref);
  files['xl/workbook.xml'] = strToU8(XML_HEAD
    + `<workbook xmlns="${MAIN}" xmlns:r="${REL}">`
    + `<workbookPr${book.date1904 ? ' date1904="1"' : ''}/>`
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000" activeTab="0"/></bookViews>'
    + `<sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`
    + (definedNames.length ? `<definedNames>${definedNames.map((d) => `<definedName name="${esc(d.name)}"${d.sheet !== undefined ? ` localSheetId="${d.sheet}"` : ''}>${esc(toFileFormula(d.ref))}</definedName>`).join('')}</definedNames>` : '')
    // the file's formulas are recalculated when Excel opens it
    + '<calcPr calcId="191029" fullCalcOnLoad="1"/>'
    + '</workbook>');
  files['xl/_rels/workbook.xml.rels'] = strToU8(XML_HEAD
    + `<Relationships xmlns="${PKG_REL}">`
    + sheetXml.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${n + 2}" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>');
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(x); });
  const fmts = [...customFmts.entries()];
  files['xl/styles.xml'] = strToU8(XML_HEAD
    + `<styleSheet xmlns="${MAIN}">`
    + (fmts.length ? `<numFmts count="${fmts.length}">${fmts.map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>` : '')
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.map((x) => `<xf numFmtId="${x.fmtId}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.fmtId ? ' applyNumberFormat="1"' : ''}${x.bold ? ' applyFont="1"' : ''}/>`).join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>');
  files['xl/sharedStrings.xml'] = strToU8(XML_HEAD
    + `<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si>${tEl(s)}</si>`).join('')}</sst>`);
  return zipSync(files, { level: 6 });
}

/** A calculated workbook as a file: formulas with their results, styles, widths, merges. */
export function modelToWriteBook(model: WorkbookModel, wb: Workbook, title?: string): WriteBook {
  return {
    title,
    date1904: model.date1904,
    names: model.names,
    sheets: model.sheets.map((s, si) => {
      const cells = new Map<string, WriteCell>();
      for (const { r, c, v } of wb.cells(si)) {
        const ref = cellName(r, c);
        const src = wb.input(si, r, c);
        const st = s.styles?.[ref];
        const cell: WriteCell = { v, ...(st?.fmt ? { fmt: st.fmt } : {}), ...(st?.b ? { bold: true } : {}) };
        if (src.startsWith('=') && wb.isFormula(si, r, c) && !wb.isInput(si, r, c)) {
          cell.f = src;
          const sp = wb.spillArea(si, r, c);
          if (sp) cell.array = sp;
        }
        cells.set(ref, cell);
      }
      for (const [ref, st] of Object.entries(s.styles ?? {})) if (!cells.has(ref)) cells.set(ref, { v: null, ...(st.fmt ? { fmt: st.fmt } : {}), ...(st.b ? { bold: true } : {}) });
      const widths: Record<number, number> = {};
      for (const [k, px] of Object.entries(s.widths ?? {})) widths[Number(k)] = px;
      return { name: s.name, cells, widths, merges: (s.merges ?? []).map((m) => parseRange(m)).filter((a): a is NonNullable<typeof a> => !!a) };
    }),
  };
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export { isDateFormat };
