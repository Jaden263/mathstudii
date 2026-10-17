// Properties of the sketch being edited: status, the selected dimension or geometry,
// and the list of constraints. Also the mass-property table the CAD panels share.
import { Trash2 } from 'lucide-react';
import type { CadResult } from '../../cad/evaluate';
import type { MassOut } from '../../cad/design';
import { isAngleDim, isDimension, removeFromSketch, type CadConstraint, type CadEntity, type CadSketch } from '../../cad/model';
import { repattern } from '../../cad/sketchTools';
import { withHandle } from '../../cad/edit';
import { missingGlyphs } from '../../cad/text';
import { LazyInput } from '../sketch/SketchProps';
import { fmtNum } from './cadRender';

export const TYPE_LABEL: Record<string, string> = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  equal: 'Equal', fix: 'Fixed', pointOnLine: 'Point on line', pointOnCircle: 'Point on circle', tangent: 'Tangent',
  midpoint: 'Midpoint', symmetric: 'Symmetric', concentric: 'Concentric', distance: 'Distance', distanceX: 'Horizontal distance',
  distanceY: 'Vertical distance', length: 'Length', angle: 'Angle', radius: 'Radius', diameter: 'Diameter',
  collinear: 'Collinear', pointOnCurve: 'Point on curve', curvature: 'Curvature (G2)', majorRadius: 'Major radius', minorRadius: 'Minor radius',
  offset: 'Offset', pattern: 'Pattern',
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
              <span>{c.type === 'pattern' ? (c.pattern?.kind === 'circ' ? 'Total angle' : 'Spacing') : 'Value'}{v !== undefined ? ` (now ${fmtNum(isAngleDim(c) ? (v * 180) / Math.PI : v)}${isAngleDim(c) ? '°' : ` ${unit}`})` : ''}</span>
              <LazyInput label="Dimension value" value={c.value ?? ''} onCommit={(t) => updC(c, { value: t.trim() })} />
            </label>
            <div className="row2">
              <label className="field">
                <span>Name ({name}.…)</span>
                <LazyInput label="Dimension name" value={c.name ?? ''} onCommit={(t) => updC(c, { name: t.trim() || undefined })} />
              </label>
              <label className="check" title="A reference dimension measures the geometry instead of driving it">
                <input type="checkbox" checked={c.driving === false} onChange={(e) => updC(c, { driving: e.target.checked ? false : undefined, value: e.target.checked ? c.value : String(+((isAngleDim(c) ? ((v ?? 0) * 180) / Math.PI : v ?? 0).toPrecision(6))) })} /> Reference only
              </label>
            </div>
            {c.type === 'pattern' && c.pattern && <PatternCount sk={sk} c={c} onSketch={onSketch} />}
          </>
        );
      })()}
      {selEnts.length === 1 && <EntityFields sk={sk} e={selEnts[0]} onSketch={onSketch} />}
      {selEnts.length > 0 && (
        <>
          <h3 className="sub">{selEnts.length === 1 ? ENTITY_LABEL[selEnts[0].type] ?? selEnts[0].type : `${selEnts.length} entities`}</h3>
          <label className="check">
            <input type="checkbox" checked={selEnts.every((e) => e.construction)} onChange={(e) => {
              const ids = new Set(selEnts.map((x) => x.id));
              onSketch({ ...sk, entities: sk.entities.map((x) => (ids.has(x.id) ? { ...x, construction: e.target.checked || undefined } : x)) });
            }} /> Construction (not part of the profile)
          </label>
        </>
      )}

      {sk.sources?.length ? (
        <>
          <h3 className="sub">Projected ({sk.sources.length})</h3>
          <ul className="cad-sources">
            {sk.sources.map((q) => (
              <li key={q.id}>
                <span>{q.label ?? (q.kind === 'section' ? 'Section of the bodies' : q.kind === 'datum' ? 'Construction geometry' : q.kind === 'face' ? 'Face outline' : 'Edge')}</span>
                <button className="icon-btn" aria-label="Remove the projection" title="Remove the projected geometry" onClick={() => onSketch(removeFromSketch(sk, new Set([q.id])))}><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>
          <p className="hint">Projected geometry is fixed and follows the model when it is rebuilt. Toggle Construction (X) to make it part of a profile.</p>
        </>
      ) : null}

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

const ENTITY_LABEL: Record<CadEntity['type'], string> = {
  line: 'Line', circle: 'Circle', arc: 'Arc', point: 'Point', spline: 'Spline', ellipse: 'Ellipse', text: 'Text',
};

/** What one selected spline, ellipse or text has to set. */
function EntityFields({ sk, e, onSketch }: { sk: CadSketch; e: CadEntity; onSketch: (sk: CadSketch, coalesce?: string) => void }) {
  const upd = (patch: Partial<CadEntity>, coalesce?: string) => onSketch({ ...sk, entities: sk.entities.map((x) => (x.id === e.id ? ({ ...x, ...patch } as CadEntity) : x)) }, coalesce);
  const P = new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }]));
  if (e.ref) {
    const src = sk.sources?.find((q) => q.id === e.ref);
    return <p className="hint">Projected from {src?.label ?? 'the model'}: fixed, it follows the model.</p>;
  }
  if (e.type === 'text') {
    const missing = missingGlyphs(e.text);
    return (
      <>
        <h3 className="sub">Text</h3>
        <label className="field"><span>Text</span><LazyInput label="Text" value={e.text} onCommit={(t) => t.trim() && upd({ text: t })} /></label>
        <div className="row2">
          <label className="field" title="The font size: capitals are 0.694 of it"><span>Size</span><LazyInput label="Text size" value={String(e.size)} onCommit={(t) => Number(t) > 0 && upd({ size: Number(t) })} /></label>
          <label className="field"><span>Angle °</span><LazyInput label="Text angle" value={String(e.angle ?? 0)} onCommit={(t) => Number.isFinite(Number(t)) && upd({ angle: Number(t) || undefined })} /></label>
        </div>
        {missing.length > 0 && <p className="hint">⚠ Not in the font (left out): {missing.join(' ')}</p>}
      </>
    );
  }
  if (e.type === 'spline') {
    const hasH = !!(e.h1 || e.h2);
    return (
      <>
        <h3 className="sub">Spline</h3>
        <label className="check" title="Through its points (fit), or with them as the poles of a B-spline (control)">
          <input type="checkbox" checked={e.mode === 'control'} onChange={(x) => upd({ mode: x.target.checked ? 'control' : undefined, h1: undefined, h2: undefined, knots: undefined })} /> Control points (poles) instead of fit points
        </label>
        <label className="check"><input type="checkbox" checked={!!e.closed} onChange={(x) => upd({ closed: x.target.checked || undefined, h1: undefined, h2: undefined, knots: undefined })} /> Closed</label>
        {e.mode !== 'control' && !e.closed && (
          <label className="check" title="Handles at the ends set the direction and speed the curve leaves them with">
            <input type="checkbox" checked={hasH} onChange={(x) => onSketch(x.target.checked ? withHandle(withHandle(sk, P, e.id, 0), P, e.id, 1) : removeFromSketch({ ...sk, entities: sk.entities.map((y) => (y.id === e.id ? { ...e, h1: undefined, h2: undefined } : y)) }, new Set()))} /> Tangent handles at the ends
          </label>
        )}
      </>
    );
  }
  return null;
}

