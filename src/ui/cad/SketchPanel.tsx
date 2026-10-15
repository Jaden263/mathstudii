// Properties of the sketch being edited: status, the selected dimension or geometry,
// and the list of constraints. Also the mass-property table the CAD panels share.
import { Trash2 } from 'lucide-react';
import type { CadResult } from '../../cad/evaluate';
import type { MassOut } from '../../cad/design';
import { isDimension, removeFromSketch, type CadConstraint, type CadSketch } from '../../cad/model';
import { LazyInput } from '../sketch/SketchProps';
import { fmtNum } from './cadRender';

export const TYPE_LABEL: Record<string, string> = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  equal: 'Equal', fix: 'Fixed', pointOnLine: 'Point on line', pointOnCircle: 'Point on circle', tangent: 'Tangent',
  midpoint: 'Midpoint', symmetric: 'Symmetric', concentric: 'Concentric', distance: 'Distance', distanceX: 'Horizontal distance',
  distanceY: 'Vertical distance', length: 'Length', angle: 'Angle', radius: 'Radius', diameter: 'Diameter',
};

export const num = (v: number | undefined, d = 5) => (v === undefined || !Number.isFinite(v) ? '–' : String(+v.toPrecision(d)));

/** Volume, mass, centre of gravity and inertia. */
export function MassTable({ m, unit }: { m: MassOut | null | undefined; unit: string }) {
  if (!m) return <p className="hint">No solid yet.</p>;
  return (
    <table className="props-table">
      <tbody>
        <tr><td>V</td><td>{num(m.V)} {unit}³</td></tr>
        {m.m !== undefined && <tr><td>m</td><td>{num(m.m, 4)} kg</td></tr>}
        <tr><td>CoG</td><td>{num(m.xg, 4)}, {num(m.yg, 4)}, {num(m.zg, 4)} {unit}</td></tr>
        {m.Im && <tr><td>I<sub>x</sub>, I<sub>y</sub>, I<sub>z</sub></td><td>{num(m.Im[0], 4)}, {num(m.Im[1], 4)}, {num(m.Im[2], 4)} kg·{unit}²</td></tr>}
        {m.Im && (m.Im[3] || m.Im[4] || m.Im[5]) ? <tr><td>I<sub>xy</sub>, I<sub>xz</sub>, I<sub>yz</sub></td><td>{num(m.Im[3], 4)}, {num(m.Im[4], 4)}, {num(m.Im[5], 4)}</td></tr> : null}
      </tbody>
    </table>
  );
}

interface Props {
  sketch: CadSketch;
  result?: CadResult;
  unit: string;
  partName: string;
  selected: string[];
  onSelect: (ids: string[]) => void;
  onSketch: (sk: CadSketch, coalesce?: string) => void;
}

export function SketchPanel({ sketch: sk, result, unit, partName, selected: sel, onSelect, onSketch }: Props) {
  const selDims = sk.constraints.filter((c) => sel.includes(c.id) && isDimension(c.type));
  const selEnts = sk.entities.filter((e) => sel.includes(e.id));
  const updC = (c: CadConstraint, patch: Partial<CadConstraint>) => onSketch({ ...sk, constraints: sk.constraints.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) }, `dim:${c.id}`);
  const s = result?.section;
  const name = partName || 'part';
  return (
    <div className="props">
      {result && (
        <table className="props-table">
          <tbody>
            <tr><td>Status</td><td>{!result.ok ? `${result.conflicting.length} conflicting` : result.dof === 0 ? 'Fully defined' : `${result.dof} DOF free`}{result.redundant.length ? `, ${result.redundant.length} redundant` : ''}</td></tr>
            {s && <tr><td>A</td><td>{num(s.A)} {unit}²</td></tr>}
            {s && <tr><td>x<sub>c</sub>, y<sub>c</sub></td><td>{num(s.xc)}, {num(s.yc)} {unit}</td></tr>}
            {s && <tr><td>I<sub>x</sub>, I<sub>y</sub></td><td>{num(s.Ix)}, {num(s.Iy)} {unit}⁴</td></tr>}
          </tbody>
        </table>
      )}
      {result?.issues.map((x) => <p key={x} className="hint">⚠ {x}</p>)}

      {selDims.length === 1 && (() => {
        const c = selDims[0];
        const err = result?.dimErrors[c.id];
        const v = result?.values[c.id];
        return (
          <>
            <h3 className="sub">{TYPE_LABEL[c.type]} dimension</h3>
            {err && <div className="region-error">{err}</div>}
            <label className="field" title="A number in the part unit, a value with a unit (25 mm, 30 deg) or any worksheet expression">
              <span>Value{v !== undefined ? ` (now ${fmtNum(c.type === 'angle' ? (v * 180) / Math.PI : v)}${c.type === 'angle' ? '°' : ` ${unit}`})` : ''}</span>
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
              onSketch({ ...sk, entities: sk.entities.map((x) => (ids.has(x.id) ? { ...x, construction: e.target.checked || undefined } : x)) });
            }} /> Construction (not part of the profile)
          </label>
        </>
      )}

      <h3 className="sub">Constraints ({sk.constraints.length})</h3>
      <ul className="cad-clist">
        {sk.constraints.map((c) => {
          const bad = result?.conflicting.includes(c.id), red = result?.redundant.includes(c.id);
          return (
            <li key={c.id} className={`${sel.includes(c.id) ? 'sel' : ''}${bad ? ' bad' : red ? ' warn' : ''}`}>
              <button className="link" onClick={() => onSelect([c.id])}>
                {TYPE_LABEL[c.type] ?? c.type}{isDimension(c.type) ? ` = ${c.value ?? ''}${c.name ? ` (${c.name})` : ''}` : ''}{bad ? ' — conflicts' : red ? ' — redundant' : ''}
              </button>
              <button className="icon-btn" aria-label="Delete constraint" title="Delete" onClick={() => onSketch(removeFromSketch(sk, new Set([c.id])))}><Trash2 size={13} /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
