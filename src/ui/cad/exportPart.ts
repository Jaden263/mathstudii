// STEP and STL files of a CAD part, written by the kernel worker from the exact shapes
// and saved like every other export (a save dialog in the desktop app, a download in the
// browser). Used by the CAD workspace and the part's context menu on the worksheet.
import type { CadRegion } from '../../model/types';
import { designOf } from '../../cad/design';
import type { CadResult } from '../../cad/evaluate';
import { designKey, designNumbers } from '../../cad/keys';
import type { ExportScope } from '../../cad/kernel/protocol';
import { exportFile } from '../../platform/files';
import { kernelRequest } from './kernelClient';

export type PartFormat = 'step' | 'stl';

/** Write the part (a single occurrence in its own coordinates, else the assembly) and save it. */
export async function exportPart(region: CadRegion, result: CadResult | undefined, format: PartFormat): Promise<void> {
  const dr = result?.design;
  if (!dr) throw new Error('the part has not been evaluated yet');
  const design = designOf(region);
  const one = design.occurrences.length === 1 ? design.occurrences[0] : null;
  const scope: ExportScope = one ? { kind: 'component', component: one.component } : { kind: 'assembly' };
  const name = region.name.trim() || design.components[0]?.name || 'Part';
  const numbers = designNumbers(dr);
  // an edit the worksheet has not evaluated yet: its numbers would build something else
  if (dr.display && designKey(design, numbers) !== dr.display) throw new Error('the part is still being evaluated — try again in a moment');
  const data = await kernelRequest({ op: 'export', design, numbers, format, scope, unit: region.unit, name });
  const file = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
  await exportFile(`${file}.${format}`, data, format === 'step' ? 'model/step' : 'model/stl');
}
