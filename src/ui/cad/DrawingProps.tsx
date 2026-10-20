import { useState, type Dispatch } from 'react';
import { ArrowLeftRight, Plus, Trash2 } from 'lucide-react';
import type { DrawingRegion } from '../../model/types';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';
import { sheetSize, SHEET_SIZES, type SheetName } from '../../cad/drawingSheet';
import { scaleText } from '../../cad/drawing';
import { fmtMass, type TitleFields } from '../../cad/annotations';
import { AnnotationProps } from './AnnotationProps';
import { useDrawingState } from './drawingState';

const SCALES: [string, number | undefined][] = [
  ['Automatic (largest that fits)', undefined], ['5:1', 5], ['2:1', 2], ['1:1', 1], ['1:2', 0.5], ['1:2.5', 0.4], ['1:5', 0.2], ['1:10', 0.1], ['1:20', 0.05], ['1:50', 0.02], ['1:100', 0.01],
];
const DETAIL_SCALES = [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1];

/** Side panel of a drawing: views, projection, sheet, scale, sections and details, annotations, the title block, revisions and the parts list. */
export function DrawingProps({ region, dispatch }: { region: DrawingRegion; dispatch: Dispatch<Action> }) {
  const set = (patch: Partial<DrawingRegion>, key = 'dw') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const { live } = useDrawingState(region.id);
  const tb = region.titleBlock ?? {};
  const setTb = (patch: Partial<TitleFields>, key: string) => {
    const next: TitleFields = { ...tb, ...patch };
    for (const k of Object.keys(next) as (keyof TitleFields)[]) if (next[k] === undefined || next[k] === '') delete next[k];
    set({ titleBlock: Object.keys(next).length ? next : undefined }, key);
  };
  const revs = region.revisions ?? [];
  const setRev = (i: number, patch: Partial<NonNullable<DrawingRegion['revisions']>[number]>) => set({ revisions: revs.map((r, k) => (k === i ? { ...r, ...patch } : r)) }, `rev${i}`);
  const [balloonView, setBalloonView] = useState('');
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
      <label className="check" title="The flat blank of the part's sheet-metal body, with its bend lines (dashed, layer BEND in the DXF) and bend notes">
        <input type="checkbox" checked={!!region.flat} onChange={(e) => set({ flat: e.target.checked ? {} : undefined })} /> Flat pattern (sheet metal)
      </label>
      <label className="check"><input type="checkbox" checked={region.hidden} onChange={(e) => set({ hidden: e.target.checked })} /> Hidden lines (dashed)</label>
      <label className="check"><input type="checkbox" checked={region.tangent !== false} onChange={(e) => set({ tangent: e.target.checked ? undefined : false })} /> Tangent edges (narrow)</label>
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
      <AnnotationProps region={region} dispatch={dispatch} />
      <h3 className="sub">Title block (ISO 7200)</h3>
      <label className="field"><span>Title</span><LazyInput label="Title" mono={false} value={region.title ?? ''} placeholder="part name" onCommit={(v) => set({ title: v.trim() || undefined }, 'title')} /></label>
      <div className="row2">
        <label className="field"><span>Drawing no.</span><LazyInput label="Drawing number" mono={false} value={region.partNo ?? ''} onCommit={(v) => set({ partNo: v.trim() || undefined }, 'pn')} /></label>
        <label className="field"><span>Revision</span><LazyInput label="Revision" mono={false} value={tb.revision ?? ''} placeholder={revs.at(-1)?.rev ?? '—'} onCommit={(v) => setTb({ revision: v.trim() || undefined }, 'tbrev')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Material</span><LazyInput label="Material" mono={false} value={region.material ?? ''} placeholder="from the density" onCommit={(v) => set({ material: v.trim() || undefined }, 'mat')} /></label>
        <label className="field"><span>Mass</span><LazyInput label="Mass" mono={false} value={tb.mass ?? ''} placeholder="from the part" onCommit={(v) => setTb({ mass: v.trim() || undefined }, 'tbmass')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Created by</span><LazyInput label="Created by" mono={false} value={region.drawnBy ?? ''} onCommit={(v) => set({ drawnBy: v.trim() || undefined }, 'by')} /></label>
        <label className="field"><span>Date of issue</span><LazyInput label="Date" mono={false} value={region.date ?? ''} placeholder="today" onCommit={(v) => set({ date: v.trim() || undefined }, 'date')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Checked by</span><LazyInput label="Checked by" mono={false} value={tb.checkedBy ?? ''} onCommit={(v) => setTb({ checkedBy: v.trim() || undefined }, 'tbchk')} /></label>
        <label className="field"><span>Approved by</span><LazyInput label="Approved by" mono={false} value={tb.approvedBy ?? ''} onCommit={(v) => setTb({ approvedBy: v.trim() || undefined }, 'tbapp')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Legal owner</span><LazyInput label="Legal owner" mono={false} value={tb.owner ?? ''} onCommit={(v) => setTb({ owner: v.trim() || undefined }, 'tbown')} /></label>
        <label className="field"><span>Document type</span><LazyInput label="Document type" mono={false} value={tb.docType ?? ''} placeholder={live?.assembly ? 'Assembly drawing' : 'Detail drawing'} onCommit={(v) => setTb({ docType: v.trim() || undefined }, 'tbdoc')} /></label>
      </div>
      <div className="row2">
        <label className="field"><span>Sheet</span><input type="number" min={1} value={tb.sheet ?? 1} onChange={(e) => setTb({ sheet: Math.max(1, Math.round(Number(e.target.value) || 1)) }, 'tbsheet')} /></label>
        <label className="field"><span>of</span><input type="number" min={1} value={tb.sheets ?? tb.sheet ?? 1} onChange={(e) => setTb({ sheets: Math.max(1, Math.round(Number(e.target.value) || 1)) }, 'tbsheets')} /></label>
      </div>
      <h3 className="sub">Revisions ({revs.length})</h3>
      <label className="check"><input type="checkbox" checked={!!tb.revisions} onChange={(e) => setTb({ revisions: e.target.checked || undefined }, 'tbrevs')} /> Revision table on the sheet</label>
      {revs.map((r, i) => (
        <div key={i} className="dw-rev">
          <div className="row2">
            <label className="field"><span>Rev.</span><LazyInput label="Revision index" value={r.rev} onCommit={(v) => setRev(i, { rev: v.trim() })} /></label>
            <label className="field"><span>Date</span><LazyInput label="Revision date" mono={false} value={r.date} onCommit={(v) => setRev(i, { date: v.trim() })} /></label>
          </div>
          <div className="row2">
            <label className="field"><span>Change</span><LazyInput label="Revision description" mono={false} value={r.text} onCommit={(v) => setRev(i, { text: v.trim() })} /></label>
            <label className="field"><span>By</span>
              <span className="dw-rev-by">
                <LazyInput label="Revised by" mono={false} value={r.by} onCommit={(v) => setRev(i, { by: v.trim() })} />
                <button className="icon-btn" title="Delete the revision" aria-label="Delete revision" onClick={() => set({ revisions: revs.filter((_, k) => k !== i) })}><Trash2 size={13} /></button>
              </span>
            </label>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => set({ revisions: [...revs, { rev: String.fromCharCode(65 + Math.min(25, revs.length)), text: '', date: new Date().toISOString().slice(0, 10), by: region.drawnBy ?? '' }] })}><Plus size={13} /> Add a revision</button>
      <h3 className="sub">Parts list (ISO 7573)</h3>
      <label className="check"><input type="checkbox" checked={!!region.bom?.show} onChange={(e) => set({ bom: { ...region.bom, show: e.target.checked } })} /> Parts list above the title block</label>
      {(live?.bom ?? []).length > 0 && (
        <table className="dw-bom">
          <thead><tr><th>Item</th><th>Qty</th><th>Name</th><th>Material</th><th>kg</th></tr></thead>
          <tbody>
            {live!.bom.map((row) => (
              <tr key={row.component}>
                <td>{row.item}</td>
                <td>{row.qty}</td>
                <td><LazyInput label={`Name of item ${row.item}`} mono={false} value={region.bom?.rows?.[row.component]?.name ?? ''} placeholder={row.name} onCommit={(v) => set({ bom: { show: !!region.bom?.show, rows: { ...region.bom?.rows, [row.component]: { ...region.bom?.rows?.[row.component], name: v.trim() || undefined } } } })} /></td>
                <td><LazyInput label={`Material of item ${row.item}`} mono={false} value={region.bom?.rows?.[row.component]?.material ?? ''} placeholder={row.material || 'material'} onCommit={(v) => set({ bom: { show: !!region.bom?.show, rows: { ...region.bom?.rows, [row.component]: { ...region.bom?.rows?.[row.component], material: v.trim() || undefined } } } })} /></td>
                <td>{fmtMass(row.mass)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {live?.balloons && (live.bom.length ?? 0) > 0 && (
        <div className="row2">
          <label className="field"><span>Balloons on</span>
            <select value={balloonView || live.views[0]?.key || ''} onChange={(e) => setBalloonView(e.target.value)}>
              {live.views.map((v) => <option key={v.key} value={v.key}>{v.name}</option>)}
            </select>
          </label>
          <button className="btn" title="A balloon with its item number for every part in that view that has none yet (ISO 6433)" onClick={() => {
            const add = live.balloons!(balloonView || live.views[0]?.key || '');
            if (add.length) set({ annotations: [...(region.annotations ?? []), ...add] });
          }}>Add balloons</button>
        </div>
      )}
      <p className="hint">
        The drawing follows the part, its dimensions with it: a dimension whose edge is gone turns orange and says why.
        Select the drawing for <b>Section</b> and <b>Detail</b> views and the annotation tools; drag annotations and section or detail views to move them.
        <b> Print</b> gives true scale on {region.sheet}; <b>SVG</b> and <b>DXF</b> export in paper millimetres.
      </p>
    </div>
  );
}
