// The drawing's annotations in the side panel: the list (a lost one flagged, with why),
// the selected one's settings (a dimension's kind, decimals, tolerance or ISO 286 fit with
// its deviations, a note's text, a frame's characteristic, tolerance, modifier and datums,
// a datum's letter, a surface symbol's requirement), and turning the automatic dimensions
// into ones of the drawing's own.
import { useEffect, useRef, type Dispatch } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react';
import type { DrawingRegion } from '../../model/types';
import { newId } from '../../model/types';
import type { Action } from '../store';
import { LazyInput } from '../sketch/SketchProps';
import { fitKind, fitDeviations, parseFit } from '../../cad/fits';
import { GDT_CHARS, GDT_INFO, MM, devDecimals, fmtDev, type Annotation, type DimAnnotation, type GdtAnnotation, type Lay, type SurfaceAnnotation, type Tolerance } from '../../cad/annotations';
import { annotationName } from '../../cad/annotationTools';
import { selectAnnotation, takeFocus, useDrawingState } from './drawingState';

const LAYS: Lay[] = ['=', '⊥', 'X', 'M', 'C', 'R', 'P'];
const LAY_NAMES: Record<Lay, string> = { '=': '= parallel', '⊥': '⊥ perpendicular', X: 'X crossed', M: 'M multi-directional', C: 'C circular', R: 'R radial', P: 'P particulate' };

/** A number field that commits on Enter or leaving it. */
function Num({ value, onCommit, label, placeholder }: { value: number | undefined; onCommit: (v: number | undefined) => void; label: string; placeholder?: string }) {
  return (
    <LazyInput
      label={label} placeholder={placeholder} value={value === undefined || !Number.isFinite(value) ? '' : String(value)}
      onCommit={(v) => {
        const n = Number(v.replace(',', '.').replace('−', '-'));
        onCommit(v.trim() === '' || !Number.isFinite(n) ? undefined : n);
      }}
    />
  );
}

