// Exporting to Mathcad or SMath needs the worksheet's values, which live in the calculation
// worker: the page sends the worksheet and the pictures it drew of the regions only mathstudii
// has; the worker evaluates once more and answers with the file's bytes and what changed.
import type { Worksheet } from '../model/types';
import { exportWorksheet, type Format, type Picture } from './index';

export interface WorksheetExportRequest {
  worksheetExport: number;
  ws: Worksheet;
  format: Format;
  pictures: [string, Picture][];
}

export interface WorksheetExportResponse {
  worksheetExport: number;
  bytes?: Uint8Array;
  warnings?: string[];
  error?: string;
}

export const isWorksheetExportRequest = (d: unknown): d is WorksheetExportRequest => !!d && typeof d === 'object' && 'worksheetExport' in d && 'ws' in d;
export const isWorksheetExportResponse = (d: unknown): d is WorksheetExportResponse => !!d && typeof d === 'object' && 'worksheetExport' in d && !('ws' in d);

export function answerWorksheetExport(req: WorksheetExportRequest): WorksheetExportResponse {
  try {
    const { bytes, warnings } = exportWorksheet(req.ws, req.format, new Map(req.pictures));
    return { worksheetExport: req.worksheetExport, bytes, warnings };
  } catch (e) {
    return { worksheetExport: req.worksheetExport, error: (e as Error).message ?? String(e) };
  }
}
