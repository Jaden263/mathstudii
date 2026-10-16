// Right-click entries of a 3-D frame region: the named views, results as tables for
// Excel, presets.
import type { Dispatch } from 'react';
import { Copy, Eye, LayoutTemplate } from 'lucide-react';
import type { Frame3DRegion } from '../../model/types';
import type { Frame3DResult } from '../../frame3d/evaluate';
import { boundExtremes, FORCES, type Reaction3 } from '../../frame3d/solve';
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
  // round-off next to the largest value of its kind (SI) reads as 0 (the solve leaves about
  // 1e-8 of it in quantities that vanish by symmetry; six digits show nothing that small)
  const tidy = (values: number[]) => {
    const big = Math.max(0, ...values.map(Math.abs));
    return (v: number, per: number) => String(Math.abs(v) < 1e-7 * big ? 0 : +(v / per).toPrecision(6));
  };
  // the envelope: maxima from its upper side, minima from its lower one (a row each)
  const low = res.lower;
  const rf = tidy(sol.reactions.flatMap((q) => q.F)), rm = tidy(sol.reactions.flatMap((q) => q.M));
  const rows: string[][] = [['Node', `Rx [${r.forceUnit}]`, 'Ry', 'Rz', `Mx [${r.forceUnit}·${r.lengthUnit}]`, 'My', 'Mz']];
  const reaction = (q: Reaction3, tag: string) => rows.push([`${name.get(q.node) ?? '?'}${tag}`, ...q.F.map((v) => rf(v, F)), ...q.M.map((v) => rm(v, F * L))]);
  for (const q of sol.reactions) {
    const lo = low?.reactions.find((x) => x.id === q.id);
    reaction(q, lo ? ' max' : '');
    if (lo) reaction(lo, ' min');
  }
  rows.push([]);
  rows.push(['Member', ...FORCES.flatMap((k) => [`${k} max`, `${k} min`])]);
  const ex = sol.members.map((mr) => boundExtremes(mr, low?.members.find((q) => q.id === mr.id)));
  const mf = tidy(ex.flatMap((e) => [e.N, e.Vy, e.Vz].flatMap((x) => [x.max, x.min]))), mm = tidy(ex.flatMap((e) => [e.T, e.My, e.Mz].flatMap((x) => [x.max, x.min])));
  sol.members.forEach((mr, i) => {
    rows.push([name.get(mr.id) ?? '?', ...FORCES.flatMap((k) => {
      const force = k === 'N' || k === 'Vy' || k === 'Vz', f = force ? mf : mm, per = force ? F : F * L;
      return [f(ex[i][k].max, per), f(ex[i][k].min, per)];
    })]);
  });
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
