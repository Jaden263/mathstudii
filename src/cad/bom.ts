// The assembly's bill of materials as the workspace's browser lists it and copies it:
// the parts list's rows (annotations.ts: one per component, repeated occurrences counted)
// with each one's total mass, as tab-separated text the worksheet pastes as a table, or
// as CSV.
import { bomMass, bomRows, fmtMass, type BomRow } from './annotations';
import type { CadDesign } from './design';
import { toCsv, toTsv } from '../model/tableData';

export interface BomTable {
  rows: BomRow[];
  /** Mass of everything listed (kg), when every component has one. */
  total?: number;
}

/** The rows of a design, masses from the components' (kg each). */
export function bomTable(design: CadDesign, masses: Record<string, number | undefined>, density?: string): BomTable {
  const rows = bomRows(design, { masses, density });
  const total = bomMass(rows);
  return { rows, ...(total !== undefined ? { total } : {}) };
}

const HEAD = ['Item', 'Component', 'Qty', 'Material', 'Mass each', 'Mass'];
const UNITS = ['', '', '', '', 'kg', 'kg'];

function cells(t: BomTable): string[][] {
  return t.rows.map((r) => [String(r.item), r.name, String(r.qty), r.material, fmtMass(r.mass), r.mass !== undefined ? fmtMass(r.mass * r.qty) : '']);
}

/** Tab-separated, the header row with units in brackets: pasted into the worksheet it becomes a table. */
export function bomTsv(t: BomTable): string {
  return toTsv([HEAD.map((h, i) => (UNITS[i] ? `${h} [${UNITS[i]}]` : h)), ...cells(t)]);
}

export function bomCsv(t: BomTable): string {
  return toCsv(HEAD, UNITS, cells(t));
}
