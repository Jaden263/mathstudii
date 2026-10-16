// A spreadsheet component in the worksheet's calculation: inputs are worksheet values
// written into cells as numbers in the unit asked for (10 kN in "N" is 10000; with no unit,
// quantities go in SI base units, as Mathcad's Excel component does), the workbook
// calculates, and outputs read cells back as worksheet values with their unit.
import type { Unit } from 'mathjs';
import { math, isMatrix, isUnit, isComplex, splitUnit } from '../engine/math';
import { valueTex, escapeText, unitParts, unitStringTex, type FormatOptions } from '../engine/format';
import { exprTex, nameTex } from '../engine/tex';
import { isIdentifier } from '../engine/syntax';
import { vec } from '../engine/library';
import { Workbook } from './engine';
import { COL_W, type SpreadsheetData } from './model';
import { cellName, inArea, type Area } from './refs';
import { XlError, type Scalar } from './values';

export interface CellShow {
  /** What the cell shows. */
  t: string;
  /** Number, text, logical or error. */
  k: 'n' | 's' | 'b' | 'e';
  /** Written by an input, read by an output, filled by an array formula. */
  in?: 1;
  out?: 1;
  sp?: 1;
}

export interface SpreadsheetResult {
  kind: 'spreadsheet';
  /** Every cell with a value, per sheet, keyed "A1". */
  cells: Record<string, CellShow>[];
  /** Each input as shown; `si` is the unit numbers went in as when none was given. */
  inputs: { tex?: string; si?: string; error?: string }[];
  outputs: { tex?: string; error?: string }[];
  /** Values the inputs wrote: sheet, cell, value (to export the workbook as calculated). */
  written: [number, string, number | string | boolean][];
  /** Loops of circular references ("A1 → B1 → A1"). */
  circular?: string[];
  /** Functions the formulas call that are not available. */
  unknown?: string[];
  /** Formulas that could not be read: "B4: …". */
  parseErrors?: string[];
  error?: string;
}

/** Most cells a component sends to the page (a larger imported sheet still calculates). */
const SHOW_LIMIT = 50000;

function unitOf(text: string): Unit {
  let u: unknown;
  try {
    u = math.evaluate(text.replace(/·/g, ' '));
  } catch {
    throw new Error(`"${text}" is not a unit`);
  }
  if (!isUnit(u)) throw new Error(`"${text}" is not a unit`);
  return u;
}

/** A worksheet value as rows of cell values in the given unit. */
function toCells(v: unknown, unit: string, what: string): { rows: Scalar[][]; si?: string } {
  let si: string | undefined;
  const target = unit ? unitOf(unit) : null;
  const one = (x: unknown): Scalar => {
    if (typeof x === 'string' || typeof x === 'boolean') return x;
    if (isComplex(x)) {
      if (Math.abs(x.im) > 1e-14 * Math.max(1, Math.abs(x.re))) throw new Error(`${what} is complex; cells hold real numbers`);
      x = x.re;
    }
    if (typeof x === 'number') {
      if (target && target.dimensions.some((d) => d !== 0)) throw new Error(`${what} has no unit, so it cannot be written in ${unit}: leave the unit empty`);
      return target ? x / ((target.value as number) ?? 1) : x;
    }
    if (isUnit(x)) {
      if (target) {
        if (!x.equalBase(target)) throw new Error(`${what} cannot be written in ${unit}: the units do not match`);
        return x.toNumber(target.formatUnits());
      }
      const s = splitUnit(x);
      if (s.unit && s.unit.dimensions.some((d) => d !== 0)) si ??= siUnits(s.unit);
      return s.value;
    }
    throw new Error(`${what} cannot be written into a cell`);
  };
  if (isMatrix(v) || Array.isArray(v)) {
    const a = (isMatrix(v) ? v.toArray() : v) as unknown[];
    const rows = a.length && Array.isArray(a[0]) ? (a as unknown[][]).map((r) => r.map(one)) : a.map((x) => [one(x)]);
    return { rows, si };
  }
  return { rows: [[one(v)]], si };
}