/** A pattern's count: changing it makes the copies again. */
function PatternCount({ sk, c, onSketch }: { sk: CadSketch; c: CadConstraint; onSketch: (sk: CadSketch, coalesce?: string) => void }) {
  const pt = c.pattern!;
  const parts = sk.constraints.filter((k) => k.pattern?.group && k.pattern.group === pt.group);
  const first = parts[0] ?? c, second = parts[1];
  const P = new Map(sk.points.map((p) => [p.id, { x: p.x, y: p.y }]));
  const set = (n1: number, n2?: number) => {
    const r = repattern(sk, P, first.id, n1, n2);
    if (typeof r !== 'string') onSketch(r.sketch);
  };
  return (
    <div className="row2">
      <label className="field"><span>{pt.kind === 'circ' ? 'Count' : 'Count (first direction)'}</span>
        <LazyInput label="Pattern count" value={String(first.pattern!.count)} onCommit={(t) => Number(t) >= 1 && set(Math.round(Number(t)), second?.pattern?.count)} />
      </label>
      {pt.kind === 'rect' && (
        <label className="field"><span>Count (second)</span>
          <LazyInput label="Second pattern count" value={String(second?.pattern?.count ?? 1)} onCommit={(t) => Number(t) >= 1 && set(first.pattern!.count, Math.round(Number(t)))} />
        </label>
      )}
    </div>
  );
}
