import type { Dispatch } from 'react';
import type { DrawingRegion } from '../../model/types';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';

const SCALES: [string, number | undefined][] = [
  ['Automatic (largest that fits)', undefined], ['5:1', 5], ['2:1', 2], ['1:1', 1], ['1:2', 0.5], ['1:2.5', 0.4], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['1:50', 0.02], ['1:100', 0.01],
];

/** Side panel of a drawing: views, projection, sheet, scale and the title block. */
export function DrawingProps({ region, dispatch }: { region: DrawingRegion; dispatch: Dispatch<Action> }) {
  const set = (patch: Partial<DrawingRegion>, key = 'dw') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const view = (k: keyof DrawingRegion['views'], label: string) => (
    <label className="check"><input type="checkbox" checked={region.views[k]} onChange={(e) => set({ views: { ...region.views, [k]: e.target.checked } })} /> {label}</label>
  );
  return (
    <div className="props">
      <h3 className="sub">Drawing</h3>
      <div className="row2">
        <div>
          {view('front', 'Front')}
          {view('top', 'Top')}
        </div>
        <div>
          {view('side', region.projection === 'first' ? 'Left side' : 'Right side')}
          {view('iso', 'Isometric')}
        </div>
      </div>
      <label className="check"><input type="checkbox" checked={region.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Hidden lines (dashed)</label>
      <label className="check"><input type="checkbox" checked={region.dims} onChange={(e) => set({ dims: e.target.checked })} /> Overall dimensions</label>
      <div className="row2">
        <label className="field"><span>Projection</span>
          <select value={region.projection} onChange={(e) => set({ projection: e.target.value as DrawingRegion['projection'] })}>
            <option value="first">First angle (ISO)</option>
            <option value="third">Third angle (ANSI)</option>
          </select>
        </label>
        <label className="field"><span>Sheet</span>
          <select value={region.sheet} onChange={(e) => set({ sheet: e.target.value as DrawingRegion['sheet'] })}>
            <option value="A4">A4 landscape</option>
            <option value="A3">A3 landscape</option>
          </select>
        </label>
      </div>
      <label className="field"><span>Scale</span>
        <select value={String(region.scale ?? '')} onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : undefined })}>
          {SCALES.map(([l, v]) => <option key={l} value={v === undefined ? '' : String(v)}>{l}</option>)}
        </select>
      </label>
      <h3 className="sub">Title block</h3>
      <label className="field"><span>Title</span><LazyInput label="Title" mono={false} value={region.title ?? ''} placeholder="part name" onCommit={(v) => set({ title: v.trim() || undefined }, 'title')} /></label>
      <div className="row2">
        <label className="field"><span>Part no.</span><LazyInput label="Part number" mono={false} value={region.partNo ?? ''} onCommit={(v) => set({ partNo: v.trim() || undefined }, 'pn')} /></label>
        <label className="field"><span>Material</span><LazyInput label="Material" mono={false} value={region.material ?? ''} placeholder="S355, EN AW-6082 …" onCommit={(v) => set({ material: v.trim() || undefined }, 'mat')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Drawn by</span><LazyInput label="Drawn by" mono={false} value={region.drawnBy ?? ''} onCommit={(v) => set({ drawnBy: v.trim() || undefined }, 'by')} /></label>
        <label className="field"><span>Date</span><LazyInput label="Date" mono={false} value={region.date ?? ''} placeholder="today" onCommit={(v) => set({ date: v.trim() || undefined }, 'date')} /></label>
      </div>
      <p className="hint">The drawing follows the part. Select it for <b>Print</b> (true scale on {region.sheet}, or Save as PDF), <b>SVG</b> and <b>DXF</b>. Lines come from the part's mesh: curved edges are fine polylines, and only the overall sizes are dimensioned automatically.</p>
    </div>
  );
}