/** "m", "kg m / s^2" … for a quantity in SI base units. */
function siUnits(u: Unit): string {
  // mathjs' base dimensions: mass, length, time, current, temperature, luminous intensity, amount, angle
  const parts = ([['kg', 0], ['m', 1], ['s', 2], ['A', 3], ['K', 4], ['mol', 6], ['cd', 5], ['rad', 7]] as const)
    .map(([n, i]) => [n, u.dimensions[i] ?? 0] as const).filter(([, p]) => p);
  const up = parts.filter(([, p]) => p > 0).map(([n, p]) => (p === 1 ? n : `${n}^${p}`));
  const down = parts.filter(([, p]) => p < 0).map(([n, p]) => (p === -1 ? n : `${n}^${-p}`));
  return (up.join(' ') || '1') + (down.length ? ` / ${down.join(' ')}` : '');
}

const refTex = (label: string) => `\\text{${escapeText(label)}}`;
const big = (v: unknown) => (isMatrix(v) ? v.size().reduce((a, b) => a * b, 1) > 6 : false);
const sizeText = (v: unknown) => {
  if (!isMatrix(v)) return '';
  const size = v.size();
  return size.length === 1 ? `${size[0]} values` : size.join(' × ');
};

/**
 * Calculate a component: `evalExpr` evaluates a worksheet expression where the component
 * stands. Returns what the page shows and the variables the outputs define.
 */
