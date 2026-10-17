import type { Dispatch } from 'react';
import { ArrowLeftRight, Trash2 } from 'lucide-react';
import type { DrawingRegion } from '../../model/types';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';
import { sheetSize, SHEET_SIZES, type SheetName } from '../../cad/drawingSheet';
import { scaleText } from '../../cad/drawing';

const SCALES: [string, number | undefined][] = [
  ['Automatic (largest that fits)', undefined], ['5:1', 5], ['2:1', 2], ['1:1', 1], ['1:2', 0.5], ['1:2.5', 0.4], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['1:50', 0.02], ['1:100', 0.01],
];
const DETAIL_SCALES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1];

/** Side panel of a drawing: views, projection, sheet, scale, sections and details, and the title block. */
export function DrawingProps({ region, dispatch }: { region: DrawingRegion; dispatch: Dispatch<Action> }) {
  const set = (patch: Partial<DrawingRegion>, key = 'dw') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const view = (k: keyof DrawingRegion['views'], label: string) => (
    <label className="check"><input type="checkbox" checked={region.views[k]} onChange={(e) => set({ views: { ...region.views, [k]: e.target.checked } })} /> {label}</label>
  );
  // the region keeps the sheet's proportions
  const sheet = (patch: Partial<DrawingRegion>) => {
    const [W, H] = sheetSize({ ...region, ...patch });
    set({ ...patch, height: Math.round((region.width * H) / W) });
  };
  const centres = (key: string) => !region.noCentres?.includes(key);
  const setCentres = (key: string, on: boolean) => set({ noCentres: on ? (region.noCentres ?? []).filter((k) => k !== key) : [...(region.noCentres ?? []), key] });
  const sections = region.sections ?? [], details = region.details ?? [];
  const viewName = (k: string) => k === 'front' ? 'front' : k === 'top' ? 'top' : k === 'side' ? 'side' : k === 'iso' ? 'isometric'
    : `section ${sections.find((s) => `sec:${s.id}` === k)?.letter ?? '?'}`;
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
      <label className="check"><input type="checkbox" checked={region.tangent !== false} onChange={(e) => set({ tangent: e.target.checked ? undefined : false })} /> Tangent edges (narrow)</label>
      <label className="check"><input type="checkbox" checked={region.dims} onChange={(e) => set({ dims: e.target.checked })} /> Overall dimensions</label>
      <div className="row2">
        <label className="field"><span>Projection</span>
          <select value={region.projection} onChange={(e) => set({ projection: e.target.value as DrawingRegion['projection'] })}>
            <option value="first">First angle (ISO)</option>
            <option value="third">Third angle (ANSI)</option>
          </select>
        </label>
        <label className="field"><span>Sheet</span>
          <select value={`${region.sheet}${region.portrait ? 'p' : ''}`} onChange={(e) => sheet({ sheet: e.target.value.slice(0, 2) as SheetName, portrait: e.target.value.endsWith('p') || undefined })}>
            {(Object.keys(SHEET_SIZES) as SheetName[]).slice().reverse().flatMap((s) => [
              <option key={s} value={s}>{s} landscape</option>,
              <option key={`${s}p`} value={`${s}p`}>{s} portrait</option>,
            ])}
          </select>
        </label>
      </div>
      <label className="field"><span>Scale</span>
        <select value={String(region.scale ?? '')} onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : undefined })}>
          {SCALES.map(([l, v]) => <option key={l} value={v === undefined ? '' : String(v)}>{l}</option>)}
        </select>
      </label>
      <h3 className="sub">Centre marks and lines</h3>
      <div className="row2">
        {(['front', 'top', 'side'] as const).filter((k) => region.views[k]).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={centres(k)} onChange={(e) => setCentres(k, e.target.checked)} /> {k === 'side' ? 'Side' : k[0].toUpperCase() + k.slice(1)}</label>
        ))}
        {sections.map((s) => (
          <label key={s.id} className="check"><input type="checkbox" checked={centres(`sec:${s.id}`)} onChange={(e) => setCentres(`sec:${s.id}`, e.target.checked)} /> {s.letter}–{s.letter}</label>
        ))}
        {details.map((d) => (
          <label key={d.id} className="check"><input type="checkbox" checked={centres(`det:${d.id}`)} onChange={(e) => setCentres(`det:${d.id}`, e.target.checked)} /> Detail {d.letter}</label>
        ))}
      </div>
      <h3 className="sub">Sections ({sections.length})</h3>
      {sections.length ? (
        <ul className="cad-clist">
          {sections.map((s) => (
            <li key={s.id}>
              <span className="dw-item">{s.letter}–{s.letter} <small>on the {viewName(s.view)} view</small></span>
              <span>
                <button className="icon-btn" title="Look the other way" aria-label="Flip the direction of view" onClick={() => set({ sections: sections.map((q) => (q.id === s.id ? { ...q, flip: !q.flip || undefined } : q)) })}><ArrowLeftRight size={13} /></button>
                <button className="icon-btn" title="Delete the section view" aria-label="Delete section" onClick={() => set({ sections: sections.filter((q) => q.id !== s.id), details: details.filter((d) => d.view !== `sec:${s.id}`) })}><Trash2 size={13} /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="hint">Select the drawing and press <b>Section</b>, then click the two ends of the cutting line on a view.</p>}
      <h3 className="sub">Details ({details.length})</h3>
      {details.length ? (
        <ul className="cad-clist">
          {details.map((d) => (
            <li key={d.id}>
              <span className="dw-item">{d.letter} <small>of the {viewName(d.view)} view</small></span>
              <span>
                <select aria-label="Detail scale" value={String(d.scale)} onChange={(e) => set({ details: details.map((q) => (q.id === d.id ? { ...q, scale: Number(e.target.value) } : q)) })}>
                  {[...new Set([...DETAIL_SCALES, d.scale])].sort((a, b) => b - a).map((v) => <option key={v} value={String(v)}>{scaleText(v)}</option>)}
                </select>
                <button className="icon-btn" title="Delete the detail view" aria-label="Delete detail" onClick={() => set({ details: details.filter((q) => q.id !== d.id) })}><Trash2 size={13} /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="hint">Press <b>Detail</b>, click the centre on a view and then the size of the circle.</p>}
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
      <p className="hint">
        The drawing follows the part. Lines come from OpenCascade's exact hidden-line removal: circles, arcs and ellipses stay exact.
        Select the drawing for <b>Section</b> (draw a cutting line across a view) and <b>Detail</b> (a circle to enlarge); drag those views to move them.
        <b> Print</b> gives true scale on {region.sheet}; <b>SVG</b> and <b>DXF</b> export in paper millimetres.
      </p>
    </div>
  );
}
