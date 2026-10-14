import type { Dispatch } from 'react';
import { Trash2 } from 'lucide-react';
import type { CadRegion } from '../../model/types';
import type { CadResult } from '../../cad/evaluate';
import { CAD_UNITS, MATERIALS, isDimension, removeFromSketch, type CadConstraint, type CadFeature, type CadSketch, type CadUnit } from '../../cad/model';
import { solveLocal } from '../../cad/edit';
import type { Action } from '../store';
import { useSketchUI } from '../sketch/context';
import { LazyInput } from '../sketch/SketchProps';
import { fmtNum } from './cadRender';

const TYPE_LABEL: Record<string, string> = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  equal: 'Equal', fix: 'Fixed', pointOnLine: 'Point on line', pointOnCircle: 'Point on circle', tangent: 'Tangent',
  midpoint: 'Midpoint', symmetric: 'Symmetric', concentric: 'Concentric', distance: 'Distance', distanceX: 'Horizontal distance',
  distanceY: 'Vertical distance', length: 'Length', angle: 'Angle', radius: 'Radius', diameter: 'Diameter',
};

const p = (v: number | undefined, d = 5) => (v === undefined || !Number.isFinite(v) ? '–' : +v.toPrecision(d));

export function CadProps({ region, result, dispatch }: { region: CadRegion; result?: CadResult; dispatch: Dispatch<Action> }) {
  const { ui, setUi } = useSketchUI();
  const set = (patch: Partial<CadRegion>, key = 'cad') => dispatch({ type: 'update', id: region.id, patch, coalesce: `${key}:${region.id}` });
  const setSketch = (sk: CadSketch, key?: string) => set({ sketch: solveLocal(sk, region.unit, result?.values) }, key ?? 'cadsk');
  const sk = region.sketch;
  const sel = ui.regionId === region.id ? ui.selected : [];
  const selDims = sk.constraints.filter((c) => sel.includes(c.id) && isDimension(c.type));
  const selEnts = sk.entities.filter((e) => sel.includes(e.id));
  const updC = (c: CadConstraint, patch: Partial<CadConstraint>) => setSketch({ ...sk, constraints: sk.constraints.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }, `dim:${c.id}`);
  const f = region.feature;
  const setFeature = (feature: CadFeature) => set({ feature }, 'feature');
  const lines = sk.entities.filter((e) => e.type === 'line');
  const material = MATERIALS.find((m) => m.density === region.density.trim());
  const s = result?.section, m = result?.mass, u = region.unit;
  const name = region.name.trim() || 'part';

  return (
    <div className="props">
      <h3 className="sub">CAD part</h3>
      <label className="field">
        <span>Variable for the part's properties</span>
        <LazyInput label="Variable name" value={region.name} placeholder="e.g. part" onCommit={(v) => set({ name: v.trim() }, 'name')} />
      </label>
      <p className="hint">
        With a name, the math below can use <code>{name}.A</code>, <code>{name}.Ix</code>, <code>{name}.V</code>, <code>{name}.m</code>, <code>{name}.Imz</code>
        {' '}and every named dimension (<code>{name}.d1</code>). Dimensions accept worksheet expressions, so the part follows the calculation above it.
      </p>
      <div className="row2">
        <label className="field">
          <span>Units</span>
          <select value={region.unit} onChange={(e) => set({ unit: e.target.value as CadUnit })}>
            {CAD_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="field">
          <span>3-D feature</span>
          <select
            value={f.type}
            onChange={(e) => {
              const t = e.target.value;
              if (t === 'none') setFeature({ type: 'none' });
              if (t === 'extrude') setFeature({ type: 'extrude', depth: '10' });
              if (t === 'revolve') setFeature({ type: 'revolve', axis: 'y', angle: '360' });
            }}
          >
            <option value="none">None (2-D)</option>
            <option value="extrude">Extrude</option>
            <option value="revolve">Revolve</option>
          </select>
        </label>
      </div>
      {f.type === 'extrude' && (
        <div className="row2">
          <label className="field" title="A number in the sketch unit, a value with a unit, or a worksheet expression">
            <span>Depth</span>
            <LazyInput label="Extrusion depth" value={f.depth} onCommit={(v) => setFeature({ ...f, depth: v })} />
          </label>
          <label className="check"><input type="checkbox" checked={!!f.symmetric} onChange={(e) => setFeature({ ...f, symmetric: e.target.checked || undefined })} /> Symmetric</label>
        </div>
      )}
      {f.type === 'revolve' && (
        <div className="row2">
          <label className="field">
            <span>Axis</span>
            <select value={f.axis} onChange={(e) => setFeature({ ...f, axis: e.target.value })}>
              <option value="y">Sketch y axis</option>
              <option value="x">Sketch x axis</option>
              {lines.map((l, i) => <option key={l.id} value={l.id}>Line {i + 1}{l.construction ? ' (construction)' : ''}</option>)}
            </select>
          </label>
          <label className="field" title="Degrees if no unit is given">
            <span>Angle</span>
            <LazyInput label="Revolve angle" value={f.angle} onCommit={(v) => setFeature({ ...f, angle: v })} />
          </label>
        </div>
      )}
      {f.type !== 'none' && (
        <div className="row2">
          <label className="field">
            <span>Material</span>
            <select value={material ? material.density : region.density.trim() ? 'custom' : 'none'} onChange={(e) => {
              const v = e.target.value;
              if (v === 'none') set({ density: '' });
              else if (v !== 'custom') set({ density: v });
            }}>
              {MATERIALS.map((x) => <option key={x.name} value={x.density}>{x.name}</option>)}
              <option value="custom">Custom density</option>
              <option value="none">No mass</option>
            </select>
          </label>
          <label className="field">
            <span>Density</span>
            <LazyInput label="Density" value={region.density} placeholder="kg/m^3" onCommit={(v) => set({ density: v.trim() }, 'density')} />
          </label>
        </div>
      )}
      {result?.featureError && <div className="region-error">{result.featureError}</div>}

      {selDims.length === 1 && (() => {
        const c = selDims[0];
        const err = result?.dimErrors[c.id];
        const v = result?.values[c.id];
        return (
          <>
            <h3 className="sub">{TYPE_LABEL[c.type]} dimension</h3>
            {err && <div className="region-error">{err}</div>}
            <label className="field" title="A number in the sketch unit, a value with a unit (25 mm, 30 deg) or any worksheet expression">
              <span>Value{v !== undefined ? ` (now ${fmtNum(c.type === 'angle' ? (v * 180) / Math.PI : v)}${c.type === 'angle' ? '°' : ` ${u}`})` : ''}</span>
              <LazyInput label="Dimension value" value={c.value ?? ''} onCommit={(t) => updC(c, { value: t.trim() })} />
            </label>
            <div className="row2">
              <label className="field">
                <span>Name ({name}.…)</span>
                <LazyInput label="Dimension name" value={c.name ?? ''} onCommit={(t) => updC(c, { name: t.trim() || undefined })} />
              </label>
              <label className="check" title="A reference dimension measures the geometry instead of driving it">
                <input type="checkbox" checked={c.driving === false} onChange={(e) => updC(c, { driving: e.target.checked ? false : undefined, value: e.target.checked ? c.value : String(+((c.type === 'angle' ? ((v ?? 0) * 180) / Math.PI : v ?? 0).toPrecision(6))) })} /> Reference only
              </label>
            </div>
          </>
        );
      })()}
      {selEnts.length > 0 && (
        <>
          <h3 className="sub">{selEnts.length === 1 ? selEnts[0].type[0].toUpperCase() + selEnts[0].type.slice(1) : `${selEnts.length} entities`}</h3>
          <label className="check">
            <input type="checkbox" checked={selEnts.every((e) => e.construction)} onChange={(e) => {
              const ids = new Set(selEnts.map((x) => x.id));
              setSketch({ ...sk, entities: sk.entities.map((x) => (ids.has(x.id) ? { ...x, construction: e.target.checked || undefined } : x)) });
            }} /> Construction (not part of the profile)
          </label>
        </>
      )}

      {result && !result.error && (
        <>
          <h3 className="sub">Results</h3>
          <table className="props-table">
            <tbody>
              <tr><td>Status</td><td>{!result.ok ? `${result.conflicting.length} conflicting` : result.dof === 0 ? 'Fully defined' : `${result.dof} DOF free`}{result.redundant.length ? `, ${result.redundant.length} redundant` : ''}</td></tr>
              {s && <tr><td>A</td><td>{p(s.A)} {u}²</td></tr>}
              {s && <tr><td>x<sub>c</sub>, y<sub>c</sub></td><td>{p(s.xc)}, {p(s.yc)} {u}</td></tr>}
              {s && <tr><td>I<sub>x</sub>, I<sub>y</sub></td><td>{p(s.Ix)}, {p(s.Iy)} {u}⁴</td></tr>}
              {s && <tr><td>W<sub>x</sub>, W<sub>y</sub></td><td>{p(s.Wx)}, {p(s.Wy)} {u}³</td></tr>}
              {m && <tr><td>V</td><td>{p(m.V)} {u}³</td></tr>}
              {m?.m !== undefined && <tr><td>m</td><td>{p(m.m, 4)} kg</td></tr>}
              {m && <tr><td>x<sub>g</sub>, y<sub>g</sub>, z<sub>g</sub></td><td>{p(m.xg, 4)}, {p(m.yg, 4)}, {p(m.zg, 4)} {u}</td></tr>}
              {m?.density !== undefined && <tr><td>I<sub>m,x</sub>, I<sub>m,y</sub>, I<sub>m,z</sub></td><td>{p(m.Ixx * m.density, 4)}, {p(m.Iyy * m.density, 4)}, {p(m.Izz * m.density, 4)} kg·{u}²</td></tr>}
            </tbody>
          </table>
          {result.issues.map((x) => <p key={x} className="hint">⚠ {x}</p>)}
        </>
      )}

      <h3 className="sub">Constraints ({sk.constraints.length})</h3>
      <ul className="cad-clist">
        {sk.constraints.map((c) => {
          const bad = result?.conflicting.includes(c.id), red = result?.redundant.includes(c.id);
          return (
            <li key={c.id} className={`${sel.includes(c.id) ? 'sel' : ''}${bad ? ' bad' : red ? ' warn' : ''}`}>
              <button className="link" onClick={() => setUi({ regionId: region.id, selected: [c.id] })}>
                {TYPE_LABEL[c.type] ?? c.type}{isDimension(c.type) ? ` = ${c.value ?? ''}${c.name ? ` (${c.name})` : ''}` : ''}{bad ? ' — conflicts' : red ? ' — redundant' : ''}
              </button>
              <button className="icon-btn" aria-label="Delete constraint" title="Delete" onClick={() => setSketch(removeFromSketch(sk, new Set([c.id])))}><Trash2 size={13} /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