export function solveSpreadsheet(r: SpreadsheetData, evalExpr: (src: string) => unknown, fmt: FormatOptions): { result: SpreadsheetResult; defined: [string, unknown][] } {
  const result: SpreadsheetResult = { kind: 'spreadsheet', cells: [], inputs: [], outputs: [], written: [] };
  const defined: [string, unknown][] = [];
  if (!r.sheets.length) return { result: { ...result, error: 'The spreadsheet has no sheets' }, defined };
  const wb = new Workbook(r);
  const inputAreas: { sheet: number; area: Area }[] = [];
  for (const inp of r.inputs) {
    if (!inp.expr.trim() && !inp.ref.trim()) { result.inputs.push({}); continue; }
    try {
      if (!inp.expr.trim()) throw new Error('Give the expression to write into the cells');
      const where = wb.resolve(inp.ref);
      if (!where) throw new Error(`"${inp.ref}" is not a cell, range or name of this spreadsheet`);
      const v = evalExpr(inp.expr);
      const what = isIdentifier(inp.expr.trim()) ? inp.expr.trim() : 'The value';
      const { rows, si } = toCells(v, inp.unit?.trim() ?? '', what);
      const h = rows.length, w = rows[0]?.length ?? 0;
      let { area } = where;
      const single = area.r1 === area.r2 && area.c1 === area.c2;
      // a vector into a one-row range goes across
      const across = !single && area.r1 === area.r2 && w === 1 && h === area.c2 - area.c1 + 1;
      if (single) area = { r1: area.r1, c1: area.c1, r2: area.r1 + h - 1, c2: area.c1 + w - 1 };
      else if (!across && (area.r2 - area.r1 + 1 !== h || area.c2 - area.c1 + 1 !== w)) {
        throw new Error(`The value is ${h} × ${w}, the range ${area.r2 - area.r1 + 1} × ${area.c2 - area.c1 + 1}`);
      }
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) {
        const rr = across ? area.r1 : area.r1 + i, cc = across ? area.c1 + i : area.c1 + j;
        const x = rows[i][j];
        wb.setInput(where.sheet, rr, cc, x);
        if (x !== null && !(x instanceof XlError)) result.written.push([where.sheet, cellName(rr, cc), x]);
      }
      inputAreas.push({ sheet: where.sheet, area });
      let lhs: string;
      try {
        lhs = exprTex(inp.expr.trim());
      } catch {
        lhs = `\\text{${escapeText(inp.expr.trim())}}`;
      }
      const inUnit = inp.unit?.trim() ? `\\ \\text{in}\\ ${unitStringTex(unitOf(inp.unit.trim()).formatUnits())}` : '';
      const shown = big(v) ? `\\text{${sizeText(v)}}${inUnit}` : valueTex(v, fmt, inp.unit?.trim() || undefined);
      const note = !inp.unit?.trim() && si ? `\\ (\\text{in}\\ ${unitStringTex(si)})` : '';
      result.inputs.push({ tex: `${lhs} = ${shown}\\ \\rightarrow\\ ${refTex(wb.areaLabel(where.sheet, area))}${note}`, ...(si && !inp.unit?.trim() ? { si } : {}) });
    } catch (e) {
      result.inputs.push({ error: (e as Error).message });
    }
  }
  wb.recalc();
  const outputAreas: { sheet: number; area: Area }[] = [];
  for (const out of r.outputs) {
    const name = out.name.trim();
    if (!name && !out.ref.trim()) { result.outputs.push({}); continue; }
    try {
      if (!isIdentifier(name)) throw new Error(name ? `"${name}" is not a valid variable name` : 'Give the output a variable name');
      const where = wb.resolve(out.ref);
      if (!where) throw new Error(`"${out.ref}" is not a cell, range or name of this spreadsheet`);
      outputAreas.push(where);
      const u = out.unit?.trim() ? unitOf(out.unit.trim()) : null;
      const label = wb.areaLabel(where.sheet, where.area);
      const cells = wb.areaValues(where.sheet, where.area);
      const single = cells.length === 1 && cells[0].length === 1;
      const conv = (x: Scalar, i: number, j: number): unknown => {
        const at = () => wb.label(where.sheet, where.area.r1 + i, where.area.c1 + j);
        if (x instanceof XlError) throw new Error(x.code === '#CIRC!' ? `${at()} is in a circular reference` : `${at()} is ${x.code}`);
        if (x === null) {
          if (single) throw new Error(`${at()} is empty`);
          x = 0;
        }
        if (typeof x === 'boolean') x = x ? 1 : 0;
        if (typeof x === 'string') return x;
        return u ? math.multiply(x, u) : x;
      };
      const vals = cells.map((row, i) => row.map((x, j) => conv(x, i, j)));
      let value: unknown;
      if (single) value = vals[0][0];
      else if (vals[0].length === 1) value = vec(vals.map((row) => row[0]));
      else value = math.matrix(vals as never);
      defined.push([name, value]);
      const shown = big(value) ? `\\text{${sizeText(value)}}${u ? `\\ \\text{in}\\ ${unitStringTex(u.formatUnits())}` : ''}` : valueTex(value, fmt);
      result.outputs.push({ tex: `${nameTex(name)} \\coloneqq ${refTex(label)} = ${shown}` });
    } catch (e) {
      result.outputs.push({ error: (e as Error).message });
    }
  }
  let shownCount = 0;
  result.cells = r.sheets.map((sheet, si) => {
    const show: Record<string, CellShow> = {};
    for (const { r: rr, c, v } of wb.cells(si)) {
      if (v === null || ++shownCount > SHOW_LIMIT) continue;
      const k = typeof v === 'number' ? 'n' : typeof v === 'boolean' ? 'b' : v instanceof XlError ? 'e' : 's';
      // General numbers get as many digits as the column shows (about 7 px a digit)
      const chars = Math.max(4, Math.floor(((sheet.widths?.[c] ?? COL_W) - 8) / 7));
      const s: CellShow = { t: wb.display(si, rr, c, chars), k };
      if (inputAreas.some((a) => a.sheet === si && inArea(a.area, rr, c))) s.in = 1;
      if (outputAreas.some((a) => a.sheet === si && inArea(a.area, rr, c))) s.out = 1;
      const anchor = wb.spillAnchor(si, rr, c);
      if (anchor && (anchor.r !== rr || anchor.c !== c)) s.sp = 1;
      show[cellName(rr, c)] = s;
    }
    return show;
  });
  if (shownCount > SHOW_LIMIT) result.error = `Only the first ${SHOW_LIMIT} cells are shown (the sheet has ${shownCount})`;
  if (wb.cycles.length) result.circular = wb.cycles.map((c) => c.text);
  if (wb.unknownFunctions.size) result.unknown = [...wb.unknownFunctions].sort();
  if (wb.parseErrors.size) result.parseErrors = [...wb.parseErrors].map(([c, m]) => `${c}: ${m}`);
  if (!result.error) {
    if (result.circular) result.error = `Circular reference: ${result.circular[0]}`;
    else if (result.unknown) result.error = `Not available here: ${result.unknown.join(', ')} (the cells show #NAME?)`;
    else if (result.parseErrors) result.error = `A formula cannot be read: ${result.parseErrors[0]}`;
  }
  return { result, defined };
}

/** A worksheet value in practical units, as the Results sheet of an export lists it. */
export function displayParts(v: unknown, metric: boolean, unit?: string): { value: number | string | boolean; unit: string } {
  if (isUnit(v)) {
    const p = unitParts(v, unit || undefined, metric);
    return { value: typeof p.value === 'number' ? p.value : String(p.value), unit: p.units };
  }
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return { value: v, unit: '' };
  if (isComplex(v)) return { value: v.toString(), unit: '' };
  return { value: String(v), unit: '' };
}
