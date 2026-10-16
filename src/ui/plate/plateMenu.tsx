// Right-click entries of a plate region: results as a table for Excel, the section cut,
// presets.
import type { Dispatch } from 'react';
import { Copy, LayoutTemplate, Scissors } from 'lucide-react';
import type { PlateRegion } from '../../model/types';
import type { PlateResult } from '../../plate/evaluate';
import { platePreset, type PlatePreset } from '../../plate/model';
import { toTsv } from '../../model/tableData';
import { STEEL_GRADES } from '../../engine/materials';
import type { Action } from '../store';
import type { MenuItem } from '../ContextMenu';
import { FORCE_N, LENGTH_M } from '../beam/beamDraw';
import { displayUnit, FIELDS, fieldOf } from './plateDraw';

/** Reactions and the extremes of every field shown, as one tab-separated block (region units). */
export function plateResultsTsv(r: PlateRegion, res: PlateResult): string | null {
  if (!res.fields || !res.reactions) return null;
  const F = FORCE_N[r.forceUnit] ?? 1e3, L = LENGTH_M[r.lengthUnit] ?? 1;
  const v = (x?: number, per = F) => (x === undefined || !Number.isFinite(x) ? '' : String(+(x / per).toPrecision(6)));
  const rows: string[][] = [['Support', `R [${r.forceUnit}]`, `r max [${r.forceUnit}/${r.lengthUnit}]`, 'r min', 'at start', 'at end']];
  for (const q of res.reactions) {
    const inner = q.r?.slice(1, -1).filter(Number.isFinite) ?? [];
    rows.push([q.name, v(q.R), inner.length ? v(Math.max(...inner), F / L) : '', inner.length ? v(Math.min(...(q.rmin?.slice(1, -1) ?? inner)), F / L) : '', v(q.ends?.[0]), v(q.ends?.[1])]);
  }
  rows.push([]);
  rows.push(['Field', 'max', 'min', 'unit']);
  for (const fi of FIELDS) {
    if (!res.fields[fi.key]) continue;
    const du = displayUnit(r, fi.kind), hi = fieldOf(res, fi.key, 'max')!, lo = fieldOf(res, fi.key, 'min')!;
    let mx = -Infinity, mn = Infinity;
    for (let i = 0; i < hi.length; i++) mx = Math.max(mx, hi[i]);
    for (let i = 0; i < lo.length; i++) mn = Math.min(mn, lo[i]);
    rows.push([fi.label, String(+(mx * du.k).toPrecision(6)), String(+(mn * du.k).toPrecision(6)), du.unit]);
  }
  return toTsv(rows);
}

export function plateMenuItems(r: PlateRegion, res: PlateResult | undefined, dispatch: Dispatch<Action>, toast: (s: string) => void): MenuItem[] {
  const set = (patch: Partial<PlateRegion>) => dispatch({ type: 'update', id: r.id, patch });
  const tsv = res ? plateResultsTsv(r, res) : null;
  const preset = (kind: PlatePreset) => () => {
    if (r.outline.length && !window.confirm('Replace the plate with the preset?')) return;
    const { loadCases, thickness, material, ...data } = platePreset(kind, { length: r.lengthUnit, force: r.forceUnit });
    // (a steel plate has no reinforcement, as the side panel's presets do it)
    set({ ...data, loadCases, thickness: thickness ?? r.thickness, material: material ?? r.material, rebar: STEEL_GRADES.includes(material ?? '') ? undefined : r.rebar, view: undefined, cut: undefined });
  };
  return [
    {
      label: 'Copy results as a table (Excel)', icon: <Copy size={14} />, disabled: !tsv,
      onClick: () => { if (tsv) { void navigator.clipboard?.writeText(tsv); toast('Reactions and extremes copied'); } },
    },
    ...(r.cut ? [{ label: 'Remove the section cut', icon: <Scissors size={14} />, onClick: () => set({ cut: undefined }) }] : []),
    {
      label: 'Start from a preset', icon: <LayoutTemplate size={14} />,
      submenu: [
        { label: 'Slab on walls', onClick: preset('simple') },
        { label: 'Flat slab', onClick: preset('flat') },
        { label: 'Circular slab', onClick: preset('circle') },
        { label: 'L-shaped slab', onClick: preset('lshape') },
        { label: 'Steel plate', onClick: preset('steel') },
      ],
    },
  ];
}