export function AnnotationProps({ region, dispatch }: { region: DrawingRegion; dispatch: Dispatch<Action> }) {
  const { selected, live } = useDrawingState(region.id);
  const list = region.annotations ?? [];
  const placed = new Map((live?.placed ?? []).map((p) => [p.id, p]));
  const set = (patch: Partial<DrawingRegion>, key = 'ann') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const update = (id: string, patch: Partial<Annotation>) => set({ annotations: list.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)) }, `ann:${id}`);
  const remove = (id: string) => {
    set({ annotations: list.filter((a) => a.id !== id && !((a.kind === 'gdt' || a.kind === 'datum') && a.dim === id)) });
    if (selected === id) selectAnnotation(region.id, null);
  };
  const auto = live?.auto ?? [];
  const sel = list.find((a) => a.id === selected);
  const autoSel = !sel && selected ? auto.find((a) => a.id === selected) : undefined;
  // the automatic dimensions become the drawing's own (new names), and stop being made
  const makeOwn = () => {
    const ids = new Map(auto.map((a) => [a.id, newId()]));
    set({ annotations: [...list, ...auto.map((a) => ({ ...a, id: ids.get(a.id)! }))], dims: false });
  };
  const lostCount = list.filter((a) => placed.get(a.id)?.lost).length;
  return (
    <>
      <h3 className="sub">Annotations ({list.length}){lostCount ? <span className="dw-lost-mark" title="Annotations whose geometry is gone"> · {lostCount} lost</span> : null}</h3>
      <div className="row2">
        <label className="field"><span>Decimals</span>
          <select value={region.decimals ?? ''} onChange={(e) => set({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })}>
            <option value="">As needed (up to {live?.unit === 'mm' || !live ? 2 : 3})</option>
            {[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="check" title="Overall sizes, hole callouts and sizes, and where the holes are, made from the model each time it changes">
          <input type="checkbox" checked={region.dims} onChange={(e) => set({ dims: e.target.checked })} /> Automatic dimensions
        </label>
      </div>
      {region.dims && auto.length > 0 && (
        <button className="btn" onClick={makeOwn} title="Keep the automatic dimensions as the drawing's own: they can then be moved, edited and deleted one by one">
          Make the {auto.length} automatic dimensions editable
        </button>
      )}
      {list.length ? (
        <ul className="cad-clist dw-ann-list">
          {list.map((a) => {
            const p = placed.get(a.id);
            return (
              <li key={a.id} className={a.id === selected ? 'on' : ''}>
                <span className="dw-item" role="button" tabIndex={0} title={p?.lost ? `Lost: ${p.lost}` : 'Select it on the sheet'} onClick={() => selectAnnotation(region.id, a.id)} onKeyDown={(e) => e.key === 'Enter' && selectAnnotation(region.id, a.id)}>
                  {p?.lost && <TriangleAlert size={12} className="dw-lost-mark" />} {annotationName(a, p?.text)} <small>{p?.view ?? a.view}</small>
                </span>
                <span>
                  <button className="icon-btn" title="Delete" aria-label="Delete annotation" onClick={() => remove(a.id)}><Trash2 size={13} /></button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : <p className="hint">Select the drawing and use the tools under it: <b>Dimension</b>, <b>Note</b>, <b>Hole</b>, <b>GD&T</b>, <b>Datum</b>, <b>Surface</b>, <b>Centre</b>, <b>Balloon</b>. Picks snap to corners, edge middles, circle centres and quadrants.</p>}
      {autoSel && <p className="dw-ann-note">An automatic dimension ({placed.get(autoSel.id)?.text}): make the automatic dimensions editable to move or change it.</p>}
      {sel && <Editor key={sel.id} a={sel} region={region} unit={live?.unit ?? 'mm'} reads={placed.get(sel.id)} update={(patch) => update(sel.id, patch)} remove={() => remove(sel.id)} />}
    </>
  );
}

function Editor({ a, region, unit, reads, update, remove }: {
  a: Annotation; region: DrawingRegion; unit: string; reads?: { lost?: string; value?: number; text?: string; error?: string };
  update: (patch: Partial<Annotation>) => void; remove: () => void;
}) {
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (a.kind === 'note' && takeFocus(region.id, a.id)) {
      noteRef.current?.focus();
      noteRef.current?.select();
    }
  }, [a.id, a.kind, region.id]);
  return (
    <div className="dw-ann-edit">
      {reads?.lost && <p className="dw-ann-note warn"><TriangleAlert size={12} /> Lost: {reads.lost}. It is drawn where it was, in orange; delete it or place it again.</p>}
      {reads?.error && <p className="dw-ann-note err">{reads.error}</p>}
      {a.kind === 'dim' && <DimEditor d={a} unit={unit} reads={reads} update={update} />}
      {a.kind === 'note' && (
        <label className="field"><span>Text</span>
          <textarea ref={noteRef} defaultValue={a.text} aria-label="Note text" onBlur={(e) => e.target.value !== a.text && update({ text: e.target.value || ' ' })} />
        </label>
      )}
      {a.kind === 'hole' && (
        <>
          <p className="dw-ann-note">{reads?.text}</p>
          <div className="row2">
            <label className="field"><span>Thread class</span><LazyInput label="Thread tolerance class" value={a.cls ?? '6H'} onCommit={(v) => update({ cls: v.trim() === '6H' ? undefined : v.trim() })} /></label>
            <label className="field"><span>Text</span><LazyInput label="Callout text" mono={false} value={a.override ?? ''} placeholder="<> = generated" onCommit={(v) => update({ override: v.trim() || undefined })} /></label>
          </div>
        </>
      )}
      {a.kind === 'gdt' && <GdtEditor g={a} update={update} />}
      {a.kind === 'datum' && (
        <label className="field"><span>Letter</span><LazyInput label="Datum letter" value={a.letter} onCommit={(v) => update({ letter: v.trim().toUpperCase() || a.letter })} /></label>
      )}
      {a.kind === 'surface' && <SurfaceEditor s={a} update={update} />}
      {a.kind === 'centre' && !a.hide && (
        <label className="field"><span>Past the circle (mm)</span><Num label="Centre line overshoot" value={a.ext ?? 3} onCommit={(v) => update({ ext: v === undefined || v === 3 ? undefined : Math.max(0, v) })} /></label>
      )}
      {a.kind === 'centre' && a.hide && <p className="dw-ann-note">The automatic centre mark here is taken away. Delete this to bring it back.</p>}
      {a.kind === 'balloon' && <p className="dw-ann-note">{reads?.text}</p>}
      <button className="danger" onClick={remove}><Trash2 size={13} /> Delete</button>
    </div>
  );
}

const TOL_KINDS: [string, string][] = [['', 'None'], ['sym', '± symmetric'], ['dev', 'Deviations'], ['limits', 'Limits'], ['fit', 'ISO 286 fit']];

function DimEditor({ d, unit, reads, update }: { d: DimAnnotation; unit: string; reads?: { value?: number; text?: string }; update: (patch: Partial<DimAnnotation>) => void }) {
  const round = d.a.shape.k === 'circle';
  const tol = d.tol;
  const setTol = (kind: string) => {
    const t: Tolerance | undefined = kind === 'sym' ? { kind: 'sym', t: 0.1 } : kind === 'dev' ? { kind: 'dev', upper: 0.1, lower: -0.1 } : kind === 'limits' ? { kind: 'limits', upper: 0.1, lower: -0.1 } : kind === 'fit' ? { kind: 'fit', code: 'H7' } : undefined;
    update({ tol: t });
  };
  // the fit's deviations at this size, for reading off
  const value = reads?.value;
  let fitInfo = '';
  if (tol?.kind === 'fit' && value !== undefined && d.type !== 'angle') {
    const mm = MM[unit] ?? 1, size = value * mm;
    try {
      const f = parseFit(tol.code);
      if (f?.hole && f.shaft) {
        const k = fitKind(fitDeviations(`${f.hole.letter}${f.hole.grade}`, size), fitDeviations(`${f.shaft.letter}${f.shaft.grade}`, size));
        fitInfo = `${k.kind} fit: clearance ${k.min} … ${k.max} µm`;
      } else if (f) {
        const dv = fitDeviations(tol.code, size), dd = devDecimals([dv.upper, dv.lower], 'mm');
        fitInfo = `${tol.code.trim()} at ${+size.toFixed(3)} mm: ${fmtDev(dv.upper, dd)} / ${fmtDev(dv.lower, dd)} µm (ISO 286-2)`;
      }
    } catch (e) {
      fitInfo = (e as Error).message;
    }
  }
  return (
    <>
      <p className="dw-ann-note">{reads?.text}{value !== undefined && d.type !== 'angle' ? ` · measured ${+value.toFixed(6)} ${unit}` : ''}</p>
      <div className="row2">
        <label className="field"><span>Kind</span>
          <select value={d.type === 'linear' ? `linear:${d.orient ?? ''}` : d.type} onChange={(e) => {
            const v = e.target.value;
            update(v.startsWith('linear:') ? { type: 'linear', orient: (v.slice(7) || undefined) as DimAnnotation['orient'] } : { type: v as DimAnnotation['type'] });
          }}>
            {round && <option value="diameter">Diameter Ø</option>}
            {round && <option value="radius">Radius R</option>}
            {round && d.a.shape.k === 'circle' && d.a.shape.a1 - d.a.shape.a0 < 2 * Math.PI - 1e-9 && <option value="arc">Arc length</option>}
            {d.type === 'diameter' && !round && <option value="diameter">Diameter Ø</option>}
            {d.type === 'linear' && (d.orient !== undefined || d.b?.shape.k === 'point' || d.a.shape.k === 'point' || (d.a.shape.k === 'line' && !d.b)) ? (
              <>
                <option value="linear:h">Horizontal</option>
                <option value="linear:v">Vertical</option>
                <option value="linear:aligned">Aligned</option>
              </>
            ) : d.type === 'linear' && <option value="linear:">Distance</option>}
            {d.type === 'angle' && <option value="angle">Angle</option>}
            {d.type === 'pitch' && <option value="pitch">Pitch circle Ø</option>}
          </select>
        </label>
        <label className="field"><span>Decimals</span>
          <select value={d.decimals ?? ''} onChange={(e) => update({ decimals: e.target.value === '' ? undefined : Number(e.target.value) })}>
            <option value="">Drawing’s</option>
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <div className="row2">
        <label className="field"><span>Before</span><LazyInput label="Text before the value" mono={false} value={d.prefix ?? ''} placeholder="4×" onCommit={(v) => update({ prefix: v.trim() || undefined })} /></label>
        <label className="field"><span>After</span><LazyInput label="Text after the value" mono={false} value={d.suffix ?? ''} onCommit={(v) => update({ suffix: v || undefined })} /></label>
      </div>
      <label className="field"><span>Text instead of the value</span><LazyInput label="Override text" mono={false} value={d.override ?? ''} placeholder="<> stands for the value" onCommit={(v) => update({ override: v.trim() || undefined })} /></label>
      <label className="field"><span>Tolerance</span>
        <select value={tol?.kind ?? ''} onChange={(e) => setTol(e.target.value)}>
          {TOL_KINDS.filter(([k]) => d.type !== 'angle' || k !== 'fit').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {tol?.kind === 'sym' && <label className="field"><span>± ({d.type === 'angle' ? '°' : unit})</span><Num label="Symmetric tolerance" value={tol.t} onCommit={(v) => v !== undefined && update({ tol: { kind: 'sym', t: Math.abs(v) } })} /></label>}
      {(tol?.kind === 'dev' || tol?.kind === 'limits') && (
        <div className="row2">
          <label className="field"><span>Upper ({d.type === 'angle' ? '°' : unit})</span><Num label="Upper deviation" value={tol.upper} onCommit={(v) => v !== undefined && update({ tol: { ...tol, upper: v } })} /></label>
          <label className="field"><span>Lower ({d.type === 'angle' ? '°' : unit})</span><Num label="Lower deviation" value={tol.lower} onCommit={(v) => v !== undefined && update({ tol: { ...tol, lower: v } })} /></label>
        </div>
      )}
      {tol?.kind === 'fit' && (
        <>
          <div className="row2">
            <label className="field" title="Hole H5 … H11, shafts c d e f g h js k m n p r s 5 … 11, or a fit H7/g6"><span>Class or fit</span>
              <LazyInput label="ISO 286 class" value={tol.code} placeholder="H7, g6, H7/g6" onCommit={(v) => update({ tol: { ...tol, code: v.trim() || 'H7' } })} />
            </label>
            <label className="field"><span>Show</span>
              <select value={tol.show ?? 'code'} onChange={(e) => update({ tol: { ...tol, show: e.target.value === 'code' ? undefined : (e.target.value as 'dev' | 'limits') } })}>
                <option value="code">Class only (Ø20 H7)</option>
                <option value="dev">With deviations</option>
                <option value="limits">With limits</option>
              </select>
            </label>
          </div>
          {fitInfo && <p className="dw-ann-note">{fitInfo}</p>}
        </>
      )}
      <div className="row2">
        <label className="check" title="Auxiliary dimension, for information only (ISO 129-1): in parentheses"><input type="checkbox" checked={!!d.reference} onChange={(e) => update({ reference: e.target.checked || undefined })} /> Reference ( )</label>
        <label className="check" title="Theoretically exact dimension (ISO 1101, ISO 5458): framed"><input type="checkbox" checked={!!d.basic} onChange={(e) => update({ basic: e.target.checked || undefined })} /> Exact (framed)</label>
      </div>
    </>
  );
}

function GdtEditor({ g, update }: { g: GdtAnnotation; update: (patch: Partial<GdtAnnotation>) => void }) {
  const info = GDT_INFO[g.char];
  const datums = [0, 1, 2].map((i) => g.datums?.[i] ?? { letter: '' });
  const setDatum = (i: number, patch: Partial<{ letter: string; mod?: 'M' | 'L' }>) => {
    const next = datums.map((d, k) => (k === i ? { ...d, ...patch } : d));
    // trailing empty ones dropped
    while (next.length && !next[next.length - 1].letter.trim()) next.pop();
    update({ datums: next.length ? next.map((d) => ({ letter: d.letter.trim().toUpperCase(), ...(d.mod ? { mod: d.mod } : {}) })) : undefined });
  };
  return (
    <>
      <label className="field"><span>Characteristic (ISO 1101)</span>
        <select value={g.char} onChange={(e) => {
          const c = e.target.value as GdtAnnotation['char'];
          update({ char: c, ...(GDT_INFO[c].datum === 'none' ? { datums: undefined } : {}), ...(GDT_INFO[c].dia ? {} : { dia: undefined }) });
        }}>
          {GDT_CHARS.map((c) => <option key={c} value={c}>{GDT_INFO[c].name}</option>)}
        </select>
      </label>
      <div className="row2">
        <label className="field"><span>Tolerance</span><Num label="Tolerance value" value={g.tol} onCommit={(v) => v !== undefined && v > 0 && update({ tol: v })} /></label>
        <label className="field"><span>Modifier</span>
          <select value={g.mod ?? ''} onChange={(e) => update({ mod: (e.target.value || undefined) as GdtAnnotation['mod'] })}>
            <option value="">None</option>
            <option value="M">Ⓜ maximum material</option>
            <option value="L">Ⓛ least material</option>
            <option value="P">Ⓟ projected zone</option>
          </select>
        </label>
      </div>
      {info.dia && <label className="check"><input type="checkbox" checked={!!g.dia} onChange={(e) => update({ dia: e.target.checked || undefined })} /> Cylindrical zone (Ø)</label>}
      {info.datum !== 'none' && (
        <div className="dw-datums">
          {datums.map((d, i) => (
            <div key={i} className="row2">
              <label className="field"><span>{['Primary', 'Secondary', 'Tertiary'][i]} datum</span><LazyInput label={`Datum ${i + 1}`} value={d.letter} placeholder={i ? '' : 'A'} onCommit={(v) => setDatum(i, { letter: v })} /></label>
              <label className="field"><span>Modifier</span>
                <select value={d.mod ?? ''} onChange={(e) => setDatum(i, { mod: (e.target.value || undefined) as 'M' | 'L' | undefined })} disabled={!d.letter.trim()}>
                  <option value="">None</option>
                  <option value="M">Ⓜ</option>
                  <option value="L">Ⓛ</option>
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
      <p className="dw-ann-note">{g.dim ? 'Under its dimension: it applies to the feature of size (its axis or median plane).' : info.datum === 'required' ? 'Needs a datum.' : info.datum === 'none' ? 'A form tolerance: no datum.' : 'A datum is optional.'}</p>
    </>
  );
}

function SurfaceEditor({ s, update }: { s: SurfaceAnnotation; update: (patch: Partial<SurfaceAnnotation>) => void }) {
  return (
    <>
      <div className="row2">
        <label className="field"><span>Parameter</span>
          <select value={s.param} onChange={(e) => update({ param: e.target.value as 'Ra' | 'Rz' })}>
            <option value="Ra">Ra (mean deviation)</option>
            <option value="Rz">Rz (max. height)</option>
          </select>
        </label>
        <label className="field"><span>Value (µm)</span><Num label="Roughness value" value={s.value} onCommit={(v) => v !== undefined && v > 0 && update({ value: v })} /></label>
      </div>
      <label className="field"><span>Process</span>
        <select value={s.process} onChange={(e) => update({ process: e.target.value as SurfaceAnnotation['process'] })}>
          <option value="any">Any process</option>
          <option value="removal">Material removal required</option>
          <option value="noremoval">Material removal not permitted</option>
        </select>
      </label>
      <div className="row2">
        <label className="field"><span>Lay</span>
          <select value={s.lay ?? ''} onChange={(e) => update({ lay: (e.target.value || undefined) as Lay | undefined })}>
            <option value="">—</option>
            {LAYS.map((l) => <option key={l} value={l}>{LAY_NAMES[l]}</option>)}
          </select>
        </label>
        <label className="field"><span>Method</span><LazyInput label="Manufacturing method" mono={false} value={s.method ?? ''} placeholder="ground" onCommit={(v) => update({ method: v.trim() || undefined })} /></label>
      </div>
    </>
  );
}
