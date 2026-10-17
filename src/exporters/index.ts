// Export a worksheet to Mathcad Prime (.mcdx), Mathcad 15 (.xmcd) or SMath Studio (.sm):
// evaluate it for the values that stand in for regions the other program does not have,
// plan the regions (plan.ts), then write the file.
import { evaluateWithScope } from '../engine/evaluator';
import type { Worksheet } from '../model/types';
import { makePlan, FORMAT_NAME, type Format, type Picture } from './plan';
import { writeMcdx } from './mcdx';
import { writeXmcd } from './xmcd';
import { writeSm } from './sm';

export type { Format, Picture } from './plan';
export { FORMAT_NAME } from './plan';

export const FORMAT_EXT: Record<Format, string> = { mcdx: 'mcdx', xmcd: 'xmcd', sm: 'sm' };
export const FORMAT_MIME: Record<Format, string> = {
  mcdx: 'application/vnd.mathcad.mcdx', xmcd: 'application/xml', sm: 'application/xml',
};

export interface ExportOutcome {
  bytes: Uint8Array;
  /** What did not carry over as it is: notes, pictures, values in place of regions. */
  warnings: string[];
}

export function exportWorksheet(ws: Worksheet, format: Format, pictures = new Map<string, Picture>()): ExportOutcome {
  const { variables, shown } = evaluateWithScope(ws);
  const metric = (ws.settings.unitSystem ?? 'si') === 'si';
  const plan = makePlan(ws, format, { pictures, variables, shown, metric });
  const { precision, expThreshold } = ws.settings;
  const bytes = format === 'mcdx' ? writeMcdx(plan, { precision, expThreshold })
    : format === 'xmcd' ? writeXmcd(plan)
    : writeSm(plan, { precision, expThreshold, origin: plan.origin, metric });
  return { bytes, warnings: plan.warnings };
}

/** The file name for a worksheet title. */
export function exportName(title: string, format: Format): string {
  return `${(title || 'worksheet').replace(/[\\/:*?"<>|]+/g, '_')}.${FORMAT_EXT[format]}`;
}

export const formatLabel = (f: Format) => `${FORMAT_NAME[f]} (.${FORMAT_EXT[f]})`;
