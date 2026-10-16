import { useMemo, useRef, useState, type Dispatch } from 'react';
import { Trash2, Plus, X } from 'lucide-react';
import type { PlotRegion, PlotTrace, Region, RegionStyle, TraceStyle, TextRegion, ImageRegion, WorksheetFormat, ReportSettings } from '../model/types';
import { PX_PER_MM } from '../model/types';
import type { Action } from './store';
import { Tex } from './Tex';
import { OPERATORS, CALCULUS, MATRIX, PROGRAMMING, SYMBOLIC, GREEK, UNIT_GROUPS, FUNCTIONS, CONSTANTS, type PaletteItem } from './catalog';
import { SERIES_COLORS } from './plot/draw';
import { SketchProps } from './sketch/SketchProps';
import { CadProps } from './cad/CadProps';
import { DrawingProps } from './cad/DrawingProps';
import { BeamProps } from './beam/BeamProps';
import { Frame3DProps } from './frame3d/Frame3DProps';
import type { RegionResult, SketchResult, CadResult, BeamResult, Frame3DResult } from '../engine/evaluator';

export type Tab = 'math' | 'units' | 'functions' | 'format' | 'properties';

interface Props {
  tab: Tab;
  setTab: (t: Tab) => void;
  insert: (text: string) => void;
  selection: Region[];
  results: Map<string, RegionResult>;
  dispatch: Dispatch<Action>;
  onClose: () => void;
  /** Format of the whole worksheet. */
  format?: WorksheetFormat;
  /** Push overlapping regions apart (after text grew). */
  onReflow?: () => void;
  /** Page header and footer. */
  report?: ReportSettings;
}

/** Keep focus in the active editor when clicking palette buttons. */
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

function Group({ title, items, insert }: { title: string; items: PaletteItem[]; insert: (t: string) => void }) {
  return (
    <section className="palette-group">
      <h3>{title}</h3>
      <div className="palette-grid">
        {items.map((it) => (
          <button key={it.label + it.insert} className="pal-btn" title={it.tip} aria-label={it.tip} onMouseDown={keepFocus} onClick={() => insert(it.insert)}>
            <Tex tex={it.tex ?? it.label} display={false} />
          </button>
        ))}
      </div>
    </section>
  );
}

const TEXT_COLOURS = ['#c92a2a', '#2f6fdf', '#2b8a3e', '#e67700', '#7048e8', '#495057'];
// see-through highlights read well on light and dark pages
const HIGHLIGHTS = ['rgba(255, 212, 59, 0.35)', 'rgba(105, 219, 124, 0.3)', 'rgba(77, 171, 247, 0.28)', 'rgba(255, 135, 135, 0.3)', 'rgba(177, 151, 252, 0.3)'];

function Scale({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="fmt-row">
      <span>{label}</span>
      <button className="icon-btn" aria-label={`Smaller ${label.toLowerCase()}`} onClick={() => onChange(Math.max(min, +(value - step * 2).toFixed(2)))}>−</button>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <button className="icon-btn" aria-label={`Larger ${label.toLowerCase()}`} onClick={() => onChange(Math.min(max, +(value + step * 2).toFixed(2)))}>+</button>
      <output>{Math.round(value * 100)}%</output>
    </label>
  );
}

function Swatches({ label, value, colours, onChange }: { label: string; value?: string; colours: string[]; onChange: (c: string | undefined) => void }) {
  return (
    <div className="fmt-row">
      <span>{label}</span>
      <div className="fmt-swatches">
        <button className={`none${!value ? ' on' : ''}`} title="None" aria-label={`${label}: none`} onClick={() => onChange(undefined)} />
        {colours.map((c) => <button key={c} className={value === c ? 'on' : ''} style={{ background: c }} title={c} aria-label={`${label} ${c}`} onClick={() => onChange(c)} />)}
        <input type="color" value={value && value.startsWith('#') ? value : '#000000'} onChange={(e) => onChange(e.target.value)} aria-label={`${label}: custom`} title="Custom colour" />
      </div>
    </div>
  );
}

