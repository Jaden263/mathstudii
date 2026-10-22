// Exchange files of a CAD part, written by the kernel worker (STEP from the exact shapes,
// the mesh formats from tessellations of them) and saved like every other export (a save
// dialog in the desktop app, a download in the browser). Used by the CAD workspace and the
// part's context menu on the worksheet.
import { strFromU8, unzipSync } from 'fflate';
import type { CadRegion } from '../../model/types';
import { designOf } from '../../cad/design';
import type { CadResult } from '../../cad/evaluate';
import { designKey, designNumbers } from '../../cad/keys';
import type { ExportFormat, ExportScope } from '../../cad/kernel/protocol';
import { exportFile } from '../../platform/files';
import { kernelRequest } from './kernelClient';

export type PartFormat = ExportFormat;

/** What each format is, for menus and dialogs. */
export const FORMATS: Record<PartFormat, { label: string; ext: string; mime: string; title: string }> = {
  step: { label: 'STEP', ext: 'step', mime: 'model/step', title: 'STEP AP214: the exact solids with names, colours and the assembly (other CAD programs)' },
  stl: { label: 'STL', ext: 'stl', mime: 'model/stl', title: 'Binary STL in millimetres (3-D printing), tessellated finely from the exact surfaces' },
  '3mf': { label: '3MF', ext: '3mf', mime: 'model/3mf', title: '3MF in millimetres with colours, an object per component placed by the build (3-D printing)' },
  obj: { label: 'OBJ', ext: 'obj', mime: 'model/obj', title: 'OBJ with an MTL file of the colours, in millimetres (renderers, game engines)' },
  glb: { label: 'glTF', ext: 'glb', mime: 'model/gltf-binary', title: 'glTF 2.0 binary (.glb): a node per occurrence, PBR colours, metres, Y up (web viewers, AR)' },
};

/** The scope a part exports by default: a single occurrence in its own coordinates, else the assembly. */
export function defaultScope(region: CadRegion): ExportScope {
  const design = designOf(region);
  const one = design.occurrences.length === 1 ? design.occurrences[0] : null;
  return one ? { kind: 'component', component: one.component } : { kind: 'assembly' };
}

/** Write the part's scope in a format and save it (OBJ as two files, the .obj and its .mtl). */
export async function exportPart(region: CadRegion, result: CadResult | undefined, format: PartFormat, scope: ExportScope = defaultScope(region)): Promise<void> {
  const dr = result?.design;
  if (!dr) throw new Error('the part has not been evaluated yet');
  const design = designOf(region);
  const name = region.name.trim() || design.components[0]?.name || 'Part';
  const numbers = designNumbers(dr);
  // an edit the worksheet has not evaluated yet: its numbers would build something else
  if (dr.display && designKey(design, numbers) !== dr.display) throw new Error('the part is still being evaluated — try again in a moment');
  const data = await kernelRequest({ op: 'export', design, numbers, format, scope, unit: region.unit, name });
  const file = (region.name.trim() || 'part').replace(/[^\w.-]+/g, '_');
  const f = FORMATS[format];
  if (format !== 'obj') return exportFile(`${file}.${f.ext}`, data, f.mime);
  // the kernel hands back the .obj and the .mtl it names, zipped: saved as the two files
  const files = unzipSync(data);
  const obj = Object.keys(files).find((k) => k.endsWith('.obj'))!, mtl = Object.keys(files).find((k) => k.endsWith('.mtl'))!;
  await exportFile(`${file}.obj`, strFromU8(files[obj]).replace(`mtllib ${mtl}`, `mtllib ${file}.mtl`), f.mime);
  await exportFile(`${file}.mtl`, strFromU8(files[mtl]), 'model/mtl');
}
