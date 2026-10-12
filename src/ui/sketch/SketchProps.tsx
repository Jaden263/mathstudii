import { useEffect, useState, type Dispatch } from 'react';
import { Trash2 } from 'lucide-react';
import type { SketchRegion } from '../../model/types';
import {
  SYMBOLS, SKETCH_UNITS, defaultSectionParams, getField, setField, isClosed, areaRole,
  type Shape, type SketchUnit, type Dash, type AreaRole,
} from '../../model/sketch';
import { TEMPLATES, type SectionTemplate } from '../../engine/geometry';
import type { SketchResult } from '../../engine/sketchEval';
import type { Action } from '../store';
import { useSketchUI } from './context';
import { fmtLen } from './render';

const NUMERIC = /^\s*-?(\d+\.?\d*|\.\d+)(e-?\d+)?\s*$/i;

/** A text field committed on Enter/blur. */
function LazyInput({ value, onCommit, mono = true, placeholder, label }: { value: string; onCommit: (v: string) => void; mono?: boolean; placeholder?: string; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onCommit(v);
  return (
    <input
      className={mono ? 'mono' : ''}
      value={v}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}

/** A numeric shape field that also accepts a worksheet expression (bound). */
function BindField({ shape, path, label, update }: { shape: Shape; path: string; label: string; update: (s: Shape) => void }) {
  const bound = shape.bind?.[path];
  const num = getField(shape, path);
  const shown = bound ?? (typeof num === 'number' ? String(+num.toFixed(6)) : '');
  return (
    <label className={`field${bound !== undefined ? ' bound' : ''}`} title={bound !== undefined ? 'Bound to a worksheet expression' : 'A number, or any worksheet expression to make it parametric'}>
      <span>{label}{bound !== undefined && <em> = ƒ</em>}</span>
      <LazyInput
        label={label}
        value={shown}
        onCommit={(text) => {
          const bind = { ...(shape.bind ?? {}) };
          if (NUMERIC.test(text)) {
            delete bind[path];
            update({ ...setField(shape, path, Number(text)), bind });
          } else if (text.trim()) {
            bind[path] = text.trim();
            update({ ...shape, bind });
          } else {
            delete bind[path];
            update({ ...shape, bind });
          }
        }}
      />
    </label>
  );
}

function pointFields(s: Shape): [string, string][] {
  switch (s.type) {
    case 'line': case 'arrow': case 'dim': case 'link': case 'rect':
      return [['a.x', 'start x'], ['a.y', 'start y'], ['b.x', 'end x'], ['b.y', 'end y']];
    case 'circle': return [['c.x', 'centre x'], ['c.y', 'centre y'], ['r', 'radius']];
    case 'arc': return [['c.x', 'centre x'], ['c.y', 'centre y'], ['r', 'radius'], ['a0', 'start angle (°)'], ['a1', 'end angle (°)']];
    case 'text': return [['p.x', 'x'], ['p.y', 'y'], ['size', 'height']];
    case 'symbol': return [['p.x', 'x'], ['p.y', 'y'], ['rot', 'rotation (°)'], ['size', 'size']];
    case 'section': return [['p.x', 'centre x'], ['p.y', 'centre y'], ['rot', 'rotation (°)']];
    case 'poly': case 'path':
      return s.pts.slice(0, 16).flatMap((_, i) => [[`pts.${i}.x`, `x${i}`], [`pts.${i}.y`, `y${i}`]] as [string, string][]);
  }
}

const TYPE_LABEL: Record<Shape['type'], string> = {
  line: 'Line', arrow: 'Arrow', dim: 'Dimension', link: 'Link', poly: 'Polyline', path: 'Freehand', rect: 'Rectangle',
  circle: 'Circle', arc: 'Arc', text: 'Text', symbol: 'Symbol', section: 'Cross-section',
};

export function SketchProps({ region, result, dispatch }: { region: SketchRegion; result?: SketchResult; dispatch: Dispatch<Action> }) {
  const { ui, setUi } = useSketchUI();
  const sel = ui.regionId === region.id ? region.shapes.filter((s) => ui.selected.includes(s.id)) : [];
  const setRegion = (patch: Partial<SketchRegion>, key = 'sk') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const updateShape = (s: Shape) => dispatch({ type: 'update', id: region.id, patch: { shapes: region.shapes.map((q) => (q.id === s.id ? s : q)) } });

  if (sel.length > 1) {
    return (
      <div className="props">
        <p>{sel.length} shapes selected</p>
        <button className="danger" onClick={() => { dispatch({ type: 'update', id: region.id, patch: { shapes: region.shapes.filter((s) => !ui.selected.includes(s.id)) } }); setUi({ selected: [] }); }}>
          <Trash2 size={14} /> Delete shapes
        </button>
      </div>
    );
  }

  if (sel.length === 1) {
    const s = sel[0];
    const err = result?.errors[s.id];
    const style = s.style ?? {};
    const setStyle = (patch: Partial<typeof style>) => updateShape({ ...s, style: { ...style, ...patch } });
    return (
      <div className="props">
        <h3 className="sub">{TYPE_LABEL[s.type]}{s.type === 'symbol' ? ` · ${SYMBOLS.find((x) => x.kind === s.symbol)?.label}` : ''}</h3>
        {err && <div className="region-error">{err}</div>}
        {s.type === 'text' && (
          <label className="field"><span>Text</span><LazyInput label="Text" mono={false} value={s.text} onCommit={(v) => updateShape({ ...s, text: v })} /></label>
        )}
        {s.type === 'symbol' && (
          <label className="field">
            <span>Symbol</span>
            <select value={s.symbol} onChange={(e) => updateShape({ ...s, symbol: e.target.value as typeof s.symbol })}>
              {SYMBOLS.map((x) => <option key={x.kind} value={x.kind}>{x.label}</option>)}
            </select>
          </label>
        )}
        {s.type === 'section' && (
          <>
            <label className="field">
              <span>Shape</span>
              <select value={s.template} onChange={(e) => {
                const t = e.target.value as SectionTemplate;
                updateShape({ ...s, template: t, params: defaultSectionParams(t) });
              }}>
                {(Object.keys(TEMPLATES) as SectionTemplate[]).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}
              </select>
            </label>
            <div className="row2">
              {TEMPLATES[s.template].params.map((p) => (
                <label key={p.key} className="field">
                  <span>{p.label}</span>
                  <LazyInput label={p.label} value={s.params[p.key] ?? ''} onCommit={(v) => updateShape({ ...s, params: { ...s.params, [p.key]: v } })} />
                </label>
              ))}
            </div>
            <p className="hint">Dimensions accept worksheet expressions with units, e.g. <code>h_b</code> or <code>30 cm</code>. Plain numbers are in {region.unit}.</p>
          </>
        )}
        {s.type === 'dim' && (
          <>
            <BindField shape={s} path="offset" label="offset" update={updateShape} />
            <label className="field"><span>Label (blank = measured length)</span><LazyInput label="Label" mono={false} value={s.text ?? ''} onCommit={(v) => updateShape({ ...s, text: v })} /></label>
          </>
        )}
        {s.type === 'arrow' && (
          <label className="check"><input type="checkbox" checked={!!s.double} onChange={(e) => updateShape({ ...s, double: e.target.checked })} /> Double-headed</label>
        )}
        {s.type === 'poly' && (
          <label className="check"><input type="checkbox" checked={s.closed} onChange={(e) => updateShape({ ...s, closed: e.target.checked })} /> Closed polygon</label>
        )}
        <div className="row2">
          {pointFields(s).map(([path, label]) => <BindField key={path} shape={s} path={path} label={label} update={updateShape} />)}
        </div>
        {isClosed(s) && (
          <label className="field">
            <span>Area role (section properties)</span>
            <select value={areaRole(s)} onChange={(e) => updateShape({ ...s, role: e.target.value as AreaRole })}>
              <option value="solid">Solid material</option>
              <option value="hole">Hole / cut-out</option>
              <option value="none">Ignore (just a drawing)</option>
            </select>
          </label>
        )}
        <h3 className="sub">Style</h3>
        <div className="row2">
          <label className="field"><span>Colour</span><input type="color" value={style.stroke || '#3a3d45'} onChange={(e) => setStyle({ stroke: e.target.value })} /></label>
          <label className="field"><span>Line width (px)</span><input type="number" min={0.5} step={0.5} value={style.width ?? (s.type === 'link' ? 4 : 1.6)} onChange={(e) => setStyle({ width: Number(e.target.value) })} /></label>
          <label className="field">
            <span>Line type</span>
            <select value={style.dash ?? 'solid'} onChange={(e) => setStyle({ dash: e.target.value as Dash })}>
              <option value="solid">Solid</option><option value="dash">Dashed</option><option value="dot">Dotted</option><option value="center">Centre line</option>
            </select>
          </label>
          {isClosed(s) && (
            <label className="check"><input type="checkbox" checked={style.hatch !== false} onChange={(e) => setStyle({ hatch: e.target.checked })} /> Hatch</label>
          )}
        </div>
        <button className="danger" onClick={() => { dispatch({ type: 'update', id: region.id, patch: { shapes: region.shapes.filter((q) => q.id !== s.id) } }); setUi({ selected: [] }); }}>
          <Trash2 size={14} /> Delete shape
        </button>
      </div>
    );
  }

  const p = result?.props;
  const u = region.unit;
  return (
    <div className="props">
      <h3 className="sub">Sketch</h3>
      <label className="field">
        <span>Variable for section properties</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. sec" onCommit={(v) => setRegion({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">With a name, the closed shapes define <code>{region.name || 'sec'}.A</code>, <code>.Ix</code>, <code>.Iy</code>, <code>.Wx</code>, <code>.xc</code>, <code>.I1</code>, <code>.θ</code>… for use in math below the sketch.</p>
      <div className="row2">
        <label className="field">
          <span>Units</span>
          <select value={region.unit} onChange={(e) => setRegion({ unit: e.target.value as SketchUnit })}>
            {SKETCH_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field"><span>Grid ({u})</span><input type="number" min={0} value={region.grid} onChange={(e) => setRegion({ grid: Math.max(0, Number(e.target.value)) }, 'grid')} /></label>
        <label className="field"><span>Width (px)</span><input type="number" min={160} value={region.width} onChange={(e) => setRegion({ width: Math.max(160, Number(e.target.value)) }, 'w')} /></label>
        <label className="field"><span>Height (px)</span><input type="number" min={120} value={region.height} onChange={(e) => setRegion({ height: Math.max(120, Number(e.target.value)) }, 'h')} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={region.snap} onChange={(e) => setRegion({ snap: e.target.checked })} /> Snap to grid</label>
      <label className="check"><input type="checkbox" checked={region.showProps} onChange={(e) => setRegion({ showProps: e.target.checked })} /> Show centroid and principal axes</label>
      {p && (
        <table className="props-table">
          <tbody>
            <tr><td>A</td><td>{fmtLen(p.A)} {u}²</td></tr>
            <tr><td>x<sub>c</sub>, y<sub>c</sub></td><td>{fmtLen(p.xc)}, {fmtLen(p.yc)} {u}</td></tr>
            <tr><td>I<sub>x</sub></td><td>{p.Ix.toPrecision(5)} {u}⁴</td></tr>
            <tr><td>I<sub>y</sub></td><td>{p.Iy.toPrecision(5)} {u}⁴</td></tr>
            <tr><td>I<sub>xy</sub></td><td>{p.Ixy.toPrecision(4)} {u}⁴</td></tr>
            <tr><td>I<sub>1</sub>, I<sub>2</sub></td><td>{p.I1.toPrecision(4)}, {p.I2.toPrecision(4)} {u}⁴</td></tr>
            <tr><td>θ</td><td>{fmtLen(p.theta)}°</td></tr>
            <tr><td>W<sub>x</sub>, W<sub>y</sub></td><td>{p.Wx.toPrecision(4)}, {p.Wy.toPrecision(4)} {u}³</td></tr>
          </tbody>
        </table>
      )}
      <h3 className="sub">Animation</h3>
      <p className="hint">Sweep a variable defined above the sketch; shapes bound to it move. Press ▶ on the sketch.</p>
      <div className="row2">
        <label className="field"><span>Variable</span><LazyInput label="Animated variable" value={region.animation?.variable ?? ''} placeholder="θ" onCommit={(v) => setRegion({ animation: v.trim() ? { from: '0', to: '360 deg', seconds: 4, ...region.animation, variable: v.trim() } : undefined })} /></label>
        <label className="field"><span>Seconds per sweep</span><input type="number" min={0.2} step={0.5} value={region.animation?.seconds ?? 4} disabled={!region.animation} onChange={(e) => region.animation && setRegion({ animation: { ...region.animation, seconds: Number(e.target.value) } })} /></label>
        <label className="field"><span>From</span><LazyInput label="From" value={region.animation?.from ?? ''} onCommit={(v) => region.animation && setRegion({ animation: { ...region.animation, from: v } })} /></label>
        <label className="field"><span>To</span><LazyInput label="To" value={region.animation?.to ?? ''} onCommit={(v) => region.animation && setRegion({ animation: { ...region.animation, to: v } })} /></label>
      </div>
    </div>
  );
}
