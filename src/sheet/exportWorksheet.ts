// A worksheet as an Excel workbook: a "Results" sheet listing every variable (name, value,
// unit, the expression that defined it), vectors as columns of a "Vectors" sheet, each
// matrix, table and spreadsheet component on a sheet of its own.
import type { RegionResult } from '../engine/evaluator';
import type { FormatOptions } from '../engine/format';
import { isMatrix, isUnit } from '../engine/math';
import { parseStatement } from '../engine/syntax';
import { evaluationOrder } from '../model/areas';
import type { SpreadsheetRegion, TableRegion, Worksheet } from '../model/types';
import { displayParts } from './component';
import { Workbook } from './engine';
import { renameSheets } from './formula';
import { cellName, colName, parseCell } from './refs';
import { tableSheet } from './tableXlsx';
import { modelToWriteBook, sheetNames, type WriteBook, type WriteCell, type WriteSheet } from './xlsx';

interface Definition {
  name: string;
  expr: string;
  /** Unit the worksheet shows it in (x := … = kN, or a later "x = kN"). */
  unit?: string;
}

/** Where each variable was defined, in reading order, with its expression. */
function definitions(ws: Worksheet, results: Map<string, RegionResult>): Definition[] {
  const out = new Map<string, Definition>();
  const shownIn = new Map<string, string>();
  const add = (name: string, expr: string, unit?: string) => {
    const d = out.get(name);
    if (d) {
      d.expr = expr;
      if (unit) d.unit = unit;
    } else out.set(name, { name, expr, ...(unit ? { unit } : {}) });
  };
  for (const r of evaluationOrder(ws)) {
    if (r.disabled) continue;
    switch (r.kind) {
      case 'math': {
        let st;
        try {
          st = parseStatement(r.source);
        } catch {
          break;
        }
        if (st.type === 'define' && st.lhs.kind === 'var') add(st.lhs.name, st.rhs, st.unit || undefined);
        else if (st.type === 'define' && st.lhs.kind === 'index') add(st.lhs.name, r.source.trim());
        else if (st.type === 'define' && st.lhs.kind === 'destructure') st.lhs.names.forEach((n) => add(n, st.rhs));
        else if (st.type === 'program' && st.lhs.kind === 'var') add(st.lhs.name, '(program)');
        else if (st.type === 'eval' && /^[\p{L}_][\p{L}\p{N}_.']*$/u.test(st.expr.trim()) && st.unit) shownIn.set(st.expr.trim(), st.unit);
        break;
      }
      case 'solve': {
        try {
          const st = parseStatement(r.solver);
          if (st.type === 'define' && st.lhs.kind === 'var') add(st.lhs.name, st.rhs, st.unit || undefined);
          if (st.type === 'define' && st.lhs.kind === 'destructure') st.lhs.names.forEach((n) => add(n, st.rhs));
        } catch {
          /* not a definition */
        }
        break;
      }
      case 'table':
        add(r.name, 'table');
        if (r.columnVars) (r.headers ?? []).forEach((h) => h.trim() && add(h.trim(), `column of table ${r.name}`));
        break;
      case 'spreadsheet':
        for (const o of r.outputs) if (o.name.trim()) add(o.name.trim(), `spreadsheet ${o.ref}`, o.unit?.trim() || undefined);
        break;
      case 'python': {
        const res = results.get(r.id);
        if (res?.kind === 'python') for (const o of res.outputs) if (o.tex) add(o.name, 'Python');
        break;
      }
      case 'beam': case 'frame3d': case 'plate': case 'cad': case 'sketch':
        if (r.name.trim()) add(r.name.trim(), `${r.kind === 'frame3d' ? '3-D frame' : r.kind === 'cad' ? 'CAD part' : r.kind} results`);
        break;
      default:
        break;
    }
  }
  for (const [name, unit] of shownIn) {
    const d = out.get(name);
    if (d && !d.unit) d.unit = unit;
  }
  return [...out.values()];
}

/** Rows of a matrix value, 1-D vectors as one column. */
function rowsOf(v: unknown): unknown[][] {
  const a = (isMatrix(v) ? v.toArray() : v) as unknown[];
  return a.length && Array.isArray(a[0]) ? (a as unknown[][]) : a.map((x) => [x]);
}

/** The unit a vector or matrix is listed in: that of its first non-zero element. */
function commonUnit(items: unknown[], metric: boolean, wanted?: string): string {
  if (wanted) return prettyUnit(wanted.replace(/\*/g, ' ').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim());
  const u = items.find((x) => isUnit(x) && (x.value as number) !== 0) ?? items.find(isUnit);
  return u ? prettyUnit(displayParts(u, metric).unit) : '';
}

function numberIn(x: unknown, unit: string, metric: boolean): number | string | boolean | null {
  if (x === null || x === undefined) return null;
  try {
    return displayParts(x, metric, unit.replace(/·/g, ' ') || undefined).value;
  } catch {
    return displayParts(x, metric).value;
  }
}

const bold = (v: string): WriteCell => ({ v, bold: true });

/** A unit as an engineer writes it in a spreadsheet: "kN m" → "kN·m", "kg / m s^2" → "kg/(m·s^2)". */
export function prettyUnit(u: string): string {
  if (!u) return u;
  const [num, den] = u.split(' / ');
  const join = (s: string) => s.trim().split(/\s+/).join('·');
  if (!den) return join(num);
  const d = den.trim().split(/\s+/);
  return `${join(num)}/${d.length > 1 ? `(${d.join('·')})` : d[0]}`;
}

/** The workbook of an evaluated worksheet. */
export function worksheetBook(ws: Worksheet, variables: Map<string, unknown>, results: Map<string, RegionResult>, fmt: FormatOptions): WriteBook {
  const metric = !!fmt.metric;
  const results_: Map<string, WriteCell> = new Map();
  const head = ['Name', 'Value', 'Unit', 'Expression', 'Values in'];
  head.forEach((h, j) => results_.set(cellName(0, j), bold(h)));
  const vectors: { name: string; unit: string; values: unknown[] }[] = [];
  const matrices: { name: string; unit: string; rows: unknown[][]; row: number }[] = [];
  const tables = new Set(ws.regions.filter((r): r is TableRegion => r.kind === 'table').map((t) => t.name));
  let row = 1;
  const put = (name: string, value: unknown, expr: string, unit: string | undefined, depth = 0) => {
    if (typeof value === 'function' || value === undefined) return;
    if (row > 100000) return;
    if (isMatrix(value) || Array.isArray(value)) {
      const rows = rowsOf(value);
      const items = rows.flat();
      // a table's columns have units of their own (on its sheet)
      const u = tables.has(name) && depth === 0 ? '' : commonUnit(items, metric, unit);
      const isVector = rows.every((r) => r.length === 1) || rows.length === 1;
      results_.set(cellName(row, 0), { v: name });
      results_.set(cellName(row, 2), { v: u || null });
      results_.set(cellName(row, 3), { v: expr });
      if (tables.has(name) && depth === 0) results_.set(cellName(row, 4), { v: `sheet ${name}` });
      else if (isVector) {
        vectors.push({ name, unit: u, values: rows.length === 1 ? rows[0] : rows.map((r) => r[0]) });
        results_.set(cellName(row, 4), { v: `Vectors, column ${colName(vectors.length - 1)}` });
      } else matrices.push({ name, unit: u, rows, row });
      results_.set(cellName(row, 1), { v: `${rows.length} × ${rows[0]?.length ?? 0}` });
      row++;
      return;
    }
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      // results of beams, sections …: their fields, one level down
      if (depth > 1) return;
      let n = 0;
      for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
        if (n++ > 300) break;
        if (isMatrix(x) && depth > 0) continue;
        put(`${name}.${k}`, x, expr, undefined, depth + 1);
      }
      return;
    }
    let shown: { value: number | string | boolean; unit: string };
    try {
      shown = displayParts(value, metric, unit);
    } catch {
      shown = displayParts(value, metric);
    }
    results_.set(cellName(row, 0), { v: name });
    results_.set(cellName(row, 1), { v: shown.value });
    if (shown.unit) results_.set(cellName(row, 2), { v: prettyUnit(shown.unit) });
    results_.set(cellName(row, 3), { v: expr });
    row++;
  };
  const listed = new Set<string>();
  for (const d of definitions(ws, results)) {
    if (!variables.has(d.name)) continue;
    listed.add(d.name);
    put(d.name, variables.get(d.name), d.expr, d.unit);
  }
  for (const [name, v] of variables) if (!listed.has(name)) put(name, v, '', undefined);

  const sheets: WriteSheet[] = [{ name: 'Results', cells: results_, widths: { 0: 120, 1: 110, 2: 70, 3: 260, 4: 140 }, freezeRows: 1 }];
  if (vectors.length) {
    const cells = new Map<string, WriteCell>();
    vectors.forEach((vc, j) => {
      cells.set(cellName(0, j), bold(vc.unit ? `${vc.name} [${vc.unit}]` : vc.name));
      vc.values.forEach((x, i) => cells.set(cellName(i + 1, j), { v: numberIn(x, vc.unit, metric) }));
    });
    sheets.push({ name: 'Vectors', cells, freezeRows: 1 });
  }
  for (const m of matrices) {
    const cells = new Map<string, WriteCell>();
    cells.set('A1', bold(m.unit ? `${m.name} [${m.unit}]` : m.name));
    m.rows.forEach((r, i) => r.forEach((x, j) => cells.set(cellName(i + 1, j), { v: numberIn(x, m.unit, metric) })));
    sheets.push({ name: m.name, cells });
  }
  for (const t of ws.regions) {
    if (t.kind !== 'table' || t.disabled) continue;
    const res = results.get(t.id);
    sheets.push(tableSheet(t, res?.kind === 'table' ? res.values : undefined));
  }
  // a matrix called "Results" or two tables of one name: sheet names Excel takes
  const fixed = sheetNames(sheets.map((s) => s.name));
  sheets.forEach((s, i) => { s.name = fixed[i]; });
  const firstMatrix = vectors.length ? 2 : 1;
  matrices.forEach((m, i) => results_.set(cellName(m.row, 4), { v: `sheet ${sheets[firstMatrix + i].name}` }));
  // spreadsheet components with their formulas, calculated with the inputs they had
  const names: WriteBook['names'] = [];
  const used = new Set(sheets.map((s) => s.name.toUpperCase()));
  for (const r of ws.regions) {
    if (r.kind !== 'spreadsheet' || r.disabled) continue;
    const res = results.get(r.id);
    const wb = new Workbook(r);
    if (res?.kind === 'spreadsheet') for (const [s, ref, v] of res.written) { const p = parseCell(ref); if (p) wb.setInput(s, p.r, p.c, v); }
    wb.recalc();
    const book = modelToWriteBook(r as SpreadsheetRegion, wb);
    // sheet names already taken get another one, and the formulas follow
    const renamed = sheetNames([...used].concat(book.sheets.map((s) => s.name))).slice(used.size);
    const map = new Map<string, string>();
    book.sheets.forEach((s, i) => {
      if (renamed[i] !== s.name) map.set(s.name.toUpperCase(), renamed[i]);
      used.add(renamed[i].toUpperCase());
    });
    const first = sheets.length;
    book.sheets.forEach((s, i) => {
      const cells = s.cells instanceof Map ? s.cells : new Map(Object.entries(s.cells));
      if (map.size) for (const c of cells.values()) if (c.f) c.f = renameSheets(c.f, map);
      sheets.push({ ...s, name: renamed[i], cells });
    });
    for (const n of r.names ?? []) {
      const ref = renameSheets(`=${n.ref}`, map).slice(1);
      const clash = names.some((m) => m.name.toUpperCase() === n.name.toUpperCase() && m.sheet === undefined);
      names.push({ name: n.name, ref, ...(n.sheet !== undefined || clash ? { sheet: first + (n.sheet ?? 0) } : {}) });
    }
  }
  return { sheets, names, title: ws.title };
}
