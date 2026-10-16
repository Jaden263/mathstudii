// Exporting a worksheet to .xlsx needs its values, which live in the calculation worker:
// the page asks the worker, which evaluates once more and answers with the file's bytes.
import { evaluateWithScope } from '../engine/evaluator';
import type { Worksheet } from '../model/types';
import { worksheetBook } from './exportWorksheet';
import { writeXlsx } from './xlsx';

export interface ExportRequest {
  xlsxExport: number;
  ws: Worksheet;
}

export interface ExportResponse {
  xlsxExport: number;
  bytes?: Uint8Array;
  error?: string;
}

export const isExportRequest = (d: unknown): d is ExportRequest => !!d && typeof d === 'object' && 'xlsxExport' in d && 'ws' in d;
export const isExportResponse = (d: unknown): d is ExportResponse => !!d && typeof d === 'object' && 'xlsxExport' in d && !('ws' in d);

/** The worksheet as an .xlsx file (Results, Vectors, matrices, tables, spreadsheets). */
export function exportWorksheetXlsx(ws: Worksheet): Uint8Array {
  const { results, variables, fmt } = evaluateWithScope(ws);
  return writeXlsx(worksheetBook(ws, variables, results, fmt));
}

export function answerExport(req: ExportRequest): ExportResponse {
  try {
    return { xlsxExport: req.xlsxExport, bytes: exportWorksheetXlsx(req.ws) };
  } catch (e) {
    return { xlsxExport: req.xlsxExport, error: (e as Error).message ?? String(e) };
  }
}