/** Font size, weight, colour, highlight and line thickness of the selection, and of the whole worksheet. */
function FormatTab({ selection, format, dispatch, onReflow }: { selection: Region[]; format?: WorksheetFormat; dispatch: Dispatch<Action>; onReflow?: () => void }) {
  // bigger text can make regions overlap: push them apart once the change settles
  const reflow = useRef<number | undefined>(undefined);
  const later = () => {
    window.clearTimeout(reflow.current);
    reflow.current = window.setTimeout(() => onReflow?.(), 500);
  };
  const first = selection[0]?.style ?? {};
  const upd = (patch: Partial<RegionStyle>) => {
    for (const r of selection) {
      const style: RegionStyle = { ...r.style, ...patch };
      for (const k of Object.keys(style) as (keyof RegionStyle)[]) if (style[k] === undefined || style[k] === false || (k.endsWith('Scale') && style[k] === 1)) delete style[k];
      dispatch({ type: 'update', id: r.id, patch: { style: Object.keys(style).length ? style : undefined }, coalesce: `fmt:${Object.keys(patch).join()}` });
    }
    if ('fontScale' in patch || 'bold' in patch) later();
  };
  const f = format ?? {};
  const setF = (patch: Partial<WorksheetFormat>) => {
    dispatch({ type: 'settings', patch: { format: { ...f, ...patch } } });
    if ('fontScale' in patch || 'textFont' in patch) later();
  };
  return (
    <div className="props">
      <h3 className="sub">{selection.length ? `Selected (${selection.length} region${selection.length > 1 ? 's' : ''})` : 'Selected regions'}</h3>
      {!selection.length ? <p className="hint">Select one or more regions on the page to format them. The settings below change the whole worksheet.</p> : (
        <>
          <Scale label="Font size" value={first.fontScale ?? 1} min={0.6} max={2.5} step={0.05} onChange={(v) => upd({ fontScale: v })} />
          <div className="fmt-row">
            <span>Style</span>
            <div className="fmt-toggles">
              <button className={first.bold ? 'on' : ''} aria-pressed={!!first.bold} onClick={() => upd({ bold: !first.bold })} title="Bold"><b>B</b></button>
              <button className={first.italic ? 'on' : ''} aria-pressed={!!first.italic} onClick={() => upd({ italic: !first.italic })} title="Italic"><i>I</i></button>
            </div>
          </div>
          <Swatches label="Colour" value={first.color} colours={TEXT_COLOURS} onChange={(c) => upd({ color: c })} />
          <Swatches label="Highlight" value={first.background} colours={HIGHLIGHTS} onChange={(c) => upd({ background: c })} />
          <Scale label="Line thickness" value={first.lineScale ?? 1} min={0.5} max={3} step={0.1} onChange={(v) => upd({ lineScale: v })} />
          <p className="hint">Line thickness applies to sketches, plots and beams.</p>
          <button className="btn" onClick={() => upd({ fontScale: undefined, bold: undefined, italic: undefined, color: undefined, background: undefined, lineScale: undefined })}>Reset selection</button>
        </>
      )}
      <h3 className="sub">Whole worksheet</h3>
      <Scale label="Font size" value={f.fontScale ?? 1} min={0.7} max={2} step={0.05} onChange={(v) => setF({ fontScale: v })} />
      <Scale label="Line thickness" value={f.lineScale ?? 1} min={0.5} max={3} step={0.1} onChange={(v) => setF({ lineScale: v })} />
      <label className="fmt-row">
        <span>Text font</span>
        <select value={f.textFont ?? 'sans'} onChange={(e) => setF({ textFont: e.target.value as WorksheetFormat['textFont'] })}>
          <option value="sans">Sans-serif</option>
          <option value="serif">Serif</option>
        </select>
      </label>
      <button className="btn" onClick={() => dispatch({ type: 'settings', patch: { format: undefined } })}>Reset worksheet format</button>
    </div>
  );
}

