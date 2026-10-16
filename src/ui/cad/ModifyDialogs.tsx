// Dialogs of the modify features: fillet, chamfer, shell, draft, press-pull, split and
// move/copy. Edges, faces and bodies are picked in the 3-D view (CadWorkspace sends the
// clicks to the feature); a plane or an axis field takes the next click when its Pick
// button is pressed. Every size is a worksheet expression.
import { Crosshair, Plus, X } from 'lucide-react';
import type { CadResult } from '../../cad/evaluate';
import {
  isSketch, itemName,
  type AxisPick, type CadComponent, type CadDesign, type FilletSet, type ModifyFeature, type PlanePick,
} from '../../cad/design';
import { refWords, type TopoRef } from '../../cad/topology';
import { Expr, Pick, axisOptions, bodyOptions } from './FeatureDialogs';

/** What the next click in the view picks for a modify dialog's plane or axis field. */
export type PickTarget = 'plane' | 'axis';

export interface ModifyProps {
  design: CadDesign;
  comp: CadComponent;
  feature: ModifyFeature;
  result?: CadResult;
  /** The field waiting for a click, if any. */
  target?: PickTarget;
  onTarget: (t: PickTarget | undefined) => void;
  /** The fillet set clicked edges go into. */
  set: number;
  onSet: (i: number) => void;
  onChange: (patch: Partial<ModifyFeature>, coalesce?: string) => void;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 edges · Clear". */
function Picked({ label, n, what, onClear }: { label: string; n: number; what: [string, string]; onClear: () => void }) {
  return (
    <div className="field">
      <span>{label}</span>
      <p className="cadd-picked">
        <b>{n ? count(n, what[0], what[1]) : `No ${what[1]} yet`}</b>
        {n > 0 && <button className="link" onClick={onClear}>Clear</button>}
      </p>
    </div>
  );
}

/** A plane or axis field: a list of origin and sketch choices, a face or edge picked in the view, and the button to pick one. */
function PickField<T extends PlanePick | AxisPick>({ label, value, options, design, waiting, onWait, onChange, none }: {
  label: string; value: T | undefined; options: [string, string][]; design: CadDesign; waiting: boolean; onWait: () => void; onChange: (v: T | undefined) => void; none?: string;
}) {
  const picked = value && typeof value !== 'string' ? (value as TopoRef) : null;
  const words = picked && refWords(picked, (id) => itemName(design, id));
  const key = value === undefined ? '' : picked ? 'picked' : (value as string);
  return (
    <div className="cadd-pickfield">
      <Pick label={label} value={key} onChange={(k) => k !== 'picked' && onChange((k || undefined) as T | undefined)}
        options={[...(none ? [['', none] as [string, string]] : []), ...options, ...(words ? [['picked', `Picked: ${words.replace(/^the /, '')}`] as [string, string]] : [])]} />
      <button className={`btn${waiting ? ' primary' : ''}`} onClick={onWait} title="Click a face or edge in the view">
        <Crosshair size={13} /> {waiting ? 'Click in the view…' : 'Pick'}
      </button>
    </div>
  );
}

export function ModifyFields({ design, comp, feature: f, result, target, onTarget, set, onSet, onChange }: ModifyProps) {
  const sketches = comp.items.filter(isSketch);
  const upto = comp.items.indexOf(f);
  const before = sketches.filter((s) => comp.items.indexOf(s) < (upto < 0 ? Infinity : upto));
  const planes: [string, string][] = [['XY', 'XY plane'], ['XZ', 'XZ plane'], ['YZ', 'YZ plane'], ...before.map((s) => [s.id, `Plane of ${s.name}`] as [string, string])];
  // the bodies it starts from, not those it makes (a split's pieces, copies)
  const bodies = bodyOptions(comp, result).filter(([id]) => !id.startsWith(`${f.id}.`));
  const wait = (t: PickTarget) => onTarget(target === t ? undefined : t);
  const chain = (on: boolean | undefined) => (
    <label className="check" title="Round along the edges tangent to a picked one (OpenCascade always does: off refuses a chain that goes on)">
      <input type="checkbox" checked={on !== false} onChange={(e) => onChange({ chain: e.target.checked ? undefined : false } as Partial<ModifyFeature>)} /> Tangent chain
    </label>
  );
  switch (f.kind) {
    case 'fillet': {
      const setAt = (i: number, patch: Partial<FilletSet>, key?: string) => onChange({ sets: f.sets.map((s, k) => (k === i ? { ...s, ...patch } : s)) }, key && `${key}${i}`);
      return (
        <>
          {f.sets.map((s, i) => (
            <fieldset key={i} className={`cadd-side cadd-set${i === set ? ' on' : ''}`} onClick={() => i !== set && onSet(i)}>
              <legend>Set {i + 1}{i === set ? ' · clicks go here' : ''}</legend>
              <p className="cadd-picked">
                <b>{s.edges.length ? count(s.edges.length, 'edge') : 'No edges yet'}</b>
                {s.edges.length > 0 && <button className="link" onClick={() => setAt(i, { edges: [] })}>Clear</button>}
                {f.sets.length > 1 && <button className="link" onClick={(e) => { e.stopPropagation(); onChange({ sets: f.sets.filter((_, k) => k !== i) }); onSet(Math.max(0, Math.min(set, f.sets.length - 2))); }}><X size={11} /> Remove</button>}
              </p>
              <div className="row2">
                <Expr label="Radius" value={s.r} onChange={(r) => setAt(i, { r }, 'r')} />
                <Expr label="End radius" value={s.r2 ?? ''} placeholder="constant" hint="Empty: the same radius all along. Otherwise the radius goes linearly from the start of the chain (its end with the smaller x, then y, z) to its end." onChange={(r2) => setAt(i, { r2: r2 || undefined }, 're')} />
              </div>
            </fieldset>
          ))}
          <button className="btn" onClick={() => { onChange({ sets: [...f.sets, { edges: [], r: f.sets[f.sets.length - 1]?.r ?? '2' }] }); onSet(f.sets.length); }}><Plus size={13} /> Another radius</button>
          {chain(f.chain)}
          <p className="hint">Click edges in the view to round them; click one again, or its rounding, to take it out. A face adds all its edges.</p>
        </>
      );
    }
    case 'chamfer':
      return (
        <>
          <Picked label="Edges" n={f.edges.length} what={['edge', 'edges']} onClear={() => onChange({ edges: [] })} />
          <Pick label="Type" value={f.type} options={[['equal', 'Equal distance'], ['two', 'Two distances'], ['angle', 'Distance and angle']]}
            onChange={(type) => onChange({ type, ...(type === 'two' && !f.d2 ? { d2: f.d } : {}), ...(type === 'angle' && !f.angle ? { angle: '45 deg' } : {}) })} />
          <div className="row2">
            <Expr label={f.type === 'equal' ? 'Distance' : 'Distance 1'} value={f.d} onChange={(d) => onChange({ d }, 'd')} />
            {f.type === 'two' && <Expr label="Distance 2" value={f.d2 ?? ''} onChange={(d2) => onChange({ d2 }, 'd2')} />}
            {f.type === 'angle' && <Expr label="Angle" value={f.angle ?? ''} onChange={(angle) => onChange({ angle }, 'angle')} />}
          </div>
          {f.type !== 'equal' && (
            <label className="check" title="Distance 1 (and the angle) are measured on the face of each edge that comes first by name; flip takes the other face">
              <input type="checkbox" checked={!!f.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined })} /> Flip (distance 1 on the other face)
            </label>
          )}
          {chain(f.chain)}
          <p className="hint">Click edges in the view to chamfer them; click one again, or its chamfer, to take it out. A face adds all its edges.</p>
        </>
      );
    case 'shell':
      return (
        <>
          <Picked label="Faces to remove" n={f.faces.length} what={['face', 'faces']} onClear={() => onChange({ faces: [] })} />
          {!f.faces.length && <Pick label="Body to hollow out" value={f.body ?? ''} options={[['', '— pick —'], ...bodies]} onChange={(body) => onChange({ body: body || undefined })} />}
          <div className="row2">
            <Expr label="Thickness" value={f.t} onChange={(t) => onChange({ t }, 't')} />
            <Pick label="Walls" value={f.side} options={[['inside', 'Inside'], ['outside', 'Outside']]} onChange={(side) => onChange({ side })} />
          </div>
          <p className="hint">Click the faces to open (the top of a box). With none, the body is hollowed out: a closed void inside it.</p>
        </>
      );
    case 'draft':
      return (
        <>
          <Picked label="Faces" n={f.faces.length} what={['face', 'faces']} onClear={() => onChange({ faces: [] })} />
          <PickField<PlanePick> label="Neutral plane" value={f.plane} options={planes} design={design} waiting={target === 'plane'} onWait={() => wait('plane')} onChange={(plane) => plane && onChange({ plane })} />
          <PickField<AxisPick> label="Pull direction" value={f.pull} options={axisOptions(before)} none="Normal of the neutral plane" design={design} waiting={target === 'axis'} onWait={() => wait('axis')} onChange={(pull) => onChange({ pull })} />
          <Expr label="Draft angle" value={f.angle} onChange={(angle) => onChange({ angle }, 'angle')} />
          <label className="check"><input type="checkbox" checked={!!f.flip} onChange={(e) => onChange({ flip: e.target.checked || undefined })} /> Flip the pull direction</label>
          <p className="hint">Click the faces to draft. They turn about where they meet the neutral plane; a positive angle takes material off on the side the pull direction points to (a part narrowing towards it).</p>
        </>
      );
    case 'presspull':
      return (
        <>
          <Picked label="Faces" n={f.faces.length} what={['face', 'faces']} onClear={() => onChange({ faces: [] })} />
          <Expr label="Distance" value={f.d} onChange={(d) => onChange({ d }, 'd')} />
          <p className="hint">Click flat or cylindrical faces. A positive distance pulls a face out of the material (adds), a negative one pushes it in. A hole's wall pulled out makes the hole smaller.</p>
        </>
      );
    case 'split':
      return (
        <>
          <Pick label="Body" value={f.body} options={[['', '— pick —'], ...bodies]} onChange={(body) => onChange({ body })} />
          <PickField<PlanePick> label="Splitting plane" value={f.plane} options={planes} design={design} waiting={target === 'plane'} onWait={() => wait('plane')} onChange={(plane) => plane && onChange({ plane })} />
          <Expr label="Offset along its normal" value={f.offset ?? ''} placeholder="0" onChange={(offset) => onChange({ offset: offset || undefined }, 'offset')} />
          <p className="hint">Click the body in the view. The piece behind the plane keeps the body; the others become new bodies.</p>
        </>
      );
    case 'move':
      return (
        <>
          <div className="field">
            <span>Bodies</span>
            <p className="cadd-picked"><b>{f.bodies.length ? f.bodies.map((b) => bodies.find(([id]) => id === b)?.[1] ?? b).join(', ') : 'Click bodies in the view'}</b>
              {f.bodies.length > 0 && <button className="link" onClick={() => onChange({ bodies: [] })}>Clear</button>}</p>
          </div>
          <div className="row3">
            <Expr label="ΔX" value={f.dx ?? ''} placeholder="0" onChange={(dx) => onChange({ dx: dx || undefined }, 'dx')} />
            <Expr label="ΔY" value={f.dy ?? ''} placeholder="0" onChange={(dy) => onChange({ dy: dy || undefined }, 'dy')} />
            <Expr label="ΔZ" value={f.dz ?? ''} placeholder="0" onChange={(dz) => onChange({ dz: dz || undefined }, 'dz')} />
          </div>
          <PickField<AxisPick> label="Turn about" value={f.axis} options={axisOptions(before)} none="No turn" design={design} waiting={target === 'axis'} onWait={() => wait('axis')} onChange={(axis) => onChange({ axis })} />
          {f.axis && <Expr label="Angle" value={f.angle ?? ''} placeholder="0" onChange={(angle) => onChange({ angle: angle || undefined }, 'angle')} />}
          <label className="check"><input type="checkbox" checked={!!f.copy} onChange={(e) => onChange({ copy: e.target.checked || undefined })} /> Copy (keep the original)</label>
          <p className="hint">The bodies turn about the axis first, then move by ΔX, ΔY, ΔZ (component axes).</p>
        </>
      );
  }
}
