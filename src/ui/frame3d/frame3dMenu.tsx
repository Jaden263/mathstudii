// Right-click entries of a 3-D frame region: the named views, results as tables for
// Excel, presets.
import type { Dispatch } from 'react';
import { Copy, Eye, LayoutTemplate } from 'lucide-react';
import type { Frame3DRegion } from '../../model/types';
import type { Frame3DResult } from '../../frame3d/evaluate';
import { memberExtremes, FORCES } from '../../frame3d/solve';
import { framePreset, type Frame3DPreset } from '../../frame3d/model';
import { toTsv } from '../../model/tableData';
import type { Action } from '../store';
import type { MenuItem } from '../ContextMenu';
import { FORCE_N, LENGTH_M } from '../beam/beamDraw';
import { VIEWS } from './frame3dDraw';

/** Reactions and member extremes of what is shown, as one tab-separated block (region units, mm). */
export function frame3dResultsTsv(r: Frame3DRegion, res: Frame3DResult): string | null {
  const sol = res.solution;
  if (!sol) return null;
  const F = FORCE_N[r.forceUnit] ?? 1e3, L = LENGTH_M[r.lengthUnit] ?? 1;
  const name = new Map([...r.nodes, ...r.members].map((q) => [q.id, q.name]));
  const num = (v: number) => String(+v.toPrecision(6));
  const rows: string[][] = [['Node', `Rx [${r.forceUnit}]`, 'Ry', 'Rz', `Mx [${r.forceUnit}·${r.lengthUnit}]`, 'My', 'Mz']];
  for (const q of sol.reactions) rows.push([name.get(q.node) ?? '?', ...q.F.map((v) => num(v / F)), ...q.M.map((v) => num(v / (F * L)))]);
  rows.push([]);
  rows.push(['Member', ...FORCES.flatMap((k) => [`${k} max`, `${k} min`])]);
  for (const mr of sol.members) {
    const ex = memberExtremes(mr);
    rows.push([name.get(mr.id) ?? '?', ...FORCES.flatMap((k) => {
      const per = k === 'N' || k === 'Vy' || k === 'Vz' ? F : F * L;
      return [num(ex[k].max / per), num(ex[k].min / per)];
    })]);
  }
  return toTsv(rows);
}

export function frame3dMenuItems(r: Frame3DRegion, res: Frame3DResult | undefined, dispatch: Dispatch<Action>, toast: (s: string) => void): MenuItem[] {
  const set = (patch: Partial<Frame3DRegion>) => dispatch({ type: 'update', id: r.id, patch });
  const tsv = res ? frame3dResultsTsv(r, res) : null;
  const preset = (kind: Frame3DPreset) => () => {
    if (r.members.length && !window.confirm('Replace the frame with the preset?')) return;
    const { loadCases, ...data } = framePreset(kind, { length: r.lengthUnit, force: r.forceUnit });
    set({ ...data, loadCases });
  };
  return [
    {
      label: 'View', icon: <Eye size={14} />,
      submenu: [
        ...VIEWS.map((v): MenuItem => ({ label: v.label, onClick: () => dispatch({ type: 'update', id: r.id, patch: { camera: { ...r.camera, yaw: v.yaw, pitch: v.pitch, zoom: 1, panX: 0, panY: 0 } }, history: false }) })),
      ],
    },
    {
      label: 'Copy results as a table (Excel)', icon: <Copy size={14} />, disabled: !tsv,
      onClick: () => { if (tsv) { void navigator.clipboard?.writeText(tsv); toast('Reactions and member extremes copied'); } },
    },
    {
      label: 'Start from a preset', icon: <LayoutTemplate size={14} />,
      submenu: [
        { label: '3-D portal frame', onClick: preset('portal') },
        { label: 'Space truss tower', onClick: preset('truss') },
        { label: 'Grillage', onClick: preset('grillage') },
      ],
    },
  ];
}