function ReportTab({ report, dispatch }: { report?: ReportSettings; dispatch: Dispatch<Action> }) {
  const r: ReportSettings = report ?? { enabled: false };
  const set = (patch: Partial<ReportSettings>) => dispatch({ type: 'settings', patch: { report: { ...r, ...patch } } });
  const field = (key: keyof ReportSettings, label: string, placeholder = '') => (
    <>
      <span>{label}</span>
      <input value={(r[key] as string | undefined) ?? ''} placeholder={placeholder} onChange={(e) => set({ [key]: e.target.value })} aria-label={label} />
    </>
  );
  const pickLogo = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => set({ logo: String(rd.result) });
      rd.readAsDataURL(f);
    };
    input.click();
  };
  return (
    <div className="props">
      <h3 className="sub">Page header &amp; footer</h3>
      <label className="check">
        <input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Show on every page (and when printing)
      </label>
      {r.enabled && (
        <>
          <div className="report-fields">
            {field('company', 'Company')}
            {field('project', 'Project')}
            {field('subject', 'Subject', 'worksheet title')}
            {field('docNo', 'Document no.')}
            {field('revision', 'Revision')}
            {field('author', 'Made by')}
            {field('checker', 'Checked by')}
            {field('date', 'Date', 'date of printing')}
          </div>
          <div className="fmt-row">
            <span>Logo</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn" onClick={pickLogo}>{r.logo ? 'Change…' : 'Choose…'}</button>
              {r.logo && <button className="btn" onClick={() => set({ logo: undefined })}>Remove</button>}
            </div>
          </div>
          <p className="hint">Page numbers count the pages that hold regions. Print (Ctrl+P) or “Save as PDF” in the print dialog for the report.</p>
        </>
      )}
    </div>
  );
}

export function SidePanel({ tab, setTab, insert, selection, results, dispatch, onClose, format, onReflow, report }: Props) {
  return (
    <aside className="side-panel" aria-label="Tools">
      <div className="side-tabs" role="tablist">
        {(['math', 'units', 'functions', 'format', 'properties'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onMouseDown={keepFocus} onClick={() => setTab(t)}>
            {t === 'math' ? 'Math' : t === 'units' ? 'Units' : t === 'functions' ? 'Functions' : t === 'format' ? 'Format' : 'Properties'}
          </button>
        ))}
        <button className="icon-btn close-panel" onClick={onClose} aria-label="Close panel"><X size={16} /></button>
      </div>
      <div className="side-body">
        {tab === 'math' && (
          <>
            <Group title="Operators" items={OPERATORS} insert={insert} />
            <Group title="Calculus" items={CALCULUS} insert={insert} />
            <Group title="Vectors & matrices" items={MATRIX} insert={insert} />
            <Group title="Programming" items={PROGRAMMING} insert={insert} />
            <Group title="Symbolic" items={SYMBOLIC} insert={insert} />
            <Group title="Greek" items={GREEK} insert={insert} />
            <Group title="Constants" items={CONSTANTS} insert={insert} />
          </>
        )}
        {tab === 'units' && <UnitsTab insert={insert} />}
        {tab === 'functions' && <FunctionsTab insert={insert} />}
        {tab === 'format' && (
          <>
            <FormatTab selection={selection} format={format} dispatch={dispatch} onReflow={onReflow} />
            <ReportTab report={report} dispatch={dispatch} />
          </>
        )}
        {tab === 'properties' && <Properties selection={selection} results={results} dispatch={dispatch} />}
      </div>
    </aside>
  );
}

function UnitsTab({ insert }: { insert: (t: string) => void }) {
  return (
    <>
      <p className="hint">Units multiply numbers: <code>5 kN</code>. To convert a result, type the unit after <code>=</code>, e.g. <code>F = kN</code>.</p>
      {UNIT_GROUPS.map((g) => (
        <section key={g.name} className="palette-group">
          <h3>{g.name}</h3>
          <div className="unit-grid">
            {g.units.map(([u, name]) => (
              <button key={u} className="unit-btn" title={name} onMouseDown={keepFocus} onClick={() => insert(` ${u}`)}>
                {u}
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function FunctionsTab({ insert }: { insert: (t: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? FUNCTIONS.filter((f) => f.name.toLowerCase().includes(s) || f.desc.toLowerCase().includes(s) || f.cat.toLowerCase().includes(s)) : FUNCTIONS;
  }, [q]);
  const cats = [...new Set(list.map((f) => f.cat))];
  return (
    <>
      <input className="search" placeholder="Search functions…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search functions" />
      {cats.map((c) => (
        <section key={c} className="palette-group">
          <h3>{c}</h3>
          <ul className="fn-list">
            {list.filter((f) => f.cat === c).map((f) => (
              <li key={f.name}>
                <button onMouseDown={keepFocus} onClick={() => insert(f.sig.includes('→') ? f.sig.replace(/\(.*\)/, '(|)') : `${f.name}(|)`)} title="Insert">
                  <code>{f.sig}</code>
                  <span>{f.desc}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

const mm = (px: number) => Math.round((px / PX_PER_MM) * 10) / 10;

function Field({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className={mono ? 'mono' : ''} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
    </label>
  );
}

function Properties({ selection, results, dispatch }: { selection: Region[]; results: Map<string, RegionResult>; dispatch: Dispatch<Action> }) {
  if (selection.length === 0) return <p className="hint">Select a region to see its properties. Click a plot to edit its traces and axes.</p>;
  if (selection.length > 1) {
    return (
      <div className="props">
        <p>{selection.length} regions selected</p>
        <button className="danger" onClick={() => dispatch({ type: 'delete', ids: selection.map((r) => r.id) })}><Trash2 size={14} /> Delete</button>
      </div>
    );
  }
  const r = selection[0];
  const upd = (patch: Partial<Region>, key = 'props') => dispatch({ type: 'update', id: r.id, patch, coalesce: `${key}:${r.id}` });
  return (
    <div className="props">
      <div className="row2">
        <label className="field"><span>X (mm)</span><input type="number" value={mm(r.x)} onChange={(e) => upd({ x: Math.max(0, Number(e.target.value) * PX_PER_MM) }, 'x')} /></label>
        <label className="field"><span>Y (mm)</span><input type="number" value={mm(r.y)} onChange={(e) => upd({ y: Math.max(0, Number(e.target.value) * PX_PER_MM) }, 'y')} /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!r.disabled} onChange={(e) => upd({ disabled: e.target.checked })} /> Disable evaluation
      </label>
      {r.kind === 'plot' && <PlotProps r={r} upd={upd} />}
      {r.kind === 'sketch' && <SketchProps region={r} result={results.get(r.id) as SketchResult | undefined} dispatch={dispatch} />}
      {r.kind === 'cad' && <CadProps region={r} result={results.get(r.id) as CadResult | undefined} dispatch={dispatch} />}
      {r.kind === 'beam' && <BeamProps region={r} result={results.get(r.id) as BeamResult | undefined} dispatch={dispatch} />}
      {r.kind === 'frame3d' && <Frame3DProps region={r} result={results.get(r.id) as Frame3DResult | undefined} dispatch={dispatch} />}
      {r.kind === 'drawing' && <DrawingProps region={r} dispatch={dispatch} />}
      {(r.kind === 'text' || r.kind === 'image') && (
        <label className="field">
          <span>Width (mm)</span>
          <input type="number" value={mm((r as TextRegion | ImageRegion).width)} onChange={(e) => upd({ width: Math.max(20, Number(e.target.value) * PX_PER_MM) } as Partial<Region>, 'w')} />
        </label>
      )}
      <button className="danger" onClick={() => dispatch({ type: 'delete', ids: [r.id] })}><Trash2 size={14} /> Delete region</button>
    </div>
  );
}

function PlotProps({ r, upd }: { r: PlotRegion; upd: (p: Partial<PlotRegion>, key?: string) => void }) {
  const setTrace = (i: number, patch: Partial<PlotTrace>) => upd({ traces: r.traces.map((t, k) => (k === i ? { ...t, ...patch } : t)) }, `trace${i}`);
  const surface = r.plotType === 'surface' || r.plotType === 'contour';
  return (
    <>
      <label className="field">
        <span>Plot type</span>
        <select value={r.plotType} onChange={(e) => upd({ plotType: e.target.value as PlotRegion['plotType'] })}>
          <option value="xy">X-Y plot</option>
          <option value="polar">Polar plot (θ, r)</option>
          <option value="surface">3-D surface</option>
          <option value="contour">Contour</option>
        </select>
      </label>
      <Field label="Title" value={r.title} onChange={(v) => upd({ title: v }, 'title')} />
      {surface ? (
        <>
          <Field mono label="z = f(x, y), function name, or matrix" value={r.z} onChange={(v) => upd({ z: v }, 'z')} placeholder="sin(x)*cos(y)" />
          <div className="row2">
            <Field mono label="x min" value={r.xmin} onChange={(v) => upd({ xmin: v }, 'xmin')} placeholder="-5" />
            <Field mono label="x max" value={r.xmax} onChange={(v) => upd({ xmax: v }, 'xmax')} placeholder="5" />
          </div>
          <div className="row2">
            <Field mono label="y min" value={r.ymin} onChange={(v) => upd({ ymin: v }, 'ymin')} placeholder="-5" />
            <Field mono label="y max" value={r.ymax} onChange={(v) => upd({ ymax: v }, 'ymax')} placeholder="5" />
          </div>
        </>
      ) : (
        <>
          <Field mono label={r.plotType === 'polar' ? 'Angle θ (range variable or undefined)' : 'X axis (range variable, vector, or undefined for QuickPlot)'} value={r.xExpr} onChange={(v) => upd({ xExpr: v }, 'xexpr')} />
          <h3 className="sub">Traces</h3>
          {r.traces.map((t, i) => (
            <div key={i} className="trace">
              <span className="swatch" style={{ background: t.color || SERIES_COLORS[i % SERIES_COLORS.length] }} />
              <input className="mono" value={t.y} onChange={(e) => setTrace(i, { y: e.target.value })} aria-label={`Trace ${i + 1} expression`} spellCheck={false} />
              <select value={t.style} onChange={(e) => setTrace(i, { style: e.target.value as TraceStyle })} aria-label="Trace style">
                <option value="line">line</option>
                <option value="points">points</option>
                <option value="both">line+points</option>
                <option value="step">step</option>
                <option value="bar">bars</option>
              </select>
              <input type="color" value={t.color || SERIES_COLORS[i % SERIES_COLORS.length]} onChange={(e) => setTrace(i, { color: e.target.value })} aria-label="Trace colour" />
              <button className="icon-btn" onClick={() => upd({ traces: r.traces.filter((_, k) => k !== i) })} aria-label="Remove trace"><X size={14} /></button>
            </div>
          ))}
          <button onClick={() => upd({ traces: [...r.traces, { y: '', style: 'line' }] })}><Plus size={14} /> Add trace</button>
          <div className="row2">
            <Field mono label="x min" value={r.xmin} onChange={(v) => upd({ xmin: v }, 'xmin')} placeholder="auto" />
            <Field mono label="x max" value={r.xmax} onChange={(v) => upd({ xmax: v }, 'xmax')} placeholder="auto" />
          </div>
          {r.plotType === 'xy' && (
            <>
              <div className="row2">
                <Field mono label="y min" value={r.ymin} onChange={(v) => upd({ ymin: v }, 'ymin')} placeholder="auto" />
                <Field mono label="y max" value={r.ymax} onChange={(v) => upd({ ymax: v }, 'ymax')} placeholder="auto" />
              </div>
              <div className="row2">
                <Field mono label="x unit" value={r.xUnit} onChange={(v) => upd({ xUnit: v }, 'xunit')} placeholder="auto" />
                <Field mono label="y unit" value={r.yUnit} onChange={(v) => upd({ yUnit: v }, 'yunit')} placeholder="auto" />
              </div>
              <div className="row2">
                <label className="check"><input type="checkbox" checked={r.logX} onChange={(e) => upd({ logX: e.target.checked })} /> log x</label>
                <label className="check"><input type="checkbox" checked={r.logY} onChange={(e) => upd({ logY: e.target.checked })} /> log y</label>
              </div>
            </>
          )}
        </>
      )}
      <div className="row2">
        <label className="field"><span>Width (mm)</span><input type="number" value={mm(r.width)} onChange={(e) => upd({ width: Math.max(160, Number(e.target.value) * PX_PER_MM) }, 'pw')} /></label>
        <label className="field"><span>Height (mm)</span><input type="number" value={mm(r.height)} onChange={(e) => upd({ height: Math.max(120, Number(e.target.value) * PX_PER_MM) }, 'ph')} /></label>
      </div>
      <p className="hint">QuickPlot: if the x variable is undefined it is sampled across x min…x max (default −10…10). Limits may use units, e.g. <code>0 m</code>.</p>
    </>
  );
}

export type { Tab as SideTab };
